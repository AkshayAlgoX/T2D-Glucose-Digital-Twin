#!/usr/bin/env python3
"""run_phase10a1.py -- Phase 10A.1: Trivial Correction Challenge for PR-TFT vs UKF.

Constructs and evaluates four forecast arms on the test patients:
  Arm A: UKF-only prior forecast
  Arm B: UKF + initial-state offset correction: y_B(h) = y_UKF(h) + [CGM(t0) - y_UKF(t0)]
  Arm C: UKF + simple residual regression fit ONLY on validation patients (Ridge/OLS)
  Arm D: Frozen PR-TFT + UKF checkpoint

Computes RMSE, MAE, Residual MSE, Residual R2, Bias, Paired Bootstrap (B=2000),
Trivial Correction Fractions, and Stratified Incremental Gains.
"""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
import torch

# Ensure backend is on PYTHONPATH
REPO_DIR = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_DIR / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import provenance as prov
import train_pr_tft as T
import evaluate_run as E

def run_phase10a1():
    print("=" * 80)
    print("PHASE 10A.1 — TRIVIAL CORRECTION CHALLENGE")
    print("=" * 80)

    ckpt_path = REPO_DIR / "runs" / "pr_tft_final" / "checkpoints" / "stage2_observed-epoch=03-val_loss=0.2255.ckpt"
    cfg_path = BACKEND_DIR / "final_config.json"
    data_dir = BACKEND_DIR / "synthetic_v2"

    if not ckpt_path.is_file():
        print(f"CRITICAL ERROR: Verified checkpoint not found at {ckpt_path}")
        sys.exit(1)
    
    print(f"Target Checkpoint: {ckpt_path}")
    print(f"Config Path:       {cfg_path}")
    print(f"Data Directory:    {data_dir}")

    # Load configuration and split
    run_cfg = T.load_run_config(cfg_path, data_dir=data_dir)
    cfg = run_cfg.cfg
    split = prov.load_json(BACKEND_DIR / "split_293.json")
    
    # Load model module
    module = T.PRTFTModule.load_from_checkpoint(str(ckpt_path), map_location="cpu")
    module.eval()

    # Load cohort data via authoritative load_data
    print("\n[1/6] Loading data telemetry and preparing series...")
    series = T.load_data(cfg)
    
    # Initialize UKF Twin
    twin = T.make_twin(cfg)

    # Fit/Load normalizer
    norm_saved = prov.load_json(REPO_DIR / "runs" / "pr_tft_final" / "normalization.json")
    norm = T.Normalizer(**norm_saved)
    train_series = [series[p] for p in split["train"]]
    pop = T.population_habit(train_series)

    # -------------------------------------------------------------------------
    # Process Validation Patients & Fit Ridge Regression for Arm C
    # -------------------------------------------------------------------------
    print("\n[2/6] Processing Validation Patients & Fitting Arm C Regression Model...")
    val_pids = sorted(split["val"])
    val_series = [series[p] for p in val_pids]
    val_anchors = {p: T.eligible_anchors(series[p], cfg) for p in val_pids}
    split_val = T.build_split(val_series, val_anchors, twin, norm, pop, cfg)
    
    val_preds = E._predict(module, split_val, cfg)
    
    # Extract validation regression features & targets
    # y_true shape: (N_val, 24)
    # y_ukf shape: (N_val, 24)
    y_val_true = val_preds["y"]
    y_val_mask = val_preds["y_mask"] > 0
    y_val_ukf = val_preds["twin"]
    
    # Validation regression features per anchor:
    # 1. CGM(t0)
    # 2. UKF(t0)
    # 3. CGM(t0) - UKF(t0)
    # 4. current CGM trend (CGM(t0) - CGM(t0-1))
    # 5. sin(time-of-day)
    # 6. cos(time-of-day)
    
    val_cgm_t0 = val_preds["g0"]  # (N_val,)
    val_ukf_t0 = y_val_ukf[:, 0]  # or current step prediction
    
    val_p_idx = split_val.anchor_patient.numpy()
    val_t_idx = split_val.anchor_t.numpy()

    val_X_list = []
    val_Y_res_list = []
    
    for i in range(len(split_val.anchor_patient)):
        p_idx = val_p_idx[i]
        ps = val_series[p_idx]
        t = val_t_idx[i]
        
        cgm_t0 = val_preds["g0"][i]
        ukf_t0 = y_val_ukf[i, 0]
        offset_t0 = np.nan_to_num(cgm_t0 - ukf_t0, nan=0.0)
        trend_t0 = np.nan_to_num(cgm_t0 - ps.cgm_ff[t-1], nan=0.0) if t > 0 else 0.0
        
        hour_t0 = (ps.stamps[t].hour + ps.stamps[t].minute / 60.0)
        sin_tod = math.sin(2 * math.pi * hour_t0 / 24.0)
        cos_tod = math.cos(2 * math.pi * hour_t0 / 24.0)
        
        feat = np.nan_to_num([cgm_t0, ukf_t0, offset_t0, trend_t0, sin_tod, cos_tod], nan=0.0)
        
        y_true_seq = y_val_true[i]
        y_ukf_seq = y_val_ukf[i]
        mask_seq = val_preds["y_mask"][i] > 0
        
        if mask_seq.all() and np.isfinite(feat).all() and np.isfinite(y_true_seq).all() and np.isfinite(y_ukf_seq).all():
            val_X_list.append(feat)
            val_Y_res_list.append(y_true_seq - y_ukf_seq)

    X_val_mat = np.array(val_X_list) # (N_clean_val, 6)
    Y_val_res_mat = np.array(val_Y_res_list) # (N_clean_val, 24)

    # Fit Ridge models for each horizon step h in 0..23
    ridge_models = []
    for h in range(T.HORIZON):
        r = Ridge(alpha=10.0)
        r.fit(X_val_mat, Y_val_res_mat[:, h])
        ridge_models.append(r)
    print("Arm C Ridge Regression models successfully fitted on validation cohort.")

    # -------------------------------------------------------------------------
    # Process Test Patients
    # -------------------------------------------------------------------------
    print("\n[3/6] Running Inference on Test Patients (44 patients)...")
    test_pids = sorted(split["test"])
    test_series = [series[p] for p in test_pids]
    test_anchors = {p: T.eligible_anchors(series[p], cfg) for p in test_pids}
    split_test = T.build_split(test_series, test_anchors, twin, norm, pop, cfg)
    
    test_preds = E._predict(module, split_test, cfg)

    y_true = test_preds["y"] # (N_test, 24)
    y_mask = test_preds["y_mask"] > 0
    y_pr_tft = test_preds["q"][..., T.MEDIAN_IDX] # (N_test, 24) median forecast
    y_ukf = test_preds["twin"] # (N_test, 24)
    
    anchor_pids = np.array(split_test.anchor_patient.numpy())
    anchor_ts = np.array(split_test.anchor_t.numpy())
    
    # Construct Arm A, B, C, D predictions
    N_test = y_true.shape[0]
    
    Arm_A = y_ukf.copy() # UKF-only
    Arm_B = np.zeros_like(y_ukf) # UKF + initial offset
    Arm_C = np.zeros_like(y_ukf) # UKF + Ridge residual regression
    Arm_D = y_pr_tft.copy() # PR-TFT + UKF

    # Metadata for stratification
    meta_offset = np.zeros(N_test)
    meta_tod_sin = np.zeros(N_test)
    meta_tod_cos = np.zeros(N_test)
    meta_hour = np.zeros(N_test)
    meta_nis = np.zeros(N_test)
    meta_meal = np.zeros(N_test, dtype=bool)
    meta_active = np.zeros(N_test, dtype=bool)
    meta_group = np.zeros(N_test, dtype=object)

    for i in range(N_test):
        p_idx = anchor_pids[i]
        ps = test_series[p_idx]
        t = anchor_ts[i]
        
        cgm_t0 = test_preds["g0"][i]
        ukf_t0 = y_ukf[i, 0]
        ukf_res = twin._run(ps)
        
        offset_t0 = np.nan_to_num(cgm_t0 - ukf_t0, nan=0.0)
        trend_t0 = np.nan_to_num(cgm_t0 - ps.cgm_ff[t-1], nan=0.0) if t > 0 else 0.0
        
        hour_t0 = (ps.stamps[t].hour + ps.stamps[t].minute / 60.0)
        sin_tod = math.sin(2 * math.pi * hour_t0 / 24.0)
        cos_tod = math.cos(2 * math.pi * hour_t0 / 24.0)
        
        feat = np.nan_to_num(np.array([[cgm_t0, ukf_t0, offset_t0, trend_t0, sin_tod, cos_tod]]), nan=0.0)
        
        # Arm B: UKF + initial offset
        Arm_B[i] = y_ukf[i] + offset_t0
        
        # Arm C: UKF + Ridge residual
        pred_res = np.array([ridge_models[h].predict(feat)[0] for h in range(T.HORIZON)])
        Arm_C[i] = y_ukf[i] + pred_res
        
        # Metadata
        meta_offset[i] = abs(offset_t0)
        meta_hour[i] = hour_t0
        meta_nis[i] = float(ukf_res["innov_z"][t])**2 if "innov_z" in ukf_res else 0.0
        
        # Meal in past 2h or future 2h
        meal_bins = T.meal_step_index(ps.meal_min)
        has_meal = np.any((meal_bins >= t - 24) & (meal_bins <= t + 24))
        meta_meal[i] = has_meal
        
        # Activity (steps > 0 or hr > rest)
        meta_active[i] = bool(ps.steps[t] > 0 or ps.hr[t] > 80)
        meta_group[i] = ps.group

    # -------------------------------------------------------------------------
    # Compute Metrics for 30, 60, 120 min
    # -------------------------------------------------------------------------
    print("\n[4/6] Computing Performance Metrics (30 min, 60 min, 120 min)...")
    horizons = {"30min": 5, "60min": 11, "120min": 23} # 0-indexed: 5 = 30min, 11 = 60min, 23 = 120min
    
    arms = {"Arm A (UKF)": Arm_A, "Arm B (UKF+Offset)": Arm_B, "Arm C (UKF+Ridge)": Arm_C, "Arm D (PR-TFT)": Arm_D}

    metrics_table = {}
    for h_name, h_idx in horizons.items():
        metrics_table[h_name] = {}
        y_t = y_true[:, h_idx]
        mask = y_mask[:, h_idx] & np.isfinite(y_t)
        
        y_true_valid = y_t[mask]
        var_y = np.var(y_true_valid)
        
        for arm_name, y_pred_mat in arms.items():
            pred = y_pred_mat[:, h_idx][mask]
            err = pred - y_true_valid
            
            rmse = math.sqrt(np.mean(err**2))
            mae = np.mean(np.abs(err))
            mse = np.mean(err**2)
            r2 = 1.0 - (mse / var_y) if var_y > 0 else np.nan
            bias = np.mean(err)
            
            metrics_table[h_name][arm_name] = {
                "RMSE": rmse, "MAE": mae, "Residual MSE": mse, "Residual R2": r2, "Bias": bias
            }

    # Print Table
    for h_name in horizons:
        print(f"\n--- Horizon: {h_name} ---")
        df_m = pd.DataFrame(metrics_table[h_name]).T
        print(df_m.to_string(float_format=lambda x: f"{x:.4f}"))

    # -------------------------------------------------------------------------
    # Paired Patient-Level Bootstrap (B=2000) & Improvement Fractions
    # -------------------------------------------------------------------------
    print("\n[5/6] Patient-Level Paired Bootstrap (B=2000) & Improvement Fractions...")
    
    unique_pids = np.unique(anchor_pids)
    n_boot = 2000
    rng = np.random.default_rng(20260930)
    
    # Store bootstrap MSE differences for 60min and 120min
    boot_diffs = {h_name: {"D-A": [], "D-B": [], "D-C": []} for h_name in horizons}
    frac_explained = {h_name: {"B_frac": [], "C_frac": []} for h_name in horizons}

    for h_name, h_idx in horizons.items():
        y_t = y_true[:, h_idx]
        mask = y_mask[:, h_idx] & np.isfinite(y_t)
        
        for b in range(n_boot):
            # Sample patients with replacement
            sampled_pids = rng.choice(unique_pids, size=len(unique_pids), replace=True)
            
            # Gather indices for sampled patients
            sample_indices = []
            for pid in sampled_pids:
                sample_indices.extend(np.flatnonzero(anchor_pids == pid))
            sample_indices = np.array(sample_indices)
            
            # Filter valid mask
            sub_mask = mask[sample_indices]
            idx_sub = sample_indices[sub_mask]
            
            y_sub = y_t[idx_sub]
            
            mse_A = np.mean((Arm_A[idx_sub, h_idx] - y_sub)**2)
            mse_B = np.mean((Arm_B[idx_sub, h_idx] - y_sub)**2)
            mse_C = np.mean((Arm_C[idx_sub, h_idx] - y_sub)**2)
            mse_D = np.mean((Arm_D[idx_sub, h_idx] - y_sub)**2)
            
            rmse_A = math.sqrt(mse_A)
            rmse_B = math.sqrt(mse_B)
            rmse_C = math.sqrt(mse_C)
            rmse_D = math.sqrt(mse_D)
            
            boot_diffs[h_name]["D-A"].append(rmse_D - rmse_A)
            boot_diffs[h_name]["D-B"].append(rmse_D - rmse_B)
            boot_diffs[h_name]["D-C"].append(rmse_D - rmse_C)
            
            # Fractions of MSE improvement
            denom = mse_A - mse_D
            if abs(denom) > 1e-6:
                frac_explained[h_name]["B_frac"].append((mse_A - mse_B) / denom)
                frac_explained[h_name]["C_frac"].append((mse_A - mse_C) / denom)

    # Print Bootstrap Summary
    print("\n--- Paired Bootstrap (PR-TFT RMSE minus Baseline RMSE) ---")
    for h_name in horizons:
        print(f"\nHorizon: {h_name}")
        for pair in ("D-A", "D-B", "D-C"):
            arr = np.array(boot_diffs[h_name][pair])
            mean_val = np.mean(arr)
            ci_lo, ci_hi = np.percentile(arr, [2.5, 97.5])
            print(f"  {pair}: Point/Mean Diff = {mean_val:.4f} mg/dL (95% CI: [{ci_lo:.4f}, {ci_hi:.4f}])")
        
        b_f = np.array(frac_explained[h_name]["B_frac"])
        c_f = np.array(frac_explained[h_name]["C_frac"])
        print(f"  Fraction explained by Initial Offset (Arm B): {np.mean(b_f):.4f} (95% CI: [{np.percentile(b_f, 2.5):.4f}, {np.percentile(b_f, 97.5):.4f}])")
        print(f"  Fraction explained by Ridge Regression (Arm C): {np.mean(c_f):.4f} (95% CI: [{np.percentile(c_f, 2.5):.4f}, {np.percentile(c_f, 97.5):.4f}])")

    # -------------------------------------------------------------------------
    # Stratified Incremental Gains (at 60 min & 120 min)
    # -------------------------------------------------------------------------
    print("\n[6/6] Computing Stratified Incremental Gains...")
    
    def evaluate_strata(subset_mask, strata_name, h_idx=11):
        idx_sub = np.flatnonzero(subset_mask & y_mask[:, h_idx] & np.isfinite(y_true[:, h_idx]))
        if len(idx_sub) == 0:
            return
        y_sub = y_true[idx_sub, h_idx]
        rmse_A = math.sqrt(np.mean((Arm_A[idx_sub, h_idx] - y_sub)**2))
        rmse_B = math.sqrt(np.mean((Arm_B[idx_sub, h_idx] - y_sub)**2))
        rmse_C = math.sqrt(np.mean((Arm_C[idx_sub, h_idx] - y_sub)**2))
        rmse_D = math.sqrt(np.mean((Arm_D[idx_sub, h_idx] - y_sub)**2))
        print(f"  {strata_name:30s} (N={len(idx_sub):5d}) | RMSE A: {rmse_A:6.2f} | B: {rmse_B:6.2f} | C: {rmse_C:6.2f} | D: {rmse_D:6.2f} | Gain D-B: {rmse_D - rmse_B:6.2f} | Gain D-C: {rmse_D - rmse_C:6.2f}")

    print("\n--- Stratification at 60 min (Horizon 12) ---")
    evaluate_strata(meta_offset < 10, "Offset < 10 mg/dL")
    evaluate_strata(meta_offset >= 10, "Offset >= 10 mg/dL")
    evaluate_strata((meta_hour >= 6) & (meta_hour < 22), "Daytime (06:00-22:00)")
    evaluate_strata((meta_hour < 6) | (meta_hour >= 22), "Nighttime (22:00-06:00)")
    evaluate_strata(meta_nis < 3.84, "Low NIS (< 3.84)")
    evaluate_strata(meta_nis >= 3.84, "High NIS (>= 3.84)")
    evaluate_strata(~meta_meal, "No Meal (Clean)")
    evaluate_strata(meta_meal, "Meal Present (Within 2h)")
    evaluate_strata(~meta_active, "Inactive")
    evaluate_strata(meta_active, "Active (Steps/HR)")
    evaluate_strata(meta_group == "Prediabetes", "Prediabetes")
    evaluate_strata(meta_group == "Type 2", "Type 2")

    print("\n--- Stratification at 120 min (Horizon 24) ---")
    evaluate_strata(meta_offset < 10, "Offset < 10 mg/dL", h_idx=23)
    evaluate_strata(meta_offset >= 10, "Offset >= 10 mg/dL", h_idx=23)
    evaluate_strata((meta_hour >= 6) & (meta_hour < 22), "Daytime (06:00-22:00)", h_idx=23)
    evaluate_strata((meta_hour < 6) | (meta_hour >= 22), "Nighttime (22:00-06:00)", h_idx=23)
    evaluate_strata(meta_nis < 3.84, "Low NIS (< 3.84)", h_idx=23)
    evaluate_strata(meta_nis >= 3.84, "High NIS (>= 3.84)", h_idx=23)
    evaluate_strata(~meta_meal, "No Meal (Clean)", h_idx=23)
    evaluate_strata(meta_meal, "Meal Present (Within 2h)", h_idx=23)
    evaluate_strata(~meta_active, "Inactive", h_idx=23)
    evaluate_strata(meta_active, "Active (Steps/HR)", h_idx=23)
    evaluate_strata(meta_group == "Prediabetes", "Prediabetes", h_idx=23)
    evaluate_strata(meta_group == "Type 2", "Type 2", h_idx=23)

    print("\n" + "=" * 80)
    print("PHASE 10A.1 ANALYSIS SUMMARY")
    print("=" * 80)

if __name__ == "__main__":
    run_phase10a1()

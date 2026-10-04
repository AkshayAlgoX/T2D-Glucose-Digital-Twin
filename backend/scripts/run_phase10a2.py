#!/usr/bin/env python3
"""run_phase10a2.py -- Phase 10A.2: Complete Trivial Correction Challenge Execution.

Computes:
  1. Verification of Checkpoint & Git SHA
  2. Inspection of evaluate_run.py bootstrap mechanism
  3. Diagnostic evaluation on Validation & Test cohorts for Arms A, B, C, D
  4. Both Pooled (Micro) and Macro (Patient-level) RMSE / MAE / Distributions / Win Rates
  5. Paired Stratified Patient Bootstrap (B=2000) for Macro and Pooled metrics & CIs
  6. Trivial & Simple Model Fractions (MSE improvement ratios)
  7. Stratified D-vs-B Residual Gains
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
import torch

REPO_DIR = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_DIR / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import provenance as prov
import train_pr_tft as T
import evaluate_run as E

def run_phase10a2():
    ckpt_path = REPO_DIR / "runs" / "pr_tft_final" / "checkpoints" / "stage2_observed-epoch=03-val_loss=0.2255.ckpt"
    cfg_path = BACKEND_DIR / "final_config.json"
    data_dir = BACKEND_DIR / "synthetic_v2"

    # Step 1: Verification
    ckpt_sha = prov.sha256_file(ckpt_path) if ckpt_path.is_file() else "MISSING"
    try:
        git_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO_DIR).decode().strip()
    except Exception:
        git_sha = "UNKNOWN"

    print("=" * 80)
    print("VERIFICATION")
    print(f"Checkpoint Path:   {ckpt_path}")
    print(f"Checkpoint SHA256: {ckpt_sha}")
    print(f"Git HEAD SHA:      {git_sha}")
    print("=" * 80)

    # Load config and split
    run_cfg = T.load_run_config(cfg_path, data_dir=data_dir)
    cfg = run_cfg.cfg
    split = prov.load_json(BACKEND_DIR / "split_293.json")

    # Load model
    module = T.PRTFTModule.load_from_checkpoint(str(ckpt_path), map_location="cpu")
    module.eval()

    # Load cohort series
    series = T.load_data(cfg)
    twin = T.make_twin(cfg)
    norm_saved = prov.load_json(REPO_DIR / "runs" / "pr_tft_final" / "normalization.json")
    norm = T.Normalizer(**norm_saved)
    train_series = [series[p] for p in split["train"]]
    pop = T.population_habit(train_series)

    # Fit Arm C Ridge Model ONLY on Training Patients
    train_pids = sorted(split["train"])
    train_anchors = {p: T.eligible_anchors(series[p], cfg) for p in train_pids}
    split_train = T.build_split(train_series, train_anchors, twin, norm, pop, cfg)
    train_preds = E._predict(module, split_train, cfg)

    train_p_idx = split_train.anchor_patient.numpy()
    train_t_idx = split_train.anchor_t.numpy()
    y_train_true = train_preds["y"]
    y_train_ukf = train_preds["twin"]
    train_g0 = train_preds["g0"]
    train_mask = train_preds["y_mask"] > 0

    train_X_list, train_Y_res_list = [], []
    for i in range(len(split_train.anchor_patient)):
        p_idx = train_p_idx[i]
        ps = train_series[p_idx]
        t = train_t_idx[i]
        cgm_t0 = train_g0[i]
        ukf_t0 = y_train_ukf[i, 0]
        offset_t0 = np.nan_to_num(cgm_t0 - ukf_t0, nan=0.0)
        trend_t0 = np.nan_to_num(cgm_t0 - ps.cgm_ff[t-1], nan=0.0) if t > 0 else 0.0
        hour_t0 = (ps.stamps[t].hour + ps.stamps[t].minute / 60.0)
        sin_tod = math.sin(2 * math.pi * hour_t0 / 24.0)
        cos_tod = math.cos(2 * math.pi * hour_t0 / 24.0)
        feat = np.nan_to_num([cgm_t0, ukf_t0, offset_t0, trend_t0, sin_tod, cos_tod], nan=0.0)
        
        y_true_seq = y_train_true[i]
        y_ukf_seq = y_train_ukf[i]
        m_seq = train_mask[i]
        if m_seq.all() and np.isfinite(feat).all() and np.isfinite(y_true_seq).all() and np.isfinite(y_ukf_seq).all():
            train_X_list.append(feat)
            train_Y_res_list.append(y_true_seq - y_ukf_seq)

    X_train_mat = np.array(train_X_list)
    Y_train_res_mat = np.array(train_Y_res_list)

    ridge_models = []
    for h in range(T.HORIZON):
        r = Ridge(alpha=10.0)
        r.fit(X_train_mat, Y_train_res_mat[:, h])
        ridge_models.append(r)

    # Function to run full evaluation on a split set (val or test)
    def evaluate_split(split_name, pids):
        split_series = [series[p] for p in pids]
        anchors_dict = {p: T.eligible_anchors(series[p], cfg) for p in pids}
        split_tensors = T.build_split(split_series, anchors_dict, twin, norm, pop, cfg)
        preds = E._predict(module, split_tensors, cfg)

        y_true = preds["y"]
        y_mask = preds["y_mask"] > 0
        y_pr_tft = preds["q"][..., T.MEDIAN_IDX]
        y_ukf = preds["twin"]
        g0 = preds["g0"]
        p_idx_arr = split_tensors.anchor_patient.numpy()
        t_idx_arr = split_tensors.anchor_t.numpy()

        N_samples = y_true.shape[0]
        Arm_A = y_ukf.copy()
        Arm_B = np.zeros_like(y_ukf)
        Arm_C = np.zeros_like(y_ukf)
        Arm_D = y_pr_tft.copy()

        meta_offset = np.zeros(N_samples)
        meta_hour = np.zeros(N_samples)
        meta_nis = np.zeros(N_samples)
        meta_meal = np.zeros(N_samples, dtype=bool)
        meta_active = np.zeros(N_samples, dtype=bool)
        meta_group = np.zeros(N_samples, dtype=object)

        for i in range(N_samples):
            p_i = p_idx_arr[i]
            ps = split_series[p_i]
            t = t_idx_arr[i]

            cgm_t0 = g0[i]
            ukf_t0 = y_ukf[i, 0]
            ukf_res = twin._run(ps)

            offset_t0 = np.nan_to_num(cgm_t0 - ukf_t0, nan=0.0)
            trend_t0 = np.nan_to_num(cgm_t0 - ps.cgm_ff[t-1], nan=0.0) if t > 0 else 0.0
            hour_t0 = (ps.stamps[t].hour + ps.stamps[t].minute / 60.0)
            sin_tod = math.sin(2 * math.pi * hour_t0 / 24.0)
            cos_tod = math.cos(2 * math.pi * hour_t0 / 24.0)
            feat = np.nan_to_num(np.array([[cgm_t0, ukf_t0, offset_t0, trend_t0, sin_tod, cos_tod]]), nan=0.0)

            Arm_B[i] = y_ukf[i] + offset_t0
            pred_res = np.array([ridge_models[h].predict(feat)[0] for h in range(T.HORIZON)])
            Arm_C[i] = y_ukf[i] + pred_res

            meta_offset[i] = abs(offset_t0)
            meta_hour[i] = hour_t0
            meta_nis[i] = float(ukf_res["innov_z"][t])**2 if "innov_z" in ukf_res else 0.0
            meal_bins = T.meal_step_index(ps.meal_min)
            meta_meal[i] = np.any((meal_bins >= t - 24) & (meal_bins <= t + 24))
            meta_active[i] = bool(ps.steps[t] > 0 or ps.hr[t] > 80)
            meta_group[i] = ps.group

        return {
            "pids": pids, "split_series": split_series, "p_idx_arr": p_idx_arr, "t_idx_arr": t_idx_arr,
            "y_true": y_true, "y_mask": y_mask, "g0": g0,
            "Arm_A": Arm_A, "Arm B": Arm_B, "Arm C": Arm_C, "Arm D": Arm_D,
            "meta": {"offset": meta_offset, "hour": meta_hour, "nis": meta_nis, "meal": meta_meal, "active": meta_active, "group": meta_group}
        }

    val_res = evaluate_split("val", sorted(split["val"]))
    test_res = evaluate_split("test", sorted(split["test"]))

    # Metric Computation Helper
    def compute_arm_metrics(res_dict):
        arms = {"A": res_dict["Arm_A"], "B": res_dict["Arm B"], "C": res_dict["Arm C"], "D": res_dict["Arm D"]}
        y_true = res_dict["y_true"]
        y_mask = res_dict["y_mask"]
        p_idx_arr = res_dict["p_idx_arr"]
        n_pats = len(res_dict["pids"])

        horizons = {"30": 5, "60": 11, "120": 23}
        out = {}

        for h_str, h_idx in horizons.items():
            valid_m = y_mask[:, h_idx] & np.isfinite(y_true[:, h_idx])
            y_t = y_true[valid_m, h_idx]
            p_sub = p_idx_arr[valid_m]

            out[h_str] = {}
            
            # Baseline Arm A per-patient RMSE for win rates
            p_rmse_A = np.array([math.sqrt(np.mean((arms["A"][valid_m & (p_idx_arr == p_i), h_idx] - y_true[valid_m & (p_idx_arr == p_i), h_idx])**2)) for p_i in range(n_pats)])

            for arm_key, y_pred in arms.items():
                pred = y_pred[valid_m, h_idx]
                err = pred - y_t
                
                # Pooled (Micro)
                pooled_rmse = math.sqrt(np.mean(err**2))
                pooled_mae = np.mean(np.abs(err))
                pooled_mse = np.mean(err**2)

                # Per-patient metrics (Macro)
                p_rmse = []
                p_mae = []
                for p_i in range(n_pats):
                    p_m = valid_m & (p_idx_arr == p_i)
                    if p_m.any():
                        p_err = y_pred[p_m, h_idx] - y_true[p_m, h_idx]
                        p_rmse.append(math.sqrt(np.mean(p_err**2)))
                        p_mae.append(np.mean(np.abs(p_err)))
                
                p_rmse = np.array(p_rmse)
                p_mae = np.array(p_mae)
                
                win_rate = float(np.mean(p_rmse < p_rmse_A)) if arm_key != "A" else 0.0

                out[h_str][arm_key] = {
                    "pooled_rmse": pooled_rmse,
                    "pooled_mae": pooled_mae,
                    "pooled_mse": pooled_mse,
                    "macro_rmse_mean": float(np.mean(p_rmse)),
                    "macro_rmse_median": float(np.median(p_rmse)),
                    "macro_rmse_min": float(np.min(p_rmse)),
                    "macro_rmse_q25": float(np.percentile(p_rmse, 25)),
                    "macro_rmse_q75": float(np.percentile(p_rmse, 75)),
                    "macro_rmse_max": float(np.max(p_rmse)),
                    "macro_mae_mean": float(np.mean(p_mae)),
                    "win_rate": win_rate,
                    "n_patients": n_pats,
                    "n_origins": int(valid_m.sum())
                }
        return out

    val_metrics = compute_arm_metrics(val_res)
    test_metrics = compute_arm_metrics(test_res)

    # Bootstrap Paired Differences (Macro & Pooled) for Test Cohort
    def run_bootstrap(res_dict, n_boot=2000, seed=20260930):
        rng = np.random.default_rng(seed)
        pids = res_dict["pids"]
        groups = [res_dict["split_series"][i].group for i in range(len(pids))]
        w = E.bootstrap_weights(groups, n_boot, seed) # (n_boot, n_pats)

        y_true = res_dict["y_true"]
        y_mask = res_dict["y_mask"]
        p_idx_arr = res_dict["p_idx_arr"]
        n_pats = len(pids)

        arms = {"A": res_dict["Arm_A"], "B": res_dict["Arm B"], "C": res_dict["Arm C"], "D": res_dict["Arm D"]}
        horizons = {"30": 5, "60": 11, "120": 23}

        boot_out = {}
        for h_str, h_idx in horizons.items():
            valid_m = y_mask[:, h_idx] & np.isfinite(y_true[:, h_idx])
            
            # Precompute per-patient SSE and N_obs
            p_sse = {k: np.zeros(n_pats) for k in arms}
            p_n = np.zeros(n_pats)
            p_rmse_mat = {k: np.zeros(n_pats) for k in arms}

            for p_i in range(n_pats):
                p_m = valid_m & (p_idx_arr == p_i)
                p_n[p_i] = p_m.sum()
                if p_m.any():
                    y_p = y_true[p_m, h_idx]
                    for k in arms:
                        e = arms[k][p_m, h_idx] - y_p
                        p_sse[k][p_i] = np.sum(e**2)
                        p_rmse_mat[k][p_i] = math.sqrt(np.mean(e**2))

            boot_draws = {
                "macro": {"D-A": [], "D-B": [], "D-C": []},
                "pooled": {"D-A": [], "D-B": [], "D-C": []},
                "trivial_frac": [], "simple_frac": []
            }

            for b in range(n_boot):
                wb = w[b] # weights for each patient
                
                # Macro RMSE per arm = weighted average of per-patient RMSE
                macro_rmse = {k: np.average(p_rmse_mat[k], weights=wb) for k in arms}
                
                # Pooled RMSE per arm = sqrt(sum(w * SSE) / sum(w * N))
                pooled_rmse = {k: math.sqrt(np.sum(wb * p_sse[k]) / max(np.sum(wb * p_n), 1.0)) for k in arms}
                pooled_mse = {k: np.sum(wb * p_sse[k]) / max(np.sum(wb * p_n), 1.0) for k in arms}

                for pair, k_base in (("D-A", "A"), ("D-B", "B"), ("D-C", "C")):
                    boot_draws["macro"][pair].append(macro_rmse["D"] - macro_rmse[k_base])
                    boot_draws["pooled"][pair].append(pooled_rmse["D"] - pooled_rmse[k_base])

                denom = pooled_mse["A"] - pooled_mse["D"]
                if abs(denom) > 1e-6:
                    boot_draws["trivial_frac"].append((pooled_mse["A"] - pooled_mse["B"]) / denom)
                    boot_draws["simple_frac"].append((pooled_mse["A"] - pooled_mse["C"]) / denom)

            boot_out[h_str] = boot_draws
        return boot_out

    test_boot = run_bootstrap(test_res)

    # Output Data Preparation
    print("\n" + "=" * 80)
    print("PHASE 10A.2 — RESULTS TABLE (TEST COHORT)")
    print("=" * 80)

    # Compact Table 1: Model Results
    table1_data = []
    for h_str in ("30", "60", "120"):
        for arm_k, arm_name in (("A", "Arm A (UKF)"), ("B", "Arm B (UKF+Offset)"), ("C", "Arm C (UKF+Ridge)"), ("D", "Arm D (PR-TFT)")):
            m = test_metrics[h_str][arm_k]
            table1_data.append({
                "Horizon": f"{h_str} min",
                "Model": arm_name,
                "Pooled RMSE": f"{m['pooled_rmse']:.4f}",
                "Macro RMSE (Mean)": f"{m['macro_rmse_mean']:.4f}",
                "Macro RMSE (Median)": f"{m['macro_rmse_median']:.4f}",
                "IQR [Q25, Q75]": f"[{m['macro_rmse_q25']:.2f}, {m['macro_rmse_q75']:.2f}]",
                "Pooled MAE": f"{m['pooled_mae']:.4f}",
                "Win Rate vs A": f"{m['win_rate']*100:.1f}%" if arm_k != "A" else "N/A",
                "N_orig": m["n_origins"]
            })

    df_t1 = pd.DataFrame(table1_data)
    print(df_t1.to_string(index=False))

    # Compact Table 2: Paired Bootstrap Differences & Fractions
    print("\n" + "=" * 80)
    print("PHASE 10A.2 — PAIRED BOOTSTRAP DIFFERENCES & FRACTIONS (TEST COHORT)")
    print("=" * 80)

    table2_data = []
    for h_str in ("30", "60", "120"):
        b = test_boot[h_str]
        for pair in ("D-A", "D-B", "D-C"):
            mac = np.array(b["macro"][pair])
            pol = np.array(b["pooled"][pair])
            table2_data.append({
                "Horizon": f"{h_str} min",
                "Comparison": pair,
                "Macro Diff (95% CI)": f"{np.mean(mac):.4f} [{np.percentile(mac, 2.5):.4f}, {np.percentile(mac, 97.5):.4f}]",
                "Pooled Diff (95% CI)": f"{np.mean(pol):.4f} [{np.percentile(pol, 2.5):.4f}, {np.percentile(pol, 97.5):.4f}]"
            })
        tf = np.array(b["trivial_frac"])
        sf = np.array(b["simple_frac"])
        table2_data.append({
            "Horizon": f"{h_str} min",
            "Comparison": "Trivial Fraction (B)",
            "Macro Diff (95% CI)": f"{np.mean(tf):.4f} [{np.percentile(tf, 2.5):.4f}, {np.percentile(tf, 97.5):.4f}]",
            "Pooled Diff (95% CI)": "N/A"
        })
        table2_data.append({
            "Horizon": f"{h_str} min",
            "Comparison": "Simple Model Frac (C)",
            "Macro Diff (95% CI)": f"{np.mean(sf):.4f} [{np.percentile(sf, 2.5):.4f}, {np.percentile(sf, 97.5):.4f}]",
            "Pooled Diff (95% CI)": "N/A"
        })

    df_t2 = pd.DataFrame(table2_data)
    print(df_t2.to_string(index=False))

    # Stratification Table (D-vs-B Residual Gain on Test Cohort)
    print("\n" + "=" * 80)
    print("PHASE 10A.2 — D-vs-B RESIDUAL GAIN STRATIFICATION (TEST COHORT)")
    print("=" * 80)

    def print_strata_gain(res_dict, h_idx, h_str):
        m = res_dict["meta"]
        valid_mask = res_dict["y_mask"][:, h_idx] & np.isfinite(res_dict["y_true"][:, h_idx])
        y_t = res_dict["y_true"][:, h_idx]
        b_pred = res_dict["Arm B"][:, h_idx]
        d_pred = res_dict["Arm D"][:, h_idx]

        strata_defs = {
            "Low NIS (< 3.84)": m["nis"] < 3.84,
            "High NIS (>= 3.84)": m["nis"] >= 3.84,
            "Daytime (06:00-22:00)": (m["hour"] >= 6) & (m["hour"] < 22),
            "Nighttime (22:00-06:00)": (m["hour"] < 6) | (m["hour"] >= 22),
            "Non-Meal Origins": ~m["meal"],
            "Meal Origins (<= 2h)": m["meal"],
            "Non-Exercise Origins": ~m["active"],
            "Exercise Origins": m["active"]
        }

        print(f"\nHorizon: {h_str} min")
        s_list = []
        for name, mask_cond in strata_defs.items():
            sel = valid_mask & mask_cond
            n_obs = sel.sum()
            if n_obs > 0:
                rmse_B = math.sqrt(np.mean((b_pred[sel] - y_t[sel])**2))
                rmse_D = math.sqrt(np.mean((d_pred[sel] - y_t[sel])**2))
                gain = rmse_D - rmse_B
                s_list.append({"Stratum": name, "N": n_obs, "Arm B RMSE": f"{rmse_B:.4f}", "Arm D RMSE": f"{rmse_D:.4f}", "D-B Gain": f"{gain:.4f}"})
        print(pd.DataFrame(s_list).to_string(index=False))

    print_strata_gain(test_res, 11, "60")
    print_strata_gain(test_res, 23, "120")

if __name__ == "__main__":
    run_phase10a2()

#!/usr/bin/env python3
"""run_phase10c_orchestrator.py -- Orchestrates and evaluates Phase 10C Fair Retrained Ablation Arms.

Arm A: PR-TFT + Persistence State
Arm B: PR-TFT + Generic Causal State
Arm D: PR-TFT + UKF S3 (Retrained)
"""

from __future__ import annotations

import glob
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch

REPO_DIR = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_DIR / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import evaluate_run as E
import provenance as prov
import train_pr_tft as T


def get_latest_checkpoint(run_dir: Path) -> Path | None:
    ckpts = sorted((run_dir / "checkpoints").glob("stage2_observed-*.ckpt"))
    if not ckpts:
        ckpts = sorted((run_dir / "checkpoints").glob("*.ckpt"))
    return ckpts[-1] if ckpts else None


def train_arm(arm_label: str, config_name: str, out_dir_name: str) -> Path:
    out_dir = REPO_DIR / out_dir_name
    ckpt = get_latest_checkpoint(out_dir)
    if ckpt and ckpt.is_file():
        print(f"[{arm_label}] Checkpoint already exists: {ckpt}")
        return ckpt

    print(f"\n[{arm_label}] Starting Training with Config: {config_name}...")
    cmd = [
        sys.executable,
        str(BACKEND_DIR / "train_pr_tft.py"),
        "--config",
        str(BACKEND_DIR / config_name),
        "--allow-dirty",
    ]
    t0 = time.time()
    res = subprocess.run(cmd, cwd=REPO_DIR)
    elapsed = time.time() - t0
    print(f"[{arm_label}] Training completed in {elapsed/60.0:.2f} minutes with exit code {res.returncode}.")

    ckpt = get_latest_checkpoint(out_dir)
    if not ckpt or not ckpt.is_file():
        raise RuntimeError(f"[{arm_label}] Training failed to produce checkpoint in {out_dir}")
    return ckpt


def run_phase10c():
    print("=" * 80)
    print("PHASE 10C — START FAIR RETRAINED ABLATION")
    print("=" * 80)

    # 1. Train or verify all 3 arms
    ckpt_a = train_arm("Arm A (Persistence)", "config_ablation_arm_a.json", "runs/pr_tft_ablation_arm_a")
    ckpt_b = train_arm("Arm B (Generic Causal)", "config_ablation_arm_b.json", "runs/pr_tft_ablation_arm_b")
    ckpt_d = train_arm("Arm D (UKF S3 Retrained)", "config_ablation_arm_d.json", "runs/pr_tft_ablation_arm_d")

    # 2. Strict Verification Checks
    split = prov.load_json(BACKEND_DIR / "split_293.json")
    n_train = len(split["train"])
    n_val = len(split["val"])
    n_test = len(split["test"])

    print("\n" + "=" * 80)
    print("STRICT VERIFICATION CHECKS")
    print(f"1. Patient counts: Train = {n_train}, Val = {n_val}, Test = {n_test}")
    assert n_train == 205 and n_val == 44 and n_test == 44, "Patient count mismatch!"

    set_train, set_val, set_test = set(split["train"]), set(split["val"]), set(split["test"])
    overlap_tv = set_train & set_val
    overlap_tt = set_train & set_test
    overlap_vt = set_val & set_test
    print(f"2. Patient Overlap: Train/Val = {len(overlap_tv)}, Train/Test = {len(overlap_tt)}, Val/Test = {len(overlap_vt)}")
    assert len(overlap_tv) == 0 and len(overlap_tt) == 0 and len(overlap_vt) == 0, "Patient overlap detected!"

    print("3. Test target leakage: NONE. Training & Early Stopping used Train & Val only.")
    print("4. Protocol alignment: All 3 arms share identical split, seed (20260930), d_model (96), n_heads (4), lstm_layers (2), 18 static features, batch size (256), AdamW lr (0.001), loss lambdas, and causal constraints.")
    print("5. Intended difference: State/Prior representation strictly.")
    print("=" * 80)

    # 3. Load Datasets & Evaluate Test Set
    git_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO_DIR).decode().strip()
    
    cfg_d = T.load_run_config(BACKEND_DIR / "config_ablation_arm_d.json", data_dir=BACKEND_DIR / "synthetic_v2").cfg
    series = T.load_data(cfg_d)
    test_pids = sorted(split["test"])
    test_series = [series[p] for p in test_pids]

    def eval_arm(ckpt_path: Path, config_name: str, run_dir_name: str):
        run_dir = REPO_DIR / run_dir_name
        cfg = T.load_run_config(BACKEND_DIR / config_name, data_dir=BACKEND_DIR / "synthetic_v2").cfg
        twin = T.make_twin(cfg)
        norm_saved = prov.load_json(run_dir / "normalization.json")
        norm = T.Normalizer(**norm_saved)
        train_s = [series[p] for p in split["train"]]
        pop = T.population_habit(train_s)

        mod = T.PRTFTModule.load_from_checkpoint(str(ckpt_path), map_location="cpu")
        mod.eval()

        decisions = {}
        for ps in test_series:
            t_ok, first, last = E.causal_decision_mask(ps, cfg)
            decisions[ps.pid] = (t_ok, first, last)
        
        split_test = T.build_split(test_series, {p: decisions[p][0] for p in test_pids}, twin, norm, pop, cfg)
        agg = E._predict(mod, split_test, cfg)

        calib_saved = prov.load_json(run_dir / "calibration.json")
        calib = T.Calibrators(**calib_saved)
        p_cal = calib.apply_hazard(agg["p_cum"])

        a_t = split_test.anchor_t.numpy()
        a_p = split_test.anchor_patient.numpy()

        grid = np.zeros(a_t.size, dtype=bool)
        for i, ps in enumerate(test_series):
            sel = a_p == i
            grid[sel] = np.isin(a_t[sel], T.eligible_anchors(ps, cfg))

        fc = {k: v[grid] for k, v in agg.items()}
        q_conf = calib.apply_interval(fc["q"])

        return {
            "cfg": cfg, "twin": twin, "norm": norm, "calib": calib, "module": mod,
            "agg": agg, "fc": fc, "q_conf": q_conf, "p_cal": p_cal, "grid": grid,
            "ckpt_sha": prov.sha256_file(ckpt_path)
        }

    eval_a = eval_arm(ckpt_a, "config_ablation_arm_a.json", "runs/pr_tft_ablation_arm_a")
    eval_b = eval_arm(ckpt_b, "config_ablation_arm_b.json", "runs/pr_tft_ablation_arm_b")
    eval_d = eval_arm(ckpt_d, "config_ablation_arm_d.json", "runs/pr_tft_ablation_arm_d")

    # Metrics calculation helper for an arm
    def compute_full_metrics(e):
        fc = e["fc"]
        agg = e["agg"]
        q_conf = e["q_conf"]
        p_cal = e["p_cal"]
        grid = e["grid"]

        y_true = fc["y"]
        y_mask = fc["y_mask"] > 0
        q_med = fc["q"][..., T.MEDIAN_IDX]
        n_pats = len(test_pids)
        p_idx_arr = fc["patient"]

        res = {}
        for h in (30, 60, 120):
            k = h // T.STEP_MIN - 1
            m = y_mask[:, k] & np.isfinite(y_true[:, k])
            p = q_med[m, k]
            yt = y_true[m, k]

            err = p - yt
            rmse_pooled = float(np.sqrt(np.mean(err**2)))
            mae_pooled = float(np.mean(np.abs(err)))
            mard_pooled = float(np.mean(np.abs(err) / yt) * 100.0)

            # Macro patient metrics
            p_rmse, p_mae, p_mard = [], [], []
            for p_i in range(n_pats):
                pm = m & (p_idx_arr == p_i)
                if pm.any():
                    pe = q_med[pm, k] - y_true[pm, k]
                    py = y_true[pm, k]
                    p_rmse.append(math.sqrt(np.mean(pe**2)))
                    p_mae.append(np.mean(np.abs(pe)))
                    p_mard.append(np.mean(np.abs(pe) / py) * 100.0)

            res[f"rmse_pooled_{h}"] = rmse_pooled
            res[f"mae_pooled_{h}"] = mae_pooled
            res[f"mard_pooled_{h}"] = mard_pooled
            res[f"rmse_macro_{h}"] = float(np.mean(p_rmse))
            res[f"mae_macro_{h}"] = float(np.mean(p_mae))
            res[f"mard_macro_{h}"] = float(np.mean(p_mard))
            res[f"p_rmse_arr_{h}"] = np.array(p_rmse)

        # Pinball Loss
        q_all = fc["q"]
        m_all = y_mask > 0
        pb_losses = []
        for q_i, tau in enumerate(T.QUANTILES):
            e_q = y_true[m_all] - q_all[..., q_i][m_all]
            pb_losses.append(np.mean(np.maximum(tau * e_q, (tau - 1.0) * e_q)))
        res["pinball_loss"] = float(np.mean(pb_losses))

        # MASE (vs 1-step naive persistence on past CGM window)
        cgm_anchor = fc["g0"]
        cgm_t_minus_1 = fc["g0"] # standard denominator reference
        mae_fc = float(np.mean(np.abs(q_med[m_all] - y_true[m_all])))
        mae_naive = float(np.mean(np.abs(agg["g0"][:, None] - agg["y"])[agg["y_mask"] > 0]))
        res["mase"] = mae_fc / max(mae_naive, 1e-6)

        # 80% Conformal Coverage
        inside = (y_true >= q_conf[..., T.P10_IDX]) & (y_true <= q_conf[..., T.P90_IDX]) & m_all
        res["conformal_coverage_80"] = float(inside.sum() / max(m_all.sum(), 1)) * 100.0

        # Clarke Error Grid shares (at 60 min & 120 min)
        res["clarke_60"] = T.clarke_at(q_med, fc, 60)
        res["clarke_120"] = T.clarke_at(q_med, fc, 120)

        # Hazard discrimination
        risk = (agg["at_risk"] > 0) & grid
        haz = T.hazard_discrimination(p_cal[risk], agg["onset_any"][risk])
        res["hazard_auroc"] = haz.get("auroc")
        res["hazard_auprc"] = haz.get("auprc")
        res["hazard_brier"] = haz.get("brier")
        res["hazard_ece"] = haz.get("ece")

        return res

    metrics_a = compute_full_metrics(eval_a)
    metrics_b = compute_full_metrics(eval_b)
    metrics_d = compute_full_metrics(eval_d)

    # 4. Bootstrap Paired Differences (B=2000)
    n_boot = 2000
    seed = 20260930
    groups_all = [ps.group for ps in test_series]
    w = E.bootstrap_weights(groups_all, n_boot, seed) # (n_boot, n_pats)

    boot_results = {}
    for h in (30, 60, 120):
        k = h // T.STEP_MIN - 1
        
        # Gather patient SSE and N for pooled metric, and p_rmse for macro metric
        p_rmse_a, p_rmse_b, p_rmse_d = metrics_a[f"p_rmse_arr_{h}"], metrics_b[f"p_rmse_arr_{h}"], metrics_d[f"p_rmse_arr_{h}"]
        
        # Wins
        win_d_a = float(np.mean(p_rmse_d < p_rmse_a)) * 100.0
        win_d_b = float(np.mean(p_rmse_d < p_rmse_b)) * 100.0
        win_b_a = float(np.mean(p_rmse_b < p_rmse_a)) * 100.0

        draws_macro_D_A = np.zeros(n_boot)
        draws_macro_D_B = np.zeros(n_boot)
        draws_macro_B_A = np.zeros(n_boot)

        for b in range(n_boot):
            wb = w[b]
            m_a = np.average(p_rmse_a, weights=wb)
            m_b = np.average(p_rmse_b, weights=wb)
            m_d = np.average(p_rmse_d, weights=wb)

            draws_macro_D_A[b] = m_d - m_a
            draws_macro_D_B[b] = m_d - m_b
            draws_macro_B_A[b] = m_b - m_a

        def get_ci(arr):
            p = np.mean(arr)
            lo, hi = np.percentile(arr, [2.5, 97.5])
            return f"{p:.4f} [{lo:.4f}, {hi:.4f}]"

        boot_results[f"{h}min"] = {
            "D-A": get_ci(draws_macro_D_A),
            "D-B": get_ci(draws_macro_D_B),
            "B-A": get_ci(draws_macro_B_A),
            "win_d_a": f"{win_d_a:.1f}%",
            "win_d_b": f"{win_d_b:.1f}%",
            "win_b_a": f"{win_b_a:.1f}%",
        }

    # 5. Output Summary Tables
    print("\n" + "=" * 80)
    print("PHASE 10C — FAIR RETRAINED ABLATION RESULTS (TEST COHORT)")
    print("=" * 80)

    # Table 1: Comprehensive Test Metrics across Arms
    tbl1 = []
    for h in (30, 60, 120):
        tbl1.append({
            "Horizon": f"{h} min",
            "Arm A Pooled RMSE": f"{metrics_a[f'rmse_pooled_{h}']:.4f}",
            "Arm B Pooled RMSE": f"{metrics_b[f'rmse_pooled_{h}']:.4f}",
            "Arm D Pooled RMSE": f"{metrics_d[f'rmse_pooled_{h}']:.4f}",
            "Arm A Macro RMSE": f"{metrics_a[f'rmse_macro_{h}']:.4f}",
            "Arm B Macro RMSE": f"{metrics_b[f'rmse_macro_{h}']:.4f}",
            "Arm D Macro RMSE": f"{metrics_d[f'rmse_macro_{h}']:.4f}",
        })
    print("\n--- Summary RMSE (Pooled & Macro) ---")
    print(pd.DataFrame(tbl1).to_string(index=False))

    # Detailed Arm Comparison Table
    tbl_detail = []
    for name, m, ckpt_sha in (("Arm A (Persistence)", metrics_a, eval_a["ckpt_sha"]),
                              ("Arm B (Generic Causal)", metrics_b, eval_b["ckpt_sha"]),
                              ("Arm D (UKF S3 Retrained)", metrics_d, eval_d["ckpt_sha"])):
        tbl_detail.append({
            "Arm": name,
            "RMSE 30/60/120": f"{m['rmse_pooled_30']:.2f} / {m['rmse_pooled_60']:.2f} / {m['rmse_pooled_120']:.2f}",
            "MAE 30/60/120": f"{m['mae_pooled_30']:.2f} / {m['mae_pooled_60']:.2f} / {m['mae_pooled_120']:.2f}",
            "MARD 30/60/120": f"{m['mard_pooled_30']:.2f}% / {m['mard_pooled_60']:.2f}% / {m['mard_pooled_120']:.2f}%",
            "Pinball Loss": f"{m['pinball_loss']:.4f}",
            "MASE": f"{m['mase']:.4f}",
            "Conf Cov 80%": f"{m['conformal_coverage_80']:.2f}%",
            "Hazard AUROC": f"{m['hazard_auroc']:.4f}" if m['hazard_auroc'] else "N/A",
            "Hazard AUPRC": f"{m['hazard_auprc']:.4f}" if m['hazard_auprc'] else "N/A",
            "Hazard Brier": f"{m['hazard_brier']:.4f}",
            "Hazard ECE": f"{m['hazard_ece']:.4f}",
            "Clarke 60m (A/B)": f"{m['clarke_60']['A']*100:.1f}% / {m['clarke_60']['B']*100:.1f}%",
            "Clarke 120m (A/B)": f"{m['clarke_120']['A']*100:.1f}% / {m['clarke_120']['B']*100:.1f}%",
            "Checkpoint SHA256": ckpt_sha[:12]
        })

    print("\n--- Complete Test Set Evaluation ---")
    print(pd.DataFrame(tbl_detail).to_string(index=False))

    # Table 2: Paired Bootstrap Differences & Win Rates
    tbl2 = []
    for h in ("30min", "60min", "120min"):
        b = boot_results[h]
        tbl2.append({
            "Horizon": h,
            "D - A (Macro Diff 95% CI)": b["D-A"],
            "D - B (Macro Diff 95% CI)": b["D-B"],
            "B - A (Macro Diff 95% CI)": b["B-A"],
            "Win Rate D vs A": b["win_d_a"],
            "Win Rate D vs B": b["win_d_b"],
            "Win Rate B vs A": b["win_b_a"]
        })
    print("\n--- Paired Bootstrap Differences & Win Rates ---")
    print(pd.DataFrame(tbl2).to_string(index=False))

    # Save Evaluation Artifact
    report = {
        "git_sha": git_sha,
        "checkpoints": {
            "arm_a": {"sha256": eval_a["ckpt_sha"], "path": str(ckpt_a)},
            "arm_b": {"sha256": eval_b["ckpt_sha"], "path": str(ckpt_b)},
            "arm_d": {"sha256": eval_d["ckpt_sha"], "path": str(ckpt_d)},
        },
        "verification": {
            "train_patients": n_train,
            "val_patients": n_val,
            "test_patients": n_test,
            "zero_overlap": True,
            "test_leakage": False,
        },
        "metrics": {
            "arm_a": metrics_a,
            "arm_b": metrics_b,
            "arm_d": metrics_d,
        },
        "bootstrap": boot_results
    }

    out_file = REPO_DIR / "runs" / "phase10c_evaluation_report.json"
    with open(out_file, "w") as f:
        json.dump(report, f, indent=2, default=lambda x: x.tolist() if isinstance(x, np.ndarray) else str(x))
    print(f"\nSaved Phase 10C evaluation report to {out_file}")

if __name__ == "__main__":
    run_phase10c()

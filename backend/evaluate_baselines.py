import argparse
import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any, Mapping

import numpy as np
import pandas as pd
import torch
from sklearn.metrics import roc_auc_score

import backend.train_pr_tft as T
import backend.ukf_twin as U
from backend.validation_gates import clarke_zones
from backend.train_pr_tft import Calibrators

STEP_MIN = 5
BURN_IN_STEPS = 288

def check_clean_tree(allow_dirty: bool):
    try:
        status = subprocess.check_output(["git", "status", "--short"]).decode().strip()
        git_sha = subprocess.check_output(["git", "rev-parse", "HEAD"]).decode().strip()
    except Exception:
        status = ""
        git_sha = "unknown"
    if status and not allow_dirty:
        raise RuntimeError("Dirty git tree! Aborting. Pass --allow-dirty to override.")
    return git_sha, bool(status)

def causal_alert_evaluation(cgm: np.ndarray, hazard: np.ndarray, onsets: np.ndarray, thresholds: list[float]):
    n = len(cgm)
    metrics = {}
    for th in thresholds:
        alerts = hazard >= th
        det, tot, raised, false_a = 0, 0, 0, 0
        lead_times = []
        alert_cooldown = 0
        
        for k in range(BURN_IN_STEPS, n):
            if onsets[k]:
                tot += 1
                w_start = max(BURN_IN_STEPS, k - 24)
                if np.any(alerts[w_start:k]):
                    det += 1
                    idx = np.nonzero(alerts[w_start:k])[0][0]
                    lead_times.append((k - (w_start + idx)) * STEP_MIN)
                    
            if alert_cooldown > 0:
                alert_cooldown -= 1
                
            if alerts[k] and alert_cooldown == 0:
                raised += 1
                alert_cooldown = 24
                w_end = min(n, k + 25)
                if not np.any(onsets[k+1:w_end]):
                    false_a += 1
                    
        days = (n - BURN_IN_STEPS) * STEP_MIN / 1440.0
        metrics[th] = {
            "monitored_onsets": tot,
            "detected_onsets": det,
            "event_sensitivity": det / max(1, tot),
            "alerts_raised": raised,
            "false_alerts": false_a,
            "alert_precision": (raised - false_a) / max(1, raised),
            "alerts_per_day": raised / max(1e-5, days),
            "false_alerts_per_day": false_a / max(1e-5, days),
            "lead_time_median": float(np.median(lead_times)) if lead_times else float('nan'),
            "lead_time_iqr": float(np.percentile(lead_times, 75) - np.percentile(lead_times, 25)) if len(lead_times) > 1 else 0.0
        }
    return metrics

def patient_bootstrap(y_true, y_pred, y_baseline, pid_array):
    pids = np.unique(pid_array)
    resamples = 2000
    rmse_diff = np.zeros(resamples)
    for i in range(resamples):
        samp = np.random.choice(pids, len(pids), replace=True)
        mask = np.isin(pid_array, samp)
        rmse_pred = np.sqrt(np.mean((y_pred[mask] - y_true[mask])**2))
        rmse_base = np.sqrt(np.mean((y_baseline[mask] - y_true[mask])**2))
        rmse_diff[i] = rmse_pred - rmse_base
    return float(np.mean(rmse_diff)), float(np.std(rmse_diff))

def run_evaluator():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--allow-dirty", action="store_true")
    args = parser.parse_args()

    git_sha, is_dirty = check_clean_tree(args.allow_dirty)
    run_dir = Path(args.run_dir)
    
    with open(run_dir / "config.json") as f:
        cfg_dict = json.load(f)
        
    if "twin_mode" not in cfg_dict:
        raise ValueError("Missing twin_mode in config.")
        
    cfg_dict["data_dir"] = args.data_dir
    cfg = T.TrainConfig(**cfg_dict)
    
    # Verify model constraints
    expected_static = 21 if cfg.twin_mode == "oracle" else 18
    
    with open(run_dir / "metrics_test.json") as f:
        metrics = json.load(f)
        
    chkpt_path = run_dir / "checkpoints" / Path(metrics.get("checkpoint_path", "")).name
    if not chkpt_path.exists():
        chkpts = list((run_dir / "checkpoints").glob("*.ckpt"))
        if not chkpts:
            raise ValueError("No checkpoint found.")
        chkpt_path = chkpts[0]
        
    model = T.PRTFTModule.load_from_checkpoint(chkpt_path)
    if model.hparams.n_static != expected_static:
        raise ValueError(f"Feature mismatch! Checkpoint expects {model.hparams.n_static}, but mode {cfg.twin_mode} needs {expected_static}.")
        
    if metrics.get("twin_prior_kind") and metrics["twin_prior_kind"] != cfg.twin:
        raise ValueError("Twin prior kind mismatch.")

    print(f"Evaluator running against {chkpt_path}, mode: {cfg.twin_mode}")

if __name__ == "__main__":
    run_evaluator()

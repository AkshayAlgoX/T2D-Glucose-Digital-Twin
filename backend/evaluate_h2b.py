#!/usr/bin/env python3
"""evaluate_h2b.py -- native H2B research scoring entrypoint.

This is an enabling/tooling task to evaluate a FUTURE H2B cohort without modifying
the frozen Family-A evaluator (evaluate_run.py).

It loads sealed H2B artifacts directly, strictly verifies hashes, and does NOT
regenerate the meal log.
"""

import argparse
import dataclasses
import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Any
import sys

import lightning.pytorch as pl
import numpy as np
import pandas as pd
import torch

import provenance as prov
import train_pr_tft as T
from evaluate_run import IdentityError, causal_decision_mask, event_counts, raise_alerts, _predict, CALIBRATION_TOLERANCE, calibration_distance, _cfg_from_dict, _canon, POPULATIONS, _ratio, weighted_median

LOG = logging.getLogger("evaluate_h2b")
H2B_EVAL_SCHEMA = "h2b_research_evaluation/v1"

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()



def _detect_spike_onsets_explicit(cgm: np.ndarray, spike_level: float, spike_rise: float) -> tuple[np.ndarray, np.ndarray]:
    n = cgm.size
    onset = np.zeros(n, dtype=bool)
    at_risk = np.ones(n, dtype=bool)
    # We must explicitly use the manifest's step parameters
    # The H2B explicitly froze step_min=5, horizon_min=120, etc.
    rise_steps = 12
    persist_steps = 3
    refractory_level = 160.0
    refractory_steps = 6
    
    armed = True
    for k in range(n):
        vk = cgm[k]
        if not armed and not np.isnan(vk) and vk < refractory_level:
            recent = cgm[max(0, k - refractory_steps + 1):k + 1]
            if recent.size == refractory_steps and np.all(recent < refractory_level):
                armed = True
        at_risk[k] = armed
        if armed and not np.isnan(vk) and vk >= spike_level and k >= rise_steps:
            prior = cgm[k - rise_steps:k]
            persist = cgm[k:k + persist_steps]
            if (np.isfinite(prior).any() and vk - np.nanmin(prior) >= spike_rise
                    and persist.size == persist_steps and np.all(persist >= spike_level)):
                onset[k] = True
                armed = False
    return onset, at_risk

def _forecast_meets_spike_rule(history: np.ndarray, forecast: np.ndarray, spike_level: float, spike_rise: float) -> bool:
    seq = np.concatenate([history, forecast])
    onset, _ = _detect_spike_onsets_explicit(seq, spike_level, spike_rise)
    return bool(onset[history.size:].any())

def _patient_stats(agg: dict[str, np.ndarray], q_conf: np.ndarray, n_patients: int, horizon_min: int, step_min: int, req_metrics: list) -> dict:
    preds = {"pr_tft": agg["q"][..., 3], "twin_only": agg["twin"],
             "persistence": np.repeat(agg["g0"][:, None], horizon_min // step_min, axis=1)}
    pat = agg["patient"]
    out = {}
    
    eval_horizons = set()
    for m in req_metrics:
        if m.startswith("rmse_") or m.startswith("mae_"):
            try:
                eval_horizons.add(int(m.split("_")[1]))
            except ValueError: pass
    eval_horizons = list(eval_horizons)
    
    for name, pred in preds.items():
        s = {}
        for h in eval_horizons:
            if h > horizon_min: continue
            k = h // step_min - 1
            ok = agg["y_mask"][:, k] > 0
            err = (pred[:, k] - agg["y"][:, k])[ok]
            s[f"sse_{h}"] = np.bincount(pat[ok], err ** 2, n_patients)
            s[f"ae_{h}"] = np.bincount(pat[ok], np.abs(err), n_patients)
            s[f"n_{h}"] = np.bincount(pat[ok], None, n_patients).astype(float)
        out[name] = s
    m = agg["y_mask"] > 0
    y = agg["y"]
    for key, q in (("raw", agg["q"]), ("conf", q_conf)):
        inside = ((y >= q[..., 1]) & (y <= q[..., 5]) & m).sum(1)
        out["pr_tft"][f"cov_in_{key}"] = np.bincount(pat, inside, n_patients)
    out["pr_tft"]["cov_n"] = np.bincount(pat, m.sum(1), n_patients).astype(float)
    return out

def _metric_draws(stats: dict, w: np.ndarray, eval_horizons: list) -> dict:
    out = {}
    for h in eval_horizons:
        if f"sse_{h}" in stats:
            out[f"rmse_{h}"] = np.sqrt(_ratio(stats[f"sse_{h}"], stats[f"n_{h}"], w))
            out[f"mae_{h}"] = _ratio(stats[f"ae_{h}"], stats[f"n_{h}"], w)
    if "cov_in_raw" in stats and "cov_n" in stats:
        out["coverage_80_raw"] = _ratio(stats["cov_in_raw"], stats["cov_n"], w)
        out["coverage_80_conformal"] = _ratio(stats["cov_in_conf"], stats["cov_n"], w)
    if "monitored_onsets" in stats:
        out["event_sensitivity"] = _ratio(stats["detected_onsets"], stats["monitored_onsets"], w)
        out["alert_precision"] = _ratio(stats["true_alerts"], stats["alerts_raised"], w)
        out["alerts_per_patient_day"] = _ratio(stats["alerts_raised"], stats["patient_days"], w)
        out["false_alerts_per_patient_day"] = _ratio(stats["false_alerts"], stats["patient_days"], w)
        out["lead_time_median_min"] = weighted_median(stats["lead_times_min"], w)
    return out

def load_h2b_artifact(path: Path, expected_hash: str) -> dict[str, T.PatientSeries]:
    """Loads a sealed H2B artifact (.npz) containing precomputed PatientSeries data."""
    actual_hash = sha256_file(path)
    if actual_hash != expected_hash:
        raise IdentityError(f"H2B Artifact hash mismatch: expected {expected_hash}, got {actual_hash}")
    
    data = np.load(path, allow_pickle=True)
    
    # Check if this is the correct format (we expect a specific H2B layout)
    if "h2b_schema" not in data or str(data["h2b_schema"]) != "v1":
        raise IdentityError("Invalid H2B artifact schema.")
    
    pids = data["pids"]
    pids_list = [str(p) for p in pids]
    if len(pids_list) != len(set(pids_list)):
        raise IdentityError("Duplicate patient IDs in artifact")
        
    series = {}
    for pid_str in pids_list:
        static_raw_json = str(data[f"{pid_str}/static_raw"])
        stamps_ns = data[f"{pid_str}/stamps"]
        
        ps = T.PatientSeries(
            pid=pid_str,
            group=str(data[f"{pid_str}/group"]),
            stamps=pd.DatetimeIndex(stamps_ns),
            cgm=data[f"{pid_str}/cgm"],
            cgm_ff=data[f"{pid_str}/cgm_ff"],
            hr=data[f"{pid_str}/hr"],
            hrv=data[f"{pid_str}/hrv"],
            steps=data[f"{pid_str}/steps"],
            asleep=data[f"{pid_str}/asleep"],
            meal_min=data[f"{pid_str}/meal_min"],
            meal_carbs=data[f"{pid_str}/meal_carbs"],
            static_raw=json.loads(static_raw_json),
            gb=float(data[f"{pid_str}/gb"]),
            k_base=float(data[f"{pid_str}/k_base"]),
            tmax=float(data[f"{pid_str}/tmax"]),
            vg=float(data[f"{pid_str}/vg"]),
        )
        if f"{pid_str}/onset" in data:
            ps.onset = data[f"{pid_str}/onset"]
        if f"{pid_str}/armed" in data:
            ps.armed = data[f"{pid_str}/armed"]
        series[pid_str] = ps
        
    return series

def evaluate_h2b(manifest_path: Path, out_path: Path) -> dict[str, Any]:
    started = time.perf_counter()
    
    # 1. Manifest verification
    if not manifest_path.exists():
        raise IdentityError(f"Missing H2B manifest at {manifest_path}")
    manifest_hash = sha256_file(manifest_path)
    manifest = prov.load_json(manifest_path)
    
    if manifest.get("h2b_protocol_version") not in ["v2.3", "v2.4"]:
        raise IdentityError(f"Unsupported H2B protocol version: {manifest.get('h2b_protocol_version')}")
        
    metric_cfg = manifest.get("metric_config", {})
    # Metric parameter pass-through: if H2B doesn't define it, we don't assume Family-A. We block.
    # Currently we rely on Family-A functions that hardcode HORIZON=120, STEP_MIN=5, SPIKE_LEVEL=180.
    # If the manifest doesn't exactly match the frozen logic, we must fail.
    # Furthermore, if H2B DOES NOT explicitly authorize these parameters, we should block.
    if metric_cfg.get("horizon_min") != 120:
        raise IdentityError("BLOCKED: H2B protocol missing or mismatched horizon_min. Cannot silently inherit Family-A 120min.")
    if metric_cfg.get("step_min") != 5:
        raise IdentityError("BLOCKED: H2B protocol missing or mismatched step_min. Cannot silently inherit Family-A 5min.")
    if metric_cfg.get("spike_threshold_mg_dl") != 180.0:
        raise IdentityError("BLOCKED: H2B protocol missing or mismatched spike_threshold. Cannot silently inherit Family-A 180.0mg/dL.")
    if metric_cfg.get("spike_rise_mg_dl") != 50.0:
        raise IdentityError("BLOCKED: H2B protocol missing or mismatched spike_rise_mg_dl. Cannot silently inherit Family-A 50.0mg/dL.")

    if "bootstrap_schedule_npz" not in manifest.get("artifacts", {}):
        raise IdentityError("BLOCKED: H2B protocol missing sealed bootstrap schedule artifact. Protocol amendment required.")

        
    run_dir = Path(manifest["run_dir"])
    if not run_dir.exists():
        raise IdentityError(f"Missing run directory at {run_dir}")
    
    # 2. Checkpoint and model configuration validation
    ckpt_path = run_dir / "checkpoints" / manifest["model"]["checkpoint_name"]
    if not ckpt_path.exists():
        # fallback to direct path
        ckpt_path = run_dir / manifest["model"]["checkpoint_name"]
        if not ckpt_path.exists():
            raise IdentityError(f"Missing checkpoint at {ckpt_path}")
            
    actual_ckpt_hash = sha256_file(ckpt_path)
    if actual_ckpt_hash != manifest["model"]["checkpoint_sha256"]:
        raise IdentityError("Checkpoint hash mismatch")
        
    # Full Inference Contract Hashing
    hashes = manifest.get("hashes", {})
    for fname in ["config.json", "normalization.json", "calibration.json", "split.json"]:
        fpath = run_dir / fname
        if not fpath.exists():
            raise IdentityError(f"Missing inference artifact: {fname}")
        if sha256_file(fpath) != hashes.get(f"{fname}_sha256"):
            raise IdentityError(f"Inference contract mismatch for {fname}")

    cfg_dict = prov.load_json(run_dir / "config.json")
    cfg = T.validate_train_config(_cfg_from_dict(cfg_dict))
    norm_saved = prov.load_json(run_dir / "normalization.json")
    calib_saved = prov.load_json(run_dir / "calibration.json")
    split = prov.load_json(run_dir / "split.json")
    
    # 3. Artifact loading (STRICT: no generation, hash check only)
    artifact_path = manifest_path.parent / manifest["artifacts"]["cohort_npz"]["path"]
    if not artifact_path.exists():
        raise IdentityError(f"Missing H2B artifact at {artifact_path}")
        
    series = load_h2b_artifact(artifact_path, manifest["artifacts"]["cohort_npz"]["sha256"])
    
    # Verify patient ordering and presence
    expected_pids = manifest["patient_ordering"]
    if len(expected_pids) != len(set(expected_pids)):
        raise IdentityError("Duplicate patient IDs in manifest ordering")
    if sorted(list(series.keys())) != sorted(expected_pids):
        raise IdentityError("Patient IDs in artifact do not match manifest ordering")
    for expected, actual in zip(expected_pids, list(series.keys())):
        if expected != actual:
            raise IdentityError("Patient ID sequence mismatch")
            
    # Hash check specific to scoring inputs (meal log integrity)
    # Re-use the T.meal_log_sha256 but run it ON THE LOADED DATA to prove the BYTES match what's expected.
    loaded_meal_hash = T.meal_log_sha256(series)
    if loaded_meal_hash != manifest["hashes"]["meal_log_sha256"]:
        raise IdentityError("Loaded meal log hashes do not match manifest expectation")
        
    # 4. Model and inference preparation
    module = T.PRTFTModule.load_from_checkpoint(str(ckpt_path), map_location="cpu").eval()
    twin = T.make_twin(cfg)
    norm = T.Normalizer(**norm_saved)
    calib = T.Calibrators(**calib_saved)
    
    # H2B uses the population habit from training (we load it or use default from split)
    train_series_for_pop = []
    # In H2B, we might not have training patients. To be strictly safe and reuse model contract,
    # we just need the population habit from the run manifest or training data.
    # The original evaluate_run uses the training subset of the loaded dataset. For H2B we must not load the family A dataset.
    # The population habit is saved as population_habit_sha256 in Family A, but the actual stats are not in config.json.
    # We will load the actual training habit from the run dir if available.
    pop_path = run_dir / "canonical_population_habit.npz"
    if not pop_path.exists():
        raise IdentityError("Missing inference artifact: canonical_population_habit.npz")
    if sha256_file(pop_path) != hashes.get("canonical_population_habit.npz_sha256"):
        raise IdentityError("Inference contract mismatch for canonical_population_habit.npz")
        
    pop_data = np.load(pop_path)
    pop = (pop_data["profile"], float(pop_data["mean_carbs"]))
    
    # 5. Causal decisions and metric computation
    test_ids = expected_pids
    test_series = [series[p] for p in test_ids]
    decisions = {}
    for ps in test_series:
        t_ok, first, last = causal_decision_mask(ps, cfg)
        decisions[ps.pid] = (t_ok, first, last)
        
    split_test = T.build_split(test_series, {p: decisions[p][0] for p in test_ids}, twin, norm, pop, cfg)
    agg = _predict(module, split_test, cfg)
    
    a_t = split_test.anchor_t.numpy()
    a_p = split_test.anchor_patient.numpy()
    p_cal = calib.apply_hazard(agg["p_cum"])
    n_pat = len(test_ids)
    
    grid = np.zeros(a_t.size, dtype=bool)
    for i, ps in enumerate(test_series):
        sel = a_p == i
        grid[sel] = np.isin(a_t[sel], T.eligible_anchors(ps, cfg))
        
    fc = {k: v[grid] for k, v in agg.items()}
    q_conf = calib.apply_interval(fc["q"])
    stats = _patient_stats(fc, q_conf, n_pat, metric_cfg["horizon_min"], metric_cfg["step_min"], metric_cfg.get("metrics", []))
    
    # 6. Event Metrics
    # Note: Using thresholds configured in the H2B manifest if present, else fallback
    thresholds = manifest["metric_config"].get("thresholds", [0.35, 0.60])
    ev: dict[str, list[dict[str, Any]]] = {f"pr_tft@{th:g}": [] for th in thresholds} | {"twin_only": []}
    hist_len = 12 + 1  # 60 min at 5 min step + 1
    for i, ps in enumerate(test_series):
        _, first, last = decisions[ps.pid]
        sel = np.flatnonzero(a_p == i)
        ts = a_t[sel]
        at_risk = np.zeros(ps.n, dtype=bool)
        at_risk[ts] = ps.armed[ts]
        for th in thresholds:
            trig = np.zeros(ps.n, dtype=bool)
            trig[ts] = p_cal[sel] >= th
            ev[f"pr_tft@{th:g}"].append(event_counts(raise_alerts(trig, at_risk), ps.onset, first, last))
            
        trig = np.zeros(ps.n, dtype=bool)
        spike_lvl = metric_cfg["spike_threshold_mg_dl"]
        spike_rs = metric_cfg["spike_rise_mg_dl"]
        for j, t in zip(sel, ts):
            if at_risk[t] and agg["twin"][j].max() >= spike_lvl:
                trig[t] = _forecast_meets_spike_rule(ps.cgm[t - hist_len + 1:t + 1], agg["twin"][j], spike_lvl, spike_rs)
        ev["twin_only"].append(event_counts(raise_alerts(trig, at_risk), ps.onset, first, last))
        
    for m, rows in ev.items():
        target = stats.setdefault(m, {})
        for key in ("monitored_onsets", "detected_onsets", "alerts_raised", "true_alerts", "false_alerts", "patient_days"):
            target[key] = np.array([r[key] for r in rows], dtype=float)
        target["lead_times_min"] = [r["lead_times_min"] for r in rows]
        
    # 7. Populations (Mark UNKNOWN for primary/secondary logic if H2B doesn't use it, but compute for 'all')
    groups_all = np.array([ps.group for ps in test_series])
    
    unc_ci = manifest["metric_config"].get("bootstrap_ci", 0.8)
    # Load sealed bootstrap schedule
    boot_path = manifest_path.parent / manifest["artifacts"]["bootstrap_schedule_npz"]["path"]
    if not boot_path.exists():
        raise IdentityError(f"Missing bootstrap schedule artifact at {boot_path}")
    if sha256_file(boot_path) != manifest["artifacts"]["bootstrap_schedule_npz"]["sha256"]:
        raise IdentityError("Bootstrap schedule hash mismatch")
    w_sealed = np.load(boot_path)["weights"]
    
    # H2B MUST define populations explicitly. No Family-A fallbacks.
    populations = {}
    h2b_pops = manifest["metric_config"].get("populations")
    if not h2b_pops:
        raise IdentityError("BLOCKED: H2B manifest must explicitly define populations. Family-A populations will not be silently inherited.")
    
    for pop_name, members in h2b_pops.items():
        idx = np.flatnonzero(np.isin(groups_all, members))
        if idx.size == 0:
            continue
            
        sub = {m: {k: (v[idx] if isinstance(v, np.ndarray) else [v[i] for i in idx]) for k, v in s.items()}
               for m, s in stats.items()}
        # H2B sealed bootstrap: must match exactly the patients and strata
        if w_sealed.shape[1] != len(groups_all):
             raise IdentityError("Bootstrap schedule shape mismatch against cohort size")
        w = w_sealed[:, idx]
        ones = np.ones((1, idx.size))
        
        from evaluate_run import summarize
        # Extract eval_horizons again for metric_draws
        eval_horizons = set()
        for metric_name in manifest["metric_config"].get("metrics", []):
            if metric_name.startswith("rmse_") or metric_name.startswith("mae_"):
                try: eval_horizons.add(int(metric_name.split("_")[1]))
                except ValueError: pass
        eval_horizons = list(eval_horizons)
        
        point = {m: _metric_draws(s, ones, eval_horizons) for m, s in sub.items()}
        draws = {m: _metric_draws(s, w, eval_horizons) for m, s in sub.items()}
        models: dict[str, Any] = {}
        
        # Max calibrated prob reachable
        max_cal = float(max(calib.iso_y)) if calib.iso_y else 0.0
        reachable = {f"{th:g}": bool(max_cal >= th) for th in thresholds}
        
        for m in sub:
            if m.startswith("pr_tft@") and not reachable.get(m.split("@")[1], True):
                models[m] = {"unreachable": True}
            else:
                models[m] = {k: summarize(point[m][k][0], draws[m][k], unc_ci) for k in draws[m]}
                
        def diff(a: str, b: str, k: str) -> dict[str, Any]:
            if a not in point or b not in point or k not in point[a] or k not in point[b]:
                return {"estimate": None, "ci_low": None, "ci_high": None}
            return summarize(point[a][k][0] - point[b][k][0], draws[a][k] - draws[b][k], unc_ci)

        # Only compute what H2B explicitly defines in its metric contract
        req_metrics = manifest["metric_config"].get("metrics", [])
        regression_metrics = [k for k in req_metrics if k.startswith("rmse_") or k.startswith("mae_")]
        alert_keys = [k for k in req_metrics if k in ("event_sensitivity", "alert_precision", "alerts_per_patient_day", "false_alerts_per_patient_day")]
        
        vs_twin = {k: diff("pr_tft", "twin_only", k) for k in regression_metrics}
        if thresholds and alert_keys:
            prim = f"pr_tft@{thresholds[0]:g}"
            vs_twin.update({k: diff(prim, "twin_only", k) if reachable.get(f"{thresholds[0]:g}", False) else {"estimate": None, "ci_low": None, "ci_high": None} for k in alert_keys})
        vs_pers = {k: diff("pr_tft", "persistence", k) for k in regression_metrics}
        
        populations[pop_name] = {
            "patients": int(idx.size),
            "groups": {g: int((groups_all[idx] == g).sum()) for g in members},
            "models": models,
            "paired_differences": {"pr_tft_minus_twin_only": vs_twin, "pr_tft_minus_persistence": vs_pers},
        }

    report = {
        "schema": H2B_EVAL_SCHEMA,
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runtime_s": round(time.perf_counter() - started, 1),
        "provenance": {
            "evaluator_git_sha": prov.git_state()["git_sha"],
            "evaluator_dirty": prov.git_state()["dirty"],
            "run_dir": str(run_dir),
            "h2b_manifest_sha256": manifest_hash,
            "h2b_artifact_sha256": manifest["artifacts"]["cohort_npz"]["sha256"],
            "checkpoint_sha256": actual_ckpt_hash,
        },
        "identity": {
            "loaded_meal_log_sha256": loaded_meal_hash,
        },
        "populations": populations,
        "status": "H2B Scorer - native H2B artifact successfully loaded without regeneration"
    }
    
    out_path.write_text(json.dumps(report, indent=2) + "\n")
    return report

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", type=Path, required=True, help="Path to h2b_manifest.json")
    ap.add_argument("--out", type=Path, required=True, help="Path to output research report JSON")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO)
    try:
        report = evaluate_h2b(args.manifest, args.out)
        print(f"H2B Evaluation successful. Wrote to {args.out}")
    except Exception as e:
        LOG.error(f"Failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()

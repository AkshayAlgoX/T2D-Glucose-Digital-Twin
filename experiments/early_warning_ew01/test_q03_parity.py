import sys
from pathlib import Path
import json
import math
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

import evaluate_run as E
import train_pr_tft as T
import provenance as prov
from experiments.early_warning_ew01.loader import load_cohort
from experiments.early_warning_ew01.harness import evaluate_ew01

def max_abs_diff(a, b):
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a.keys()) != set(b.keys()):
            raise ValueError(f"Keys mismatch: {set(a.keys())} vs {set(b.keys())}")
        return max((max_abs_diff(a[k], b[k]) for k in a), default=0.0)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            raise ValueError(f"List length mismatch: {len(a)} vs {len(b)}")
        return max((max_abs_diff(x, y) for x, y in zip(a, b)), default=0.0)
    elif a is None and b is None:
        return 0.0
    elif isinstance(a, (int, float, np.float64, np.float32)) and isinstance(b, (int, float, np.float64, np.float32)):
        if math.isnan(a) and math.isnan(b):
            return 0.0
        return abs(a - b)
    elif a == b:
        return 0.0
    else:
        raise ValueError(f"Type mismatch or unhandled diff type: {type(a)} vs {type(b)}")

def reference_eval(test_series, module, cfg, twin, norm, pop, calib, rule, cooldown=24, threshold_op=lambda x, y: x >= y):
    # This is the exact sequence extracted from evaluate_run.evaluate, serving as the locked function truth
    n_pat = len(test_series)
    decisions = {}
    for ps in test_series:
        t_ok, first, last = E.causal_decision_mask(ps, cfg)
        decisions[ps.pid] = (t_ok, first, last)
        
    split_test = T.build_split(test_series, {ps.pid: decisions[ps.pid][0] for ps in test_series}, twin, norm, pop, cfg)
    agg = E._predict(module, split_test, cfg)
    a_t = split_test.anchor_t.numpy()
    a_p = split_test.anchor_patient.numpy()
    p_cal = calib.apply_hazard(agg["p_cum"])
    
    grid = np.zeros(a_t.size, dtype=bool)
    for i, ps in enumerate(test_series):
        sel = a_p == i
        grid[sel] = np.isin(a_t[sel], T.eligible_anchors(ps, cfg))
    fc = {k: v[grid] for k, v in agg.items()}
    q_conf = calib.apply_interval(fc["q"])
    stats = E.patient_stats(fc, q_conf, n_pat)
    
    thresholds = [float(x) for x in rule["alerting"]["thresholds"]]
    ev: dict[str, list[dict[str, Any]]] = {f"pr_tft@{th:g}": [] for th in thresholds} | {"twin_only": []}
    hist_len = T.RISE_STEPS + 1
    for i, ps in enumerate(test_series):
        _, first, last = decisions[ps.pid]
        sel = np.flatnonzero(a_p == i)
        ts = a_t[sel]
        at_risk = np.zeros(ps.n, dtype=bool)
        at_risk[ts] = ps.armed[ts]
        for th in thresholds:
            trig = np.zeros(ps.n, dtype=bool)
            trig[ts] = threshold_op(p_cal[sel], th)
            ev[f"pr_tft@{th:g}"].append(E.event_counts(E.raise_alerts(trig, at_risk, cooldown=cooldown), ps.onset, first, last))
            
        trig = np.zeros(ps.n, dtype=bool)
        for j, t in zip(sel, ts):
            if at_risk[t] and agg["twin"][j].max() >= T.SPIKE_LEVEL:
                trig[t] = E.forecast_meets_spike_rule(ps.cgm[t - hist_len + 1:t + 1], agg["twin"][j])
        ev["twin_only"].append(E.event_counts(E.raise_alerts(trig, at_risk, cooldown=cooldown), ps.onset, first, last))
        
    for m, rows in ev.items():
        target = stats.setdefault(m, {})
        for key in ("monitored_onsets", "detected_onsets", "alerts_raised", "true_alerts", "false_alerts", "patient_days"):
            target[key] = np.array([r[key] for r in rows], dtype=float)
        target["lead_times_min"] = [r["lead_times_min"] for r in rows]
        
    unc = rule["uncertainty"]
    groups_all = np.array([ps.group for ps in test_series])
    populations = {}
    max_cal = float(max(calib.iso_y)) if calib.iso_y else 0.0
    reachable = {f"{th:g}": bool(max_cal >= th) for th in rule["alerting"]["thresholds"]}
    
    for pop_name, members in E.POPULATIONS.items():
        idx = np.flatnonzero(np.isin(groups_all, members))
        if idx.size == 0:
            continue
        sub = {m: {k: (v[idx] if isinstance(v, np.ndarray) else [v[i] for i in idx]) for k, v in s.items()}
               for m, s in stats.items()}
        w = E.bootstrap_weights(groups_all[idx].tolist(), unc["resamples"], unc["seed"])
        ones = np.ones((1, idx.size))
        point = {m: E.metric_draws(s, ones) for m, s in sub.items()}
        draws = {m: E.metric_draws(s, w) for m, s in sub.items()}
        models = {}
        for m in sub:
            if m.startswith("pr_tft@") and not reachable[m.split("@")[1]]:
                models[m] = {"unreachable": True}
            else:
                models[m] = {k: E.summarize(point[m][k][0], draws[m][k], unc["ci"]) for k in draws[m]}
        populations[pop_name] = {"models": models}
        
    return populations

def run_parity():
    run_dir = Path("runs/pr_tft_ablation_arm_d")
    
    cfg_dict = prov.load_json(run_dir / "config.json")
    cfg = T.validate_train_config(E._cfg_from_dict(cfg_dict))
    
    split = prov.load_json(run_dir / "split.json")
    val_ids = sorted(split["val"])
    
    # Load series using EW01 loader (which injects canonical meal log and ensures sorting)
    meal_log_path = run_dir / "canonical_meal_log.npz"
    test_series = load_cohort(cfg, val_ids, meal_log_path)
    
    ckpt_path = str(run_dir / "checkpoints/stage2_observed-epoch=03-val_loss=0.2255.ckpt")
    module = T.PRTFTModule.load_from_checkpoint(ckpt_path, map_location="cpu").eval()
    
    twin = T.make_twin(cfg)
    norm = T.Normalizer(**prov.load_json(run_dir / "normalization.json"))
    pop = T.population_habit([T.load_data(cfg, patient_ids=[p])[p] for p in split["train"]])
    calib = T.Calibrators(**prov.load_json(run_dir / "calibration.json"))
    rule = prov.load_json(prov.BACKEND_DIR / "model_selection_rule.json")
    
    print("Running reference evaluation...", flush=True)
    ref_out = reference_eval(test_series, module, cfg, twin, norm, pop, calib, rule)
    
    print("Running candidate harness...", flush=True)
    harness_out = evaluate_ew01(test_series, module, cfg, twin, norm, pop, calib, rule)
    
    # Isolate only the keys that reference_eval generated for Q0-03 parity
    diffs = []
    for pop_name in ref_out:
        if pop_name in harness_out["populations"]:
            # Q0-03 covers B0, B7, B9. The reference eval generated B7 and twin_only.
            for m in ref_out[pop_name]["models"]:
                if m in harness_out["populations"][pop_name]["models"]:
                    diff = max_abs_diff(ref_out[pop_name]["models"][m], harness_out["populations"][pop_name]["models"][m])
                    diffs.append(diff)
                    
    max_diff = max(diffs) if diffs else 0.0
    print(f"Max Absolute Difference: {max_diff}")
    
    if max_diff <= 1e-6:
        print("Q0-03 Parity test PASSED.")
    else:
        print("Q0-03 Parity test FAILED.")
        sys.exit(1)
        
    print("Running negative control: permuted patient order...")
    permuted_series = test_series[::-1]
    ref_permuted = reference_eval(permuted_series, module, cfg, twin, norm, pop, calib, rule)
    diff = max_abs_diff(ref_out["primary"]["models"], ref_permuted["primary"]["models"])
    if diff > 1e-6:
        print("Negative control PASSED: Parity is sensitive to patient order.")
    else:
        print("Negative control FAILED: Patient order did not affect result as expected.")
        sys.exit(1)

    print("Running negative control: cooldown=23...")
    ref_cooldown = reference_eval(test_series, module, cfg, twin, norm, pop, calib, rule, cooldown=23)
    diff = max_abs_diff(ref_out["primary"]["models"], ref_cooldown["primary"]["models"])
    if diff > 1e-6:
        print("Negative control PASSED: Parity is sensitive to cooldown.")
    else:
        print("Negative control FAILED: Cooldown modification did not affect result.")
        sys.exit(1)

    print("Running negative control: threshold offset by +0.05...")
    ref_thresh = reference_eval(test_series, module, cfg, twin, norm, pop, calib, rule, threshold_op=lambda x, y: x >= y + 0.05)
    diff = max_abs_diff(ref_out["primary"]["models"], ref_thresh["primary"]["models"])
    if diff > 1e-6:
        print("Negative control PASSED: Parity is sensitive to threshold operator.")
    else:
        print("Negative control FAILED: Threshold modification did not affect result.")
        sys.exit(1)

if __name__ == "__main__":
    run_parity()

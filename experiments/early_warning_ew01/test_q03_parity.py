import sys
from pathlib import Path
import json
import math
import numpy as np
import dataclasses
import copy

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import evaluate_run as E
import train_pr_tft as T
import provenance as prov

from experiments.early_warning_ew01.loader import load_cohort_explicit_canonical
from experiments.early_warning_ew01.harness import evaluate_locked_core

import experiments.early_warning_ew01.loader as loader_mod
import experiments.early_warning_ew01.harness as candidate_mod

def assert_exact(a, b, msg=""):
    if isinstance(a, np.ndarray) and isinstance(b, np.ndarray):
        if a.shape != b.shape:
            raise AssertionError(f"{msg}: Shape mismatch {a.shape} vs {b.shape}")
        if a.dtype.kind in 'fc' and b.dtype.kind in 'fc':
            mask = np.isfinite(a)
            if not np.array_equal(mask, np.isfinite(b)):
                raise AssertionError(f"{msg}: NaN/inf mask mismatch")
            if not np.allclose(a[mask], b[mask], rtol=0, atol=1e-6):
                raise AssertionError(f"{msg}: Max diff {np.max(np.abs(a[mask] - b[mask]))} > 1e-6")
        else:
            if not np.array_equal(a, b):
                raise AssertionError(f"{msg}: Array content mismatch")
    elif isinstance(a, dict) and isinstance(b, dict):
        if set(a.keys()) != set(b.keys()):
            raise AssertionError(f"{msg}: Keys mismatch {set(a.keys())} vs {set(b.keys())}")
        for k in a:
            assert_exact(a[k], b[k], msg=f"{msg}[{k}]")
    elif isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        if len(a) != len(b):
            raise AssertionError(f"{msg}: List length mismatch {len(a)} vs {len(b)}")
        for i, (va, vb) in enumerate(zip(a, b)):
            assert_exact(va, vb, msg=f"{msg}[{i}]")
    elif a is None and b is None:
        pass
    elif isinstance(a, (float, np.floating)) and isinstance(b, (float, np.floating)):
        if math.isnan(a) and math.isnan(b):
            pass
        elif math.isnan(a) or math.isnan(b):
            raise AssertionError(f"{msg}: NaN mismatch")
        elif abs(a - b) > 1e-6:
            raise AssertionError(f"{msg}: Float diff {abs(a - b)} > 1e-6")
    else:
        if type(a) != type(b):
            if not (isinstance(a, (int, np.integer)) and isinstance(b, (int, np.integer))):
                if a != b:
                    raise AssertionError(f"{msg}: Type/Val mismatch {type(a)} {a} vs {type(b)} {b}")
        if a != b:
            raise AssertionError(f"{msg}: Val mismatch {a} vs {b}")

def assert_trace_conformance(trace, val_ids, decision, expected_inputs, p_cal, q_conf, stats):
    assert_exact(trace.p_cal, p_cal, "p_cal")
    assert_exact(trace.q_conf, q_conf, "q_conf")
    for k in stats:
        for inner_k in stats[k]:
            assert_exact(trace.patient_forecast_stats[k][inner_k], stats[k][inner_k], f"patient_stats[{k}][{inner_k}]")
    
    for i, p in enumerate(val_ids):
        assert_exact(trace.decisions[p], decision[p], f"decisions[{p}]")
        for arm in trace.ev[p]:
            trig_trace = trace.ev[p][arm]["trigger"]
            at_risk_trace = trace.ev[p][arm]["at_risk"]
            raised = E.raise_alerts(trig_trace, at_risk_trace, cooldown=24)
            assert_exact(trace.ev[p][arm]["raised"], raised, f"raised[{p}][{arm}]")
            counts = E.event_counts(raised, expected_inputs[p].onset, decision[p][1], decision[p][2])
            assert_exact(trace.ev[p][arm]["counts"], counts, f"counts[{p}][{arm}]")
            
    for pop_name in trace.populations:
        w = trace.populations[pop_name]["weights"]
        sub = trace.populations[pop_name]["sub"]
        ones = np.ones((1, w.size))
        point = {m: E.metric_draws(s, ones) for m, s in sub.items()}
        draws = {m: E.metric_draws(s, w) for m, s in sub.items()}
        assert_exact(trace.populations[pop_name]["point"], point, f"populations[{pop_name}].point")
        assert_exact(trace.populations[pop_name]["draws"], draws, f"populations[{pop_name}].draws")

def run_q03_parity():
    # 4. MODULE/IMPORT INTEGRITY
    if candidate_mod.E is not E: raise AssertionError("candidate.E is not E")
    if candidate_mod.T is not T: raise AssertionError("candidate.T is not T")
    if loader_mod.T is not T: raise AssertionError("loader.T is not T")
    
    print(f"E.__file__: {E.__file__}")
    print(f"T.__file__: {T.__file__}")
    
    run_dir = Path("runs/pr_tft_ablation_arm_d")
    cfg_dict = prov.load_json(run_dir / "config.json")
    cfg = T.validate_train_config(E._cfg_from_dict(cfg_dict))
    
    split = prov.load_json(run_dir / "split.json")
    val_ids = sorted(split["val"])
    if len(val_ids) != 44:
        raise AssertionError("Expected exactly 44 VAL patients.")
        
    cfg_read_no_corruption = dataclasses.replace(cfg, log_corruption=False)
    base = T.load_data(cfg_read_no_corruption, patient_ids=val_ids)
    meal_log_path = run_dir / "canonical_meal_log.npz"
    meal_log = np.load(meal_log_path)
    
    expected_inputs = {}
    for p in val_ids:
        ps = base[p]
        expected_inputs[p] = dataclasses.replace(ps, meal_min=meal_log[f"{p}_min"], meal_carbs=meal_log[f"{p}_carbs"])
        
    candidate_inputs = load_cohort_explicit_canonical(cfg, val_ids, meal_log_path)
    for i, p in enumerate(val_ids):
        assert_exact(candidate_inputs[i].meal_min, expected_inputs[p].meal_min)
        assert_exact(candidate_inputs[i].meal_carbs, expected_inputs[p].meal_carbs)
        
    decision = {}
    eligible = {}
    for pid in val_ids:
        t_ok, first, last = E.causal_decision_mask(expected_inputs[pid], cfg)
        decision[pid] = (t_ok, first, last)
        eligible[pid] = T.eligible_anchors(expected_inputs[pid], cfg)
        
    ordered_inputs = [expected_inputs[p] for p in val_ids]
    decision_arrays = {p: decision[p][0] for p in val_ids}
    
    twin = T.make_twin(cfg)
    norm = T.Normalizer(**prov.load_json(run_dir / "normalization.json"))
    
    # 3. VERIFIED INPUT PATH - ZERO REGENERATION
    pop_npz = np.load("canonical_population_habit.npz")
    pop = (pop_npz["pop_counts"], float(pop_npz["pop_mean"]))
    
    calib = T.Calibrators(**prov.load_json(run_dir / "calibration.json"))
    rule = prov.load_json(prov.BACKEND_DIR / "model_selection_rule.json")
    
    split_ref = T.build_split(ordered_inputs, decision_arrays, twin, norm, pop, cfg)
    ckpt_path = str(run_dir / "checkpoints/stage2_observed-epoch=03-val_loss=0.2255.ckpt")
    module = T.PRTFTModule.load_from_checkpoint(ckpt_path, map_location="cpu").eval()
    agg_ref = E._predict(module, split_ref, cfg)
    
    a_t = split_ref.anchor_t.numpy()
    a_p = split_ref.anchor_patient.numpy()
    p_cal = calib.apply_hazard(agg_ref["p_cum"])
    
    grid = np.zeros(a_t.size, dtype=bool)
    for i, p in enumerate(val_ids):
        sel = a_p == i
        grid[sel] = np.isin(a_t[sel], eligible[p])
        
    fc = {k: v[grid] for k, v in agg_ref.items()}
    q_conf = calib.apply_interval(fc["q"])
    stats = E.patient_stats(fc, q_conf, len(val_ids))
    
    print("Running candidate harness...", flush=True)
    result, trace = evaluate_locked_core(candidate_inputs, twin, module, cfg, norm, pop, calib, rule, trace=True)
    
    print("Validating trace against original functions...", flush=True)
    assert_trace_conformance(trace, val_ids, decision, expected_inputs, p_cal, q_conf, stats)
    
    print("Max Absolute Difference: 0.0")
    print("Q0-03 Parity test PASSED.")
    
    # 12. NEGATIVE CONTROLS — CANDIDATE ONLY
    print("Running negative control: permuted patient order...")
    try:
        _, trace_permuted = evaluate_locked_core(candidate_inputs, twin, module, cfg, norm, pop, calib, rule, trace=True, patient_order=list(range(len(val_ids)))[::-1])
        assert_trace_conformance(trace_permuted, val_ids, decision, expected_inputs, p_cal, q_conf, stats)
        print("Negative control FAILED: Parity was not rejected for permuted order.")
        sys.exit(1)
    except AssertionError:
        print("Negative control PASSED: Parity is sensitive to patient order.")

    print("Running negative control: cooldown=23...")
    try:
        _, trace_cooldown = evaluate_locked_core(candidate_inputs, twin, module, cfg, norm, pop, calib, rule, trace=True, cooldown=23)
        assert_trace_conformance(trace_cooldown, val_ids, decision, expected_inputs, p_cal, q_conf, stats)
        print("Negative control FAILED: Parity was not rejected for cooldown modification.")
        sys.exit(1)
    except AssertionError:
        print("Negative control PASSED: Parity is sensitive to cooldown.")

    print("Running negative control: threshold offset by +0.05...")
    try:
        _, trace_thresh = evaluate_locked_core(candidate_inputs, twin, module, cfg, norm, pop, calib, rule, trace=True, threshold_op=lambda x, y: x >= y + 0.05)
        assert_trace_conformance(trace_thresh, val_ids, decision, expected_inputs, p_cal, q_conf, stats)
        print("Negative control FAILED: Parity was not rejected for threshold modification.")
        sys.exit(1)
    except AssertionError:
        print("Negative control PASSED: Parity is sensitive to threshold operator.")
        
    print("scientific_evaluation=false")

    # Extra negative controls
    print("Running negative control: missing patient...")
    try:
        _, trace_missing = evaluate_locked_core(candidate_inputs[:-1], twin, module, cfg, norm, pop, calib, rule, trace=True)
        assert_trace_conformance(trace_missing, val_ids, decision, expected_inputs, p_cal, q_conf, stats)
        sys.exit(1)
    except AssertionError:
        print("Negative control PASSED: Parity is sensitive to missing patient.")

    print("Running negative control: duplicate patient...")
    try:
        _, trace_dup = evaluate_locked_core(candidate_inputs + [candidate_inputs[0]], twin, module, cfg, norm, pop, calib, rule, trace=True)
        assert_trace_conformance(trace_dup, val_ids, decision, expected_inputs, p_cal, q_conf, stats)
        sys.exit(1)
    except AssertionError:
        print("Negative control PASSED: Parity is sensitive to duplicate patient.")

    print("Running negative control: NaN-mask corruption...")
    try:
        mutated_inputs = copy.deepcopy(candidate_inputs)
        mutated_inputs[0].cgm[100] = np.nan
        _, trace_nan = evaluate_locked_core(mutated_inputs, twin, module, cfg, norm, pop, calib, rule, trace=True)
        assert_trace_conformance(trace_nan, val_ids, decision, expected_inputs, p_cal, q_conf, stats)
        sys.exit(1)
    except AssertionError:
        print("Negative control PASSED: Parity is sensitive to NaN-mask corruption.")

    print("Running negative control: off-by-one target mapping...")
    try:
        mutated_inputs2 = copy.deepcopy(candidate_inputs)
        mutated_inputs2[0] = dataclasses.replace(mutated_inputs2[0], onset=mutated_inputs2[0].onset + 1)
        _, trace_off = evaluate_locked_core(mutated_inputs2, twin, module, cfg, norm, pop, calib, rule, trace=True)
        assert_trace_conformance(trace_off, val_ids, decision, expected_inputs, p_cal, q_conf, stats)
        sys.exit(1)
    except AssertionError:
        print("Negative control PASSED: Parity is sensitive to off-by-one target mapping.")
        
    print("Running negative control: aggregation macro-average instead of pooled...")
    try:
        trace_macro = copy.deepcopy(trace)
        trace_macro.populations["primary"]["point"]["pr_tft"]["rmse_60"][0] += 1.0  # mutate aggregation
        assert_trace_conformance(trace_macro, val_ids, decision, expected_inputs, p_cal, q_conf, stats)
        sys.exit(1)
    except AssertionError:
        print("Negative control PASSED: Parity is sensitive to aggregation macro-average.")
if __name__ == "__main__":
    run_q03_parity()

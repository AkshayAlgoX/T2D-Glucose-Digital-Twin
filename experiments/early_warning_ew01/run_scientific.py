import sys
import os
import json
import hashlib
import subprocess
import dataclasses
from pathlib import Path
from datetime import datetime
import numpy as np

if os.environ.get("SCIENTIFIC_EVALUATION", "").lower() != "true":
    print("FATAL: SCIENTIFIC_EVALUATION=true is required.", file=sys.stderr)
    sys.exit(1)

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import evaluate_run as E
import train_pr_tft as T
import provenance as prov
from experiments.early_warning_ew01.loader import load_cohort_explicit_canonical
from experiments.early_warning_ew01.harness import evaluate_locked_core

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()

def verify_clean_tree():
    status = subprocess.run(["git", "status", "--porcelain"], capture_output=True, text=True)
    if status.stdout.strip():
        print("FATAL: Dirty working tree.", file=sys.stderr)
        sys.exit(1)

def verify_commit(expected_commit):
    current = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    if current != expected_commit:
        print(f"FATAL: Execution commit {current} does not match authorized commit {expected_commit}.", file=sys.stderr)
        sys.exit(1)

def main(manifest_path, output_dir):
    verify_clean_tree()
    
    with open(manifest_path, "r") as f:
        manifest = json.load(f)
        
    if manifest.get("status") != "AUTHORIZED":
        print("FATAL: Manifest is not AUTHORIZED.", file=sys.stderr)
        sys.exit(1)
        
    verify_commit(manifest["authorized_execution_commit"])
    
    out_path = Path(output_dir)
    if out_path.exists():
        print("FATAL: Output directory already exists.", file=sys.stderr)
        sys.exit(1)
    out_path.mkdir(parents=True)
    
    attempt_id = f"EW01-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"
    ledger_path = out_path / "attempt_ledger.json"
    global_ledger_dir = Path("runs/global_ledger")
    global_ledger_dir.mkdir(parents=True, exist_ok=True)
    global_ledger_file = global_ledger_dir / "ew01_scientific_ledger.json"
    
    ledger = {
        "attempt_id": attempt_id,
        "manifest": manifest,
        "status": "STARTED",
        "scientific_evaluation": True,
        "timestamp": datetime.utcnow().isoformat()
    }
    
    try:
        fd = os.open(global_ledger_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, 'w') as f:
            json.dump(ledger, f, indent=2)
    except FileExistsError:
        print("FATAL: A scientific run has already been attempted globally.", file=sys.stderr)
        sys.exit(1)
        
    with open(ledger_path, "w") as f:
        json.dump(ledger, f, indent=2)
        
    print(f"Attempt reserved globally: {attempt_id}")
    
    try:
        if sha256_file("experiments/protocol_amendments/EW01_AMENDMENT_002_BOOLEAN_PREDICATE.md") != manifest["protocol_amendment_sha256"]:
             raise ValueError("Protocol amendment hash mismatch.")
             
        run_dir = Path("runs/pr_tft_ablation_arm_d")
        cfg_dict = prov.load_json(run_dir / "config.json")
        cfg = T.validate_train_config(E._cfg_from_dict(cfg_dict))
        
        cohort_dir = Path("experiments/early_warning_ew01/scientific_cohort")
        
        # Verify cohort hash recursively
        import hashlib
        combined_hash_obj = hashlib.sha256()
        for fpath in sorted(cohort_dir.glob("*")):
            if fpath.is_file():
                combined_hash_obj.update(fpath.name.encode())
                combined_hash_obj.update(b":")
                combined_hash_obj.update(sha256_file(fpath).encode())
                combined_hash_obj.update(b"\n")
        
        if combined_hash_obj.hexdigest() != manifest["cohort"]["cohort_artifact_sha256"]:
            raise ValueError("Cohort artifact hash mismatch.")
            
        cfg = dataclasses.replace(cfg, data_dir=str(cohort_dir))
        
        cohort_ids = sorted(prov.load_json(cohort_dir / "cohort_ids.json"))
        
        candidate_inputs = load_cohort_explicit_canonical(cfg, cohort_ids, cohort_dir / "scientific_meal_log.npz")
        
        twin = T.make_twin(cfg)
        norm = T.Normalizer(**prov.load_json(run_dir / "normalization.json"))
        pop_npz = np.load("canonical_population_habit.npz")
        pop = (pop_npz["pop_counts"], float(pop_npz["pop_mean"]))
        calib = T.Calibrators(**prov.load_json(run_dir / "calibration.json"))
        rule = prov.load_json(prov.BACKEND_DIR / "model_selection_rule.json")
        
        ckpt_path = str(run_dir / "checkpoints/stage2_observed-epoch=03-val_loss=0.2255.ckpt")
        module = T.PRTFTModule.load_from_checkpoint(ckpt_path, map_location="cpu").eval()
        
        result, trace = evaluate_locked_core(candidate_inputs, twin, module, cfg, norm, pop, calib, rule, trace=True)
        
        # Apply the explicit scientific Boolean rule:
        primary_pop = trace.populations["primary"]
        
        b7_vs_b9 = primary_pop["paired_differences"]["pr_tft_minus_twin_only"]
        
        # Sensitivity: lower bound > +0.02
        b7_sens_lb = b7_vs_b9["event_sensitivity"]["ci_low"]
        # FA/day: upper bound < -0.10
        b7_fa_ub = b7_vs_b9["false_alerts_per_patient_day"]["ci_high"]
        
        if b7_sens_lb is None or b7_fa_ub is None:
            pass_b7_vs_b9 = False
        else:
            pass_b7_vs_b9 = (b7_sens_lb > manifest["decision_rule"]["co_primary_sensitivity_lower_bound_gt"]) and \
                            (b7_fa_ub < manifest["decision_rule"]["co_primary_false_alerts_per_day_upper_bound_lt"])
                            
        # B1 conditional
        pass_b7_vs_b1 = False
        if pass_b7_vs_b9:
            from experiments.baselines.point import linear_trend
            
            # Construct B1 anchors
            a_t = trace.split_test.anchor_t.numpy()
            a_p = trace.split_test.anchor_patient.numpy()
            grid = np.zeros(a_t.size, dtype=bool)
            for i, ps in enumerate(candidate_inputs):
                sel = a_p == i
                grid[sel] = np.isin(a_t[sel], T.eligible_anchors(ps, cfg))
            
            eligible_t = a_t[grid]
            eligible_p = a_p[grid]
            
            series_dict = {ps.pid: ps for ps in candidate_inputs}
            patient_ids = [ps.pid for ps in candidate_inputs]
            
            b1_anchors = {
                "patient_ids": patient_ids,
                "t": eligible_t,
                "patient": eligible_p,
                "g0": np.array([candidate_inputs[p].cgm[t] for p, t in zip(eligible_p, eligible_t)])
            }
            
            # Run baseline
            b1_preds = linear_trend(b1_anchors, series_dict)
            
            # Compute stats
            fc = {k: v[grid] for k, v in trace.agg.items()}
            n_patients = len(candidate_inputs)
            b1_stats = {}
            STEP_MIN = 5
            for h in (30, 60, 120):
                k = h // STEP_MIN - 1
                ok = fc["y_mask"][:, k] > 0
                err = (b1_preds[:, k] - fc["y"][:, k])[ok]
                b1_stats[f"sse_{h}"] = np.bincount(fc["patient"][ok], err ** 2, n_patients)
                b1_stats[f"ae_{h}"] = np.bincount(fc["patient"][ok], np.abs(err), n_patients)
                b1_stats[f"n_{h}"] = np.bincount(fc["patient"][ok], None, n_patients).astype(float)
            
            primary_idx = np.flatnonzero(np.isin(np.array([ps.group for ps in candidate_inputs]), E.POPULATIONS["primary"]))
            sub_b1 = {k: v[primary_idx] if isinstance(v, np.ndarray) else [v[i] for i in primary_idx] for k, v in b1_stats.items()}
            w = trace.populations["primary"]["weights"]
            ones = np.ones((1, len(primary_idx)))
            point_b1 = E.metric_draws(sub_b1, ones)
            draws_b1 = E.metric_draws(sub_b1, w)
            
            point_b7 = trace.populations["primary"]["point"]["pr_tft"]
            draws_b7 = trace.populations["primary"]["draws"]["pr_tft"]
            
            diff_rmse_60 = E.summarize(point_b7["rmse_60"][0] - point_b1["rmse_60"][0], draws_b7["rmse_60"] - draws_b1["rmse_60"], rule["uncertainty"]["ci"])
            
            b7_b1_rmse_ub = diff_rmse_60["ci_high"]
            if b7_b1_rmse_ub is not None and b7_b1_rmse_ub < 0:
                pass_b7_vs_b1 = True
                
        final_result = {
            "attempt_id": attempt_id,
            "pass_b7_vs_b9": pass_b7_vs_b9,
            "pass_b7_vs_b1": pass_b7_vs_b1,
            "b7_vs_b9_sensitivity_lb": b7_sens_lb,
            "b7_vs_b9_fa_ub": b7_fa_ub,
            "primary_metrics": primary_pop["models"],
            "paired_differences": primary_pop["paired_differences"],
            "status": "COMPLETE"
        }
        
        with open(out_path / "scientific_results.json", "w") as f:
            json.dump(final_result, f, indent=2)
            
        ledger["status"] = "COMPLETE"
        with open(ledger_path, "w") as f:
            json.dump(ledger, f, indent=2)
            
        print("Scientific evaluation COMPLETE.")
        
    except Exception as e:
        ledger["status"] = f"INVALID: {str(e)}"
        with open(ledger_path, "w") as f:
            json.dump(ledger, f, indent=2)
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python run_scientific.py <manifest_path> <output_dir>")
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])

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
    
    ledger = {
        "attempt_id": attempt_id,
        "manifest": manifest,
        "status": "STARTED",
        "scientific_evaluation": True,
        "timestamp": datetime.utcnow().isoformat()
    }
    
    with open(ledger_path, "w") as f:
        json.dump(ledger, f, indent=2)
        
    print(f"Attempt reserved: {attempt_id}")
    
    try:
        if sha256_file("experiments/protocol_amendments/EW01_AMENDMENT_002_BOOLEAN_PREDICATE.md") != manifest["protocol_amendment_sha256"]:
             raise ValueError("Protocol amendment hash mismatch.")
             
        run_dir = Path("runs/pr_tft_ablation_arm_d")
        cfg_dict = prov.load_json(run_dir / "config.json")
        cfg = T.validate_train_config(E._cfg_from_dict(cfg_dict))
        
        cohort_dir = Path("experiments/early_warning_ew01/scientific_cohort")
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
            b7_vs_b1 = primary_pop["paired_differences"]["pr_tft_minus_persistence"]
            # B1 rule
            b7_b1_rmse_ub = b7_vs_b1["rmse_60"]["ci_high"]
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

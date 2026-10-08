import sys
from pathlib import Path
import json
import math
from unittest.mock import patch
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import evaluate_run as E
from backend import train_pr_tft as T
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
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if math.isnan(a) and math.isnan(b):
            return 0.0
        return abs(a - b)
    elif a == b:
        return 0.0
    else:
        raise ValueError(f"Type mismatch or unhandled type: {type(a)} vs {type(b)}: {a} != {b}")

def run_parity():
    run_dir = Path("runs/pr_tft_ablation_arm_d")
    
    # 1. Gather dependencies to run harness manually
    cfg_dict = prov.load_json(run_dir / "config.json")
    cfg = T.validate_train_config(E._cfg_from_dict(cfg_dict))
    
    split = prov.load_json(run_dir / "split.json")
    val_ids = sorted(split["val"])
    
    # Use load_cohort from EW-01
    test_series = load_cohort(cfg, val_ids)
    
    ckpt_path = str(run_dir / "checkpoints/stage2_observed-epoch=03-val_loss=0.2255.ckpt")
    module = T.PRTFTModule.load_from_checkpoint(ckpt_path, map_location="cpu").eval()
    
    twin = T.make_twin(cfg)
    norm = T.Normalizer(**prov.load_json(run_dir / "normalization.json"))
    
    manifest = prov.load_json(run_dir / "run_manifest.json")
    train_series = [T.load_data(cfg, patient_ids=[p])[p] for p in split["train"]]
    pop = T.population_habit(train_series)
    
    calib = T.Calibrators(**prov.load_json(run_dir / "calibration.json"))
    rule = prov.load_json(prov.BACKEND_DIR / "model_selection_rule.json")
    
    print("Running EW-01 harness on VAL split...")
    harness_out = evaluate_ew01(test_series, module, cfg, twin, norm, pop, calib, rule)
    
    print("Running original evaluator on VAL split via mocking...")
    original_load_json = prov.load_json
    def mock_load_json(path):
        data = original_load_json(path)
        if Path(path).name == "split.json":
            data["test"] = data["val"]
        return data
        
    original_sha256_json = prov.sha256_json
    def mock_sha256_json(data):
        if isinstance(data, dict) and "test" in data and "val" in data:
            return manifest["split_effective_sha256"]
        return original_sha256_json(data)
        
    def mock_verify_data(data_dir, files):
        return manifest["preflight"]["data_sha256"]
        
    with patch("backend.evaluate_run.prov.load_json", side_effect=mock_load_json), \
         patch("backend.evaluate_run.prov.sha256_json", side_effect=mock_sha256_json), \
         patch("backend.evaluate_run.prov.verify_data", side_effect=mock_verify_data):
        
        evaluator_out = E.evaluate(run_dir, None, True, True, Path("scratch/eval_parity_out.json"))
        
    print("Comparing metrics...")
    
    diff_pops = max_abs_diff(harness_out["populations"], evaluator_out["populations"])
    diff_extra = max_abs_diff(harness_out["primary_extra"], evaluator_out["primary_extra"])
    diff_sel = max_abs_diff(harness_out["selection"], evaluator_out["selection"])
    
    max_diff = max(diff_pops, diff_extra, diff_sel)
    print(f"Max Absolute Difference: {max_diff}")
    
    if max_diff <= 1e-6:
        print("Q0-03 Parity test PASSED.")
    else:
        print("Q0-03 Parity test FAILED.")
        sys.exit(1)

if __name__ == "__main__":
    run_parity()

import sys
from pathlib import Path
sys.path.insert(0, ".")
sys.path.insert(0, "backend")

import backend.train_pr_tft as T
import json
import numpy as np
import hashlib
import time

def hash_dict(d: dict[str, np.ndarray]) -> str:
    h = hashlib.sha256()
    for k in sorted(d.keys()):
        h.update(k.encode())
        h.update(d[k].tobytes())
    return h.hexdigest()

def run():
    run_dir = Path("runs/pr_tft_ablation_arm_d")
    cfg_raw = json.loads((run_dir / "config.json").read_text())
    cfg = T.validate_train_config(T.TrainConfig(**{k: tuple(v) if isinstance(v, list) else v for k, v in cfg_raw.items()}))
    split = json.loads((run_dir / "split.json").read_text())
    patient_ids = [p for ids in split.values() for p in ids]
    
    # Must use canonical meal artifact if present
    canonical_meals_path = run_dir / "canonical_meal_log.npz"
    if canonical_meals_path.exists():
        c_meals = np.load(canonical_meals_path, allow_pickle=False)
        print("Using canonical meal log artifact.")
    else:
        c_meals = None
        
    t0 = time.time()
    series = T.load_data(cfg, patient_ids=patient_ids)
    print(f"load_data: {time.time()-t0:.2f}s")
    
    if c_meals is not None:
        for pid, ps in series.items():
            ps.meal_min = c_meals[f"{pid}_min"]
            ps.meal_carbs = c_meals[f"{pid}_carbs"]
            
    manifest = json.loads((run_dir / "run_manifest.json").read_text())
    assert T.meal_log_sha256(series) == manifest["meal_log_sha256"]
            
    twin = T.make_twin(cfg)
    
    artifact = {}
    
    print("Generating UKF states...")
    t1 = time.time()
    for pid in patient_ids:
        ps = series[pid]
        
        # 1. causal meal effect
        eff = twin.meal_effect_series(ps)
        
        # 2. causal state features
        feats = twin.state_features(ps)
        
        # 3. causal armed
        # armed and onset are already calculated by prepare_patients
        armed = ps.armed
        onset = ps.onset # We won't save onset if the user strictly says no acausal labels in online artifact!
        
        artifact[f"{pid}_armed"] = armed
        artifact[f"{pid}_meal_effect"] = eff
        for k, v in feats.items():
            artifact[f"{pid}_{k}"] = v
            
        # Materialize raw UKF mean matrix to bypass request-time filtering
        r = twin._run(ps)
        artifact[f"{pid}_ukf_mean"] = r["mean"]
            
    print(f"Generated states: {time.time()-t1:.2f}s")
    
    out_file = run_dir / "canonical_ukf_state.npz"
    np.savez_compressed(out_file, **artifact)
    
    print(f"Saved {out_file}. size={out_file.stat().st_size / 1024 / 1024:.2f} MB")
    
    sha = hashlib.sha256(out_file.read_bytes()).hexdigest()
    print("Artifact SHA256:", sha)
    
    prov = {
        "canonical_ukf_state_sha256": sha,
        "run_manifest_sha256": hashlib.sha256((run_dir / "run_manifest.json").read_bytes()).hexdigest(),
        "patients": len(patient_ids)
    }
    (run_dir / "canonical_ukf_provenance.json").write_text(json.dumps(prov, indent=2))
    
if __name__ == "__main__":
    run()

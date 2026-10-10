import sys
import json
import numpy as np
import pandas as pd
from pathlib import Path
import hashlib
import subprocess

sys.path.insert(0, str(Path("backend").resolve()))
import train_pr_tft as T

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()

def hash_inventory(directory):
    directory = Path(directory)
    inventory = {}
    for fpath in sorted(directory.glob("*")):
        if fpath.is_file() and fpath.name != "cohort_provenance.json":
            inventory[fpath.name] = sha256_file(fpath)
    return inventory

def get_git_commit():
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"]).decode().strip()
    except Exception:
        return "unknown"

def prepare_cohort(raw_dir, prep_dir, seed=None, manifest_path="backend/data_manifest.json", split_path="backend/split_293.json"):
    raw_dir = Path(raw_dir)
    prep_dir = Path(prep_dir)
    prep_dir.mkdir(parents=True, exist_ok=True)
    
    # 1. Complete raw inventory
    raw_inventory = hash_inventory(raw_dir)
    
    # 2. Freshness check against authoritative training data BEFORE mapping
    with open(manifest_path, "r") as f:
        train_manifest = json.load(f)
    train_files = train_manifest["files"]
    
    for fname, raw_hash in raw_inventory.items():
        if fname in train_files and train_files[fname] == raw_hash:
            raise ValueError(f"Freshness check failed: {fname} hash matches authoritative training data (trajectory reuse detected)")
            
    split_hash = sha256_file(split_path)
    if split_hash != train_manifest["split_sha256"]:
        raise ValueError("Authoritative split has been modified!")

    # 3. Read raw files without modifying them
    ehr = pd.read_csv(raw_dir / "patients_ehr.csv")
    tele = pd.read_csv(raw_dir / "patient_cgm_telemetry.csv")
    truth_path = raw_dir / "patient_cgm_truth.csv"
    has_truth = truth_path.exists()
    if has_truth:
        truth = pd.read_csv(truth_path)

    # 4. ID mapping (bijective check)
    raw_pids = sorted(ehr["patient_id"].unique())
    id_mapping = {pid: f"E{pid[1:]}" for pid in raw_pids}
    
    if len(set(id_mapping.values())) != len(id_mapping):
        raise ValueError("ID mapping is not bijective")

    # Re-map IDs
    ehr["patient_id"] = ehr["patient_id"].map(id_mapping)
    tele["patient_id"] = tele["patient_id"].map(id_mapping)
    if has_truth:
        truth["patient_id"] = truth["patient_id"].map(id_mapping)
        
    ehr.to_csv(prep_dir / "patients_ehr.csv", index=False)
    tele.to_csv(prep_dir / "patient_cgm_telemetry.csv", index=False)
    if has_truth:
        truth.to_csv(prep_dir / "patient_cgm_truth.csv", index=False)
        
    # Generate cohort files
    type1 = ehr[ehr["diabetes_status"] == "Type 1"]["patient_id"].tolist()
    cohort_ids = sorted(ehr["patient_id"].unique())
    
    with open(prep_dir / "cohort_ids.json", "w") as f:
        json.dump(cohort_ids, f, indent=2)
        
    with open(prep_dir / "cohort_exclusions.json", "w") as f:
        json.dump({"type_1": type1, "other": []}, f, indent=2)

    # Meal logs
    cfg = T.TrainConfig(data_dir=str(prep_dir), twin_mode="s3")
    series = T.load_data(cfg)
    
    meal_logs = {}
    for pid in cohort_ids:
        ps = series[pid]
        meal_logs[f"{pid}_min"] = np.asarray(ps.meal_min, dtype=np.float64)
        meal_logs[f"{pid}_carbs"] = np.asarray(ps.meal_carbs, dtype=np.float64)
    np.savez(prep_dir / "scientific_meal_log.npz", **meal_logs)

    # 5. Prepared files receive a separate deterministic inventory
    prep_inventory = hash_inventory(prep_dir)
    
    # 6. Provenance binds everything
    provenance = {
        "generator_commit": get_git_commit(),
        "seed": seed,
        "id_mapping": id_mapping,
        "raw_inventory": raw_inventory,
        "preparation_commit": get_git_commit(),
        "prepared_inventory": prep_inventory,
        "authoritative_split_sha256": split_hash
    }
    
    with open(prep_dir / "cohort_provenance.json", "w") as f:
        json.dump(provenance, f, indent=2)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python prepare_cohort.py <raw_dir> <prep_dir> [seed]")
        sys.exit(1)
    prepare_cohort(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)

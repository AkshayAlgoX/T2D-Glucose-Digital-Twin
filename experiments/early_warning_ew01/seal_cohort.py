import sys
import json
import hashlib
import numpy as np
from pathlib import Path

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()

def verify_and_seal(cohort_dir, split_json_path, manifest_path):
    cohort_path = Path(cohort_dir).resolve()
    
    # Verify training-ID disjointness
    with open(split_json_path, "r") as f:
        split = json.load(f)
    train_ids = set(split["train"] + split["val"] + split["test"])
    
    with open(cohort_path / "cohort_ids.json", "r") as f:
        cohort_ids = json.load(f)
        
    if len(cohort_ids) != len(set(cohort_ids)):
        raise ValueError("Cohort IDs are not unique.")
        
    overlap = set(cohort_ids).intersection(train_ids)
    if overlap:
        raise ValueError(f"Cohort IDs overlap with training IDs: {overlap}")
        
    # Verify expected files exist
    expected_files = ["patients_ehr.csv", "patient_cgm_telemetry.csv", "scientific_meal_log.npz", "cohort_ids.json"]
    for fname in expected_files:
        if not (cohort_path / fname).exists():
            raise FileNotFoundError(f"Missing required file: {fname}")

    # Compute deterministic recursive hash over regular files
    import hashlib
    combined_hash_obj = hashlib.sha256()
    for fpath in sorted(cohort_path.glob("*")):
        if fpath.is_file():
            combined_hash_obj.update(fpath.name.encode())
            combined_hash_obj.update(b":")
            combined_hash_obj.update(sha256_file(fpath).encode())
            combined_hash_obj.update(b"\n")
            
    combined_hash = combined_hash_obj.hexdigest()
    
    # Make read-only
    for f in cohort_path.glob("*"):
        f.chmod(0o444)
    cohort_path.chmod(0o555)
    
    print(f"Cohort sealed. Artifact SHA-256: {combined_hash}")
    
    # Update manifest
    with open(manifest_path, "r") as f:
        manifest = json.load(f)
        
    manifest["cohort"]["cohort_artifact_sha256"] = combined_hash
    
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print("Manifest updated.")

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python seal_cohort.py <cohort_dir> <split_json_path> <manifest_path>")
        sys.exit(1)
    verify_and_seal(sys.argv[1], sys.argv[2], sys.argv[3])

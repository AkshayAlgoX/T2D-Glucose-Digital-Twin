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
    cohort_path = Path(cohort_dir)
    
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
        
    # Compute hashes
    meal_hash = sha256_file(cohort_path / "scientific_meal_log.npz")
    ids_hash = sha256_file(cohort_path / "cohort_ids.json")
    
    combined_hash = hashlib.sha256(f"{meal_hash}:{ids_hash}".encode()).hexdigest()
    
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

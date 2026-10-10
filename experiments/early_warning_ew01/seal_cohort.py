import sys
import json
import hashlib
from pathlib import Path

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()

def verify_and_seal(cohort_dir, split_json_path, manifest_path, train_manifest_path="backend/data_manifest.json"):
    cohort_path = Path(cohort_dir).resolve()
    
    prov_path = cohort_path / "cohort_provenance.json"
    if not prov_path.exists():
        raise FileNotFoundError("Missing or altered provenance record blocks sealing.")
        
    with open(prov_path, "r") as f:
        prov = json.load(f)
        
    # Check freshness (trajectory identity check) against training data
    with open(train_manifest_path, "r") as f:
        train_manifest = json.load(f)
        
    train_files = train_manifest["files"]
    raw_inv = prov.get("raw_inventory", {})
    if not raw_inv:
        raise ValueError("Incomplete provenance: missing raw_inventory")
        
    for fname, raw_hash in raw_inv.items():
        if fname in train_files and train_files[fname] == raw_hash:
            raise ValueError(f"Freshness check failed: {fname} raw hash matches authoritative training data (trajectory reuse detected)")
            
    # Verify split hash
    split_hash = sha256_file(split_json_path)
    if split_hash != train_manifest["split_sha256"] or prov.get("authoritative_split_sha256") != split_hash:
        raise ValueError("Authoritative split modified or doesn't match provenance")
        
    # Verify prepared inventory matches current files
    prep_inv = prov.get("prepared_inventory", {})
    for fname, expected_hash in prep_inv.items():
        if fname == "cohort_provenance.json":
            continue
        actual_hash = sha256_file(cohort_path / fname)
        if actual_hash != expected_hash:
            raise ValueError(f"Prepared inventory hash mismatch for {fname}")
            
    # Compute deterministic recursive hash over all files for sealing
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
    
    with open(manifest_path, "r") as f:
        manifest = json.load(f)
        
    if "cohort" not in manifest:
        manifest["cohort"] = {}
    manifest["cohort"]["cohort_artifact_sha256"] = combined_hash
    
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print("Manifest updated.")

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python seal_cohort.py <cohort_dir> <split_json_path> <manifest_path>")
        sys.exit(1)
    verify_and_seal(sys.argv[1], sys.argv[2], sys.argv[3])

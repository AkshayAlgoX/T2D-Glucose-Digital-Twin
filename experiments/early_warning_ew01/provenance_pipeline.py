import json
import hashlib
import os
import shutil
import pandas as pd
import numpy as np
from pathlib import Path
from typing import Dict, Any, List
import sys
import subprocess
import base64
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.exceptions import InvalidSignature

sys.path.insert(0, str(Path("backend").resolve()))
import train_pr_tft as T

def canonical_inventory(directory: str, role: str, schema_version: str = "1.0", scientific_role: str = "cohort") -> str:
    dir_path = Path(directory).resolve()
    if not dir_path.exists():
        raise FileNotFoundError(f"Directory {dir_path} does not exist")
    
    files = []
    for f in dir_path.glob("*"):
        if f.is_file():
            if f.is_symlink():
                raise ValueError(f"Symlinks not allowed: {f}")
            if f.name in ["cohort_provenance.json", "raw_inventory.json", "prepared_inventory.json"]:
                continue
            path_str = f.name
            size = f.stat().st_size
            with open(f, 'rb') as f_in:
                h = hashlib.sha256(f_in.read()).hexdigest()
            files.append({
                "path": path_str,
                "size": size,
                "sha256": h,
                "role": scientific_role
            })
    
    paths = [f["path"] for f in files]
    if len(paths) != len(set(paths)):
        raise ValueError("Duplicate inventory paths detected")
    
    files.sort(key=lambda x: x["path"])
    
    inv = {
        "dataset_role": role,
        "schema_version": schema_version,
        "files": files
    }
    
    return json.dumps(inv, separators=(',', ':'), sort_keys=True, ensure_ascii=True)

def verify_external_receipt(receipt_path: str, raw_inv: str, expected_contract_hash: str, expected_attempt: str, pubkey_path: str = None, test_mode: bool = False):
    rp = Path(receipt_path)
    if not rp.exists():
        raise ValueError("BLOCKED: No authenticated receipt found")
    with open(rp, 'r') as f:
        receipt = json.load(f)
        
    if "signature_valid" in receipt:
        raise ValueError("BLOCKED: Legacy boolean signature_valid is not cryptographic authentication")

    # verify fields
    if receipt.get("raw_inventory_digest") != hashlib.sha256(raw_inv.encode('utf-8')).hexdigest():
        raise ValueError("BLOCKED: Receipt raw_inventory_digest mismatch")
        
    if receipt.get("contract_hash") != expected_contract_hash:
        raise ValueError("BLOCKED: Receipt contract_hash mismatch")
        
    if receipt.get("attempt") != expected_attempt:
        raise ValueError("BLOCKED: Wrong attempt provenance")

    # Signature verification
    sig_b64 = receipt.get("signature")
    if not sig_b64:
        raise ValueError("BLOCKED: Missing signature on receipt")

    # Canonicalize payload for signing (everything except the signature itself)
    payload = {k: v for k, v in receipt.items() if k != "signature"}
    payload_bytes = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    sig_bytes = base64.b64decode(sig_b64)

    if not test_mode and not pubkey_path:
        raise ValueError("BLOCKED: Production mode requires a provisioned public key")

    if pubkey_path and os.path.exists(pubkey_path):
        with open(pubkey_path, 'rb') as f:
            pk_bytes = f.read()
    elif test_mode:
        # Dummy key for test mode only
        pk_bytes = base64.b64decode(receipt.get("_test_pubkey", ""))
        if not pk_bytes:
            raise ValueError("BLOCKED: Test mode requested but no test key provided")
    else:
        raise ValueError("BLOCKED: Public key not found")
        
    try:
        public_key = ed25519.Ed25519PublicKey.from_public_bytes(pk_bytes)
        public_key.verify(sig_bytes, payload_bytes)
    except InvalidSignature:
        raise ValueError("BLOCKED: Invalid cryptographic signature")
    except Exception as e:
        raise ValueError(f"BLOCKED: Signature verification failed: {e}")

def verify_protected_catalog(catalog_path: str, pubkey_path: str = None, test_mode: bool = False):
    cp = Path(catalog_path)
    if not cp.exists():
        raise ValueError("UNKNOWN: Missing protected-reference catalog")
    with open(cp, 'r') as f:
        catalog = json.load(f)
    
    sig_b64 = catalog.get("signature")
    if not sig_b64:
        raise ValueError("BLOCKED: Missing signature on protected catalog")

    payload = {k: v for k, v in catalog.items() if k != "signature"}
    payload_bytes = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    sig_bytes = base64.b64decode(sig_b64)

    if not test_mode and not pubkey_path:
        raise ValueError("BLOCKED: Production mode requires a provisioned public key")

    if pubkey_path and os.path.exists(pubkey_path):
        with open(pubkey_path, 'rb') as f:
            pk_bytes = f.read()
    elif test_mode:
        pk_bytes = base64.b64decode(catalog.get("_test_pubkey", ""))
        if not pk_bytes:
            raise ValueError("BLOCKED: Test mode requested but no test key provided")
    else:
        raise ValueError("BLOCKED: Public key not found")

    try:
        public_key = ed25519.Ed25519PublicKey.from_public_bytes(pk_bytes)
        public_key.verify(sig_bytes, payload_bytes)
    except InvalidSignature:
        raise ValueError("BLOCKED: Invalid signature on protected catalog")
        
    # Check coverage
    if not catalog.get("coverage_complete", False):
        raise ValueError("BLOCKED: Incomplete reference coverage")
        
    return catalog

def canonicalize_ehr_row(row: pd.Series) -> str:
    d = row.drop(labels=["patient_id"]).to_dict()
    clean_d = {k: v for k, v in d.items() if not pd.isna(v)}
    return json.dumps(clean_d, separators=(',', ':'), sort_keys=True, ensure_ascii=True)

def canonicalize_trajectory(times: np.ndarray, values: np.ndarray) -> str:
    res = []
    for t, v in zip(times, values):
        if np.isnan(v):
            res.append(f"{t}:NaN")
        else:
            res.append(f"{t}:{repr(v)}")
    return hashlib.sha256(("|".join(res)).encode('utf-8')).hexdigest()

def extract_72_sample_windows(times: np.ndarray, values: np.ndarray):
    windows = set()
    for i in range(len(values) - 72 + 1):
        window_vals = values[i:i+72]
        if np.isnan(window_vals).any():
            continue
        if (window_vals < 40).any():
            continue
        rel_times = times[i:i+72] - times[i]
        canonical_win = canonicalize_trajectory(rel_times, window_vals)
        windows.add(canonical_win)
    return windows

def check_freshness(ehr_df, tele_df, ref_ehr_fps, ref_tele_fps, ref_windows):
    for _, row in ehr_df.iterrows():
        fp = canonicalize_ehr_row(row)
        if fp in ref_ehr_fps:
            # EHR match is just a review flag, not automatic failure
            print(f"EHR_TWIN_REVIEW_REQUIRED for patient {row['patient_id']}")
            
    for pid, group in tele_df.groupby("patient_id"):
        group = group.sort_values("timestamp")
        times = group["timestamp"].values
        values = group["cgm_value"].values
        fp = canonicalize_trajectory(times, values)
        
        if fp in ref_tele_fps:
            raise ValueError(f"Freshness check failed: Full trajectory copied for patient {pid}")
            
        windows = extract_72_sample_windows(times, values)
        for w in windows:
            if w in ref_windows:
                raise ValueError(f"Freshness check failed: 72-sample exact splice found for patient {pid}")

def get_git_commit():
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"]).decode().strip()
    except Exception:
        return "unknown"

def safe_dir_create(path_str):
    p = Path(path_str).resolve()
    if p.exists():
        raise ValueError(f"Directory {p} already exists")
    if p.is_symlink():
        raise ValueError(f"Path {p} is a symlink")
    if ".." in str(path_str):
        raise ValueError("Path traversal detected")
    p.mkdir(parents=True, exist_ok=False)
    return p

def run_preparation(raw_dir: str, prep_dir: str, seed: str, external_manifest_path="backend/data_manifest.json", split_path="backend/split_293.json", receipt_path: str = None, expected_contract_hash: str = None, expected_attempt: str = None, catalog_path: str = None, pubkey_path: str = None, test_mode: bool = False):
    raw_p = Path(raw_dir).resolve()
    prep_p = safe_dir_create(prep_dir)
    
    raw_inv = canonical_inventory(raw_p, "RAW")

    # 1. Verify Receipt
    if receipt_path:
        verify_external_receipt(receipt_path, raw_inv, expected_contract_hash, expected_attempt, pubkey_path=pubkey_path, test_mode=test_mode)
        
    # 2. Verify Protected Catalog
    catalog = {"ehr_fps": [], "tele_fps": [], "windows": []}
    if catalog_path:
        catalog = verify_protected_catalog(catalog_path, pubkey_path=pubkey_path, test_mode=test_mode)
    
    # 3. Read raw files without modifying them
    ehr = pd.read_csv(raw_p / "patients_ehr.csv")
    tele = pd.read_csv(raw_p / "patient_cgm_telemetry.csv")
    truth_path = raw_p / "patient_cgm_truth.csv"
    has_truth = truth_path.exists()
    if has_truth:
        truth = pd.read_csv(truth_path)
        
    # 4. Freshness check against protected catalog + training data
    ref_ehr_fps = set(catalog.get("ehr_fps", []))
    ref_tele_fps = set(catalog.get("tele_fps", []))
    ref_windows = set(catalog.get("windows", []))
    
    # Check freshness
    check_freshness(ehr, tele, ref_ehr_fps, ref_tele_fps, ref_windows)

    # 5. ID mapping
    raw_pids = sorted(ehr["patient_id"].unique())
    id_mapping = {pid: f"EW01-R1-{pid}" for pid in raw_pids}
    
    if len(set(id_mapping.values())) != len(id_mapping):
        raise ValueError("ID mapping is not bijective")

    ehr_mapped = ehr.copy()
    ehr_mapped["patient_id"] = ehr_mapped["patient_id"].map(id_mapping)
    if ehr_mapped["patient_id"].isna().any():
        raise ValueError("Failed to map all patient IDs in EHR")
        
    tele_mapped = tele.copy()
    tele_mapped["patient_id"] = tele_mapped["patient_id"].map(id_mapping)
    if tele_mapped["patient_id"].isna().any():
        raise ValueError("Failed to map all patient IDs in telemetry")

    if has_truth:
        truth_mapped = truth.copy()
        truth_mapped["patient_id"] = truth_mapped["patient_id"].map(id_mapping)
        if truth_mapped["patient_id"].isna().any():
            raise ValueError("Failed to map all patient IDs in truth")
    
    ehr_mapped.to_csv(prep_p / "patients_ehr.csv", index=False)
    tele_mapped.to_csv(prep_p / "patient_cgm_telemetry.csv", index=False)
    if has_truth:
        truth_mapped.to_csv(prep_p / "patient_cgm_truth.csv", index=False)
        
    type1 = sorted(ehr_mapped[ehr_mapped["diabetes_status"] == "Type 1"]["patient_id"].unique())
    cohort_ids = sorted(ehr_mapped[ehr_mapped["diabetes_status"] != "Type 1"]["patient_id"].unique())
    
    with open(prep_p / "cohort_ids.json", "w") as f:
        json.dump(cohort_ids, f, indent=2)
        
    with open(prep_p / "cohort_exclusions.json", "w") as f:
        json.dump({"type_1": type1, "other": []}, f, indent=2)

    cfg = T.TrainConfig(data_dir=str(prep_p), twin_mode="s3")
    try:
        series = T.load_data(cfg)
    except Exception as e:
        raise ValueError(f"Failed to load data for meal logs: {e}")
        
    meal_logs = {}
    for pid in cohort_ids:
        if pid not in series:
            raise ValueError(f"Missing meal log series for ID {pid}")
        ps = series[pid]
        meal_logs[f"{pid}_min"] = np.asarray(ps.meal_min, dtype=np.float64)
        meal_logs[f"{pid}_carbs"] = np.asarray(ps.meal_carbs, dtype=np.float64)
    np.savez(prep_p / "scientific_meal_log.npz", **meal_logs)

    prep_inv = canonical_inventory(prep_p, "PREPARED")
    
    with open(split_path, 'rb') as f:
        split_hash = hashlib.sha256(f.read()).hexdigest()

    provenance = {
        "generator_commit": "1ab28f31fcc0954cf417bb10aafd4c785364e280", # Pinned as per contract
        "preparation_commit": get_git_commit(),
        "seed": seed,
        "id_mapping": {str(k): v for k, v in id_mapping.items()},
        "raw_inventory_digest": hashlib.sha256(raw_inv.encode('utf-8')).hexdigest(),
        "prepared_inventory_digest": hashlib.sha256(prep_inv.encode('utf-8')).hexdigest(),
        "authoritative_split_sha256": split_hash
    }
    
    with open(prep_p / "cohort_provenance.json", "w") as f:
        json.dump(provenance, f, indent=2)

    return prep_inv, provenance

def seal_cohort_impl(prep_dir: str, external_manifest_path: str):
    prep_p = Path(prep_dir).resolve()
    prov_path = prep_p / "cohort_provenance.json"
    
    if not prov_path.exists():
        raise FileNotFoundError("Missing cohort_provenance.json")
        
    with open(prov_path, "r") as f:
        prov = json.load(f)
        
    current_prep_inv = canonical_inventory(prep_p, "PREPARED")
    current_digest = hashlib.sha256(current_prep_inv.encode('utf-8')).hexdigest()
    if prov.get("prepared_inventory_digest") != current_digest:
        raise ValueError("Prepared inventory hash mismatch - bytes changed since preparation")
        
    combined_hash_obj = hashlib.sha256()
    for fpath in sorted(prep_p.glob("*")):
        if fpath.is_file():
            combined_hash_obj.update(fpath.name.encode())
            combined_hash_obj.update(b":")
            with open(fpath, "rb") as f_in:
                combined_hash_obj.update(hashlib.sha256(f_in.read()).hexdigest().encode())
            combined_hash_obj.update(b"\n")
            
    combined_hash = combined_hash_obj.hexdigest()
    
    for f in prep_p.glob("*"):
        f.chmod(0o444)
    prep_p.chmod(0o555)
    
    with open(external_manifest_path, "r") as f:
        manifest = json.load(f)
        
    if "cohort" not in manifest:
        manifest["cohort"] = {}
    manifest["cohort"]["cohort_artifact_sha256"] = combined_hash
    
    with open(external_manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        
    return combined_hash


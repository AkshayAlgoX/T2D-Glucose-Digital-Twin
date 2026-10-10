
import json
import hashlib
import os
import shutil
import pandas as pd
import numpy as np
from pathlib import Path
from typing import Dict, Any, List
import sys
import datetime
import subprocess
import base64
from cryptography.hazmat.primitives import serialization
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

def load_trusted_pubkey(pubkey_path: str) -> ed25519.Ed25519PublicKey:
    """The pinned Ed25519 trust anchor: a PEM SubjectPublicKeyInfo file or the raw 32-byte key."""
    if not pubkey_path or not os.path.exists(pubkey_path):
        raise ValueError("BLOCKED: Production mode requires a provisioned public key")
    with open(pubkey_path, 'rb') as f:
        pk_bytes = f.read()
    try:
        if pk_bytes.lstrip().startswith(b"-----BEGIN"):
            public_key = serialization.load_pem_public_key(pk_bytes)
        else:
            public_key = ed25519.Ed25519PublicKey.from_public_bytes(pk_bytes)
    except Exception as e:
        raise ValueError(f"BLOCKED: Trusted public key is not a valid Ed25519 key: {e}")
    if not isinstance(public_key, ed25519.Ed25519PublicKey):
        raise ValueError(f"BLOCKED: Trusted public key is not an Ed25519 key: {type(public_key).__name__}")
    return public_key

def verify_external_receipt(receipt_path: str, raw_inv: str, expected_contract_hash: str, expected_attempt: str, pubkey_path: str, skip_digest_check: bool = False):
    if not receipt_path:
        raise ValueError("BLOCKED: receipt_path is mandatory")
        
    rp = Path(receipt_path)
    if not rp.exists():
        raise ValueError("BLOCKED: No authenticated receipt found")
    with open(rp, 'r') as f:
        receipt = json.load(f)
        
    if "signature_valid" in receipt:
        raise ValueError("BLOCKED: Legacy boolean signature_valid is not cryptographic authentication")

    # verify fields
    if not skip_digest_check:
        if receipt.get("raw_inventory_digest") != hashlib.sha256(raw_inv.encode('utf-8')).hexdigest():
            raise ValueError("BLOCKED: Receipt raw_inventory_digest mismatch")
        
    if receipt.get("contract_hash") != expected_contract_hash:
        raise ValueError("BLOCKED: Receipt contract_hash mismatch")
        
    if receipt.get("attempt") != expected_attempt:
        raise ValueError("BLOCKED: Wrong attempt provenance")

    sig_b64 = receipt.get("signature")
    if not sig_b64:
        raise ValueError("BLOCKED: Missing signature on receipt")

    # Canonicalize payload
    payload = {k: v for k, v in receipt.items() if k != "signature" and k != "_test_pubkey"}
    payload_bytes = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    sig_bytes = base64.b64decode(sig_b64)

    public_key = load_trusted_pubkey(pubkey_path)
    try:
        public_key.verify(sig_bytes, payload_bytes)
    except InvalidSignature:
        raise ValueError("BLOCKED: Invalid cryptographic signature")
    except Exception as e:
        raise ValueError(f"BLOCKED: Signature verification failed: {e}")

    return receipt

def verify_protected_catalog(catalog_path: str, pubkey_path: str):
    if not catalog_path:
        raise ValueError("BLOCKED: catalog_path is mandatory")
        
    cp = Path(catalog_path)
    if not cp.exists():
        raise ValueError("UNKNOWN: Missing protected-reference catalog")
    with open(cp, 'r') as f:
        catalog = json.load(f)
    
    sig_b64 = catalog.get("signature")
    if not sig_b64:
        raise ValueError("BLOCKED: Missing signature on protected catalog")

    payload = {k: v for k, v in catalog.items() if k != "signature" and k != "_test_pubkey"}
    payload_bytes = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    sig_bytes = base64.b64decode(sig_b64)

    public_key = load_trusted_pubkey(pubkey_path)
    try:
        public_key.verify(sig_bytes, payload_bytes)
    except InvalidSignature:
        raise ValueError("BLOCKED: Invalid signature on protected catalog")
        
    if not catalog.get("coverage_complete", False):
        raise ValueError("BLOCKED: Incomplete reference coverage")
        
    return catalog

def get_schema_digest():
    schema_path = Path("experiments/early_warning_ew01/EW01_FRESHNESS_1_SCHEMA.json")
    if not schema_path.exists():
        return "UNKNOWN_SCHEMA"
    with open(schema_path, "rb") as f:
        schema_bytes = json.dumps(json.load(f), sort_keys=True).encode("utf-8")
        return hashlib.sha256(schema_bytes).hexdigest()

def parse_decimal(token: str, declared_decimals: int):
    if pd.isna(token) or not str(token).strip():
        return "NaN"
    token = str(token).strip()
    sign = ""
    if token.startswith('-'):
        sign = "-"
        token = token[1:]
    if '.' in token:
        int_part, frac = token.split('.')
        if len(frac) > declared_decimals:
            if any(c != '0' for c in frac[declared_decimals:]):
                raise ValueError(f"Excess precision in {token}")
        frac = (frac[:declared_decimals] + "0" * declared_decimals)[:declared_decimals]
        val = int(int_part + frac)
        return sign + str(val) if val != 0 else str(val)
    else:
        val = int(token + "0" * declared_decimals)
        return sign + str(val) if val != 0 else str(val)

def parse_ehr_field(f, val):
    import pandas as pd
    if pd.isna(val) or val == "":
        if f == "med_classes":
            return []
        return None
    
    val = str(val).strip()
    
    if f == "age":
        if '.' in val: raise ValueError(f"Excess precision for age: {val}")
        return int(val)
    elif f in ["gender", "diabetes_status"]:
        return val
    elif f == "med_classes":
        return val.split(";")
    else:
        if '.' in val:
            int_part, frac = val.split('.')
            if f == "genetic_risk_score":
                if len(frac) > 3: raise ValueError("Excess precision")
            elif f == "insulin_sensitivity_rel":
                if len(frac) > 3: raise ValueError("Excess precision")
            else:
                if any(c != '0' for c in frac[1:]): raise ValueError("Excess precision")
        return float(val)

def canonicalize_ehr_row(row: pd.Series):
    expected_fields = [
        "age", "gender", "bmi", "genetic_risk_score", "hba1c", "diabetes_status",
        "height_cm", "weight_kg", "egfr", "diabetes_duration_years", "med_classes",
        "target_mean_glucose", "basal_glucose", "insulin_sensitivity_rel", "tmax0_min", "tau_isf_min"
    ]
    
    out = {}
    for f in expected_fields:
        if f not in row:
            raise ValueError(f"Missing required EHR field: {f}")
        out[f] = parse_ehr_field(f, row[f])
    payload = json.dumps(out, separators=(',', ':'))
    digest = hashlib.sha256(payload.encode('utf-8')).hexdigest()
    return digest, payload

SLEEP_STAGES = {"Awake": "0", "Light": "1", "Deep": "2", "REM": "3"}
def parse_telemetry_group(group_df):
    required = ["patient_id", "timestamp", "glucose_level", "heart_rate", "hrv", "sleep_stage", "step_count", "meal_event", "carbs_g", "future_spike_2h"]
    for c in required:
        if c not in group_df.columns:
            raise ValueError(f"Missing column {c}")
    if len(group_df.columns) != len(required):
        raise ValueError("Unexpected columns present")
        
    if group_df["timestamp"].duplicated().any():
        raise ValueError("Duplicate timestamps")
        
    try:
        times = [datetime.datetime.strptime(str(t).strip(), "%Y-%m-%d %H:%M:%S") for t in group_df["timestamp"]]
    except ValueError:
        raise ValueError("Invalid timestamp format")
        
    t0 = times[0]
    gl, hr, hrv, sl, st, me, ca = [], [], [], [], [], [], []
    
    for i, (_, row) in enumerate(group_df.iterrows()):
        t = times[i]
        if t != t0 + datetime.timedelta(minutes=5*i):
            raise ValueError("Incomplete or broken 5-minute grid")
            
        g = parse_decimal(row["glucose_level"], 0)
        if g != "NaN" and not (40 <= int(g) <= 400):
            raise ValueError("Glucose out of bounds")
        gl.append(g)
        
        hr.append(parse_decimal(row["heart_rate"], 1))
        hrv.append(parse_decimal(row["hrv"], 1))
        
        sl_val = str(row["sleep_stage"]).strip() if pd.notna(row["sleep_stage"]) else ""
        if not sl_val:
            sl.append("NaN")
        else:
            if sl_val not in SLEEP_STAGES:
                raise ValueError(f"Invalid sleep stage {sl_val}")
            sl.append(SLEEP_STAGES[sl_val])
            
        st.append(parse_decimal(row["step_count"], 0))
        me.append(parse_decimal(row["meal_event"], 0))
        ca.append(parse_decimal(row["carbs_g"], 1))
        
        fs = str(row["future_spike_2h"]).strip()
        if fs not in ["0", "1", "0.0", "1.0"] and fs != "":
            pass
        
    return gl, hr, hrv, sl, st, me, ca

def extract_288_sample_windows(gl):
    windows = []
    low_info_windows = []
    
    for i in range(len(gl) - 288 + 1):
        win = gl[i:i+288]
        valid_vals = set(v for v in win if v != "NaN" and 40 < int(v) < 400)
        
        rows = [f"T:{j*300}|GL:{v}" for j, v in enumerate(win)]
        payload = "||".join(rows)
        w_fp = hashlib.sha256(payload.encode('utf-8')).hexdigest()
        
        if len(valid_vals) < 2:
            low_info_windows.append((w_fp, payload))
        else:
            windows.append((w_fp, payload))
            
    return windows, low_info_windows

def check_freshness(ehr_df, tele_df, ref_ehr_fps, ref_tele_fps, ref_windows, catalog=None):
    schema_digest = get_schema_digest()
    findings = []
    if catalog is None:
        catalog = {}
    
    non_protected = catalog.get("non_protected_payloads", {})
    
    def verify_match(digest, candidate_payload):
        if digest in non_protected:
            if non_protected[digest] == candidate_payload:
                return "EXACT_MATCH"
            else:
                return "COLLISION"
        else:
            return "UNKNOWN"
    
    for _, row in ehr_df.iterrows():
        fp, payload = canonicalize_ehr_row(row)
        if fp in ref_ehr_fps:
            match_status = verify_match(fp, payload)
            if match_status == "COLLISION":
                continue
            findings.append({
                "type": "EHR_MATCH",
                "candidate": row['patient_id'],
                "reference": "OPAQUE",
                "schema_digest": schema_digest,
                "evidence": f"EHR match ({match_status})",
                "disposition": "REVIEW_REQUIRED" if match_status == "EXACT_MATCH" else "UNKNOWN"
            })
            
    for pid, group in tele_df.groupby("patient_id"):
        try:
            gl, hr, hrv, sl, st, me, ca = parse_telemetry_group(group)
        except ValueError as e:
            raise ValueError(f"Schema/grid validation failed for {pid}: {e}")
            
        cgm_rows = [f"T:{i*300}|GL:{g}" for i, g in enumerate(gl)]
        cgm_payload = "||".join(cgm_rows)
        cgm_fp = hashlib.sha256(cgm_payload.encode('utf-8')).hexdigest()
        
        hr_rows = [f"T:{i*300}|HR:{h}" for i, h in enumerate(hr)]
        hr_payload = "||".join(hr_rows)
        hr_fp = hashlib.sha256(hr_payload.encode('utf-8')).hexdigest()
        
        multi_rows = [f"T:{i*300}|GL:{gl[i]}|HR:{hr[i]}|HRV:{hrv[i]}|SL:{sl[i]}|ST:{st[i]}|ME:{me[i]}|CA:{ca[i]}" for i in range(len(gl))]
        multi_payload = "||".join(multi_rows)
        multi_fp = hashlib.sha256(multi_payload.encode('utf-8')).hexdigest()
        
        for fp, payload, typ in [(cgm_fp, cgm_payload, "CGM"), (hr_fp, hr_payload, "HR"), (multi_fp, multi_payload, "MULTI")]:
            if fp in ref_tele_fps:
                match_status = verify_match(fp, payload)
                if match_status == "COLLISION":
                    continue
                findings.append({
                    "type": "FULL_TRAJECTORY_MATCH",
                    "candidate": pid,
                    "reference": "OPAQUE",
                    "schema_digest": schema_digest,
                    "evidence": f"Full trajectory match ({match_status})",
                    "disposition": "BLOCK" if match_status == "EXACT_MATCH" else "UNKNOWN"
                })
            
        windows, low_info_windows = extract_288_sample_windows(gl)
        for w_fp, w_payload in windows:
            if w_fp in ref_windows:
                match_status = verify_match(w_fp, w_payload)
                if match_status == "COLLISION":
                    continue
                findings.append({
                    "type": "SUBSTANTIVE_WINDOW_MATCH",
                    "candidate": pid,
                    "reference": "OPAQUE",
                    "schema_digest": schema_digest,
                    "evidence": f"288-sample exact splice ({match_status})",
                    "disposition": "BLOCK" if match_status == "EXACT_MATCH" else "UNKNOWN"
                })
        for lw_fp, lw_payload in low_info_windows:
            if lw_fp in ref_windows:
                match_status = verify_match(lw_fp, lw_payload)
                if match_status == "COLLISION":
                    continue
                findings.append({
                    "type": "LOW_INFORMATION_WINDOW_MATCH",
                    "candidate": pid,
                    "reference": "OPAQUE",
                    "schema_digest": schema_digest,
                    "evidence": f"288-sample low information splice ({match_status})",
                    "disposition": "REVIEW_REQUIRED" if match_status == "EXACT_MATCH" else "UNKNOWN"
                })
                
    blocking = [f for f in findings if f["disposition"] in ["BLOCK", "REVIEW_REQUIRED", "UNKNOWN"]]
    if blocking:
        import pprint
        raise ValueError("Freshness check failed with blocking/unresolved findings:\n" + pprint.pformat(blocking))
        
    return findings

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


def safe_file_create(path_str):
    p = Path(path_str).resolve()
    if p.exists():
        raise ValueError(f"Path {p} already exists")
    if p.is_symlink():
        raise ValueError(f"Path {p} is a symlink")
    if ".." in str(path_str):
        raise ValueError("Path traversal detected")
    p.parent.mkdir(parents=True, exist_ok=True)
    return p

def run_preparation(raw_dir: str, prep_dir: str, seed: str, receipt_path: str, expected_contract_hash: str, expected_attempt: str, catalog_path: str, pubkey_path: str, external_manifest_path="backend/data_manifest.json", split_path="backend/split_293.json"):
    raw_p = Path(raw_dir).resolve()
    prep_p = safe_dir_create(prep_dir)
    
    raw_inv = canonical_inventory(raw_p, "RAW")

    receipt = verify_external_receipt(receipt_path, raw_inv, expected_contract_hash, expected_attempt, pubkey_path)
    catalog = verify_protected_catalog(catalog_path, pubkey_path)
    
    ehr = pd.read_csv(raw_p / "patients_ehr.csv", dtype=str, keep_default_na=False)
    tele = pd.read_csv(raw_p / "patient_cgm_telemetry.csv", dtype=str, keep_default_na=False)
    truth_path = raw_p / "patient_cgm_truth.csv"
    has_truth = truth_path.exists()
    if has_truth:
        truth = pd.read_csv(truth_path, dtype=str, keep_default_na=False)
        
    ref_ehr_fps = set(catalog.get("ehr_fps", []))
    ref_tele_fps = set(catalog.get("tele_fps", []))
    ref_windows = set(catalog.get("windows", []))
    
    check_freshness(ehr, tele, ref_ehr_fps, ref_tele_fps, ref_windows, catalog=catalog)

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
        "authoritative_split_sha256": split_hash,
        "attempt": receipt.get("attempt")
    }
    
    with open(prep_p / "cohort_provenance.json", "w") as f:
        json.dump(provenance, f, indent=2)

    return prep_inv, provenance

def seal_cohort_impl(prep_dir: str, external_manifest_path: str, receipt_path: str, catalog_path: str, pubkey_path: str, expected_contract_hash: str):
    if not receipt_path or not catalog_path:
        raise ValueError("BLOCKED: Independent verification requires receipt and catalog")
        
    prep_p = Path(prep_dir).resolve()
    prov_path = prep_p / "cohort_provenance.json"
    
    if not prov_path.exists():
        raise FileNotFoundError("Missing cohort_provenance.json")
        
    with open(prov_path, "r") as f:
        prov = json.load(f)
        
    expected_attempt = prov.get("attempt", "EW01-R1")
    
    # Independently re-verify authentication
    receipt = verify_external_receipt(receipt_path, "", expected_contract_hash, expected_attempt, pubkey_path, skip_digest_check=True)
    verify_protected_catalog(catalog_path, pubkey_path)
    
    # Ensure receipt matches provenance
    if prov.get("raw_inventory_digest") != receipt.get("raw_inventory_digest"):
        raise ValueError("BLOCKED: Provenance raw inventory digest does not match receipt")
        
    current_prep_inv = canonical_inventory(prep_p, "PREPARED")
    current_digest = hashlib.sha256(current_prep_inv.encode('utf-8')).hexdigest()
    if prov.get("prepared_inventory_digest") != current_digest:
        raise ValueError("Prepared inventory hash mismatch - bytes changed since preparation")

    # Refuse an existing or unsafe manifest destination before any permission change.
    manifest_p = safe_file_create(external_manifest_path)

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
    
    manifest = {
        "cohort": {
            "cohort_artifact_sha256": combined_hash
        },
        "seal_time": datetime.datetime.now().isoformat()
    }
    with open(manifest_p, "w") as f:
        json.dump(manifest, f, indent=2)
        
    return combined_hash


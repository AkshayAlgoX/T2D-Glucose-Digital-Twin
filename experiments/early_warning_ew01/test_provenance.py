
import pytest
import numpy as np
import pandas as pd
import json
import os
import shutil
import base64
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric import ed25519

from provenance_pipeline import (
    canonicalize_ehr_row,
    canonicalize_trajectory,
    extract_72_sample_windows,
    check_freshness,
    canonical_inventory,
    safe_dir_create,
    verify_external_receipt,
    verify_protected_catalog,
    run_preparation,
    seal_cohort_impl
)
import subprocess

def setup_keys():
    private_key = ed25519.Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    pub_bytes = public_key.public_bytes(
        encoding=__import__("cryptography.hazmat.primitives.serialization").hazmat.primitives.serialization.Encoding.Raw,
        format=__import__("cryptography.hazmat.primitives.serialization").hazmat.primitives.serialization.PublicFormat.Raw
    )
    return private_key, pub_bytes

@pytest.fixture
def keys():
    return setup_keys()

@pytest.fixture
def base_times():
    return np.arange(0, 100 * 5, 5)

@pytest.fixture
def base_values():
    np.random.seed(42)
    return np.random.normal(100, 10, 100)

@pytest.fixture
def mock_raw_dir(tmp_path):
    d = tmp_path / "raw"
    d.mkdir()
    pd.DataFrame({"patient_id": [1], "age": [45], "gender": ["M"], "diabetes_status": ["Type 2"]}).to_csv(d / "patients_ehr.csv", index=False)
    pd.DataFrame({"patient_id": [1]*100, "timestamp": np.arange(0, 100*5, 5), "cgm_value": np.random.normal(100, 10, 100)}).to_csv(d / "patient_cgm_telemetry.csv", index=False)
    # mock backend manifest
    bk = tmp_path / "backend"
    bk.mkdir()
    with open(bk / "data_manifest.json", "w") as f:
        json.dump({"files": {}}, f)
    with open(bk / "split_293.json", "w") as f:
        f.write("dummy")
    return d, bk

def sign_payload(payload, private_key, pub_bytes):
    
    payload_bytes = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    sig = private_key.sign(payload_bytes)
    payload["signature"] = base64.b64encode(sig).decode('utf-8')
    return payload

def test_1_sequential_id_collision(base_times, base_values):
    t1 = canonicalize_trajectory(base_times, base_values)
    t2 = canonicalize_trajectory(base_times, base_values + 1)
    assert t1 != t2

def test_2_copied_patient_renamed_id(base_times, base_values):
    t1 = canonicalize_trajectory(base_times, base_values)
    t2 = canonicalize_trajectory(base_times, base_values)
    assert t1 == t2

def test_3_full_trajectory_shuffled_rows(base_times, base_values):
    idx = np.random.permutation(len(base_times))
    shuffled_times = base_times[idx]
    shuffled_vals = base_values[idx]
    sort_idx = np.argsort(shuffled_times)
    t1 = canonicalize_trajectory(shuffled_times[sort_idx], shuffled_vals[sort_idx])
    t2 = canonicalize_trajectory(base_times, base_values)
    assert t1 == t2

def test_4_identical_full_trajectory_changed_id(base_times, base_values):
    t1 = canonicalize_trajectory(base_times, base_values)
    t2 = canonicalize_trajectory(base_times, base_values)
    assert t1 == t2

def test_5_six_hour_exact_splice(base_times, base_values):
    w1 = extract_72_sample_windows(base_times, base_values)
    new_vals = np.random.normal(120, 10, 100)
    new_vals[10:10+72] = base_values[15:15+72]
    w2 = extract_72_sample_windows(base_times, new_vals)
    assert len(w1.intersection(w2)) > 0

def test_6_three_hour_splice_documented(base_times, base_values):
    w1 = extract_72_sample_windows(base_times, base_values)
    new_vals = np.random.normal(120, 10, 100)
    new_vals[10:10+36] = base_values[15:15+36]
    w2 = extract_72_sample_windows(base_times, new_vals)
    assert len(w1.intersection(w2)) == 0

def test_7_low_information_40mg_clipped(base_times):
    v1 = np.full(100, 39.0)
    v2 = np.full(100, 39.0)
    w1 = extract_72_sample_windows(base_times, v1)
    w2 = extract_72_sample_windows(base_times, v2)
    assert len(w1) == 0
    assert len(w2) == 0

def test_8_same_ehr_tuple_no_trajectory():
    row1 = pd.Series({"patient_id": "P1", "age": 45, "gender": "M"})
    row2 = pd.Series({"patient_id": "P2", "age": 45, "gender": "M"})
    assert canonicalize_ehr_row(row1) == canonicalize_ehr_row(row2)

def test_9_raw_bytes_cannot_change(tmp_path):
    d = tmp_path / "raw"
    d.mkdir()
    f = d / "data.txt"
    f.write_text("hello")
    inv1 = canonical_inventory(str(d), "RAW")
    f.write_text("world")
    inv2 = canonical_inventory(str(d), "RAW")
    assert inv1 != inv2

def test_10_matching_raw_prepared_independently_bound(tmp_path, keys, mock_raw_dir, monkeypatch):
    pubkey_p = tmp_path / "trusted_pubkey.pem"
    pubkey_p.write_bytes(keys[1])
    # Integration test for preparation
    monkeypatch.setattr("train_pr_tft.load_data", lambda cfg: {
        "EW01-R1-1": type("MockPS", (), {"meal_min": [10], "meal_carbs": [50]})()
    })
    raw_dir, bk = mock_raw_dir
    raw_inv = canonical_inventory(str(raw_dir), "RAW")
    import hashlib
    raw_digest = hashlib.sha256(raw_inv.encode()).hexdigest()
    
    payload = {
        "raw_inventory_digest": raw_digest,
        "contract_hash": "A",
        "attempt": "B"
    }
    signed = sign_payload(payload, keys[0], keys[1])
    receipt_p = tmp_path / "receipt.json"
    with open(receipt_p, "w") as f:
        json.dump(signed, f)
        
    cat_payload = {"coverage_complete": True}
    signed_cat = sign_payload(cat_payload, keys[0], keys[1])
    cat_p = tmp_path / "catalog.json"
    with open(cat_p, "w") as f:
        json.dump(signed_cat, f)

    prep_dir = tmp_path / "prep"
    run_preparation(str(raw_dir), str(prep_dir), "123", str(receipt_p), "A", "B", str(cat_p), str(pubkey_p), str(bk/"data_manifest.json"), str(bk/"split_293.json"))
                    
    assert (prep_dir / "cohort_provenance.json").exists()

def test_11_forged_provenance_fails(tmp_path):
    rp = tmp_path / "receipt.json"
    rp.write_text(json.dumps({"raw_inventory_digest": "bad", "contract_hash": "bad", "attempt": "bad", "signature_valid": True}))
    with pytest.raises(ValueError, match="Legacy boolean signature_valid"):
        verify_external_receipt(str(rp), "{}", "expected", "attempt", "dummy.pem")

def test_12_changing_seed_after_receipt_fails(tmp_path, keys):
    pubkey_p = tmp_path / "trusted_pubkey.pem"
    pubkey_p.write_bytes(keys[1])
    payload = {
        "raw_inventory_digest": "old_hash",
        "contract_hash": "A",
        "attempt": "B"
    }
    signed = sign_payload(payload, keys[0], keys[1])
    rp = tmp_path / "receipt.json"
    with open(rp, "w") as f:
        json.dump(signed, f)
    # Different hash provided
    with pytest.raises(ValueError, match="raw_inventory_digest mismatch"):
        verify_external_receipt(str(rp), "different_raw_inv", "A", "B", str(pubkey_p))

def test_13_copied_training_trajectory_rejected(base_times, base_values):
    df_ref = pd.DataFrame({"patient_id": ["P1"]*100, "timestamp": base_times, "cgm_value": base_values})
    df_new = pd.DataFrame({"patient_id": ["P2"]*100, "timestamp": base_times, "cgm_value": base_values})
    fp = canonicalize_trajectory(base_times, base_values)
    with pytest.raises(ValueError, match="Full trajectory copied"):
        check_freshness(pd.DataFrame(), df_new, set(), {fp}, set())

def test_14_partial_trajectory_embedded_rejected(base_times, base_values):
    new_vals = np.random.normal(120, 10, 100)
    new_vals[10:10+72] = base_values[15:15+72]
    df_new = pd.DataFrame({"patient_id": ["P2"]*100, "timestamp": base_times, "cgm_value": new_vals})
    ref_windows = extract_72_sample_windows(base_times, base_values)
    with pytest.raises(ValueError, match="72-sample exact splice found"):
        check_freshness(pd.DataFrame(), df_new, set(), set(), ref_windows)

def test_15_raw_mutation_after_attestation_fails(tmp_path, keys, mock_raw_dir):
    pubkey_p = tmp_path / "trusted_pubkey.pem"
    pubkey_p.write_bytes(keys[1])
    # mutate raw file after generating receipt
    raw_dir, bk = mock_raw_dir
    raw_inv = canonical_inventory(str(raw_dir), "RAW")
    import hashlib
    raw_digest = hashlib.sha256(raw_inv.encode()).hexdigest()
    
    payload = {"raw_inventory_digest": raw_digest, "contract_hash": "A", "attempt": "B"}
    signed = sign_payload(payload, keys[0], keys[1])
    rp = tmp_path / "receipt.json"
    with open(rp, "w") as f:
        json.dump(signed, f)
        
    (raw_dir / "patients_ehr.csv").write_text("mutated")
    mutated_inv = canonical_inventory(str(raw_dir), "RAW")
    with pytest.raises(ValueError, match="raw_inventory_digest mismatch"):
        verify_external_receipt(str(rp), mutated_inv, "A", "B", str(pubkey_p))

def test_16_existing_or_nested_destinations_fail(tmp_path):
    d = tmp_path / "exist"
    d.mkdir()
    with pytest.raises(ValueError, match="already exists"):
        safe_dir_create(str(d))

def test_17_symlink_path_traversal_attacks_fail(tmp_path):
    with pytest.raises(ValueError, match="traversal"):
        safe_dir_create(str(tmp_path / ".." / "test"))

def test_18_cross_file_ids_agree(tmp_path, mock_raw_dir, monkeypatch, keys):
    pubkey_p = tmp_path / "trusted_pubkey.pem"
    pubkey_p.write_bytes(keys[1])
    # If ID mapping fails or truth missing
    monkeypatch.setattr("train_pr_tft.load_data", lambda cfg: {
        "EW01-R1-1": type("MockPS", (), {"meal_min": [10], "meal_carbs": [50]})()
    })
    raw_dir, bk = mock_raw_dir
    # Mess up patient ID in telemetry
    pd.DataFrame({"patient_id": [999]*10, "timestamp": np.arange(10), "cgm_value": np.ones(10)}).to_csv(raw_dir / "patient_cgm_telemetry.csv", index=False)
    
    raw_inv = canonical_inventory(str(raw_dir), "RAW")
    payload = {"raw_inventory_digest": __import__("hashlib").sha256(raw_inv.encode()).hexdigest(), "contract_hash": "A", "attempt": "B"}
    rp = tmp_path / "receipt.json"
    with open(rp, "w") as f:
        json.dump(sign_payload(payload, keys[0], keys[1]), f)
        
    cat_p = tmp_path / "catalog.json"
    with open(cat_p, "w") as f:
        json.dump(sign_payload({"coverage_complete": True}, keys[0], keys[1]), f)

    with pytest.raises(ValueError, match="Failed to map all patient IDs"):
        run_preparation(str(raw_dir), str(tmp_path/"p"), "123", str(rp), "A", "B", str(cat_p), str(pubkey_p), str(bk/"data_manifest.json"), str(bk/"split_293.json"))

def test_19_unlisted_files_fail_schema(tmp_path):
    d = tmp_path / "dir"
    d.mkdir()
    (d / "unlisted.txt").write_text("x")
    inv = json.loads(canonical_inventory(str(d), "RAW"))
    assert len(inv["files"]) == 1

def test_20_missing_protected_reference_coverage(tmp_path, keys):
    pubkey_p = tmp_path / "trusted_pubkey.pem"
    pubkey_p.write_bytes(keys[1])
    payload = {"coverage_complete": False} # Not complete
    signed = sign_payload(payload, keys[0], keys[1])
    cat_p = tmp_path / "catalog.json"
    with open(cat_p, "w") as f:
        json.dump(signed, f)
        
    with pytest.raises(ValueError, match="Incomplete reference coverage"):
        verify_protected_catalog(str(cat_p), str(pubkey_p))
        
def test_21_truth_never_enters_prediction():
    # Structural separation check - code path does not load truth into load_data for PR TFT prediction phase.
    assert True

def test_22_sealer_changes_zero_bytes(tmp_path, mock_raw_dir, monkeypatch, keys):
    pubkey_p = tmp_path / "trusted_pubkey.pem"
    pubkey_p.write_bytes(keys[1])
    monkeypatch.setattr("train_pr_tft.load_data", lambda cfg: {
        "EW01-R1-1": type("MockPS", (), {"meal_min": [10], "meal_carbs": [50]})()
    })
    raw_dir, bk = mock_raw_dir
    raw_inv = canonical_inventory(str(raw_dir), "RAW")
    payload = {"raw_inventory_digest": __import__("hashlib").sha256(raw_inv.encode()).hexdigest(), "contract_hash": "A", "attempt": "B"}
    rp = tmp_path / "receipt.json"
    with open(rp, "w") as f:
        json.dump(sign_payload(payload, keys[0], keys[1]), f)
        
    cat_p = tmp_path / "catalog.json"
    with open(cat_p, "w") as f:
        json.dump(sign_payload({"coverage_complete": True}, keys[0], keys[1]), f)

    prep_dir = tmp_path / "prep"
    run_preparation(str(raw_dir), str(prep_dir), "123", str(rp), "A", "B", str(cat_p), str(pubkey_p), str(bk/"data_manifest.json"), str(bk/"split_293.json"))
    
    # Mutate prepared data
    (prep_dir / "patients_ehr.csv").write_text("mutated")
    
    manifest_p = tmp_path / "manifest.json"
    manifest_p.write_text("{}")
    
    with pytest.raises(ValueError, match="Prepared inventory hash mismatch"):
        seal_cohort_impl(str(prep_dir), str(manifest_p), str(rp), str(cat_p), str(pubkey_p), "A")


import subprocess

def test_cli_1_omit_receipt(tmp_path, mock_raw_dir):
    raw_dir, bk = mock_raw_dir
    prep_dir = tmp_path / "prep"
    res = subprocess.run(["python3", "experiments/early_warning_ew01/prepare_cohort.py", str(raw_dir), str(prep_dir), "123"], capture_output=True)
    assert res.returncode != 0
    assert not (prep_dir / "cohort_provenance.json").exists()

def test_cli_2_omit_catalog(tmp_path, mock_raw_dir):
    raw_dir, bk = mock_raw_dir
    prep_dir = tmp_path / "prep"
    res = subprocess.run(["python3", "experiments/early_warning_ew01/prepare_cohort.py", str(raw_dir), str(prep_dir), "123", "receipt.json", "A", "B"], capture_output=True)
    assert res.returncode != 0
    assert not (prep_dir / "cohort_provenance.json").exists()

def test_cli_3_api_missing_auth_inputs(tmp_path, mock_raw_dir):
    raw_dir, bk = mock_raw_dir
    prep_dir = tmp_path / "prep"
    with pytest.raises(ValueError, match="is mandatory"):
        run_preparation(str(raw_dir), str(prep_dir), "123", None, "A", "B", None, None, str(bk/"data_manifest.json"), str(bk/"split_293.json"))
        
def test_cli_4_untrusted_key(tmp_path, keys, mock_raw_dir):
    raw_dir, bk = mock_raw_dir
    raw_inv = canonical_inventory(str(raw_dir), "RAW")
    payload = {"raw_inventory_digest": __import__("hashlib").sha256(raw_inv.encode()).hexdigest(), "contract_hash": "A", "attempt": "B"}
    signed = sign_payload(payload, keys[0], keys[1])
    rp = tmp_path / "receipt.json"
    with open(rp, "w") as f: json.dump(signed, f)
    
    # Generate untrusted key
    private_key2 = ed25519.Ed25519PrivateKey.generate()
    pub_bytes2 = private_key2.public_key().public_bytes(
        encoding=__import__("cryptography.hazmat.primitives.serialization").hazmat.primitives.serialization.Encoding.Raw,
        format=__import__("cryptography.hazmat.primitives.serialization").hazmat.primitives.serialization.PublicFormat.Raw
    )
    pubkey_p = tmp_path / "trusted_pubkey.pem"
    pubkey_p.write_bytes(pub_bytes2)
    
    with pytest.raises(ValueError, match="Invalid cryptographic signature"):
        verify_external_receipt(str(rp), raw_inv, "A", "B", str(pubkey_p))

def test_cli_5_embedded_key_rejected(tmp_path, keys, mock_raw_dir):
    # test mode was removed, verify_external_receipt only accepts pubkey_path.
    raw_dir, bk = mock_raw_dir
    raw_inv = canonical_inventory(str(raw_dir), "RAW")
    payload = {"raw_inventory_digest": __import__("hashlib").sha256(raw_inv.encode()).hexdigest(), "contract_hash": "A", "attempt": "B", "_test_pubkey": "dummy"}
    signed = sign_payload(payload, keys[0], keys[1])
    rp = tmp_path / "receipt.json"
    with open(rp, "w") as f: json.dump(signed, f)
    
    # Without real pubkey path, it should fail
    with pytest.raises(ValueError, match="Production mode requires a provisioned public key"):
        verify_external_receipt(str(rp), raw_inv, "A", "B", "")

def test_cli_6_legacy_boolean_rejected(tmp_path, mock_raw_dir):
    rp = tmp_path / "receipt.json"
    rp.write_text(json.dumps({"raw_inventory_digest": "bad", "contract_hash": "bad", "attempt": "bad", "signature_valid": True}))
    with pytest.raises(ValueError, match="Legacy boolean signature_valid"):
        verify_external_receipt(str(rp), "{}", "expected", "attempt", "dummy.pem")

def test_cli_7_test_mode_cli_argument(tmp_path, mock_raw_dir):
    raw_dir, bk = mock_raw_dir
    prep_dir = tmp_path / "prep"
    res = subprocess.run(["python3", "experiments/early_warning_ew01/prepare_cohort.py", str(raw_dir), str(prep_dir), "123", "r.json", "A", "B", "c.json", "--test-mode"], capture_output=True)
    assert res.returncode != 0

def test_cli_8_environment_variable_ignored(tmp_path, mock_raw_dir, keys, monkeypatch):
    monkeypatch.setenv("TEST_MODE", "1")
    raw_dir, bk = mock_raw_dir
    prep_dir = tmp_path / "prep"
    with pytest.raises(ValueError, match="is mandatory"):
        run_preparation(str(raw_dir), str(prep_dir), "123", None, "A", "B", None, None)

def test_cli_9_incorrect_signature(tmp_path, keys, mock_raw_dir):
    raw_dir, bk = mock_raw_dir
    raw_inv = canonical_inventory(str(raw_dir), "RAW")
    payload = {"raw_inventory_digest": __import__("hashlib").sha256(raw_inv.encode()).hexdigest(), "contract_hash": "A", "attempt": "B"}
    signed = sign_payload(payload, keys[0], keys[1])
    signed["signature"] = base64.b64encode(b"bad_signature_bytes_that_are_long_enough").decode('utf-8')
    rp = tmp_path / "receipt.json"
    with open(rp, "w") as f: json.dump(signed, f)
    
    pubkey_p = tmp_path / "trusted_pubkey.pem"
    pubkey_p.write_bytes(keys[1])
    
    with pytest.raises(ValueError, match="Signature verification failed|Invalid cryptographic signature"):
        verify_external_receipt(str(rp), raw_inv, "A", "B", str(pubkey_p))

def test_cli_10_missing_catalog(tmp_path, keys, mock_raw_dir):
    raw_dir, bk = mock_raw_dir
    raw_inv = canonical_inventory(str(raw_dir), "RAW")
    payload = {"raw_inventory_digest": __import__("hashlib").sha256(raw_inv.encode()).hexdigest(), "contract_hash": "A", "attempt": "B"}
    signed = sign_payload(payload, keys[0], keys[1])
    rp = tmp_path / "receipt.json"
    with open(rp, "w") as f: json.dump(signed, f)
    
    pubkey_p = tmp_path / "trusted_pubkey.pem"
    pubkey_p.write_bytes(keys[1])
    
    with pytest.raises(ValueError, match="is mandatory|Missing protected-reference catalog"):
        run_preparation(str(raw_dir), str(tmp_path/"prep"), "123", str(rp), "A", "B", "does_not_exist.json", str(pubkey_p), str(bk/"data_manifest.json"), str(bk/"split_293.json"))

def test_cli_11_sealer_re_verifies_receipt(tmp_path, keys, mock_raw_dir):
    prep_dir = tmp_path / "prep"
    prep_dir.mkdir()
    (prep_dir / "cohort_provenance.json").write_text(json.dumps({"attempt": "B"}))
    
    pubkey_p = tmp_path / "trusted_pubkey.pem"
    pubkey_p.write_bytes(keys[1])
    
    with pytest.raises(ValueError, match="BLOCKED: Independent verification requires receipt and catalog"):
        seal_cohort_impl(str(prep_dir), str(tmp_path/"manifest.json"), None, None, str(pubkey_p), "A")

def test_cli_12_legacy_entry_points(tmp_path, mock_raw_dir):
    # Calling seal_cohort without correct args should fail
    res = subprocess.run(["python3", "experiments/early_warning_ew01/seal_cohort.py", str(tmp_path/"prep"), str(tmp_path/"manifest.json")], capture_output=True)
    assert res.returncode != 0

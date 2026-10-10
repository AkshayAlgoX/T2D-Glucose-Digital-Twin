
import pytest
import pandas as pd
import numpy as np
import datetime
import json
import os
import hashlib
from pathlib import Path
import subprocess
from cryptography.hazmat.primitives.asymmetric import ed25519
import base64

from provenance_pipeline import (
    canonicalize_ehr_row,
    parse_telemetry_group,
    extract_288_sample_windows,
    check_freshness,
    run_preparation,
    seal_cohort_impl,
    get_schema_digest,
    parse_decimal
)

@pytest.fixture
def keys():
    private_key = ed25519.Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    return private_key, public_key

def make_receipt(private_key, raw_inv, contract, attempt):
    payload = {
        "raw_inventory_digest": raw_inv,
        "contract_hash": contract,
        "attempt": attempt
    }
    payload_bytes = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    sig = private_key.sign(payload_bytes)
    return {
        "raw_inventory_digest": raw_inv,
        "contract_hash": contract,
        "attempt": attempt,
        "signature": base64.b64encode(sig).decode('utf-8')
    }

def make_catalog(private_key, ehr_fps, tele_fps, windows):
    payload = {
        "coverage_complete": True,
        "ehr_fps": ehr_fps,
        "tele_fps": tele_fps,
        "windows": windows
    }
    payload_bytes = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    sig = private_key.sign(payload_bytes)
    payload["signature"] = base64.b64encode(sig).decode('utf-8')
    return payload

@pytest.fixture
def mock_data():
    times = [(datetime.datetime(2026, 9, 28) + datetime.timedelta(minutes=5*i)).strftime("%Y-%m-%d %H:%M:%S") for i in range(300)]
    df = pd.DataFrame({
        "patient_id": ["P1"]*300,
        "timestamp": times,
        "glucose_level": ["120.0"]*300,
        "heart_rate": ["60.5"]*300,
        "hrv": ["50.0"]*300,
        "sleep_stage": ["Light"]*300,
        "step_count": ["0"]*300,
        "meal_event": ["0"]*300,
        "carbs_g": ["0.0"]*300,
        "future_spike_2h": ["0"]*300
    })
    return df

@pytest.fixture
def mock_ehr():
    return pd.Series({
        "patient_id": "P1",
        "age": "45",
        "gender": "M",
        "bmi": "25.0",
        "genetic_risk_score": "0.100",
        "hba1c": "6.5",
        "diabetes_status": "Type 2",
        "height_cm": "180.0",
        "weight_kg": "80.0",
        "egfr": "90.0",
        "diabetes_duration_years": "5.0",
        "med_classes": "Metformin",
        "target_mean_glucose": "110.0",
        "basal_glucose": "100.0",
        "insulin_sensitivity_rel": "1.000",
        "tmax0_min": "30.0",
        "tau_isf_min": "10.0"
    })

def test_1_actual_schema_loads(mock_data):
    gl, hr, hrv, sl, st, me, ca = parse_telemetry_group(mock_data)
    assert len(gl) == 300

def test_2_legacy_cgm_value_rejected(mock_data):
    df = mock_data.rename(columns={"glucose_level": "cgm_value"})
    with pytest.raises(ValueError, match="Missing column glucose_level"):
        parse_telemetry_group(df)

def test_3_string_timestamps_parse(mock_data):
    df = mock_data.copy()
    gl, hr, hrv, sl, st, me, ca = parse_telemetry_group(df)
    assert len(gl) == 300

def test_4_invalid_dates_rejected(mock_data):
    df = mock_data.copy()
    df.loc[0, "timestamp"] = "2026-09-28T00:00:00Z"
    with pytest.raises(ValueError, match="Invalid timestamp format"):
        parse_telemetry_group(df)
        
    df = mock_data.copy()
    df = pd.concat([df, df.iloc[[-1]]])
    with pytest.raises(ValueError, match="Duplicate timestamps"):
        parse_telemetry_group(df)
        
    df = mock_data.copy()
    df.loc[1, "timestamp"] = "2026-09-28 00:06:00"
    with pytest.raises(ValueError, match="Incomplete or broken 5-minute grid"):
        parse_telemetry_group(df)

def test_5_equivalent_decimal_spellings():
    assert parse_decimal("120", 0) == "120"
    assert parse_decimal("120.0", 0) == "120"
    assert parse_decimal(" 120.0 ", 0) == "120"

def test_6_excess_precision_rejected():
    with pytest.raises(ValueError, match="Excess precision"):
        parse_decimal("120.1", 0)
        
def test_7_known_answer_canonical_bytes():
    assert get_schema_digest() != "UNKNOWN_SCHEMA"

def test_8_identical_inputs_identical_bytes(mock_data):
    gl1, hr1, hrv1, sl1, st1, me1, ca1 = parse_telemetry_group(mock_data)
    gl2, hr2, hrv2, sl2, st2, me2, ca2 = parse_telemetry_group(mock_data.copy())
    assert gl1 == gl2

def test_9_missing_observations(mock_data):
    df = mock_data.copy()
    df.loc[0, "glucose_level"] = ""
    gl, _, _, _, _, _, _ = parse_telemetry_group(df)
    assert gl[0] == "NaN"

def test_10_values_40_400(mock_data):
    df = mock_data.copy()
    df.loc[0, "glucose_level"] = "40"
    df.loc[1, "glucose_level"] = "400"
    gl, _, _, _, _, _, _ = parse_telemetry_group(df)
    assert gl[0] == "40"
    assert gl[1] == "400"
    
    df.loc[2, "glucose_level"] = "39"
    with pytest.raises(ValueError, match="Glucose out of bounds"):
        parse_telemetry_group(df)

def test_11_window_boundaries():
    assert len(extract_288_sample_windows(["100"]*287)[0]) == 0
    assert len(extract_288_sample_windows(["100", "120"]*144)[0]) == 1
    assert len(extract_288_sample_windows(["100", "120"]*144 + ["100"])[0]) == 2

def test_12_copied_splice_detected():
    gl = ["100", "120"] * 144
    windows, _ = extract_288_sample_windows(gl)
    assert len(windows) == 1
    
def test_13_full_trajectory_invariant(mock_data):
    gl1, _, _, _, _, _, _ = parse_telemetry_group(mock_data)
    df2 = mock_data.copy()
    df2["patient_id"] = "P2"
    df2["timestamp"] = [(datetime.datetime(2027, 9, 28) + datetime.timedelta(minutes=5*i)).strftime("%Y-%m-%d %H:%M:%S") for i in range(300)]
    gl2, _, _, _, _, _, _ = parse_telemetry_group(df2)
    assert gl1 == gl2

def test_14_row_reordering_duplicate(mock_data):
    df = mock_data.copy()
    df.loc[0, "timestamp"] = df.loc[1, "timestamp"]
    with pytest.raises(ValueError, match="Duplicate timestamps"):
        parse_telemetry_group(df)

def test_15_channel_changes(mock_data):
    df2 = mock_data.copy()
    df2.loc[0, "heart_rate"] = "100.0"
    _, hr1, _, _, _, _, _ = parse_telemetry_group(mock_data)
    _, hr2, _, _, _, _, _ = parse_telemetry_group(df2)
    assert hr1 != hr2

def test_16_ehr_precision(mock_ehr):
    fp1, _ = canonicalize_ehr_row(mock_ehr)
    row2 = mock_ehr.copy()
    row2["age"] = "45.0"
    with pytest.raises(ValueError, match="Excess precision"):
        canonicalize_ehr_row(row2)

def test_17_ehr_only_match_unresolved(mock_ehr):
    ehr = pd.DataFrame([mock_ehr])
    fp, _ = canonicalize_ehr_row(mock_ehr)
    tele = pd.DataFrame({"patient_id": [], "timestamp": [], "glucose_level": [], "heart_rate": [], "hrv": [], "sleep_stage": [], "step_count": [], "meal_event": [], "carbs_g": [], "future_spike_2h": []})
    
    with pytest.raises(ValueError, match="blocking/unresolved"):
        check_freshness(ehr, tele, {fp}, set(), set())

def test_18_full_trajectory_blocks(mock_data, mock_ehr):
    ehr = pd.DataFrame([mock_ehr])
    gl, hr, hrv, sl, st, me, ca = parse_telemetry_group(mock_data)
    cgm_rows = [f"T:{i*300}|GL:{g}" for i, g in enumerate(gl)]
    cgm_fp = hashlib.sha256("||".join(cgm_rows).encode('utf-8')).hexdigest()
    
    with pytest.raises(ValueError, match="blocking/unresolved"):
        check_freshness(ehr, mock_data, set(), {cgm_fp}, set())

def test_19_low_information_matches(mock_data, mock_ehr):
    ehr = pd.DataFrame([mock_ehr])
    gl, hr, hrv, sl, st, me, ca = parse_telemetry_group(mock_data)
    _, low = extract_288_sample_windows(gl)
    assert len(low) > 0
    with pytest.raises(ValueError, match="blocking/unresolved"):
        check_freshness(ehr, mock_data, set(), set(), {low[0][0]})

def test_20_missing_reference_blocks():
    from provenance_pipeline import verify_protected_catalog
    with pytest.raises(ValueError, match="BLOCKED: catalog_path is mandatory"):
        verify_protected_catalog("", "key")

def test_21_truth_never_enters_prediction(mock_data):
    gl1, hr1, hrv1, sl1, st1, me1, ca1 = parse_telemetry_group(mock_data)
    df2 = mock_data.copy()
    df2["future_spike_2h"] = "1"
    gl2, hr2, hrv2, sl2, st2, me2, ca2 = parse_telemetry_group(df2)
    assert gl1 == gl2 and hr1 == hr2
    import json
    with open("experiments/early_warning_ew01/EW01_FRESHNESS_1_SCHEMA.json", "r") as f:
        schema = json.load(f)
        fields = [x["name"] for x in schema["fields"]]
        assert "future_spike_2h" not in fields
        assert "plasma_glucose" not in fields

def test_22_sealer_refuses_protected_manifest(tmp_path):
    manifest = tmp_path / "protected.json"
    manifest.write_text("{}")
    from provenance_pipeline import safe_file_create
    with pytest.raises(ValueError, match="already exists"):
        safe_file_create(str(manifest))

def test_23_entry_points_cannot_bypass(tmp_path):
    from provenance_pipeline import run_preparation
    with pytest.raises(ValueError, match="BLOCKED"):
        run_preparation(str(tmp_path), str(tmp_path/"out"), "seed", None, "hash", "EW01-R1", None, None)

def test_24_two_approved_constructions():
    from provenance_pipeline import verify_external_receipt
    with pytest.raises(ValueError):
        verify_external_receipt(None, "inv", "contract", "EW01-R3", None)

def test_ehr_missingness_comparison(mock_ehr):
    row1 = mock_ehr.copy()
    row1["med_classes"] = ""
    fp1, _ = canonicalize_ehr_row(row1)
    
    row2 = mock_ehr.copy()
    row2["med_classes"] = np.nan
    fp2, _ = canonicalize_ehr_row(row2)
    assert fp1 == fp2
    
    row3 = mock_ehr.copy()
    row3["bmi"] = ""
    fp3, _ = canonicalize_ehr_row(row3)
    
    row4 = mock_ehr.copy()
    row4["bmi"] = "25.0"
    fp4, _ = canonicalize_ehr_row(row4)
    assert fp3 != fp4

def test_direct_canonical_comparison(mock_data, mock_ehr):
    ehr = pd.DataFrame([mock_ehr])
    fp, payload = canonicalize_ehr_row(mock_ehr)
    
    catalog = {
        "non_protected_payloads": {fp: payload}
    }
    with pytest.raises(ValueError, match="REVIEW_REQUIRED"):
        check_freshness(ehr, pd.DataFrame(columns=mock_data.columns), {fp}, set(), set(), catalog)
        
    catalog2 = {
        "non_protected_payloads": {fp: "forged_payload"}
    }
    res = check_freshness(ehr, pd.DataFrame(columns=mock_data.columns), {fp}, set(), set(), catalog2)
    assert len(res) == 0


# ---------------------------------------------------------------------------
# Behavioural regression tests: genuine Ed25519 verification, end-to-end
# preparation/sealing on a synthetic generator-schema cohort, and CLI fail-closed.
# ---------------------------------------------------------------------------
import stat
import sys
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from provenance_pipeline import canonical_inventory, verify_external_receipt, verify_protected_catalog

EW01_DIR = Path(__file__).resolve().parent


def write_json(path, obj):
    path.write_text(json.dumps(obj))
    return str(path)


def write_raw_key(path, public_key):
    path.write_bytes(public_key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))
    return str(path)


def write_pem_key(path, public_key):
    path.write_bytes(public_key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    return str(path)


def dir_state(d):
    return {f.name: (hashlib.sha256(f.read_bytes()).hexdigest(), stat.S_IMODE(f.stat().st_mode))
            for f in sorted(Path(d).iterdir())} | {".": stat.S_IMODE(Path(d).stat().st_mode)}


@pytest.fixture
def raw_cohort(tmp_path, mock_ehr):
    """Synthetic raw directory in the generator's schema: one Type 2 and one Type 1 patient."""
    d = tmp_path / "raw"
    d.mkdir()
    ehr = pd.DataFrame([mock_ehr, mock_ehr])
    ehr["patient_id"] = ["P0001", "P0002"]
    ehr["diabetes_status"] = ["Type 2", "Type 1"]
    ehr["age"] = ["45", "33"]
    ehr.to_csv(d / "patients_ehr.csv", index=False)
    times = [(datetime.datetime(2026, 9, 28) + datetime.timedelta(minutes=5 * i)).strftime("%Y-%m-%d %H:%M:%S")
             for i in range(300)]
    frames = []
    for k, pid in enumerate(["P0001", "P0002"]):
        frames.append(pd.DataFrame({
            "patient_id": pid, "timestamp": times,
            "glucose_level": [str(100 + k + (i * 7) % 60) for i in range(300)],
            "heart_rate": ["60.5"] * 300, "hrv": ["50.0"] * 300, "sleep_stage": ["Light"] * 300,
            "step_count": ["0"] * 300,
            "meal_event": ["1" if i in (40, 200) else "0" for i in range(300)],
            "carbs_g": ["45.0" if i in (40, 200) else "0.0" for i in range(300)],
            "future_spike_2h": ["0"] * 300}))
    pd.concat(frames).to_csv(d / "patient_cgm_telemetry.csv", index=False)
    return d


@pytest.fixture
def signed_inputs(tmp_path, keys, raw_cohort):
    sk, pk = keys
    raw_inv = canonical_inventory(str(raw_cohort), "RAW")
    digest = hashlib.sha256(raw_inv.encode("utf-8")).hexdigest()
    return {
        "raw": raw_cohort, "raw_inv": raw_inv, "digest": digest,
        "receipt": write_json(tmp_path / "receipt.json", make_receipt(sk, digest, "CONTRACT", "EW01-R1")),
        "catalog": write_json(tmp_path / "catalog.json", make_catalog(sk, [], [], [])),
        "pubkey": write_raw_key(tmp_path / "trusted_pubkey.key", pk),
    }


def prepare(tmp_path, s, prep_name="prep", **over):
    args = dict(receipt_path=s["receipt"], expected_contract_hash="CONTRACT", expected_attempt="EW01-R1",
                catalog_path=s["catalog"], pubkey_path=s["pubkey"])
    args.update(over)
    return run_preparation(str(s["raw"]), str(tmp_path / prep_name), "424242", **args)


def test_b1_valid_receipt_verifies_and_tampering_rejected(tmp_path, keys):
    sk, pk = keys
    key = write_raw_key(tmp_path / "k", pk)
    digest = hashlib.sha256(b"INV").hexdigest()
    good = make_receipt(sk, digest, "C", "EW01-R1")
    assert verify_external_receipt(write_json(tmp_path / "g.json", good), "INV", "C", "EW01-R1", key)["attempt"] == "EW01-R1"
    # Each field is changed after signing and the verifier is told to expect the new value,
    # so only the signature can reject it.
    for field, value in [("attempt", "EW01-R2"), ("contract_hash", "D"), ("raw_inventory_digest", "0" * 64)]:
        bad = dict(good, **{field: value})
        with pytest.raises(ValueError, match="BLOCKED: Invalid cryptographic signature"):
            verify_external_receipt(write_json(tmp_path / f"{field}.json", bad), "", bad["contract_hash"],
                                    bad["attempt"], key, skip_digest_check=True)


def test_b2_wrong_or_test_only_key_rejected(tmp_path, keys):
    sk, _ = keys
    other = ed25519.Ed25519PrivateKey.generate()
    digest = hashlib.sha256(b"INV").hexdigest()
    rp = write_json(tmp_path / "r.json", make_receipt(sk, digest, "C", "EW01-R1"))
    with pytest.raises(ValueError, match="BLOCKED: Invalid cryptographic signature"):
        verify_external_receipt(rp, "INV", "C", "EW01-R1", write_raw_key(tmp_path / "other", other.public_key()))
    # A receipt that carries its own (test) key is not trusted: verification still needs the pinned key.
    embedded = dict(make_receipt(other, digest, "C", "EW01-R1"),
                    _test_pubkey=base64.b64encode(other.public_key().public_bytes(
                        serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode())
    with pytest.raises(ValueError, match="BLOCKED: Invalid cryptographic signature"):
        verify_external_receipt(write_json(tmp_path / "e.json", embedded), "INV", "C", "EW01-R1",
                                write_raw_key(tmp_path / "pinned", keys[1]))
    fabricated = dict(make_receipt(sk, digest, "C", "EW01-R1"), signature=base64.b64encode(os.urandom(64)).decode())
    with pytest.raises(ValueError, match="BLOCKED: Invalid cryptographic signature"):
        verify_external_receipt(write_json(tmp_path / "f.json", fabricated), "INV", "C", "EW01-R1",
                                write_raw_key(tmp_path / "pinned2", keys[1]))


def test_b3_missing_trust_material_blocks(tmp_path, keys):
    sk, _ = keys
    rp = write_json(tmp_path / "r.json", make_receipt(sk, hashlib.sha256(b"INV").hexdigest(), "C", "EW01-R1"))
    cp = write_json(tmp_path / "c.json", make_catalog(sk, [], [], []))
    for key in [None, "", str(tmp_path / "absent.pem")]:
        with pytest.raises(ValueError, match="BLOCKED: Production mode requires a provisioned public key"):
            verify_external_receipt(rp, "INV", "C", "EW01-R1", key)
        with pytest.raises(ValueError, match="BLOCKED: Production mode requires a provisioned public key"):
            verify_protected_catalog(cp, key)


def test_b4_pem_trust_anchor_verifies(tmp_path, keys):
    """The CLIs pin trusted_pubkey.pem; a PEM-encoded Ed25519 key there must verify."""
    sk, pk = keys
    pem = write_pem_key(tmp_path / "trusted_pubkey.pem", pk)
    digest = hashlib.sha256(b"INV").hexdigest()
    rp = write_json(tmp_path / "r.json", make_receipt(sk, digest, "C", "EW01-R1"))
    assert verify_external_receipt(rp, "INV", "C", "EW01-R1", pem)["contract_hash"] == "C"
    assert verify_protected_catalog(write_json(tmp_path / "c.json", make_catalog(sk, [], [], [])), pem)["coverage_complete"]
    other_pem = write_pem_key(tmp_path / "other.pem", ed25519.Ed25519PrivateKey.generate().public_key())
    with pytest.raises(ValueError, match="BLOCKED: Invalid cryptographic signature"):
        verify_external_receipt(rp, "INV", "C", "EW01-R1", other_pem)


def test_b5_non_ed25519_or_malformed_key_blocks(tmp_path, keys):
    sk, pk = keys
    rp = write_json(tmp_path / "r.json", make_receipt(sk, hashlib.sha256(b"INV").hexdigest(), "C", "EW01-R1"))
    cp = write_json(tmp_path / "c.json", make_catalog(sk, [], [], []))
    ec_pem = write_pem_key(tmp_path / "ec.pem", ec.generate_private_key(ec.SECP256R1()).public_key())
    short = tmp_path / "short.key"
    short.write_bytes(pk.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)[:31])
    for key in [ec_pem, str(short)]:
        with pytest.raises(ValueError, match="BLOCKED: Trusted public key"):
            verify_external_receipt(rp, "INV", "C", "EW01-R1", key)
        with pytest.raises(ValueError, match="BLOCKED: Trusted public key"):
            verify_protected_catalog(cp, key)


def test_b6_catalog_tamper_wrong_key_and_incomplete_coverage(tmp_path, keys):
    sk, pk = keys
    key = write_raw_key(tmp_path / "k", pk)
    good = make_catalog(sk, ["a"], ["b"], ["c"])
    assert verify_protected_catalog(write_json(tmp_path / "g.json", good), key)["windows"] == ["c"]
    with pytest.raises(ValueError, match="BLOCKED: Invalid signature on protected catalog"):
        verify_protected_catalog(write_json(tmp_path / "t.json", dict(good, windows=[])), key)
    with pytest.raises(ValueError, match="BLOCKED: Invalid signature on protected catalog"):
        verify_protected_catalog(write_json(tmp_path / "g2.json", good),
                                 write_raw_key(tmp_path / "o", ed25519.Ed25519PrivateKey.generate().public_key()))
    payload = {"coverage_complete": False, "ehr_fps": [], "tele_fps": [], "windows": []}
    sig = sk.sign(json.dumps(payload, separators=(',', ':'), sort_keys=True).encode())
    incomplete = dict(payload, signature=base64.b64encode(sig).decode())
    with pytest.raises(ValueError, match="BLOCKED: Incomplete reference coverage"):
        verify_protected_catalog(write_json(tmp_path / "i.json", incomplete), key)


def test_b7_splice_at_any_offset_blocks(mock_data, mock_ehr):
    gl_ref = [str(100 + (i * 13) % 90) for i in range(288)]
    ref_fp = extract_288_sample_windows(gl_ref)[0][0][0]
    tele = mock_data.copy()
    tele["glucose_level"] = ["120"] * 7 + gl_ref + ["120"] * 5
    with pytest.raises(ValueError, match="SUBSTANTIVE_WINDOW_MATCH"):
        check_freshness(pd.DataFrame([mock_ehr]), tele, set(), set(), {ref_fp})
    tele["glucose_level"] = ["120"] * 7 + gl_ref[:-1] + ["121"] + ["120"] * 5
    assert check_freshness(pd.DataFrame([mock_ehr]), tele, set(), set(), {ref_fp}) == []


def test_b8_end_to_end_prepare_and_seal_is_non_destructive(tmp_path, signed_inputs):
    raw_before = dir_state(signed_inputs["raw"])
    prep_inv, prov = prepare(tmp_path, signed_inputs)
    prep = tmp_path / "prep"
    assert dir_state(signed_inputs["raw"]) == raw_before
    assert prov["raw_inventory_digest"] == signed_inputs["digest"]
    assert prov["seed"] == "424242" and prov["attempt"] == "EW01-R1"
    assert json.loads((prep / "cohort_ids.json").read_text()) == ["EW01-R1-P0001"]
    assert json.loads((prep / "cohort_exclusions.json").read_text())["type_1"] == ["EW01-R1-P0002"]
    meal = np.load(prep / "scientific_meal_log.npz")
    assert sorted(meal.files) == ["EW01-R1-P0001_carbs", "EW01-R1-P0001_min"]
    # The saved log is the contract's observed (corrupted) log for the mapped ID, not the raw meals.
    import train_pr_tft as T
    raw = pd.read_csv(signed_inputs["raw"] / "patient_cgm_telemetry.csv").query("patient_id == 'P0001'")
    cfg = T.TrainConfig(data_dir=str(prep), twin_mode="s3")
    exp_min, exp_carbs = T.observed_meal_log("EW01-R1-P0001", raw["meal_event"].to_numpy(), raw["carbs_g"].to_numpy(),
                                             cfg.seed, cfg.log_corruption)
    assert np.array_equal(meal["EW01-R1-P0001_min"], exp_min)
    assert np.array_equal(meal["EW01-R1-P0001_carbs"], exp_carbs)

    bytes_before = {k: v[0] for k, v in dir_state(prep).items() if k != "."}
    manifest = tmp_path / "out" / "ew01_manifest.json"
    sealed = seal_cohort_impl(str(prep), str(manifest), signed_inputs["receipt"], signed_inputs["catalog"],
                              signed_inputs["pubkey"], "CONTRACT")
    after = dir_state(prep)
    assert {k: v[0] for k, v in after.items() if k != "."} == bytes_before
    assert after["."] == 0o555 and all(v[1] == 0o444 for k, v in after.items() if k != ".")
    assert json.loads(manifest.read_text())["cohort"]["cohort_artifact_sha256"] == sealed
    prep.chmod(0o755)


def test_b9_refused_seal_leaves_prepared_dir_untouched(tmp_path, signed_inputs, keys):
    prepare(tmp_path, signed_inputs)
    prep = tmp_path / "prep"
    before = dir_state(prep)
    existing = tmp_path / "data_manifest.json"
    existing.write_text('{"files": {}}')
    other = ed25519.Ed25519PrivateKey.generate()
    forged = write_json(tmp_path / "forged.json", make_receipt(other, signed_inputs["digest"], "CONTRACT", "EW01-R1"))
    attempts = [
        (dict(external_manifest_path=str(existing)), "already exists"),
        (dict(receipt_path=forged), "BLOCKED: Invalid cryptographic signature"),
        (dict(receipt_path=None), "BLOCKED: Independent verification requires receipt and catalog"),
        (dict(expected_contract_hash="OTHER"), "BLOCKED: Receipt contract_hash mismatch"),
    ]
    for over, msg in attempts:
        args = dict(external_manifest_path=str(tmp_path / "m.json"), receipt_path=signed_inputs["receipt"],
                    catalog_path=signed_inputs["catalog"], pubkey_path=signed_inputs["pubkey"],
                    expected_contract_hash="CONTRACT") | over
        with pytest.raises(ValueError, match=msg):
            seal_cohort_impl(str(prep), **args)
        assert dir_state(prep) == before
        assert not (tmp_path / "m.json").exists()
    assert existing.read_text() == '{"files": {}}'


def test_b10_sealer_detects_prepared_mutation(tmp_path, signed_inputs):
    prepare(tmp_path, signed_inputs)
    prep = tmp_path / "prep"
    with open(prep / "patients_ehr.csv", "a") as f:
        f.write("\n")
    with pytest.raises(ValueError, match="bytes changed since preparation"):
        seal_cohort_impl(str(prep), str(tmp_path / "m.json"), signed_inputs["receipt"], signed_inputs["catalog"],
                         signed_inputs["pubkey"], "CONTRACT")
    assert not (tmp_path / "m.json").exists()


def test_b11_preparation_blocked_before_any_output(tmp_path, signed_inputs, keys):
    sk, _ = keys
    gl = parse_telemetry_group(pd.read_csv(signed_inputs["raw"] / "patient_cgm_telemetry.csv", dtype=str,
                                           keep_default_na=False).query("patient_id == 'P0001'"))[0]
    window_fp = extract_288_sample_windows(gl)[0][3][0]
    hit = write_json(tmp_path / "hit.json", make_catalog(sk, [], [], [window_fp]))
    cases = [
        (dict(catalog_path=hit), "SUBSTANTIVE_WINDOW_MATCH"),
        (dict(catalog_path=str(tmp_path / "absent.json")), "UNKNOWN: Missing protected-reference catalog"),
        (dict(expected_attempt="EW01-R2"), "BLOCKED: Wrong attempt provenance"),
        (dict(pubkey_path=str(tmp_path / "absent.pem")), "BLOCKED: Production mode requires"),
    ]
    for i, (over, msg) in enumerate(cases):
        with pytest.raises(ValueError, match=msg):
            prepare(tmp_path, signed_inputs, prep_name=f"prep{i}", **over)
        assert list((tmp_path / f"prep{i}").iterdir()) == []
    with open(signed_inputs["raw"] / "patients_ehr.csv", "a") as f:
        f.write("\n")
    with pytest.raises(ValueError, match="BLOCKED: Receipt raw_inventory_digest mismatch"):
        prepare(tmp_path, signed_inputs, prep_name="prep_mutated")


@pytest.mark.parametrize("script", ["prepare_cohort.py", "seal_cohort.py"])
def test_b12_cli_fails_closed_with_synthetic_trust(tmp_path, signed_inputs, script):
    """The CLIs ignore caller-supplied keys: synthetic receipts never pass the pinned anchor."""
    if script == "prepare_cohort.py":
        args = [str(signed_inputs["raw"]), str(tmp_path / "prep"), "424242", signed_inputs["receipt"], "CONTRACT",
                "EW01-R1", signed_inputs["catalog"]]
    else:
        prepare(tmp_path, signed_inputs)
        args = [str(tmp_path / "prep"), str(tmp_path / "m.json"), signed_inputs["receipt"], signed_inputs["catalog"],
                "CONTRACT"]
    before = dir_state(tmp_path / "prep") if (tmp_path / "prep").exists() else None
    res = subprocess.run([sys.executable, str(EW01_DIR / script), *args], capture_output=True, text=True,
                         cwd=EW01_DIR.parent.parent)
    assert res.returncode != 0
    assert "BLOCKED" in res.stderr
    assert not (tmp_path / "prep" / "cohort_provenance.json").exists() or script == "seal_cohort.py"
    assert not (tmp_path / "m.json").exists()
    if before is not None:
        assert dir_state(tmp_path / "prep") == before


# ---------------------------------------------------------------------------
# Integration tests of the environment lock (requirements.txt) against the running interpreter.
# ---------------------------------------------------------------------------
def parse_lock(path=EW01_DIR / "requirements.txt"):
    import re
    pins = {}
    for block in path.read_text().replace("\\\n", " ").splitlines():
        if not block.strip() or block.lstrip().startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._\-]*)==(\S+)\s", block + " ")
        assert m, f"unpinned or non-exact requirement in lock: {block[:80]}"
        hashes = re.findall(r"--hash=sha256:([0-9a-f]{64})", block)
        assert hashes, f"{m[1]} has no sha256 hash"
        name = re.sub(r"[-_.]+", "-", m[1]).lower()
        assert name not in pins, f"duplicate pin {name}"
        pins[name] = m[2]
    return pins


def test_i1_lock_pins_every_requirement_with_hashes():
    pins = parse_lock()
    assert "cryptography" in pins and "cffi" in pins and "pycparser" in pins


def test_i2_lock_covers_ew01_imports_and_dependency_closure():
    """Every distribution imported by the EW-01 path is pinned at its installed version, and every
    dependency (markers evaluated for this interpreter) of every pinned distribution is pinned."""
    import importlib.metadata as md
    import re
    from packaging.requirements import Requirement
    import prepare_cohort, seal_cohort, train_pr_tft  # noqa: F401  (the EW-01 execution path)
    norm = lambda n: re.sub(r"[-_.]+", "-", n).lower()
    pins = parse_lock()
    p2d = md.packages_distributions()
    imported = {norm(d) for m in list(sys.modules) for d in p2d.get(m.split(".")[0], [])}
    assert {"cryptography", "numpy", "pandas", "torch", "lightning"} <= imported
    assert sorted(imported - pins.keys()) == []
    for name in pins:
        assert md.version(name) == pins[name], f"installed {name} {md.version(name)} != locked {pins[name]}"
        for r in md.requires(name) or []:
            req = Requirement(r)
            if req.marker is None or req.marker.evaluate({"extra": ""}):
                assert norm(req.name) in pins, f"{name} requires {req.name}, which is not locked"
                assert req.specifier.contains(pins[norm(req.name)], prereleases=True)

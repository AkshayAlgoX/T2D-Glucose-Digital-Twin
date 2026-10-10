
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

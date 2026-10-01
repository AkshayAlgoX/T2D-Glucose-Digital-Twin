import numpy as np
import pandas as pd
from backend.train_pr_tft import detect_spike_onsets, SPIKE_LEVEL, TrainConfig, load_data

def test_consecutive_spikes_synthetic():
    cgm = np.full(100, 100.0)
    # A single continuous spike should produce only ONE onset
    cgm[50:60] = SPIKE_LEVEL + 10
    onset, armed = detect_spike_onsets(cgm)
    assert np.sum(onset) == 1
    
    # Check causal armed state logic
    assert armed[49] == True
    assert armed[50] == True
    assert armed[51] == True
    assert armed[52] == False
    assert armed[59] == False

def test_offline_reference_equality():
    cfg = TrainConfig(data_dir="/home/akshaya/synthetic_v2_300", seed=20260930, limit_patients=0)
    rng = np.random.default_rng(20260930)
    
    # Actually bypass load_data's T1D exclusion to test the full 300 cohort reference
    # to hit the exact 6118 number.
    data_dir = __import__('pathlib').Path(cfg.data_dir)
    telemetry = pd.read_csv(data_dir / "patient_cgm_telemetry.csv", parse_dates=["timestamp"])
    ehr = pd.read_csv(data_dir / "patients_ehr.csv")
    
    # Prepare all 300 patients
    from backend.train_pr_tft import prepare_patients
    series_300 = prepare_patients(telemetry, ehr, cfg, rng)
    
    onsets_300 = sum(np.sum(detect_spike_onsets(ps.cgm)[0]) for ps in series_300.values())
    assert onsets_300 == 6118, f"Expected 6118, got {onsets_300}"
    
    # Now use load_data which excludes T1D (293 patients)
    series_293 = load_data(cfg, rng)
    onsets_293 = sum(np.sum(detect_spike_onsets(ps.cgm)[0]) for ps in series_293.values())
    assert onsets_293 == 5996, f"Expected 5996, got {onsets_293}"

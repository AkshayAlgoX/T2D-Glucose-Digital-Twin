"""Spike-onset labels: one onset per physiological spike, the Blueprint definition unchanged,
and agreement with an independent implementation on the whole cohort."""

from __future__ import annotations

import numpy as np
import pandas as pd

import train_pr_tft as T


def reference_onsets(cgm: np.ndarray) -> np.ndarray:
    """Independent offline implementation of the Blueprint Section 1 rule, written for this test:
    >= 180 mg/dL, >= 50 mg/dL rise over the previous 60 min, >= 180 for 15 min, and no new onset
    until CGM has been < 160 mg/dL for 30 consecutive minutes."""
    n = cgm.size
    out = np.zeros(n, dtype=bool)
    armed, below = True, 0
    for k in range(n):
        v = cgm[k]
        if np.isnan(v):
            continue
        below = below + 1 if v < 160 else 0
        if below >= 6:
            armed = True
        if armed and v >= 180 and k >= 12:
            prior, persist = cgm[k - 12:k], cgm[k:k + 3]
            if np.isfinite(prior).any() and v - np.nanmin(prior) >= 50 and persist.size == 3 and np.all(persist >= 180):
                out[k] = True
                armed = False
    return out


def spike(n: int = 200, at: int = 60, length: int = 10, high: float = 200.0, base: float = 100.0) -> np.ndarray:
    cgm = np.full(n, base)
    cgm[at:at + length] = high
    return cgm


def test_definition_constants_unchanged():
    assert (T.SPIKE_LEVEL, T.SPIKE_RISE, T.RISE_STEPS, T.PERSIST_STEPS) == (180.0, 50.0, 12, 3)
    assert (T.REFRACTORY_LEVEL, T.REFRACTORY_STEPS) == (160.0, 6)


def test_one_onset_per_plateau():
    onset, _ = T.detect_spike_onsets(spike(length=60))
    assert onset.sum() == 1 and onset[60]


def test_no_second_onset_without_refractory():
    cgm = spike(length=10)
    cgm[70:74] = 170.0  # dips below 180 but never below 160 for 30 min
    cgm[74:90] = 240.0
    assert T.detect_spike_onsets(cgm)[0].sum() == 1


def test_second_onset_after_refractory():
    cgm = spike(length=10)
    cgm[70:78] = 100.0  # 40 min below 160 re-arms
    cgm[78:90] = 200.0
    onset, _ = T.detect_spike_onsets(cgm)
    assert np.flatnonzero(onset).tolist() == [60, 78]


def test_rise_and_persistence_are_required():
    slow = np.linspace(140, 190, 60)  # 50 mg/dL over 5 h: no 50 mg/dL rise within 60 min
    assert T.detect_spike_onsets(slow)[0].sum() == 0
    short = spike(length=2)  # only 10 min above 180
    assert T.detect_spike_onsets(short)[0].sum() == 0
    gap = spike(length=10)
    gap[61] = np.nan  # persistence window not observed
    assert not T.detect_spike_onsets(gap)[0][60]


def test_matches_independent_reference_on_every_patient(real_data_dir, cohort):
    tele = pd.read_csv(real_data_dir / "patient_cgm_telemetry.csv", usecols=["patient_id", "timestamp", "glucose_level"])
    ehr = pd.read_csv(real_data_dir / "patients_ehr.csv").set_index("patient_id")
    total = total_t1 = 0
    for pid, g in tele.groupby("patient_id"):
        cgm = g.sort_values("timestamp")["glucose_level"].to_numpy(float)
        ref = reference_onsets(cgm)
        prod, _ = T.detect_spike_onsets(cgm)
        assert np.array_equal(prod, ref), pid
        total += int(ref.sum())
        total_t1 += int(ref.sum()) if ehr.loc[pid, "diabetes_status"] == "Type 1" else 0
    assert (total, total_t1) == (6118, 122)
    # the training pipeline's labels: 293 active patients (Type 1 excluded)
    assert sum(int(ps.onset.sum()) for ps in cohort.values()) == 5996

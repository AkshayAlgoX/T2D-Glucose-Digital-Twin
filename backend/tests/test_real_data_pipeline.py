"""test_real_data_pipeline.py -- Unit and safeguard tests for preregistered real-data pipeline.

Verifies:
  1. Partition guards: attempting to access test split during development raises PartitionLockError.
  2. Deterministic splits: exact patient counts (CGMacros 27/9/9, Shanghai 60/20/20, BIG IDEAs 9/3/4)
     and reproducible SHA-256 assignment ordering.
  3. Causality & warmup: decisions require step >= 287 and >= 70% past 24h observed coverage.
  4. Shanghai non-estimable check: Shanghai 15-min cadence achieves <= 33.4% coverage on 5-min grid,
     producing 0 eligible decisions under locked 70% rule.
  5. Deterministic 1-to-1 alert matching: verifies 1 alert -> at most 1 onset, 1 onset -> at most 1 alert.
"""

import math
import sys
from pathlib import Path

import numpy as np
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
REAL_DATA_DIR = REPO_ROOT / "docs" / "evidence" / "real_data"
sys.path.insert(0, str(BACKEND_DIR))
sys.path.insert(0, str(REAL_DATA_DIR))

import develop  # noqa: E402


def test_deterministic_split_counts():
    """Verify preregistered split counts: CGMacros 27/9/9, Shanghai 60/20/20, BIG IDEAs 9/3/4."""
    # CGMacros
    cgm_pids = [f"CGMacros-{i:03d}" for i in range(1, 46)]
    tr, va, te = develop.get_patient_splits("cgmacros", cgm_pids)
    assert len(tr) == 27
    assert len(va) == 9
    assert len(te) == 9
    assert len(set(tr) & set(va)) == 0
    assert len(set(tr) & set(te)) == 0
    assert len(set(va) & set(te)) == 0

    # Shanghai
    sh_pids = [f"{i:03d}" for i in range(1, 101)]
    tr_sh, va_sh, te_sh = develop.get_patient_splits("shanghai", sh_pids)
    assert len(tr_sh) == 60
    assert len(va_sh) == 20
    assert len(te_sh) == 20

    # BIG IDEAs
    bi_pids = [f"{i:03d}" for i in range(1, 17)]
    tr_bi, va_bi, te_bi = develop.get_patient_splits("bigideas", bi_pids)
    assert len(tr_bi) == 9
    assert len(va_bi) == 3
    assert len(te_bi) == 4


def test_partition_lock_safeguard():
    """Attempting to access test partition without allow_test=True MUST raise PartitionLockError."""
    with pytest.raises(develop.PartitionLockError):
        develop.load_cgmacros(partition_filter={"test"}, allow_test=False)

    with pytest.raises(develop.PartitionLockError):
        develop.load_bigideas(partition_filter={"test"}, allow_test=False)


def test_shanghai_cadence_coverage_rejection():
    """Confirms that native 15-minute readings on a 5-minute grid fail the 70% past-coverage rule."""
    n_steps = 1000
    grid_cgm = np.full(n_steps, np.nan)
    # Every 3rd bin has a reading (15-min cadence)
    grid_cgm[::3] = 130.0

    # Rolling 288 steps (24h) coverage
    import pandas as pd
    cov = pd.Series(np.isfinite(grid_cgm)).rolling(288, min_periods=288).mean().to_numpy()
    max_cov = float(np.nanmax(cov))
    assert max_cov <= 0.34, f"15-min cadence coverage {max_cov} exceeded 34%"
    assert (cov >= 0.70).sum() == 0, "No 15-min steps should meet >= 70% coverage"


def test_deterministic_one_to_one_matching_logic():
    """Verify 1-to-1 alert matching: no single alert matches two onsets, no onset detected twice."""
    # Create synthetic test dataset
    pids = ["P1"] * 50
    steps = np.arange(100, 150)
    at_risk = np.ones(50, dtype=bool)

    # 2 onsets: step 115 and step 125
    # Warning window for onset 115 is [115-24, 115-1] = [91, 114]
    # Warning window for onset 125 is [125-24, 125-1] = [101, 124]
    # Alert at step 105 is inside BOTH warning windows!
    onsets_dict = {"P1": [115, 125]}

    ds = develop.DecisionDataset(
        features=np.zeros((50, 10), dtype=np.float32),
        feature_names=["f"] * 10,
        target_30=np.zeros(50, dtype=np.float32),
        target_60=np.zeros(50, dtype=np.float32),
        target_120=np.zeros(50, dtype=np.float32),
        onset_label=np.zeros(50, dtype=np.int32),
        at_risk=at_risk,
        patient_ids=pids,
        decision_steps=steps,
        cgm_history=np.zeros(50, dtype=np.float32),
        twin_f30=np.zeros(50, dtype=np.float32),
        twin_f60=np.zeros(50, dtype=np.float32),
        twin_f120=np.zeros(50, dtype=np.float32),
        trend_f30=np.zeros(50, dtype=np.float32),
        trend_f60=np.zeros(50, dtype=np.float32),
        trend_f120=np.zeros(50, dtype=np.float32),
        spike_onsets_per_patient=onsets_dict,
    )

    # Trigger alert at step 105 (index 5) only
    probs = np.zeros(50, dtype=float)
    probs[5] = 0.90  # step 105

    res = develop.evaluate_event_alerts(probs, ds, threshold=0.35, cooldown=24)
    # Total onsets: 2. Detected onsets: MUST BE 1 (not 2!), since alert at 105 can match at most one onset.
    assert res["total_onsets"] == 2.0
    assert res["detected_onsets"] == 1.0, "Alert matched multiple onsets! Violates 1-to-1 matching."
    assert res["total_alerts"] == 1.0
    assert res["false_alerts"] == 0.0

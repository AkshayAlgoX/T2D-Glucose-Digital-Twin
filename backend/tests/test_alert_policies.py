"""Alert-policy mechanics used by the external checks (docs/evidence/external_v2/select_combined.py):
the at-risk rule, the locked 120-min cooldown, the per-patient K-per-24-h cap and the combined-signal rules."""
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "docs" / "evidence" / "external_v2"))
sys.path.insert(0, str(ROOT / "docs" / "evidence" / "operating_point"))
import select_combined as sc  # noqa: E402


def ds(steps, at_risk=None, pid="A"):
    n = len(steps)
    return SimpleNamespace(patient_ids=[pid] * n, decision_steps=np.asarray(steps), at_risk=np.ones(n, bool) if at_risk is None else np.asarray(at_risk))


def test_cooldown_blocks_alerts_within_120_min():
    d = ds(range(0, 60))
    a = sc.alerts(np.ones(60, bool), d, sc.INF)
    assert list(np.flatnonzero(a)) == [0, sc.dv.COOLDOWN_STEPS, 2 * sc.dv.COOLDOWN_STEPS]


def test_cap_limits_alerts_per_trailing_24_h():
    d = ds(range(0, 600))
    a = sc.alerts(np.ones(600, bool), d, 2)
    steps = np.flatnonzero(a)
    for s in steps:
        assert ((steps > s - sc.DAY) & (steps <= s)).sum() <= 2
    assert len(steps) > 2  # the cap is per trailing day, not a lifetime limit


def test_no_alert_when_not_at_risk():
    d = ds(range(30), at_risk=[False] * 30)
    assert sc.alerts(np.ones(30, bool), d, sc.INF).sum() == 0


def test_caps_are_per_patient():
    d = SimpleNamespace(patient_ids=["A"] * 30 + ["B"] * 30, decision_steps=np.r_[np.arange(30), np.arange(30)], at_risk=np.ones(60, bool))
    a = sc.alerts(np.ones(60, bool), d, 1)
    assert a[:30].sum() == 1 and a[30:].sum() == 1


def test_combined_rules():
    r = np.array([0.1, 0.5, 0.2, 0.2])
    f = np.array([230.0, 150.0, 230.0, 150.0])
    rb = np.zeros(4)
    assert list(sc.candidates("C1", {"tf": 220, "tr": 0.4}, r, f, rb)) == [True, True, True, False]
    assert list(sc.candidates("C2", {"tf": 220, "tg": 0.15, "tr": 0.4}, r, f, rb)) == [False, True, True, False]
    assert list(sc.candidates("T", {"tf": 220}, r, f, rb)) == [True, False, True, False]

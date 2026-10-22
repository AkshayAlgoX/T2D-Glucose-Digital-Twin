"""Counterfactual plausibility of the physiology twin's 120-min rollout (pure physics, no checkpoint).

These check direction and ordering only, which physiology requires; they do not validate effect sizes,
which have not been compared with human counterfactual data.
"""
import numpy as np
import pytest

import ukf_twin as U

# Unit-test EHR rows; not cohort data. "s2" derives parameters from observable EHR fields.
EHR = {
    "t2d": {"age": 54, "bmi": 29.5, "weight_kg": 82.0, "hba1c": 7.6, "egfr": 88.0, "diabetes_status": "Type 2",
            "diabetes_duration_years": 6.0, "med_classes": "metformin"},
    "normal": {"age": 31, "bmi": 22.0, "weight_kg": 64.0, "hba1c": 5.2, "egfr": 105.0, "diabetes_status": "Healthy",
               "diabetes_duration_years": 0.0, "med_classes": ""},
}


def peak_after(kind, carbs=0.0, at=0, dhr=None, g0=120.0, hour=12.0):
    p = U.derive_params(EHR[kind], 65.0, mode="s2")
    meals = np.zeros(U.HORIZON)
    meals[at] = carbs
    traj = np.asarray(U.rollout(U.initial_state(g0, p).m, p, U.future_inputs(hour, meal_carbs_g=meals, dhr=dhr)))
    return traj[:, U.G]


@pytest.mark.parametrize("kind", ["t2d", "normal"])
def test_more_carbohydrate_never_lowers_the_curve(kind):
    curves = [peak_after(kind, c) for c in (0, 30, 60, 120)]
    for lo, hi in zip(curves, curves[1:]):
        assert np.all(hi >= lo - 1e-6)
        assert hi.max() > lo.max()


def test_later_meal_peaks_later():
    early, late = peak_after("t2d", 60, at=0), peak_after("t2d", 60, at=6)
    assert int(np.argmax(late)) > int(np.argmax(early))
    assert np.allclose(early[:1], late[:1], atol=1e-6) or late[0] <= early[0]


def test_activity_lowers_glucose_after_a_meal():
    dhr = np.full(U.HORIZON, 40.0)  # +40 bpm exercise heart-rate rise for the whole horizon
    assert peak_after("t2d", 60, dhr=dhr).max() < peak_after("t2d", 60).max()


def test_reduced_insulin_sensitivity_raises_the_meal_response():
    assert peak_after("t2d", 60).max() > peak_after("normal", 60).max()


def test_fixture_rows_take_the_intended_ehr_paths():
    # derive_params matches status strings exactly; a wrong label would silently use the non-diabetic path.
    t2d, normal = U.derive_params(EHR["t2d"], 65.0, mode="s2"), U.derive_params(EHR["normal"], 65.0, mode="s2")
    assert t2d.si < normal.si


def test_rollout_stays_finite_and_physiological():
    for kind in EHR:
        for c in (0, 120, 250):
            g = peak_after(kind, c)
            assert np.all(np.isfinite(g)) and g.min() >= 20 and g.max() <= 600

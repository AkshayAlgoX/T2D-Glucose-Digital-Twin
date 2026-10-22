"""The authoritative evaluator's building blocks: Clarke orientation, event-level alert
metrics, the paired stratified bootstrap, identity checks and the mechanical selection rule."""

from __future__ import annotations

import dataclasses
import json

import numpy as np
import pytest

import evaluate_run as E
import train_pr_tft as T
from conftest import BACKEND


# --------------------------------------------------------------------------- #
# Clarke error grid: the reference is the measured CGM
# --------------------------------------------------------------------------- #


def one_point(actual: float, predicted: float, minutes: int = 60) -> dict[str, float]:
    y = np.full((1, T.HORIZON), actual)
    pred = np.full((1, T.HORIZON), predicted)
    return T.clarke_at(pred, {"y": y, "y_mask": np.ones_like(y)}, minutes)


def test_clarke_reference_is_the_measured_value():
    assert one_point(100.0, 220.0)["C"] == 1.0  # over-prediction by 120 at a normal level
    assert one_point(220.0, 100.0)["C"] == 0.0  # swapping the arguments would also call this C
    assert one_point(300.0, 60.0)["E"] == 1.0
    assert one_point(150.0, 160.0)["A"] == 1.0


# --------------------------------------------------------------------------- #
# Alerts and events
# --------------------------------------------------------------------------- #


def test_alerts_respect_cooldown_and_at_risk():
    trig = np.ones(100, dtype=bool)
    risk = np.ones(100, dtype=bool)
    assert np.flatnonzero(E.raise_alerts(trig, risk, cooldown=24)).tolist() == [0, 24, 48, 72, 96]
    risk[:30] = False
    assert np.flatnonzero(E.raise_alerts(trig, risk, cooldown=24)).tolist() == [30, 54, 78]


def test_event_counts_hand_computed():
    n = 400
    onset = np.zeros(n, dtype=bool)
    onset[[20, 150, 300]] = True  # 20 is before first+24: not monitored
    raised = np.zeros(n, dtype=bool)
    raised[[140, 200, 290]] = True  # 140 detects 150 (lead 50 min); 200 is false; 290 detects 300 (lead 50 min)
    c = E.event_counts(raised, onset, first=10, last=350)
    assert c["monitored_onsets"] == 2 and c["detected_onsets"] == 2
    assert c["lead_times_min"] == [50, 50]
    assert c["alerts_raised"] == 3 and c["true_alerts"] == 2 and c["false_alerts"] == 1
    assert c["patient_days"] == pytest.approx(341 * 5 / 1440)
    late = np.zeros(n, dtype=bool)
    late[[100, 149]] = True  # 100 is 50 steps before 150: outside the 120-min window
    c = E.event_counts(late, onset, first=10, last=350)
    assert c["detected_onsets"] == 1 and c["lead_times_min"] == [5]


def test_one_to_one_matching_single_alert_with_multiple_onsets():
    """Regression test: a single alert whose horizon covers two onsets must match only one onset."""
    n = 300
    onset = np.zeros(n, dtype=bool)
    onset[[100, 110]] = True  # 10 steps (50 min) apart; both monitored
    raised = np.zeros(n, dtype=bool)
    raised[90] = True  # 10 steps before 100 (lead 50 min) and 20 steps before 110 (lead 100 min)
    c = E.event_counts(raised, onset, first=10, last=250)
    # Under old logic, alert 90 was credited with both onsets (detected_onsets = 2).
    # Under 1-to-1 matching, alert 90 matches the earliest onset (100); onset 110 is missed.
    assert c["monitored_onsets"] == 2
    assert c["detected_onsets"] == 1
    assert c["alerts_raised"] == 1
    assert c["true_alerts"] == 1
    assert c["false_alerts"] == 0
    assert c["lead_times_min"] == [50]


def test_one_to_one_matching_multiple_alerts_for_single_onset():
    """Regression test: multiple alerts within the window of a single onset must yield at most one true alert."""
    n = 300
    onset = np.zeros(n, dtype=bool)
    onset[150] = True
    raised = np.zeros(n, dtype=bool)
    raised[[130, 140]] = True  # Both in [150 - 24, 150 - 1] = [126, 149]
    c = E.event_counts(raised, onset, first=10, last=250)
    # Earliest alert (130) matches onset 150 (lead 100 min).
    # Alert 140 has no onset to match, so it is counted as a false alert.
    assert c["monitored_onsets"] == 1
    assert c["detected_onsets"] == 1
    assert c["alerts_raised"] == 2
    assert c["true_alerts"] == 1
    assert c["false_alerts"] == 1
    assert c["lead_times_min"] == [100]


def test_one_to_one_matching_overlapping_chain():
    """Chained overlapping windows: alerts at 80, 100 and onsets at 95, 115."""
    n = 300
    onset = np.zeros(n, dtype=bool)
    onset[[95, 115]] = True
    raised = np.zeros(n, dtype=bool)
    raised[[80, 100]] = True
    c = E.event_counts(raised, onset, first=10, last=250)
    # Alert 80 reaches 95 (lead 75 min); cannot reach 115 (diff 35 > 24).
    # Alert 100 reaches 115 (lead 75 min).
    assert c["monitored_onsets"] == 2
    assert c["detected_onsets"] == 2
    assert c["alerts_raised"] == 2
    assert c["true_alerts"] == 2
    assert c["false_alerts"] == 0
    assert c["lead_times_min"] == [75, 75]


def test_event_counts_boundary_conditions():
    """Boundary conditions for horizon window and monitored decision range."""
    n = 300
    first, last, horizon = 50, 200, 24
    onset = np.zeros(n, dtype=bool)
    # Boundaries for monitored onsets:
    # first + horizon = 74 (monitored), 73 (unmonitored)
    # last + 1 = 201 (monitored), 202 (unmonitored)
    onset[[73, 74, 150, 201, 202]] = True
    raised = np.zeros(n, dtype=bool)
    # For onset 150: window is [126, 149]
    # Alert at 125: too early (25 steps = 125 min > 120 min) -> false alert
    # Alert at 126: exact earliest boundary (24 steps = 120 min) -> matches 150
    # Alert at 149: exact latest boundary (1 step = 5 min)
    # Alert at 150: step of onset (lead 0 min) -> outside window
    raised[[125, 126]] = True
    c = E.event_counts(raised, onset, first=first, last=last, horizon=horizon)
    assert c["monitored_onsets"] == 3  # 74, 150, 201
    assert c["detected_onsets"] == 1   # onset 150 detected by alert 126
    assert c["alerts_raised"] == 2
    assert c["true_alerts"] == 1       # alert 126
    assert c["false_alerts"] == 1      # alert 125
    assert c["lead_times_min"] == [120]

    # Test latest boundary (1 step before onset)
    raised2 = np.zeros(n, dtype=bool)
    raised2[149] = True  # lead = 5 min
    c2 = E.event_counts(raised2, onset, first=first, last=last, horizon=horizon)
    assert c2["detected_onsets"] == 1 and c2["lead_times_min"] == [5]
    assert c2["true_alerts"] == 1 and c2["false_alerts"] == 0


def test_alert_precision_is_reported_once_in_alert_units():
    stats = {"monitored_onsets": np.array([10.0]), "detected_onsets": np.array([3.0]),
             "alerts_raised": np.array([4.0]), "true_alerts": np.array([1.0]), "false_alerts": np.array([3.0]),
             "patient_days": np.array([2.0]), "lead_times_min": [[30, 60, 90]]}
    d = E.metric_draws(stats, np.ones((1, 1)))
    assert [k for k in d if "precision" in k] == ["alert_precision"]
    assert d["alert_precision"][0] == 0.25  # true alerts / alerts, never mixed with onset counts
    assert d["event_sensitivity"][0] == 0.3
    assert d["false_alerts_per_patient_day"][0] == 1.5
    assert d["lead_time_median_min"][0] == 60


def test_twin_trigger_needs_a_forecast_spike():
    hist = np.full(T.RISE_STEPS + 1, 110.0)
    rising = np.concatenate([np.linspace(120, 200, 8), np.full(16, 205.0)])
    assert E.forecast_meets_spike_rule(hist, rising)
    assert not E.forecast_meets_spike_rule(hist, np.full(T.HORIZON, 175.0))


def test_decision_times_use_no_future_coverage(cohort, run_config):
    ps = next(iter(cohort.values()))
    gone = dataclasses.replace(ps, cgm=ps.cgm.copy(), cgm_ff=ps.cgm_ff.copy())
    t_ok, first, last = E.causal_decision_mask(ps, run_config.cfg)
    gone.cgm[last - 30:] = np.nan  # future of the last decisions disappears
    t2, _, _ = E.causal_decision_mask(gone, run_config.cfg)
    assert first == T.FIRST_ANCHOR and last == ps.n - 1 - T.HORIZON
    assert set(t_ok[t_ok < last - 30]) == set(t2[t2 < last - 30])


# --------------------------------------------------------------------------- #
# Paired, stratified, patient-level bootstrap
# --------------------------------------------------------------------------- #


def test_bootstrap_weights_are_stratified_multiplicities():
    groups = ["A", "A", "A", "B", "B"]
    w = E.bootstrap_weights(groups, 500, seed=1)
    assert np.all(w[:, :3].sum(1) == 3) and np.all(w[:, 3:].sum(1) == 2)
    assert (w >= 2).any()  # a patient drawn twice counts twice
    np.testing.assert_array_equal(w, E.bootstrap_weights(groups, 500, seed=1))


def test_bootstrap_is_paired():
    rng = np.random.default_rng(0)
    stats = {f"{k}_{h}": rng.uniform(1, 5, 6) for k in ("sse", "ae", "n") for h in (30, 60, 120)}
    w = E.bootstrap_weights(["A"] * 3 + ["B"] * 3, 300, seed=2)
    a, b = E.metric_draws(stats, w), E.metric_draws(stats, w)
    s = E.summarize(0.0, a["rmse_60"] - b["rmse_60"], 0.95)
    assert s["ci_low"] == 0.0 and s["ci_high"] == 0.0


def test_weighted_median():
    w = np.array([[1.0, 1.0], [3.0, 0.0]])
    out = E.weighted_median([[10, 20], [30]], w)
    assert out.tolist() == [20.0, 10.0]


# --------------------------------------------------------------------------- #
# Identity: an arm can never be scored as another
# --------------------------------------------------------------------------- #


def realistic_cfg() -> dict:
    return json.loads((BACKEND / "final_config.json").read_text())["train"]


def manifest_for(cfg: dict) -> dict:
    c = E._cfg_from_dict(cfg)
    return {"dims": T.model_dims(c), "twin": {"kind": c.twin, "mode": c.twin_mode}}


def hparams_for(cfg: dict, **override) -> dict:
    c = E._cfg_from_dict(cfg)
    hp = {**T.model_dims(c), "cfg_dict": json.loads(json.dumps(cfg)), "glu_std": 40.0}
    hp.update(override)
    return hp


def test_identity_accepts_matching_run():
    cfg = realistic_cfg()
    assert E.verify_identity(cfg, hparams_for(cfg), manifest_for(cfg), 40.0)["dims"]["n_static"] == 18


@pytest.mark.parametrize("override,needle", [
    ({"n_static": 21}, "n_static"),  # oracle checkpoint presented as the realistic arm
    ({"n_past": 12}, "n_past"),  # linear-twin checkpoint presented as UKF
    ({"glu_std": 41.0}, "glu_std"),
])
def test_identity_rejects_arm_or_shape_mismatch(override, needle):
    cfg = realistic_cfg()
    with pytest.raises(E.IdentityError, match=needle):
        E.verify_identity(cfg, hparams_for(cfg, **override), manifest_for(cfg), 40.0)


def test_identity_rejects_different_training_config_or_twin():
    cfg = realistic_cfg()
    other = {**cfg, "twin_mode": "s2"}
    with pytest.raises(E.IdentityError, match="twin_mode"):
        E.verify_identity(cfg, hparams_for(other), manifest_for(cfg), 40.0)
    with pytest.raises(E.IdentityError, match="twin mode"):
        E.verify_identity(cfg, hparams_for(cfg), {**manifest_for(cfg), "twin": {"kind": "ukf", "mode": "oracle"}}, 40.0)


def test_calibration_identity_tolerates_rounding_but_not_a_different_model():
    rng = np.random.default_rng(4)
    n = 4000
    p = rng.uniform(0, 1, n)
    y = (rng.uniform(0, 1, n) < p).astype(float)
    q = np.zeros((n, T.HORIZON, len(T.QUANTILES)))
    q[..., T.P10_IDX], q[..., T.P90_IDX] = -10.0, 10.0
    ys = rng.normal(0, 8, (n, T.HORIZON))
    agg = {"q": q, "y": ys, "y_mask": np.ones_like(ys), "p_cum": p, "onset_any": y, "at_risk": np.ones(n)}
    a = T.Calibrators.fit(agg, 0.8)
    b = T.Calibrators.fit({**agg, "p_cum": p + rng.normal(0, 1e-6, n)}, 0.8)  # float-level jitter
    other = T.Calibrators.fit({**agg, "p_cum": rng.uniform(0, 1, n)}, 0.8)  # a different model
    d_same, d_other = E.calibration_distance(a, b), E.calibration_distance(a, other)
    assert all(d_same[k] <= tol for k, tol in E.CALIBRATION_TOLERANCE.items())
    assert d_other["hazard_map"] > E.CALIBRATION_TOLERANCE["hazard_map"]


# --------------------------------------------------------------------------- #
# The locked rule, applied mechanically
# --------------------------------------------------------------------------- #


RULE = json.loads((BACKEND / "model_selection_rule.json").read_text())


def primary(cov=0.80, sens=(0.05, 0.10), fa=(-0.3, -0.1), rmse60=(-1.0, 1.0), rmse120=(-1.0, 1.0)) -> dict:
    ci = lambda lo_hi: {"estimate": sum(lo_hi) / 2, "ci_low": lo_hi[0], "ci_high": lo_hi[1]}
    return {"models": {"pr_tft": {"coverage_80_conformal": {"estimate": cov}}},
            "paired_differences": {"pr_tft_minus_twin_only": {
                "event_sensitivity": ci(sens), "false_alerts_per_patient_day": ci(fa),
                "rmse_60": ci(rmse60), "rmse_120": ci(rmse120)}}}


def test_rule_selects_pr_tft_only_when_non_inferior_and_better():
    ok = {"0.35": True, "0.6": False}
    assert E.apply_selection_rule(RULE, primary(), ok)["selected"] == "pr_tft"
    assert E.apply_selection_rule(RULE, primary(), {"0.35": False, "0.6": False})["selected"] == "twin_only"
    assert E.apply_selection_rule(RULE, primary(cov=0.70), ok)["selected"] == "twin_only"
    assert E.apply_selection_rule(RULE, primary(sens=(-0.08, 0.05)), ok)["selected"] == "twin_only"
    tie = primary(sens=(-0.01, 0.01), fa=(-0.05, 0.05))
    assert E.apply_selection_rule(RULE, tie, ok)["selected"] == "twin_only"
    better_rmse = primary(sens=(-0.01, 0.01), fa=(-0.05, 0.05), rmse60=(-3.0, -1.0))
    assert E.apply_selection_rule(RULE, better_rmse, ok)["selected"] == "pr_tft"

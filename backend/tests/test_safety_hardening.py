import pytest
import uuid
import datetime as dt
import numpy as np
import serve_pr_tft as S
from test_serve_pr_tft import client, subjects, request_body

def test_quantile_ordering_validation_b2(client, subjects):
    svc = client.app.state.ctx
    orig_apply = svc.calib.apply_interval
    
    # Test valid monotonic output
    r = client.post("/v1/forecasts", json=request_body(subjects[0]["subject_id"]))
    assert r.status_code == 200

    def apply_interval_mock(q):
        res = orig_apply(q)
        # intentionally cross the quantiles to test validation
        res[..., 0], res[..., 6] = res[..., 6], res[..., 0]
        return res
        
    svc.calib.apply_interval = apply_interval_mock
    try:
        r = client.post("/v1/forecasts", json=request_body(subjects[0]["subject_id"]))
        assert r.status_code == 200
        assert r.json()["model"]["fallback_used"] == "twin_only"
    finally:
        svc.calib.apply_interval = orig_apply

def test_alert_policy_semantics(client, subjects):
    machine = S.AlertMachine()
    subject = uuid.uuid4()
    
    # 1. exact threshold semantics
    now = dt.datetime(2026, 1, 1, 12, 0, tzinfo=dt.timezone.utc)
    # Below watch
    alert, event = machine.step(0.34, in_progress=False, subject=subject, now=now)
    assert alert["state"] == "none" and event is None
    
    # Watch threshold triggers state but no new alert event if previously none
    alert, event = machine.step(0.35, in_progress=False, subject=subject, now=now)
    assert alert["state"] == "watch" and event == "alert.raised"
    assert alert["suppressed_until"] is not None

    # Clear it
    alert, event = machine.step(0.20, in_progress=False, subject=subject, now=now + dt.timedelta(minutes=5))
    assert alert["state"] == "none" and event == "alert.cleared"

    # Warning threshold (advance past 120-min suppression from previous alert)
    now += dt.timedelta(minutes=125)
    alert, event = machine.step(0.60, in_progress=False, subject=subject, now=now)
    assert alert["state"] == "warning" and event == "alert.raised"
    
    # 2. one alert max per 120 min / correct re-arm behavior
    alert_id_1 = alert["alert_id"]
    # 60 mins later, still warning threshold, but suppressed!
    alert, event = machine.step(0.80, in_progress=False, subject=subject, now=now + dt.timedelta(minutes=60))
    # It updates state silently but no new alert is raised
    assert event is None
    assert alert["alert_id"] == alert_id_1

    # 120 mins later, re-arm!
    alert, event = machine.step(0.80, in_progress=False, subject=subject, now=now + dt.timedelta(minutes=120))
    assert event == "alert.raised"
    assert alert["alert_id"] != alert_id_1
    
    # 3. causal gating / no alert when spike already in progress
    machine = S.AlertMachine()
    now += dt.timedelta(minutes=200)
    alert, event = machine.step(0.80, in_progress=True, subject=subject, now=now)
    # Because in_progress is True, it is NOT at_risk, so target="none"
    assert alert["state"] == "none" and event is None

def test_no_future_dependent_access(client, subjects):
    """Verify that spike detection and historical features at anchor t depend only on historical indices <= t."""
    svc = client.app.state.ctx
    sid = uuid.UUID(subjects[0]["subject_id"])
    pc = svc.patient(sid)
    t = S.T.FIRST_ANCHOR

    # Original armed and onset status up to t
    orig_armed = pc.ps.armed[:t + 1].copy()
    orig_onset = pc.ps.onset[:t + 1].copy()

    # Mutate future CGM beyond t (simulate future spike or crash)
    cgm_mutated = pc.ps.cgm.copy()
    cgm_mutated[t + 1:] = 400.0  # extreme future spike
    onset_mut, armed_mut = S.T.detect_spike_onsets(cgm_mutated)

    # Spike onset and armed status up to anchor t MUST be identical
    np.testing.assert_array_equal(orig_armed, armed_mut[:t + 1])
    np.testing.assert_array_equal(orig_onset, onset_mut[:t + 1])


def test_fallback_quantiles_monotonic_and_honest_risk(client, subjects):
    """Verify fallback produces monotonically non-decreasing quantiles and honest unavailable risk."""
    svc = client.app.state.ctx

    # Force fallback by raising in run_model
    def mock_fail(*_args, **_kwargs):
        raise RuntimeError("simulated PR-TFT inference failure")

    orig_run = svc.run_model
    svc.run_model = mock_fail
    try:
        r = client.post("/v1/forecasts", json=request_body(subjects[0]["subject_id"]))
        assert r.status_code == 200
        body = r.json()
        assert body["model"]["fallback_used"] == "twin_only"

        # 1. Monotonicity across all 24 horizons
        points = body["forecast"]["points"]
        assert len(points) == 24
        for p in points:
            assert p["p05"] <= p["p10"] <= p["p25"] <= p["p50"] <= p["p75"] <= p["p90"] <= p["p95"]

        # 2. Honest risk semantics: neural risk model failed, so spike_risk is unavailable (null)
        assert body["spike_risk"] is None
        assert body["alert"]["state"] == "none"
    finally:
        svc.run_model = orig_run


def test_alert_policy_point_and_stream_unification():
    """Verify that stateless point policy (alert_for) and stateful streaming policy (AlertMachine) agree."""
    subject = uuid.uuid4()
    stamp = dt.datetime(2026, 1, 1, 12, 0, tzinfo=dt.timezone.utc)

    # Test cases: (probability, in_progress, expected_state)
    cases = [
        (0.20, False, "none"),
        (0.35, False, "watch"),
        (0.50, False, "watch"),
        (0.60, False, "warning"),
        (0.90, False, "warning"),
        (0.90, True, "none"),   # spike in progress -> no new alert
        (0.35, True, "none"),   # spike in progress -> no new watch
    ]

    for p, in_prog, expected in cases:
        point_alert = S.alert_for(p, in_prog, subject, stamp)
        machine = S.AlertMachine()
        stream_alert, _ = machine.step(p, in_prog, subject, stamp)
        assert point_alert["state"] == expected, f"point failed for p={p}, in_prog={in_prog}"
        assert stream_alert["state"] == expected, f"stream failed for p={p}, in_prog={in_prog}"

def test_causal_direction():
    machine = S.AlertMachine()
    subject = uuid.uuid4()
    now = dt.datetime(2026, 1, 1, 12, 0, tzinfo=dt.timezone.utc)

    # ps.armed[t] = true -> in_progress = false -> alert may be evaluated
    alert, event = machine.step(0.70, in_progress=False, subject=subject, now=now)
    assert alert["state"] == "warning"
    assert event == "alert.raised"

    # ps.armed[t] = false -> in_progress = true -> alert MUST NOT be raised
    machine2 = S.AlertMachine()
    alert2, event2 = machine2.step(0.70, in_progress=True, subject=subject, now=now)
    assert alert2["state"] == "none"
    assert event2 is None

def test_stream_include_options_b1_b5(client, subjects):
    sid = subjects[1]["subject_id"]
    # test default omitted -> drivers, twin_state
    with client.stream("GET", f"/v1/subjects/{sid}/stream", params={"speed": 0, "max_events": 1}) as r:
        text = "".join(r.iter_text())
        events = [S.json.loads(line[len("data: "):]) for line in text.splitlines() if line.startswith("data: ")]
        payload = events[0]["payload"]
        assert "drivers" in payload
        assert "twin_state" in payload
        assert "ehr_context" not in payload
        assert "twin_p50" not in payload["forecast"]["points"][0]

    # test with all supported options
    params = {"speed": 0, "max_events": 1, "include": ["drivers", "twin_state", "ehr_context", "twin_overlay"]}
    with client.stream("GET", f"/v1/subjects/{sid}/stream", params=params) as r:
        text = "".join(r.iter_text())
        events = [S.json.loads(line[len("data: "):]) for line in text.splitlines() if line.startswith("data: ")]
        payload = events[0]["payload"]
        assert "drivers" in payload
        assert "twin_state" in payload
        assert "ehr_context" in payload
        assert "twin_p50" in payload["forecast"]["points"][0]

    # test comma-separated include parameter string
    with client.stream("GET", f"/v1/subjects/{sid}/stream?speed=0&max_events=1&include=drivers,ehr_context,twin_overlay") as r:
        text = "".join(r.iter_text())
        events = [S.json.loads(line[len("data: "):]) for line in text.splitlines() if line.startswith("data: ")]
        payload = events[0]["payload"]
        assert "drivers" in payload
        assert "ehr_context" in payload
        assert "twin_state" not in payload
        assert "twin_p50" in payload["forecast"]["points"][0]

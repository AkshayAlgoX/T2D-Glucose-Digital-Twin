"""Contract tests for serve_pr_tft.py (Blueprint 9.7).

Every response is validated against the JSON Schemas in contracts/v1/, the same files the
Next.js side generates its types and Zod validators from.

    RUN_DIR=runs/pr_tft_final_smoke pytest -q tests/test_serve_pr_tft.py

RUN_DIR must name a run directory written by train_pr_tft.py (the UKF/S3 smoke run is
enough). Without it the module is skipped with that reason; it is never pointed at an
archived or hand-made run.
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
if not os.environ.get("RUN_DIR"):
    pytest.skip("RUN_DIR not set: point it at a run written by train_pr_tft.py (e.g. the --smoke-test run)",
                allow_module_level=True)
import serve_pr_tft as S  # noqa: E402
import train_pr_tft as T  # noqa: E402

CONTRACTS = ROOT / "contracts" / "v1"
RUN_DIR = Path(os.environ["RUN_DIR"]).resolve()


def _validators() -> dict[str, Draft202012Validator]:
    schemas = {p.name: json.loads(p.read_text()) for p in CONTRACTS.glob("*.json")}
    registry = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in schemas.values())
    return {name: Draft202012Validator(s, registry=registry, format_checker=Draft202012Validator.FORMAT_CHECKER)
            for name, s in schemas.items()}


V = _validators()


def assert_valid(schema: str, instance) -> None:
    errors = sorted(V[schema].iter_errors(instance), key=lambda e: list(e.path))
    assert not errors, "\n".join(f"{list(e.path)}: {e.message}" for e in errors[:5])


@pytest.fixture(scope="module")
def client():
    data_dir = Path(os.environ["DATA_DIR"]) if os.environ.get("DATA_DIR") else None
    with TestClient(S.create_app(RUN_DIR, data_dir=data_dir)) as c:
        yield c


@pytest.fixture(scope="module")
def subjects(client):
    return client.get("/v1/subjects").json()


def request_body(subject_id: str, **extra) -> dict:
    body = {"schema_version": "1.0.0", "request_id": str(uuid.uuid4()), "subject_id": subject_id}
    body.update(extra)
    assert_valid("forecast-request.json", body)
    return body


def test_health(client):
    r = client.get("/v1/health")
    assert r.status_code == 200 and r.json()["contract_version"] == "1.0.0"


def test_forecast_default(client, subjects):
    r = client.post("/v1/forecasts", json=request_body(subjects[0]["subject_id"]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert_valid("forecast-response.json", body)
    q = np.array([[p[k] for k in ("p05", "p10", "p25", "p50", "p75", "p90", "p95")] for p in body["forecast"]["points"]])
    assert (np.diff(q, axis=1) >= -1e-6).all(), "quantiles cross"
    cum = [c["p"] for c in body["spike_risk"]["cumulative"]]
    assert all(b >= a - 1e-9 for a, b in zip(cum, cum[1:])), "cumulative hazard decreases"
    assert "scenarios" not in body and "ehr_context" not in body  # absent = not requested
    assert body["model"]["fallback_used"] is None


def test_forecast_everything_and_scenarios(client, subjects):
    sid = subjects[1]["subject_id"]
    as_of = subjects[1]["last_as_of"].replace("+00:00", "Z")
    body = request_body(sid, as_of=as_of, include=["drivers", "twin_state", "ehr_context", "twin_overlay", "scenarios"],
                        scenarios=[
                            {"scenario_id": "big-meal", "label": "60 g lunch now", "inputs": [{"kind": "meal", "offset_min": 0, "carbs_g": 60}]},
                            {"scenario_id": "walk", "inputs": [{"kind": "meal", "offset_min": 0, "carbs_g": 60},
                                                               {"kind": "activity", "offset_min": 15, "duration_min": 30, "intensity": "moderate"}]},
                            {"scenario_id": "skip-dinner", "inputs": [{"kind": "skip_habitual_meal", "meal_slot": "dinner"}]},
                        ])
    r = client.post("/v1/forecasts", json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert_valid("forecast-response.json", out)
    sc = {s["scenario_id"]: s for s in out["scenarios"]}
    assert sc["big-meal"]["delta_peak_mg_dl"] > 0, "a 60 g meal must raise the predicted peak"
    walk_peak = max(p["p50"] for p in sc["walk"]["points"])
    meal_peak = max(p["p50"] for p in sc["big-meal"]["points"])
    assert walk_peak < meal_peak, "walking after the same meal must lower the peak"
    assert sc["big-meal"]["delta_probability"] is not None
    assert isinstance(sc["big-meal"]["delta_probability"], float)
    assert sc["big-meal"]["probability_120m"] is not None
    assert all("twin_p50" in p for p in out["forecast"]["points"])
    assert any(w["code"] == "SCENARIO_APPROXIMATION" for w in out.get("warnings", []))


def test_medication_scenario_is_rejected(client, subjects):
    body = request_body(subjects[0]["subject_id"], scenarios=[
        {"scenario_id": "skip-met", "inputs": [{"kind": "medication", "offset_min": 0, "med_class": "metformin", "taken": False}]}])
    r = client.post("/v1/forecasts", json=body)
    assert r.status_code == 422 and r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "SCENARIO_UNSUPPORTED"


@pytest.mark.parametrize("mutate, status, code", [
    (lambda b: b.update(subject_id=str(uuid.uuid4())), 404, "SUBJECT_NOT_FOUND"),
    (lambda b: b.pop("request_id"), 422, "REQUEST_INVALID"),
    (lambda b: b.update(schema_version="2.0.0"), 422, "REQUEST_INVALID"),
    (lambda b: b.update(as_of="2020-01-01T00:00:00Z"), 422, "AS_OF_OUT_OF_RANGE"),
])
def test_errors_are_problem_details(client, subjects, mutate, status, code):
    body = {"schema_version": "1.0.0", "request_id": str(uuid.uuid4()), "subject_id": subjects[0]["subject_id"]}
    mutate(body)
    r = client.post("/v1/forecasts", json=body)
    assert r.status_code == status and r.json()["code"] == code, r.text


def test_insufficient_data_returns_null_forecast(client):
    """Inside a CGM gap longer than 15 min no forecast may be served."""
    svc: S.ServiceContext = client.app.state.ctx
    for sid, pc in svc.patients.items():
        gaps = np.flatnonzero(~np.isfinite(pc.ps.cgm_ff[T.PAST_STEPS:])) + T.PAST_STEPS
        if gaps.size:
            stamp = pc.ps.stamps[gaps[0]].isoformat() + "Z"
            r = client.post("/v1/forecasts", json=request_body(str(sid), as_of=stamp))
            assert r.status_code == 200, r.text
            out = r.json()
            assert_valid("forecast-response.json", out)
            assert out["data_quality"]["status"] == "insufficient"
            assert out["forecast"] is None and out["spike_risk"] is None and out["alert"]["state"] == "none"
            return
    pytest.skip("cohort has no gap longer than 15 min")


def test_fallback_to_twin_only(client, subjects, monkeypatch):
    svc: S.ServiceContext = client.app.state.ctx

    def boom(*_a, **_k):
        raise RuntimeError("simulated model failure")

    monkeypatch.setattr(svc, "run_model", boom)
    r = client.post("/v1/forecasts", json=request_body(subjects[0]["subject_id"]))
    assert r.status_code == 200, r.text
    out = r.json()
    assert_valid("forecast-response.json", out)
    assert out["model"]["fallback_used"] == "twin_only"
    assert out["spike_risk"] is None
    assert out["alert"]["state"] == "none"
    points = out["forecast"]["points"]
    assert len(points) == 24
    for p in points:
        assert p["p05"] <= p["p10"] <= p["p25"] <= p["p50"] <= p["p75"] <= p["p90"] <= p["p95"]


def test_fallback_to_twin_only_with_scenarios(client, subjects, monkeypatch):
    svc: S.ServiceContext = client.app.state.ctx

    def boom(*_a, **_k):
        raise RuntimeError("simulated model failure")

    monkeypatch.setattr(svc, "run_model", boom)
    body = request_body(subjects[0]["subject_id"], scenarios=[
        {"scenario_id": "lunch", "label": "30 g carb", "inputs": [{"kind": "meal", "offset_min": 0, "carbs_g": 30}]},
        {"scenario_id": "walk", "inputs": [{"kind": "activity", "offset_min": 15, "duration_min": 30, "intensity": "moderate"}]},
    ])
    r = client.post("/v1/forecasts", json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert_valid("forecast-response.json", out)
    assert out["model"]["fallback_used"] == "twin_only"
    assert out["spike_risk"] is None
    assert out["alert"]["state"] == "none"
    assert len(out["scenarios"]) == 2
    for sc in out["scenarios"]:
        assert sc["delta_probability"] is None
        assert sc["probability_120m"] is None
        assert isinstance(sc["delta_peak_mg_dl"], float)
        assert len(sc["points"]) == 24
        for p in sc["points"]:
            assert p["p10"] <= p["p50"] <= p["p90"]


def test_scenarios_with_unavailable_baseline_probability(client, subjects):
    svc: S.ServiceContext = client.app.state.ctx
    pc = svc.patient(uuid.UUID(subjects[0]["subject_id"]))
    t = S.T.FIRST_ANCHOR
    base, _, _, _, _ = svc.rollouts(pc, t)
    reqs = [S.ScenarioRequest(scenario_id="meal1", inputs=[S.MealInput(kind="meal", offset_min=0, carbs_g=45)])]
    results, _ = S.scenarios(svc, pc, t, reqs, base, base_p120=None)
    assert len(results) == 1
    assert results[0]["scenario_id"] == "meal1"
    assert results[0]["delta_probability"] is None
    assert results[0]["probability_120m"] is not None
    assert isinstance(results[0]["probability_120m"], float)


def test_scenario_calibration_failure_surfaced(client, subjects, monkeypatch):
    svc: S.ServiceContext = client.app.state.ctx
    pc = svc.patient(uuid.UUID(subjects[0]["subject_id"]))
    t = S.T.FIRST_ANCHOR
    base, _, _, _, _ = svc.rollouts(pc, t)
    reqs = [S.ScenarioRequest(scenario_id="meal1", inputs=[S.MealInput(kind="meal", offset_min=0, carbs_g=45)])]

    orig_calibrated_hazard = S.calibrated_hazard

    # 1. Direct call to S.scenarios raises ServiceError with CALIBRATION_FAILED when calibration fails
    def boom_calib(*_a, **_k):
        raise ValueError("simulated scenario calibration failure")

    monkeypatch.setattr(S, "calibrated_hazard", boom_calib)
    with pytest.raises(S.ServiceError) as exc_info:
        S.scenarios(svc, pc, t, reqs, base, base_p120=0.2)
    assert exc_info.value.status == 500
    assert exc_info.value.code == "CALIBRATION_FAILED"
    assert "meal1" in exc_info.value.detail
    assert "simulated scenario calibration failure" in exc_info.value.detail

    # 2. HTTP endpoint surfaces CALIBRATION_FAILED error rather than falling back to twin-only
    call_count = 0

    def fail_scenario_calib(ctx, p_bin):
        nonlocal call_count
        call_count += 1
        # First call is baseline calibration; subsequent calls are for scenarios
        if call_count > 1:
            raise ValueError("simulated scenario calibration failure")
        return orig_calibrated_hazard(ctx, p_bin)

    monkeypatch.setattr(S, "calibrated_hazard", fail_scenario_calib)
    body = request_body(subjects[0]["subject_id"], scenarios=[
        {"scenario_id": "lunch", "label": "30 g carb", "inputs": [{"kind": "meal", "offset_min": 0, "carbs_g": 30}]},
    ])
    r = client.post("/v1/forecasts", json=body)
    assert r.status_code == 500, r.text
    assert r.headers["content-type"].startswith("application/problem+json")
    err = r.json()
    assert err["code"] == "CALIBRATION_FAILED"
    assert "lunch" in err["detail"]


def test_scenario_known_delta_probability_arithmetic(client, subjects, monkeypatch):
    svc: S.ServiceContext = client.app.state.ctx
    pc = svc.patient(uuid.UUID(subjects[0]["subject_id"]))
    t = S.T.FIRST_ANCHOR
    base, _, _, _, _ = svc.rollouts(pc, t)
    reqs = [S.ScenarioRequest(scenario_id="meal1", inputs=[S.MealInput(kind="meal", offset_min=0, carbs_g=45)])]

    # Mock calibrated_hazard to return a known probability of 0.7
    monkeypatch.setattr(S, "calibrated_hazard", lambda ctx, p_bin: (np.zeros(24), 0.7))

    # Baseline 0.2, scenario 0.7 -> delta = 0.5
    res1, _ = S.scenarios(svc, pc, t, reqs, base, base_p120=0.2)
    assert res1[0]["probability_120m"] == 0.7
    assert res1[0]["delta_probability"] == pytest.approx(0.5, abs=1e-6)

    # Baseline 0.0 (genuine zero), scenario 0.7 -> delta = 0.7
    res2, _ = S.scenarios(svc, pc, t, reqs, base, base_p120=0.0)
    assert res2[0]["probability_120m"] == 0.7
    assert res2[0]["delta_probability"] == pytest.approx(0.7, abs=1e-6)

    # Baseline None, scenario 0.7 -> delta = None
    res3, _ = S.scenarios(svc, pc, t, reqs, base, base_p120=None)
    assert res3[0]["probability_120m"] == 0.7
    assert res3[0]["delta_probability"] is None



def test_twin_card(client, subjects):
    r = client.get(f"/v1/subjects/{subjects[0]['subject_id']}/twin")
    assert r.status_code == 200, r.text
    assert_valid("twin-card.json", r.json())


def test_stream_events(client, subjects):
    sid = subjects[2]["subject_id"]
    with client.stream("GET", f"/v1/subjects/{sid}/stream", params={"speed": 0, "max_events": 6}) as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        text = "".join(r.iter_text())
    events = [json.loads(line[len("data: "):]) for line in text.splitlines() if line.startswith("data: ")]
    forecasts = [e for e in events if e["event"] == "forecast.updated"]
    assert len(forecasts) == 6
    for e in events:
        assert_valid("stream-event.json", e)
        if e["event"] == "forecast.updated":
            assert_valid("forecast-response.json", e["payload"])
    ids = [e["event_id"] for e in forecasts]
    assert ids == sorted(ids)
    # resume after the third forecast with Last-Event-ID
    with client.stream("GET", f"/v1/subjects/{sid}/stream", params={"speed": 0, "max_events": 1},
                       headers={"Last-Event-ID": ids[2]}) as r:
        resumed = [json.loads(line[6:]) for line in "".join(r.iter_text()).splitlines() if line.startswith("data: ")]
    assert resumed[0]["event_id"] == ids[3]


def test_stream_resume_preserves_alert_companion_and_cooldown(client, subjects):
    sid = subjects[0]["subject_id"]
    # Run uninterrupted stream for 3 readings
    with client.stream("GET", f"/v1/subjects/{sid}/stream", params={"speed": 0, "max_events": 6}) as r:
        uninterrupted = [json.loads(line[6:]) for line in "".join(r.iter_text()).splitlines() if line.startswith("data: ")]

    # If any alert event exists in uninterrupted stream:
    uninterrupted_events = [(e["event"], e["event_id"]) for e in uninterrupted]
    first_forecast_id = uninterrupted[0]["event_id"]

    # Resume immediately after first forecast event
    with client.stream("GET", f"/v1/subjects/{sid}/stream", params={"speed": 0, "max_events": 5},
                       headers={"Last-Event-ID": first_forecast_id}) as r:
        resumed = [json.loads(line[6:]) for line in "".join(r.iter_text()).splitlines() if line.startswith("data: ")]

    resumed_events = [(e["event"], e["event_id"]) for e in resumed]
    # The resumed sequence must equal the tail of the uninterrupted sequence (no omitted companion events, no duplicated alerts)
    assert resumed_events == uninterrupted_events[1:len(resumed_events) + 1]


def test_latency_p95(client, subjects):
    times = []
    for s in subjects[:40]:
        t0 = time.perf_counter()
        assert client.post("/v1/forecasts", json=request_body(s["subject_id"])).status_code == 200
        times.append(1000 * (time.perf_counter() - t0))
    p95 = float(np.percentile(times, 95))
    print(f"\nforecast latency ms: p50 {np.median(times):.0f}, p95 {p95:.0f}")
    assert p95 < 150, "Blueprint 10.2 target: p95 < 150 ms"


def test_warmup_contract_earliest_anchor(client, subjects):
    svc: S.ServiceContext = client.app.state.ctx
    sid = subjects[0]["subject_id"]
    pc = svc.patients[uuid.UUID(sid)]

    # Subject first_as_of matches FIRST_ANCHOR (step 287)
    expected_first = S.utc(pc.ps.stamps[T.FIRST_ANCHOR]).isoformat()
    assert subjects[0]["first_as_of"] == expected_first

    # Request before FIRST_ANCHOR (e.g., step 143 or step 200) must return 422 AS_OF_OUT_OF_RANGE
    stamp_early = pc.ps.stamps[200].isoformat() + "Z"
    r = client.post("/v1/forecasts", json=request_body(sid, as_of=stamp_early))
    assert r.status_code == 422
    assert r.json()["code"] == "AS_OF_OUT_OF_RANGE"

    # Request at exactly FIRST_ANCHOR (step 287) succeeds
    stamp_first = pc.ps.stamps[T.FIRST_ANCHOR].isoformat() + "Z"
    r_first = client.post("/v1/forecasts", json=request_body(sid, as_of=stamp_first))
    assert r_first.status_code == 200
    out_first = r_first.json()
    assert_valid("forecast-response.json", out_first)
    assert out_first["as_of"].startswith(expected_first[:19])
    assert out_first["data_quality"]["in_warmup"] is False


def test_warmup_insufficient_history_guarantees(client, subjects):
    svc: S.ServiceContext = client.app.state.ctx
    sid = subjects[0]["subject_id"]
    pc = svc.patients[uuid.UUID(sid)]

    # data_quality at t < FIRST_ANCHOR must be insufficient, in_warmup=True, with sensor_warmup and sensor_day1 reasons
    for step in (0, 72, 143, 200, 286):
        dq = S.data_quality(svc, pc, step)
        assert dq["status"] == "insufficient", f"Step {step} must be insufficient"
        assert dq["in_warmup"] is True
        assert dq["sensor_day"] == 0
        assert "sensor_warmup" in dq["reasons"]
        assert "sensor_day1" in dq["reasons"]

        # build_forecast at t < FIRST_ANCHOR cannot produce a valid forecast or risk
        req = S.ForecastRequest(schema_version="1.0.0", request_id=uuid.uuid4(), subject_id=uuid.UUID(sid))
        body = S.build_forecast(svc, req, t_override=step)
        assert body["data_quality"]["status"] == "insufficient"
        assert body["forecast"] is None
        assert body["spike_risk"] is None
        assert body["alert"]["state"] == "none"

        # Explicit direct calls to rollouts or run_model must fail safely
        with pytest.raises(ValueError, match="Cannot compute rollouts before FIRST_ANCHOR"):
            svc.rollouts(pc, step)
        with pytest.raises(ValueError, match="Cannot run model before FIRST_ANCHOR"):
            svc.run_model(pc, step, np.zeros(24), np.zeros((24, 8)))


def test_twin_card_caching(client, subjects):
    sid = subjects[0]["subject_id"]
    t0 = time.perf_counter()
    r1 = client.get(f"/v1/subjects/{sid}/twin")
    t1 = time.perf_counter() - t0
    assert r1.status_code == 200

    t2_start = time.perf_counter()
    r2 = client.get(f"/v1/subjects/{sid}/twin")
    t2 = time.perf_counter() - t2_start
    assert r2.status_code == 200
    assert r1.json() == r2.json()
    assert t2 < 0.05, f"Cached twin_card took {t2:.3f}s, expected < 0.05s"

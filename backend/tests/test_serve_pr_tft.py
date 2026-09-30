"""Contract tests for serve_pr_tft.py (Blueprint 9.7).

Every response is validated against the JSON Schemas in contracts/v1/, the same files the
Next.js side generates its types and Zod validators from.

    RUN_DIR=runs/pr_tft_demo pytest -q tests/test_serve_pr_tft.py
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
import serve_pr_tft as S  # noqa: E402
import train_pr_tft as T  # noqa: E402

CONTRACTS = ROOT / "contracts" / "v1"
RUN_DIR = Path(os.environ.get("RUN_DIR", ROOT / "runs" / "pr_tft_demo"))


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
    os.chdir(ROOT)  # config.json holds a relative data_dir
    with TestClient(S.create_app(RUN_DIR, data_dir=Path(os.environ.get("DATA_DIR", "data_test")))) as c:
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


def test_latency_p95(client, subjects):
    times = []
    for s in subjects[:40]:
        t0 = time.perf_counter()
        assert client.post("/v1/forecasts", json=request_body(s["subject_id"])).status_code == 200
        times.append(1000 * (time.perf_counter() - t0))
    p95 = float(np.percentile(times, 95))
    print(f"\nforecast latency ms: p50 {np.median(times):.0f}, p95 {p95:.0f}")
    assert p95 < 150, "Blueprint 10.2 target: p95 < 150 ms"

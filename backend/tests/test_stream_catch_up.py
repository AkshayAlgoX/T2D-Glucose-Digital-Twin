"""Stream catch-up: the first N readings after the replay start are sent unpaced, each a full forecast."""
import json
import os
import sys
import threading
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
RUN_DIR = Path(os.environ.get("RUN_DIR", ROOT / "runs" / "pr_tft_ablation_arm_d"))
if not (RUN_DIR / "run_manifest.json").exists():
    pytest.skip(f"no run at {RUN_DIR}", allow_module_level=True)

import serve_pr_tft as S  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

SPLIT = json.loads((RUN_DIR / "split.json").read_text())
SID = str(uuid.uuid5(S.SUBJECT_NAMESPACE, sorted(SPLIT["val"])[0]))


@pytest.fixture(scope="module")
def client():
    data_dir = Path(os.environ["DATA_DIR"]) if os.environ.get("DATA_DIR") else None
    with TestClient(S.create_app(RUN_DIR, data_dir=data_dir)) as c:
        yield c


def read_forecasts(client, params, timeout_s=60.0):
    """Read the stream in a thread so a regression to paced sending fails instead of hanging."""
    out: dict = {}

    def run():
        with client.stream("GET", f"/v1/subjects/{SID}/stream", params=params) as res:
            out["status"] = res.status_code
            out["events"] = [json.loads(line[6:]) for line in res.iter_lines() if line.startswith("data: ")]

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(timeout_s)
    assert not t.is_alive(), "catch-up readings were paced"
    return out


def test_catch_up_readings_are_unpaced_full_forecasts(client):
    # speed=0.001 would pause 300,000 s between readings; only the catch-up window can finish in time.
    out = read_forecasts(client, {"speed": 0.001, "catch_up": 4, "max_events": 4})
    assert out["status"] == 200
    forecasts = [e for e in out["events"] if e["event"] == "forecast.updated"]
    assert len(forecasts) == 4
    stamps = [e["payload"]["as_of"] for e in forecasts]
    assert stamps == sorted(stamps) and len(set(stamps)) == 4
    for e in forecasts:
        assert e["payload"]["forecast"] is None or len(e["payload"]["forecast"]["points"]) == 24


@pytest.mark.parametrize("bad", [-1, 289])
def test_catch_up_bounds_are_enforced(client, bad):
    res = client.get(f"/v1/subjects/{SID}/stream", params={"catch_up": bad, "max_events": 1})
    assert res.status_code == 422
    assert res.json()["code"] == "REQUEST_INVALID"


# ---- observed_inputs: the wearable/log readings the network consumed, exposed for the dashboard ---- #
from jsonschema import Draft202012Validator  # noqa: E402
from referencing import Registry, Resource  # noqa: E402
import numpy as np  # noqa: E402
import train_pr_tft as T  # noqa: E402

CONTRACTS = ROOT / "backend" / "contracts" / "v1"


def _validator() -> Draft202012Validator:
    schemas = {p.name: json.loads(p.read_text()) for p in CONTRACTS.glob("*.json")}
    registry = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in schemas.values())
    return Draft202012Validator(schemas["forecast-response.json"], registry=registry,
                                format_checker=Draft202012Validator.FORMAT_CHECKER)


def test_observed_inputs_match_the_series_the_network_reads(client):
    svc: S.ServiceContext = client.app.state.ctx
    pc = svc.patients[uuid.UUID(SID)]
    carbs = T._logged_carbs_series(pc.ps)
    # Check a spread of anchors, including one with a logged meal when the subject has any.
    meal_steps = [int(i) for i in np.flatnonzero(carbs > 0) if T.FIRST_ANCHOR <= i < pc.ps.n - T.HORIZON]
    anchors = [T.FIRST_ANCHOR, T.FIRST_ANCHOR + 37] + meal_steps[:1]
    validator = _validator()
    for t in anchors:
        as_of = pc.ps.stamps[t].tz_localize("UTC").isoformat() if pc.ps.stamps[t].tzinfo is None else pc.ps.stamps[t].isoformat()
        res = client.post("/v1/forecasts", json={"schema_version": "1.0.0", "request_id": str(uuid.uuid4()),
                                                 "subject_id": SID, "as_of": as_of})
        assert res.status_code == 200, res.text
        body = res.json()
        errors = list(validator.iter_errors(body))
        assert not errors, errors[0].message
        got = body["observed_inputs"]
        assert got["heart_rate_bpm"] == round(float(pc.ps.hr[t]), 1)
        assert got["hrv_rmssd_ms"] == round(float(pc.ps.hrv[t]), 1)
        assert got["steps_5min"] == round(float(pc.ps.steps[t]), 1)
        assert got["asleep"] is bool(pc.ps.asleep[t] > 0)
        assert got["carbs_logged_g"] == round(float(carbs[t]), 1)
    if meal_steps:
        assert got["carbs_logged_g"] > 0

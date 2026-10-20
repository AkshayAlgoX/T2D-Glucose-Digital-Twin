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

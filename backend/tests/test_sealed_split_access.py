"""The sealed test partition is never served: not listed, not forecast, no twin card, no stream.

A sealed subject must be indistinguishable from an unknown id, so the API cannot be used as an
oracle for which ids belong to the held-out cohort. The partition itself stays loaded and the
run's split file is untouched, so evaluation artifacts and provenance are unchanged.
"""
import json
import os
import sys
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
SEALED_PIDS = sorted(SPLIT["test"])
VAL_DEMO_PID = "P0017"


def sid(pid: str) -> str:
    return str(uuid.uuid5(S.SUBJECT_NAMESPACE, pid))


@pytest.fixture(scope="module")
def client():
    data_dir = Path(os.environ["DATA_DIR"]) if os.environ.get("DATA_DIR") else None
    with TestClient(S.create_app(RUN_DIR, data_dir=data_dir)) as c:
        yield c


def forecast_body(subject_id: str, **extra) -> dict:
    return {"schema_version": "1.0.0", "request_id": str(uuid.uuid4()), "subject_id": subject_id, **extra}


def problem(res) -> tuple:
    body = res.json()
    return res.status_code, body["code"], body["title"]


def test_split_file_still_declares_a_sealed_test_partition():
    assert SEALED_PIDS, "the run must declare a test partition"
    assert S.SEALED_SPLITS == frozenset({"test"})
    if RUN_DIR.name == "pr_tft_ablation_arm_d":
        assert len(SEALED_PIDS) == 44 and VAL_DEMO_PID in SPLIT["val"]


def test_enumeration_lists_no_sealed_subject(client):
    listed = client.get("/v1/subjects").json()
    assert {s["split"] for s in listed} == {"train", "val"}
    listed_ids = {s["subject_id"] for s in listed}
    assert not listed_ids & {sid(p) for p in SEALED_PIDS}
    assert len(listed) == len(SPLIT["train"]) + len(SPLIT["val"])
    assert client.get("/v1/health").json()["subjects"] == len(listed)
    demo = next((s for s in listed if s["patient_id"] == VAL_DEMO_PID), None)
    if VAL_DEMO_PID in SPLIT["val"]:
        assert demo is not None and demo["split"] == "val" and demo["group"] == "Type 2"


@pytest.mark.parametrize("pid", SEALED_PIDS[:3] + SEALED_PIDS[-1:])
def test_sealed_subject_is_refused_like_an_unknown_id(client, pid):
    sealed, unknown = sid(pid), str(uuid.uuid4())
    for target in (sealed, unknown):
        assert problem(client.post("/v1/forecasts", json=forecast_body(target))) == (404, "SUBJECT_NOT_FOUND", "Subject not found")
        assert problem(client.get(f"/v1/subjects/{target}/twin")) == (404, "SUBJECT_NOT_FOUND", "Subject not found")
        assert problem(client.get(f"/v1/subjects/{target}/stream", params={"max_events": 1})) == (404, "SUBJECT_NOT_FOUND", "Subject not found")


def test_sealed_subject_cannot_be_reached_through_a_scenario_or_pinned_time(client):
    target = sid(SEALED_PIDS[0])
    body = forecast_body(target, as_of="2026-10-01T12:00:00Z", include=["scenarios", "twin_overlay"],
                         scenarios=[{"scenario_id": "what-if", "inputs": [{"kind": "meal", "offset_min": 0, "carbs_g": 40}]}])
    assert problem(client.post("/v1/forecasts", json=body)) == (404, "SUBJECT_NOT_FOUND", "Subject not found")
    res = client.get(f"/v1/subjects/{target}/stream", params={"as_of": "2026-10-01T12:00:00Z", "max_events": 1},
                     headers={"Last-Event-ID": "000300-forecast"})
    assert problem(res) == (404, "SUBJECT_NOT_FOUND", "Subject not found")


def test_validation_demo_subject_is_still_served(client):
    if VAL_DEMO_PID not in SPLIT["val"]:
        pytest.skip(f"{VAL_DEMO_PID} is not a validation subject in this run")
    target = sid(VAL_DEMO_PID)
    res = client.post("/v1/forecasts", json=forecast_body(target))
    assert res.status_code == 200
    assert res.json()["subject"]["cohort"] == "synthetic-v2/val"
    assert client.get(f"/v1/subjects/{target}/twin").status_code == 200


def test_sealed_partition_stays_loaded_for_provenance(client):
    svc: S.ServiceContext = client.app.state.ctx
    assert len(svc.patients) == sum(len(v) for v in SPLIT.values())
    assert svc.sealed_pids == frozenset(SEALED_PIDS)
    assert all(svc.split_of[p] == "test" for p in SEALED_PIDS)


def test_dashboard_demo_link_is_the_validation_subject_p0017():
    import re
    src = (ROOT / "src" / "lib" / "landing.ts").read_text()
    linked = re.search(r"DEMO_SUBJECT_ID = '([0-9a-f-]{36})'", src).group(1)
    assert linked == sid(VAL_DEMO_PID)
    assert VAL_DEMO_PID in SPLIT["val"] and VAL_DEMO_PID not in SEALED_PIDS

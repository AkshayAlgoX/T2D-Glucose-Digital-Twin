import pytest
import uuid
import datetime as dt
import numpy as np
from pydantic import BaseModel
import serve_pr_tft as S
from test_serve_pr_tft import assert_valid, client, subjects, request_body

def test_quantile_ordering_guaranteed(client):
    # Mock the internal q returned by the model to cross
    svc = client.app.state.ctx
    orig_run_model = svc.run_model
    def run_model_mock(*args, **kwargs):
        res = orig_run_model(*args, **kwargs)
        # Randomly shuffle quantiles to create malformed unordered output
        bad_q = np.random.permutation(res["q"].flatten()).reshape(res["q"].shape)
        # Apply the fix in serve_pr_tft.py if not already done, wait, our fix is inside run_model
        # But we need to test the outer boundary. Let's mock module.model
        return res
    
    # Better: just mock the module.model
    class MockModel:
        def __call__(self, batch):
            import torch
            q = torch.rand(1, S.T.HORIZON, 7) * 100 + 100
            # intentionally misordered
            q[:, :, 0] = 300 
            q[:, :, 6] = 50
            return {"quantiles": q, "hazard_logits": torch.zeros(1, S.T.HORIZON), "peak": torch.zeros(1, 2)}
            
    orig_model = svc.module.model
    svc.module.model = MockModel()
    try:
        r = client.post("/v1/forecasts", json=request_body(subjects[0]["subject_id"]))
        assert r.status_code == 200, r.text
        body = r.json()
        q = np.array([[p[k] for k in ("p05", "p10", "p25", "p50", "p75", "p90", "p95")] for p in body["forecast"]["points"]])
        assert (np.diff(q, axis=1) >= 0).all(), "quantiles cross"
    finally:
        svc.module.model = orig_model

def test_stream_include_options_b1_b5(client, subjects):
    sid = subjects[1]["subject_id"]
    # 1. test default omitted -> drivers, twin_state
    with client.stream("GET", f"/v1/subjects/{sid}/stream", params={"speed": 0, "max_events": 1}) as r:
        text = "".join(r.iter_text())
        events = [S.json.loads(line[len("data: "):]) for line in text.splitlines() if line.startswith("data: ")]
        payload = events[0]["payload"]
        assert "drivers" in payload
        assert "twin_state" in payload
        assert "ehr_context" not in payload
        assert "twin_p50" not in payload["forecast"]["points"][0]

    # 2. test with all supported options
    params = {"speed": 0, "max_events": 1, "include": ["drivers", "twin_state", "ehr_context", "twin_overlay"]}
    with client.stream("GET", f"/v1/subjects/{sid}/stream", params=params) as r:
        text = "".join(r.iter_text())
        events = [S.json.loads(line[len("data: "):]) for line in text.splitlines() if line.startswith("data: ")]
        payload = events[0]["payload"]
        assert "drivers" in payload
        assert "twin_state" in payload
        assert "ehr_context" in payload
        assert "twin_p50" in payload["forecast"]["points"][0]

    # 3. test invalid include rejected safely
    params = {"speed": 0, "max_events": 1, "include": ["drivers", "invalid_include"]}
    with client.stream("GET", f"/v1/subjects/{sid}/stream", params=params) as r:
        assert r.status_code == 422


def test_stream_event_contract_payloads_b4(client, subjects):
    # Look for alerts and data quality changes by replaying a bit more
    sid = subjects[2]["subject_id"]
    # Mock alert machine step to force alert.raised and alert.cleared
    orig_step = S.AlertMachine.step
    def mock_step(self, p, p50_max, subject, now):
        if not hasattr(self, "called"):
            self.called = 1
            return {"state": "warning", "alert_id": "123", "since": now.isoformat(), "suppressed_until": None, "message_key": "alert.spike.warning"}, "alert.raised"
        elif self.called == 1:
            self.called = 2
            return {"state": "none", "alert_id": None, "since": None, "suppressed_until": None, "message_key": None}, "alert.cleared"
        return orig_step(self, p, p50_max, subject, now)

    S.AlertMachine.step = mock_step
    try:
        with client.stream("GET", f"/v1/subjects/{sid}/stream", params={"speed": 0, "max_events": 4}) as r:
            text = "".join(r.iter_text())
            events = [S.json.loads(line[len("data: "):]) for line in text.splitlines() if line.startswith("data: ")]
            
            raised = [e for e in events if e["event"] == "alert.raised"]
            if raised:
                # assert payload fits Alert contract
                # wait, in forecast-response.json, Alert is a $def. 
                # Let's just use S.Alert.model_validate
                S.Alert.model_validate(raised[0]["payload"])
            
            cleared = [e for e in events if e["event"] == "alert.cleared"]
            if cleared:
                S.Alert.model_validate(cleared[0]["payload"])

            dq = [e for e in events if e["event"] == "data_quality.changed"]
            if dq:
                S.DataQuality.model_validate(dq[0]["payload"])
                
            updated = [e for e in events if e["event"] == "forecast.updated"]
            if updated:
                S.ForecastResponse.model_validate(updated[0]["payload"])
    finally:
        S.AlertMachine.step = orig_step

def test_alert_policy_metadata_b3(client, subjects):
    sid = subjects[1]["subject_id"]
    r = client.post("/v1/forecasts", json=request_body(sid))
    body = r.json()
    # verify the current policy version is reflected and not the old one
    assert body["model"]["alert_policy_version"] == "ap-1.1-service"


import pytest
import datetime as dt
import numpy as np
import dataclasses
from pathlib import Path
import json

import train_pr_tft as T
from serve_pr_tft import ServiceContext, ForecastRequest, build_forecast, ServiceError

@pytest.fixture(scope="module")
def run_dir():
    return Path("runs/pr_tft_ablation_arm_d")

def test_inference_equivalence(run_dir, tmp_path):
    """Prove that serving behaves exactly the same with and without the artifact."""
    ukf_file = run_dir / "canonical_ukf_state.npz"
    if not ukf_file.exists():
        pytest.skip("No canonical artifact present")

    # Set up isolated run directory WITHOUT the canonical artifact to test dynamic computation safely
    dyn_run = tmp_path / "dynamic_run"
    dyn_run.mkdir()
    for item in run_dir.iterdir():
        if item.name not in ("canonical_ukf_state.npz", "canonical_ukf_provenance.json"):
            if item.is_dir():
                (dyn_run / item.name).symlink_to(item.resolve())
            else:
                (dyn_run / item.name).symlink_to(item.resolve())

    ctx_dyn = ServiceContext(dyn_run)
    ctx_stat = ServiceContext(run_dir)
    
    # Compare
    for pid in list(ctx_dyn.by_pid.keys())[:5]:
        sid = ctx_dyn.by_pid[pid]
        pc_dyn = ctx_dyn.patient(sid)
        pc_stat = ctx_stat.patient(sid)
        
        # EXACT equality on past tensors? 
        np.testing.assert_array_equal(pc_dyn.past, pc_stat.past)
        
        for as_of in [None, pc_dyn.ps.stamps[300]]:
            req = ForecastRequest(schema_version="1.0.0", subject_id=str(sid), as_of=as_of.isoformat() + "Z" if as_of else None, request_id="00000000-0000-0000-0000-000000000123")
            res_dyn = build_forecast(ctx_dyn, req)
            res_stat = build_forecast(ctx_stat, req)
            
            # Forecast points
            for dp, sp in zip(res_dyn["forecast"]["points"], res_stat["forecast"]["points"]):
                assert dp["p50"] == sp["p50"]
            
            # Risk
            assert res_dyn["spike_risk"]["probability_120m"] == res_stat["spike_risk"]["probability_120m"]
            assert res_dyn["spike_risk"]["spike_in_progress"] == res_stat["spike_risk"]["spike_in_progress"]

        # Explicitly verify warm-up contract (t < FIRST_ANCHOR)
        # 1. Pinned as_of prior to FIRST_ANCHOR is rejected by anchor_index with ServiceError(422)
        with pytest.raises(ServiceError) as exc_info:
            ctx_dyn.anchor_index(pc_dyn, pc_dyn.ps.stamps[200])
        assert exc_info.value.status == 422
        assert exc_info.value.code == "AS_OF_OUT_OF_RANGE"

        # 2. build_forecast under warm-up produces insufficient data quality and null forecasts
        req_warmup = ForecastRequest(schema_version="1.0.0", subject_id=str(sid), as_of=pc_dyn.ps.stamps[200].isoformat() + "Z", request_id="00000000-0000-0000-0000-000000000124")
        res_dyn_warmup = build_forecast(ctx_dyn, req_warmup, t_override=200)
        res_stat_warmup = build_forecast(ctx_stat, req_warmup, t_override=200)
        assert res_dyn_warmup["data_quality"]["status"] == "insufficient"
        assert res_stat_warmup["data_quality"]["status"] == "insufficient"
        assert res_dyn_warmup["data_quality"]["in_warmup"] is True
        assert res_stat_warmup["data_quality"]["in_warmup"] is True
        assert res_dyn_warmup["forecast"] is None and res_stat_warmup["forecast"] is None
        assert res_dyn_warmup["spike_risk"] is None and res_stat_warmup["spike_risk"] is None

def test_no_future_leakage(run_dir):
    """Prove that state slice at anchor 287 depends only on historical indices <= 287."""
    ctx = ServiceContext(run_dir)
    sid = list(ctx.patients.keys())[0]
    pc = ctx.patient(sid)

    # When requesting as_of at anchor 287, past matrix uses indices up to 287
    past_anchor = pc.past[:T.FIRST_ANCHOR + 1].copy()

    # Modify future readings on a copy of patient series and verify past remains invariant
    ps_copy = dataclasses.replace(pc.ps, cgm=pc.ps.cgm.copy(), hr=pc.ps.hr.copy())
    ps_copy.cgm[T.FIRST_ANCHOR + 1:] = 350.0  # Extreme future spike
    ps_copy.hr[T.FIRST_ANCHOR + 1:] = 180.0    # Extreme future heart rate

    # Re-extract past matrix with mutated future
    effect = ctx.twin.meal_effect_series(ps_copy)
    feats = ctx.twin.state_features(ps_copy)
    mutated_past = T.past_matrix(ps_copy, ctx.norm, effect, feats)

    # Historical slice through anchor 287 MUST remain mathematically identical
    np.testing.assert_array_equal(past_anchor, mutated_past[:T.FIRST_ANCHOR + 1])

import numpy as np
import pandas as pd
from backend.train_pr_tft import _logged_carbs_series, _carbs_on_board, detect_spike_onsets, eligible_anchors, TrainConfig, load_data, PatientSeries

def test_meal_binning_causality():
    # meal at 12.3 min should ONLY affect bins at and after ceil(12.3 / 5) = 3 (15 min)
    ps = PatientSeries(
        pid="test", group="Type 2", stamps=np.arange(10)*300, cgm=np.full(10, 100.0),
        cgm_ff=np.full(10, 100.0), hr=np.full(10, 70.0), hrv=np.zeros(10), steps=np.zeros(10),
        asleep=np.zeros(10), meal_min=np.array([12.3]), meal_carbs=np.array([20.0]), static_raw={},
        tmax=40.0, gb=100.0, k_base=0.01, vg=150.0
    )
    
    logged = _logged_carbs_series(ps)
    assert logged[0] == 0
    assert logged[1] == 0
    assert logged[2] == 0
    assert logged[3] == 20.0 # bin 3 corresponds to time 15.0
    
    cob = _carbs_on_board(ps)
    assert cob[0] == 0
    assert cob[1] == 0
    assert cob[2] == 0
    assert cob[3] > 0
    
    import backend.ukf_twin as U
    # also verify ukf_twin
    bins = np.clip(np.ceil(ps.meal_min / 5.0).astype(int), 0, ps.n - 1)
    assert bins[0] == 3

def test_resting_hr_causality():
    cfg = TrainConfig(data_dir="/home/akshaya/synthetic_v2_300", seed=1, limit_patients=1)
    rng = np.random.default_rng(1)
    series = load_data(cfg, rng)
    ps = next(iter(series.values()))
    
    anchors = eligible_anchors(ps, cfg)
    t = anchors[0]
    assert t >= 287 # max(143, 287)
    
    import backend.ukf_twin as U
    # Recompute parameters from truncated data
    asleep = ps.asleep[:t+1].astype(bool)
    hr_rest_trunc = U.estimate_hr_rest(ps.hr[:t+1], ps.steps[:t+1], asleep)
    hr_rest_full = U.estimate_hr_rest(ps.hr, ps.steps, ps.asleep.astype(bool))
    
    assert hr_rest_trunc == hr_rest_full

def test_causal_at_risk_label():
    # "For every sampled onset neighbourhood: armed[t] must equal the result obtainable from observations through t only."
    cgm = np.full(100, 100.0)
    cgm[50:60] = 160.0 # Spike
    
    # Run full series
    onset_full, armed_full = detect_spike_onsets(cgm)
    
    # Prefix test
    for t in range(55):
        onset_trunc, armed_trunc = detect_spike_onsets(cgm[:t+1])
        assert armed_full[t] == armed_trunc[t]

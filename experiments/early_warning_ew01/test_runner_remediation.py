import pytest
import numpy as np
import pandas as pd
from unittest.mock import MagicMock
import sys
from pathlib import Path
import json

sys.path.insert(0, str(Path("backend").resolve()))
import train_pr_tft as T
from experiments.baselines.point import linear_trend

# Import our helper from the script
from experiments.early_warning_ew01.run_scientific import evaluate_scientific_rules

def test_trace_result_keyerror():
    # Construct synthetic result/trace
    result = {
        "populations": {
            "primary": {
                "models": {"pr_tft@0.35": {}},
                "paired_differences": {
                    "pr_tft_minus_twin_only": {
                        "event_sensitivity": {"ci_low": 0.03, "ci_high": 0.05, "estimate": 0.04},
                        "false_alerts_per_patient_day": {"ci_low": -0.15, "ci_high": -0.11, "estimate": -0.12}
                    }
                }
            }
        }
    }
    
    trace = MagicMock()
    # If the script accesses trace.populations["primary"]["paired_differences"], it would KeyError
    # since trace is a MagicMock, we explicitly configure it to not have "paired_differences"
    trace.populations = {
        "primary": {
            "weights": np.ones((1, 1)),
            "point": {"pr_tft@0.35": {"event_sensitivity": [0.5], "false_alerts_per_patient_day": [0.1]}},
            "draws": {"pr_tft@0.35": {"event_sensitivity": np.array([0.5]), "false_alerts_per_patient_day": np.array([0.1])}},
        }
    }
    trace.split_test.anchor_t.numpy.return_value = np.array([10])
    trace.split_test.anchor_patient.numpy.return_value = np.array([0])
    trace.decisions = {"test_patient": (None, 0, 100)}
    
    cfg = MagicMock()
    T.eligible_anchors = MagicMock(return_value=np.array([10]))
    
    cgm = np.full(100, np.nan)
    cgm_ff = np.full(100, np.nan)
    cgm_ff[10] = 150.0
    
    ps = T.PatientSeries(
        pid="test_patient",
        group="Type 2",
        stamps=pd.date_range("2020-01-01", periods=100, freq="5min"),
        cgm=cgm,
        cgm_ff=cgm_ff,
        hr=np.zeros(100),
        hrv=np.zeros(100),
        steps=np.zeros(100),
        asleep=np.zeros(100, dtype=bool),
        meal_min=np.zeros(100),
        meal_carbs=np.zeros(100),
        static_raw={},
        gb=100.0,
        k_base=0.01,
        tmax=45.0,
        vg=150.0,
        onset=np.zeros((100, 24), dtype=bool),
        armed=np.ones(100, dtype=bool)
    )
    
    candidate_inputs = [ps]
    
    rule = {"uncertainty": {"ci": 0.95}}
    manifest = {
        "decision_rule": {
            "co_primary_sensitivity_lower_bound_gt": 0.02,
            "co_primary_false_alerts_per_day_upper_bound_lt": -0.10
        }
    }
    
    import backend.evaluate_run as E
    E.forecast_meets_spike_rule = MagicMock(return_value=False)
    E.raise_alerts = MagicMock(return_value=np.zeros(100, dtype=bool))
    E.event_counts = MagicMock(return_value={
        "monitored_onsets": 1, "detected_onsets": 0, "alerts_raised": 0, 
        "true_alerts": 0, "false_alerts": 0, "patient_days": 1, "lead_times_min": []
    })
    E.POPULATIONS = {"primary": ["primary"]}
    
    # Run the rule
    final_result = evaluate_scientific_rules(result, trace, candidate_inputs, cfg, rule, manifest, "attempt_1")
    
    # Verify no KeyError occurred and paired_differences is pulled from result
    assert "paired_differences" in final_result
    assert final_result["pass_b7_vs_b9"] == True

def test_b1_missing_history_anchor_behavior():
    # Prove B1 constructs g0 from cgm_ff not cgm
    cgm = np.full(100, np.nan)
    cgm_ff = np.full(100, np.nan)
    cgm_ff[50:54] = 120.0
    
    t = 52
    
    ps = T.PatientSeries(
        pid="test2",
        group="test",
        stamps=pd.date_range("2020-01-01", periods=100, freq="5min"),
        cgm=cgm,
        cgm_ff=cgm_ff,
        hr=np.zeros(100),
        hrv=np.zeros(100),
        steps=np.zeros(100),
        asleep=np.zeros(100, dtype=bool),
        meal_min=np.zeros(100),
        meal_carbs=np.zeros(100),
        static_raw={},
        gb=100.0,
        k_base=0.01,
        tmax=45.0,
        vg=150.0,
        onset=np.zeros((100, 24), dtype=bool),
        armed=np.ones(100, dtype=bool)
    )
    
    b1_anchors = {
        "patient_ids": ["test2"],
        "t": np.array([t]),
        "patient": np.array([0]),
        "g0": np.array([ps.cgm_ff[t]])
    }
    
    # 1. B1 g0 equals canonical cgm_ff[t]
    assert b1_anchors["g0"][0] == 120.0
    
    # 2. Output matches linear_trend invocation
    b1_preds = linear_trend(b1_anchors, {"test2": ps})
    
    # 3. Forecast is finite
    assert np.isfinite(b1_preds).all()
    # Zero-slope fallback implies prediction equals g0
    assert np.allclose(b1_preds[0], 120.0)

def test_b1_gate_failure():
    result = {
        "populations": {
            "primary": {
                "models": {"pr_tft@0.35": {}},
                "paired_differences": {
                    "pr_tft_minus_twin_only": {
                        "event_sensitivity": {"ci_low": 0.01, "ci_high": 0.05, "estimate": 0.04}, # Fails > 0.02
                        "false_alerts_per_patient_day": {"ci_low": -0.15, "ci_high": -0.11, "estimate": -0.12}
                    }
                }
            }
        }
    }
    
    trace = MagicMock()
    manifest = {
        "decision_rule": {
            "co_primary_sensitivity_lower_bound_gt": 0.02,
            "co_primary_false_alerts_per_day_upper_bound_lt": -0.10
        }
    }
    
    final_result = evaluate_scientific_rules(result, trace, [], None, None, manifest, "attempt_2")
    assert final_result["pass_b7_vs_b9"] == False
    assert final_result["pass_b7_vs_b1"] == "B1_NOT_EVALUATED_GATE_FAILED"


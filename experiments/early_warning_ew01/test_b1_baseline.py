import sys
import numpy as np
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from experiments.baselines.point import linear_trend

class DummySeries:
    def __init__(self, cgm_ff):
        self.cgm_ff = cgm_ff

def test_b1_normal_history():
    # 7 samples spanning 30 minutes (-6 to 0)
    # y = 100 + 2 * (x / 5) -> x is minutes, step=5 -> 2 mg/dL per 5 mins -> 0.4 mg/dL per min
    steps = np.arange(-6, 1)
    hist = 100.0 + 2.0 * steps
    cgm_ff = np.zeros(20)
    cgm_ff[10+steps] = hist
    series = {"P1": DummySeries(cgm_ff)}
    
    anchors = {
        "patient_ids": ["P1"],
        "t": np.array([10]),
        "patient": np.array([0]),
        "g0": np.array([100.0]) # At t=10, cgm=100
    }
    
    pred = linear_trend(anchors, series)
    # Slope is 0.4. Horizon min is 5, 10, ..., 120
    expected = 100.0 + 0.4 * np.arange(5, 125, 5)
    assert np.allclose(pred[0], expected), f"Expected {expected}, got {pred[0]}"
    print("test_b1_normal_history PASSED")

def test_b1_missing_history():
    # One NaN in history triggers slope0 fallback
    steps = np.arange(-6, 1)
    hist = 100.0 + 2.0 * steps
    hist[2] = np.nan
    cgm_ff = np.zeros(20)
    cgm_ff[10+steps] = hist
    series = {"P1": DummySeries(cgm_ff)}
    
    anchors = {
        "patient_ids": ["P1"],
        "t": np.array([10]),
        "patient": np.array([0]),
        "g0": np.array([100.0])
    }
    
    pred = linear_trend(anchors, series)
    # Slope 0 fallback -> persistence
    expected = np.full(24, 100.0)
    assert np.allclose(pred[0], expected), f"Expected {expected}, got {pred[0]}"
    print("test_b1_missing_history PASSED")

def test_b1_clipping():
    # Huge slope to test 40-400 clipping
    steps = np.arange(-6, 1)
    hist = 100 + 100 * steps # huge slope, 20 per min
    cgm_ff = np.zeros(20)
    cgm_ff[10+steps] = hist
    series = {"P1": DummySeries(cgm_ff)}
    
    anchors = {
        "patient_ids": ["P1"],
        "t": np.array([10]),
        "patient": np.array([0]),
        "g0": np.array([100.0])
    }
    
    pred = linear_trend(anchors, series)
    # Will hit 400 very fast
    expected = np.clip(100.0 + 20.0 * np.arange(5, 125, 5), 40.0, 400.0)
    assert np.allclose(pred[0], expected), f"Expected {expected}, got {pred[0]}"
    
    # Huge negative slope
    hist2 = 100 - 100 * steps
    cgm_ff[10+steps] = hist2
    series = {"P1": DummySeries(cgm_ff)}
    
    pred2 = linear_trend(anchors, series)
    expected2 = np.clip(100.0 - 20.0 * np.arange(5, 125, 5), 40.0, 400.0)
    assert np.allclose(pred2[0], expected2), f"Expected {expected2}, got {pred2[0]}"
    print("test_b1_clipping PASSED")

if __name__ == "__main__":
    test_b1_normal_history()
    test_b1_missing_history()
    test_b1_clipping()

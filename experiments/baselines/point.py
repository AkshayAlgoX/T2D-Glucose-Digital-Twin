"""Cheap point-forecast baselines B0 and B1 (experiments/baseline_matrix.csv).

Only the two baselines whose definition in the matrix is unambiguous *and* whose inputs are
raw CGM are implemented here. The model-fitting baselines (B1c, B2a, B2b, B3, B4a, B4b, B8)
are left to their own step: their feature sets / regularisation are the tuning budget BL-01 is
allowed on VAL-SEL, so building them here would be making a choice the protocol assigns to
that experiment.

Every baseline returns a (N, HORIZON) point forecast; the residual-quantile wrapper in
`metrics.py` turns it into the shared 7-quantile set.
"""
from __future__ import annotations

import numpy as np

# from common import T

STEP_MIN = 5
HORIZON = 24
CLIP = (40.0, 400.0)  # sensor range (generate_health_data_v2.sensor_stream)


def persistence(anchors: dict, series: dict, cfg=None) -> np.ndarray:
    """B0: last CGM value carried forward for all horizons."""
    return np.repeat(anchors["g0"][:, None], HORIZON, axis=1)


def linear_trend(anchors: dict, series: dict, cfg=None, window_min: int = 30) -> np.ndarray:
    """B1: least-squares slope of the last `window_min` minutes, extrapolated, clipped 40-400.

    Uses the forward-filled CGM (`cgm_ff`, ffill limit 3) so the history window is finite
    wherever `eligible_anchors` placed an anchor.
    """
    win = window_min // STEP_MIN  # 6 steps == 30 min
    ids = anchors["patient_ids"]
    t_all, p_all = anchors["t"], anchors["patient"]
    steps = np.arange(-win, 1)                       # t-win .. t  (win+1 samples = 30 min)
    pred = np.empty((t_all.size, HORIZON), dtype=float)
    for i, (p, t) in enumerate(zip(p_all, t_all)):
        hist = series[ids[p]].cgm_ff[t + steps]
        x = steps.astype(float) * STEP_MIN           # minutes relative to t
        if np.isfinite(hist).all() and np.ptp(x) > 0:
            slope = float(np.polyfit(x, hist, 1)[0])  # mg/dL per minute
        else:
            slope = 0.0                              # fall back to persistence where history is missing
        horizon_min = np.arange(1, HORIZON + 1) * STEP_MIN
        pred[i] = anchors["g0"][i] + slope * horizon_min
    return np.clip(pred, *CLIP)


# Baselines specified in baseline_matrix.csv but not implemented here. Building them is BL-01.
NOT_IMPLEMENTED = {
    "B1c": "ARIMA(p,1,0) least squares, p<=6, causal 12-h window -> experiments/baseline_matrix.csv row B1c",
    "B2a": "Global ARX ridge on 12-h lags + logged carbs/COB + steps + HR + tod + static -> row B2a",
    "B2b": "Per-patient ARX, causal per-patient fit -> row B2b",
    "B3": "Logistic regression events on B2a features + recent max/slope -> row B3",
    "B4a": "-> experiments/baseline_matrix.csv row B4a",
    "B4b": "-> experiments/baseline_matrix.csv row B4b",
    "B8": "-> experiments/baseline_matrix.csv row B8",
}
IMPLEMENTED = {"B0": persistence, "B1": linear_trend}

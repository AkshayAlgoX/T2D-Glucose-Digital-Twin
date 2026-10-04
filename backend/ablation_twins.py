#!/usr/bin/env python3
"""ablation_twins.py -- Non-physiological twin priors for Phase 10C Fair Ablation Arms.

Arm A: PersistenceTwinPrior
  - Prior forecast: Flat persistence G(t+k) = CGM(t) for all 24 horizon steps.
  - State channels: 8 trailing window statistical features (deltas, median, std, zero padding).

Arm B: GenericCausalTwinPrior
  - Prior forecast: Damped trend + empirical meal convolution (zero ODE/mechanistic params).
  - State channels: 8 causal digital signal filters (multi-rate EWMAs, slope, activity, volatility, circadian).
"""

from __future__ import annotations

import math
import numpy as np
import pandas as pd
from dataclasses import dataclass
from typing import Any

from input_contract import STEP_MIN

HORIZON = 24
GUT_KERNEL_MIN = 480

PERSISTENCE_PAST_FEATURES = (
    "persist_d15", "persist_d30", "persist_d60", "persist_d120",
    "persist_med24h", "persist_std24h", "persist_zero1", "persist_zero2"
)

GENERIC_PAST_FEATURES = (
    "gen_ewma15", "gen_ewma60", "gen_ewma240", "gen_slope30",
    "gen_meal_conv", "gen_act_filter", "gen_volatility", "gen_circadian"
)


class PersistenceTwinPrior:
    """Arm A: Flat Persistence Prior & Trailing Window Statistical State Features."""

    kind = "persistence"

    def __init__(self, mode: str = "s3"):
        self.mode = mode

    def describe(self) -> dict[str, Any]:
        return {"kind": "persistence", "mode": self.mode}

    def parameter_summary(self, ps) -> dict[str, float]:
        return {"insulin_sensitivity_rel": 0.0, "t_max_min": 0.0}

    def fit(self, series, anchors, rng, max_anchors: int = 4000) -> None:
        pass

    def meal_effect_series(self, ps) -> np.ndarray:
        return np.zeros(ps.n)

    def state_features(self, ps) -> dict[str, np.ndarray]:
        cgm = ps.cgm_ff
        n = ps.n
        
        d15 = np.zeros(n)
        d30 = np.zeros(n)
        d60 = np.zeros(n)
        d120 = np.zeros(n)
        
        d15[3:] = cgm[3:] - cgm[:-3]
        d30[6:] = cgm[6:] - cgm[:-6]
        d60[12:] = cgm[12:] - cgm[:-12]
        d120[24:] = cgm[24:] - cgm[:-24]

        # Trailing 24-h rolling median & std (288 steps)
        s_cgm = pd.Series(cgm)
        med24 = s_cgm.rolling(288, min_periods=12).median().to_numpy()
        std24 = s_cgm.rolling(288, min_periods=12).std().fillna(0.0).to_numpy()

        med24 = np.nan_to_num(med24, nan=110.0)
        std24 = np.nan_to_num(std24, nan=15.0)

        return {
            "persist_d15": np.nan_to_num(d15, nan=0.0),
            "persist_d30": np.nan_to_num(d30, nan=0.0),
            "persist_d60": np.nan_to_num(d60, nan=0.0),
            "persist_d120": np.nan_to_num(d120, nan=0.0),
            "persist_med24h": med24,
            "persist_std24h": std24,
            "persist_zero1": np.zeros(n),
            "persist_zero2": np.zeros(n),
        }

    def forecast(self, ps, t_idx: np.ndarray, habit_carbs: np.ndarray | None = None,
                 extra_flux: np.ndarray | None = None) -> np.ndarray:
        cgm_anchor = ps.cgm_ff[t_idx]
        out = np.tile(cgm_anchor[:, None], (1, HORIZON))
        return np.clip(out, 40.0, 400.0)

    def forecast_without_gut(self, ps, t_idx: np.ndarray) -> np.ndarray:
        return self.forecast(ps, t_idx)


def _ewma(x: np.ndarray, tau_min: float) -> np.ndarray:
    """Causal EWMA filter with time constant tau_min (minutes)."""
    alpha = 1.0 - math.exp(-STEP_MIN / tau_min)
    out = np.zeros_like(x, dtype=float)
    val = x[0] if np.isfinite(x[0]) else 110.0
    for i in range(x.size):
        if np.isfinite(x[i]):
            val = (1.0 - alpha) * val + alpha * x[i]
        out[i] = val
    return out


class GenericCausalTwinPrior:
    """Arm B: Generic Causal Non-Physiological Filter & Damped Trend Prior."""

    kind = "generic"

    def __init__(self, mode: str = "s3"):
        self.mode = mode

    def describe(self) -> dict[str, Any]:
        return {"kind": "generic", "mode": self.mode}

    def parameter_summary(self, ps) -> dict[str, float]:
        return {"insulin_sensitivity_rel": 0.0, "t_max_min": 0.0}

    def fit(self, series, anchors, rng, max_anchors: int = 4000) -> None:
        pass

    def meal_effect_series(self, ps) -> np.ndarray:
        """Empirical non-physiological double-exponential kernel meal convolution."""
        n_min = ps.n * STEP_MIN
        ra = np.zeros(n_min)
        tau = np.arange(GUT_KERNEL_MIN, dtype=float)
        # Generic kernel h(tau) = tau / (45^2) * exp(-tau / 45)
        kernel = (tau / 2025.0) * np.exp(-tau / 45.0)
        for m, c in zip(ps.meal_min, ps.meal_carbs):
            m0 = int(math.ceil(m))
            if not 0 <= m0 < n_min:
                continue
            span = slice(m0, min(n_min, m0 + GUT_KERNEL_MIN))
            ra[span] += 0.85 * c * 10.0 * kernel[: span.stop - m0]
        return ra[::STEP_MIN]

    def state_features(self, ps) -> dict[str, np.ndarray]:
        cgm = ps.cgm_ff
        n = ps.n

        ewma15 = _ewma(cgm, 15.0)
        ewma60 = _ewma(cgm, 60.0)
        ewma240 = _ewma(cgm, 240.0)

        slope30 = np.zeros(n)
        slope30[6:] = (cgm[6:] - cgm[:-6]) / 30.0

        meal_conv = self.meal_effect_series(ps)

        hr_rest = float(np.median(ps.hr)) if ps.hr.size else 70.0
        d_hr = np.maximum(ps.hr - hr_rest, 0.0)
        act_raw = d_hr * np.sqrt(np.maximum(ps.steps, 0.0))
        act_filter = _ewma(act_raw, 30.0)

        volatility = _ewma(np.abs(cgm - ewma60), 60.0)

        hours = (ps.stamps.hour + ps.stamps.minute / 60.0).to_numpy()
        circadian = np.sin(2 * np.pi * hours / 24.0) * (ewma60 - 110.0)

        return {
            "gen_ewma15": ewma15,
            "gen_ewma60": ewma60,
            "gen_ewma240": ewma240,
            "gen_slope30": np.nan_to_num(slope30, nan=0.0),
            "gen_meal_conv": meal_conv,
            "gen_act_filter": act_filter,
            "gen_volatility": volatility,
            "gen_circadian": circadian,
        }

    def forecast(self, ps, t_idx: np.ndarray, habit_carbs: np.ndarray | None = None,
                 extra_flux: np.ndarray | None = None) -> np.ndarray:
        cgm_t0 = ps.cgm_ff[t_idx]
        feats = self.state_features(ps)
        slope_t0 = feats["gen_slope30"][t_idx]

        a = t_idx.size
        out = np.zeros((a, HORIZON))
        gamma = 0.90
        damped_sums = np.cumsum([gamma**j for j in range(1, HORIZON + 1)])

        for k in range(HORIZON):
            out[:, k] = cgm_t0 + damped_sums[k] * slope_t0 * STEP_MIN

        if habit_carbs is not None:
            tau = np.arange(1, HORIZON + 1) * float(STEP_MIN)
            kernel = (tau / 2025.0) * np.exp(-tau / 45.0)
            for j in range(HORIZON):
                shift_kernel = np.zeros(HORIZON)
                shift_kernel[j:] = kernel[: HORIZON - j]
                out += habit_carbs[:, j, None] * 0.85 * 10.0 * shift_kernel[None, :]

        return np.clip(out, 40.0, 400.0)

    def forecast_without_gut(self, ps, t_idx: np.ndarray) -> np.ndarray:
        return self.forecast(ps, t_idx)

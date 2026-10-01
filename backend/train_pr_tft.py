#!/usr/bin/env python3
"""train_pr_tft.py -- Blueprint Sections 7 & 8: Physics-Residual Temporal Fusion Transformer.

Trains the PR-TFT on the synthetic cohort from generate_health_data_v2.py to forecast
CGM glucose 120 min ahead (24 x 5-min steps, 7 quantiles) and the hazard of a glucose
spike onset in each future 5-min bin.

Architecture (Blueprint 7.2)
    forecast(t+k) = twin_prior(t+k) + learned_residual_q(t+k)

    1. Twin prior       A causal, one-compartment linearization of the Section 3 model:
                        glucose relaxes to an equilibrium measured from the patient's own
                        trailing 24 h of CGM while logged meals appear through the Hovorka
                        two-compartment gut. Rolled out 120 min from the current CGM under
                        two scenarios, "no new meal" and "habitual meal"; both are
                        known-future inputs and --twin-base picks the forecast base
                        (default: habitual). Rate, gain and equilibrium percentile are
                        fitted on the training patients only.
    2. Static encoder   Variable selection over EHR + calibrated twin parameters, giving the
                        four TFT context vectors c_s, c_e, c_h, c_c.
    3. Past encoder     Variable selection over 144 past steps (12 h), then an LSTM
                        initialised from (c_h, c_c).
    4. Future decoder   Variable selection over 24 known-future steps (time, habit prior,
                        twin scenarios), then an LSTM continuing from the encoder state.
    5. Temporal fusion  Static enrichment -> causal interpretable multi-head attention
                        -> position-wise GRN, each with gated residual connections.
    6. Heads            Residual quantiles (monotone by construction), per-bin spike
                        hazard, and peak-glucose quantiles for spikes.

Loss (Blueprint 7.3)
    L = risk-weighted pinball(trajectory) + l1 * focal hazard
        + l2 * |median residual| + l3 * consistency(hazard vs. p50 trajectory)
        [+ peak pinball on windows that contain a spike]

Protocol (Blueprint 8.1 - 8.5)
    Patient-level 70/15/15 split stratified by diabetes status; optional stage-1
    pretraining on noise-free interstitial glucose (--pretrain-truth); training with
    AdamW + cosine decay, gradient clipping and early stopping; stage-3 calibration on the
    validation patients (conformal widening of the 80 % interval, isotonic hazard); a test
    report with RMSE / MARD at 30-60-120 min, Clarke error-grid zones, interval coverage,
    hazard AUROC / AUPRC / Brier / ECE, alert sensitivity and precision at the blueprint
    thresholds, subgroup RMSE and persistence / twin-only baselines.

Honest limits of this script
    * The twin prior is a linearized stand-in for the full UKF + ODE rollout of Blueprint
      7.2; the class TwinPrior is the plug-in point for the full model.
    * The generator exports true carbohydrates. By default this script corrupts them into
      a realistic meal *log* (missed logs, under-estimation, logging delay; Blueprint 3.4)
      so the model never trains on perfect meal knowledge. Disable with --no-log-corruption.
    * Calibrated twin parameters are read from the generator's EHR output; in production
      they come from the nightly MAP fit (Blueprint 7.5).

Quick start (from the directory holding the generator output)
    python train_pr_tft.py --data-dir synthetic_v2_300 --out-dir runs/pr_tft
    python train_pr_tft.py --data-dir synthetic_v2_300 --smoke-test        # 2-minute check

Requires: torch, lightning, numpy, pandas, scipy, scikit-learn.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import math
import time
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import lightning.pytorch as pl
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.nn.functional as F
from lightning.pytorch.callbacks import EarlyStopping, LearningRateMonitor, ModelCheckpoint
from lightning.pytorch.loggers import CSVLogger
from scipy import signal
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.model_selection import train_test_split
from torch.utils.data import DataLoader, Dataset

LOG = logging.getLogger("train_pr_tft")
warnings.filterwarnings("ignore", message=".*does not have many workers.*")
warnings.filterwarnings("ignore", message=".*LeafSpec.*")

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

STEP_MIN = 5  # CGM sampling interval
PAST_STEPS = 144  # 12 h encoder window (Blueprint 6)
HORIZON = 24  # 120 min forecast (Blueprint 1)
QUANTILES = (0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95)
MEDIAN_IDX = QUANTILES.index(0.50)
P10_IDX, P90_IDX = QUANTILES.index(0.10), QUANTILES.index(0.90)
PEAK_QUANTILES = (0.50, 0.90)

# Spike definition (Blueprint 1): level, rise, rise window, persistence, refractory.
SPIKE_LEVEL, SPIKE_RISE, RISE_STEPS, PERSIST_STEPS = 180.0, 50.0, 12, 3
REFRACTORY_LEVEL, REFRACTORY_STEPS = 160.0, 6

F_BIO = 0.85  # carbohydrate bioavailability (Blueprint 3.3)
VG_PER_KG = 1.88  # glucose distribution volume, dL/kg (Dalla Man 2007)
GUT_KERNEL_MIN = 480  # gut appearance tail considered, minutes

PAST_FEATURES = (
    "cgm", "cgm_missing", "cgm_roc", "heart_rate", "hrv", "step_count", "asleep",
    "carbs_logged", "carbs_on_board", "twin_meal_effect", "tod_sin", "tod_cos",
)
FUTURE_FEATURES = (
    "twin_no_meal", "twin_habit", "habit_meal_prob", "habit_carbs",
    "tod_sin", "tod_cos", "weekend", "horizon_frac",
)
STATUS_LEVELS = ("Healthy", "Prediabetes", "Type 1", "Type 2")
MED_CLASSES = ("metformin", "sglt2i", "glp1_ra", "dpp4i", "sulfonylurea", "basal_insulin",
               "prandial_insulin")
STATIC_CONTINUOUS = ("age", "bmi", "hba1c", "egfr", "diabetes_duration_years", "weight_kg")
STATIC_FEATURES_REALISTIC = (STATIC_CONTINUOUS + ("sex_male",) + tuple(f"status_{s}" for s in STATUS_LEVELS) + tuple(f"med_{m}" for m in MED_CLASSES))
STATIC_FEATURES_ORACLE = STATIC_FEATURES_REALISTIC + ("basal_glucose", "insulin_sensitivity_rel", "tmax0_min")

def get_static_features(cfg_or_mode) -> tuple[str, ...]:
    mode = getattr(cfg_or_mode, "twin_mode", cfg_or_mode)
    if mode == "oracle":
        return STATIC_FEATURES_ORACLE
    elif mode in ("s2", "s3", "realistic"):
        return STATIC_FEATURES_REALISTIC
    else:
        raise ValueError(f"Unsupported twin_mode: {mode}")


# z-scored past features; the rest are binary or already bounded.
ZSCORE_PAST = ("cgm_roc", "heart_rate", "hrv", "step_count", "carbs_logged", "carbs_on_board",
               "twin_meal_effect")


@dataclass
class TrainConfig:
    """Everything a run needs. Every field is a CLI flag (underscores -> dashes)."""

    data_dir: str = "synthetic_v2_300"
    out_dir: str = "runs/pr_tft"
    pretrain_truth: str = ""  # patient_cgm_truth.csv for stage-1 clean pretraining
    pretrain_epochs: int = 3
    seed: int = 20260930
    stride_steps: int = 3  # anchor every 15 min (Blueprint 6.3)
    min_past_coverage: float = 0.70
    min_target_coverage: float = 0.50
    log_corruption: bool = True
    twin_base: str = "habit"  # forecast base scenario: "habit" or "no_meal"
    twin: str = "linear"  # twin prior: "linear" (TwinPrior) or "ukf" (ukf_twin.UKFTwinPrior)
    twin_mode: str = "s2"  # UKF initialization mode: "oracle", "s2", or "s3"
    limit_patients: int = 0
    model_selection_rule_sha256: str = ""  # 0 = all
    # Model (Blueprint 7.2)
    d_model: int = 96
    n_heads: int = 4
    lstm_layers: int = 2
    dropout: float = 0.1
    # Loss weights (Blueprint 7.3)
    lambda_hazard: float = 1.0
    lambda_residual: float = 0.05
    lambda_consistency: float = 0.1
    lambda_peak: float = 0.2
    focal_gamma: float = 2.0
    focal_alpha: float = 0.75
    # Optimisation (Blueprint 8.1)
    batch_size: int = 512
    lr: float = 1e-3
    weight_decay: float = 1e-4
    max_epochs: int = 30
    patience: int = 4
    grad_clip: float = 1.0
    num_workers: int = 0
    accelerator: str = "auto"
    precision: str = "32-true"
    limit_train_batches: float = 1.0
    limit_val_batches: float = 1.0
    # Calibration and alerts (Blueprint 7.4, 8.5)
    interval_level: float = 0.80
    alert_thresholds: tuple[float, ...] = (0.35, 0.60)


# --------------------------------------------------------------------------- #
# Physiology helpers
# --------------------------------------------------------------------------- #


def gamma2(tau: np.ndarray, tmax: float) -> np.ndarray:
    """Hovorka two-compartment gut: fraction of a meal appearing per minute at age tau.
    Integrates to 1 and peaks at tau = tmax."""
    tau = np.asarray(tau, dtype=float)
    pos = np.clip(tau, 0.0, None)
    return np.where(tau >= 0, pos / tmax**2 * np.exp(-pos / tmax), 0.0)


def gamma2_absorbed(tau: np.ndarray, tmax: float) -> np.ndarray:
    """Cumulative absorbed fraction of the gamma2 kernel."""
    pos = np.clip(np.asarray(tau, dtype=float), 0.0, None)
    return 1.0 - (1.0 + pos / tmax) * np.exp(-pos / tmax)


def kovatchev_risk(g: torch.Tensor) -> torch.Tensor:
    """Kovatchev (1997) symmetric blood-glucose risk, 0 near 112 mg/dL, ~22 at 250 mg/dL."""
    g = g.clamp(40.0, 400.0)
    f = 1.509 * (torch.log(g) ** 1.084 - 5.381)
    return 10.0 * f**2


def detect_spike_onsets(cgm: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Blueprint Section 1 spike onsets on a CGM series (NaN = missing).

    Returns (onset, armed): onset[k] marks a spike onset; armed[k] is False while an
    event is in progress (the refractory period), when a new onset cannot occur."""
    n = cgm.size
    onset = np.zeros(n, dtype=bool)
    armed_out = np.ones(n, dtype=bool)
    armed_at_k = np.ones(n, dtype=bool)
    
    armed = True
    below = 0
    
    causal_armed = True
    
    for k in range(n):
        vk = cgm[k]
        
        # 1. Update causal armed state
        if not np.isnan(vk):
            below = below + 1 if vk < REFRACTORY_LEVEL else 0
            if below >= REFRACTORY_STEPS:
                causal_armed = True
                armed = True
                
        check_k = k - PERSIST_STEPS + 1
        if check_k >= 0 and onset[check_k]:
            causal_armed = False
            
        armed_out[k] = causal_armed
        armed_at_k[k] = armed
        
        if not np.isnan(vk) and armed and armed_at_k[k] and vk >= SPIKE_LEVEL and k >= RISE_STEPS:
            prior = cgm[k - RISE_STEPS:k]
            persist = cgm[k:k + PERSIST_STEPS]
            if (np.isfinite(prior).any() and vk - np.nanmin(prior) >= SPIKE_RISE
                    and persist.size == PERSIST_STEPS and np.all(persist >= SPIKE_LEVEL)):
                onset[k] = True
                armed = False

    return onset, armed_out


# --------------------------------------------------------------------------- #
# Per-patient preparation
# --------------------------------------------------------------------------- #


@dataclass
class PatientSeries:
    """One patient's aligned 5-min streams plus the parameters the twin prior needs."""

    pid: str
    group: str
    stamps: pd.DatetimeIndex
    cgm: np.ndarray  # raw CGM, NaN where missing
    cgm_ff: np.ndarray  # forward-filled at most 3 steps (15 min)
    hr: np.ndarray
    hrv: np.ndarray
    steps: np.ndarray
    asleep: np.ndarray
    meal_min: np.ndarray  # logged meal start, minutes from series start
    meal_carbs: np.ndarray  # logged carbs, g
    static_raw: dict[str, float]
    gb: float  # basal glucose, mg/dL
    k_base: float  # glucose relaxation rate, 1/min
    tmax: float  # effective gut absorption time, min
    vg: float  # glucose distribution volume, dL
    onset: np.ndarray = field(default=None)
    armed: np.ndarray = field(default=None)

    @property
    def n(self) -> int:
        return self.cgm.size


def corrupt_meal_log(minutes: np.ndarray, carbs: np.ndarray,
                     rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """Blueprint 3.4 observed layer: per-patient logging adherence ~ Beta(6, 2), carbs
    under-estimated ~ lognormal(-0.10, 0.30), logging delay ~ Exp(10 min), with 10 % of
    meals logged 5-15 min early."""
    p_log = rng.beta(6, 2)
    keep = rng.random(minutes.size) < p_log
    minutes, carbs = minutes[keep], carbs[keep]
    carbs = carbs * rng.lognormal(-0.10, 0.30, carbs.size)
    early = rng.random(minutes.size) < 0.10
    shift = np.where(early, -rng.uniform(5, 15, minutes.size), rng.exponential(10.0, minutes.size))
    order = np.argsort(minutes + shift)
    return (minutes + shift)[order], carbs[order]


def static_vector(row: pd.Series, mode: str) -> dict[str, float]:
    meds = set(str(row.get("med_classes", "")).split(";")) - {"", "nan"}
    out = {c: float(row[c]) for c in STATIC_CONTINUOUS}
    if mode == "oracle":
        try:
            out["basal_glucose"] = float(row["basal_glucose"])
            out["insulin_sensitivity_rel"] = float(row["insulin_sensitivity_rel"])
            out["tmax0_min"] = float(row["tmax0_min"])
        except KeyError as e:
            raise KeyError(f"Oracle mode requires latent field {e}")
    out["sex_male"] = float(row["gender"] == "M")
    for s in STATUS_LEVELS:
        out[f"status_{s}"] = float(row["diabetes_status"] == s)
    for m in MED_CLASSES:
        out[f"med_{m}"] = float(m in meds)
    return out


def prepare_patients(telemetry: pd.DataFrame, ehr: pd.DataFrame, cfg: TrainConfig,
                     rng: np.random.Generator) -> dict[str, PatientSeries]:
    """Align each patient to a regular 5-min grid and derive the twin parameters."""
    ehr = ehr.set_index("patient_id")
    series: dict[str, PatientSeries] = {}
    for pid, g in telemetry.groupby("patient_id", sort=True):
        if pid not in ehr.index:
            LOG.warning("patient %s has telemetry but no EHR row; skipped", pid)
            continue
        g = g.set_index("timestamp").sort_index()
        grid = pd.date_range(g.index[0], g.index[-1], freq=f"{STEP_MIN}min")
        g = g[~g.index.duplicated()].reindex(grid)
        cgm = g["glucose_level"].to_numpy(dtype=float)
        carbs = g["carbs_g"].fillna(0.0).to_numpy(dtype=float)
        meal_idx = np.flatnonzero((g["meal_event"].fillna(0).to_numpy() > 0) & (carbs > 0))
        meal_min = meal_idx * float(STEP_MIN)
        meal_carbs = carbs[meal_idx]
        if cfg.log_corruption:
            meal_min, meal_carbs = corrupt_meal_log(meal_min, meal_carbs, rng)
        row = ehr.loc[pid]

        bmi = float(row["bmi"])
        age = float(row["age"])
        t2d = row["diabetes_status"] == "Type 2"
        pre = row["diabetes_status"] == "Prediabetes"
        meds = set(str(row.get("med_classes", "")).split(";")) - {"", "nan"}
        ln_si = -0.035 * (bmi - 25) - 0.005 * (age - 45) - 0.40 * t2d - 0.20 * pre
        si_rel = float(np.clip(math.exp(ln_si), 0.15, 1.2)) * (1.10 if "metformin" in meds else 1.0)
        a1c = float(row["hba1c"])
        mu = max(28.7 * a1c - 46.7, 75.0)
        gb = 110.0 + 0.30 * (mu - 110.0) if mu > 110 else mu - 8.0
        tmax0 = 38.0

        series[pid] = PatientSeries(
            pid=pid, group=str(row["diabetes_status"]), stamps=grid, cgm=cgm,
            cgm_ff=pd.Series(cgm).ffill(limit=3).to_numpy(),
            hr=g["heart_rate"].interpolate(limit_direction="both").to_numpy(dtype=float),
            hrv=g["hrv"].interpolate(limit_direction="both").to_numpy(dtype=float),
            steps=g["step_count"].fillna(0).to_numpy(dtype=float),
            asleep=(g["sleep_stage"].fillna("Awake") != "Awake").to_numpy(dtype=float),
            meal_min=meal_min, meal_carbs=meal_carbs, static_raw=static_vector(row, cfg.twin_mode),
            gb=gb,
            k_base=0.01 + 0.01 * si_rel,
            tmax=1.3 * tmax0,  # average macronutrient slowing (Blueprint 3.3)
            vg=VG_PER_KG * float(row["weight_kg"]),
        )
        series[pid].onset, series[pid].armed = detect_spike_onsets(cgm)
    return series


# --------------------------------------------------------------------------- #
# Twin prior (Blueprint 7.2 steps 1-2, linearized)
# --------------------------------------------------------------------------- #


class TwinPrior:
    """Causal linearized twin: d(G - Ge)/dt = -k (G - Ge) + gain * Ra(t) / V_G.

    Anchored at the current CGM, so the current deviation (including any meal still being
    absorbed) relaxes with rate k while the not-yet-absorbed part of logged meals keeps
    appearing. The equilibrium Ge is a percentile of the patient's own CGM over the trailing
    24 h: observable in production, unlike the simulator's hidden basal parameter, which
    sits above the true fasting level for many patients. k_scale, gain and the percentile
    are fitted on training patients by grid search.
    """

    def __init__(self, k_scale: float = 1.0, gain: float = 1.0, eq_quantile: float = 0.4):
        self.k_scale, self.gain, self.eq_quantile = k_scale, gain, eq_quantile

    kind = "linear"

    def describe(self) -> dict[str, Any]:
        return {"kind": "linear", "k_scale": self.k_scale, "gain": self.gain, "eq_quantile": self.eq_quantile}

    def state_features(self, ps: PatientSeries) -> dict[str, np.ndarray]:
        return {}

    def forecast_without_gut(self, ps: PatientSeries, t_idx: np.ndarray) -> np.ndarray:
        """Counterfactual with no logged meals still absorbing (drivers)."""
        no_logs = dataclasses.replace(ps, meal_min=np.array([]), meal_carbs=np.array([]))
        return self.forecast(no_logs, t_idx)

    def equilibrium(self, ps: PatientSeries, t_idx: np.ndarray) -> np.ndarray:
        """Trailing-24 h CGM percentile per anchor (falls back to the basal parameter)."""
        window = BINS_PER_DAY
        idx = t_idx[:, None] - np.arange(window)[None, :]
        vals = np.where(idx >= 0, ps.cgm[np.clip(idx, 0, None)], np.nan)
        enough = np.isfinite(vals).sum(1) >= 72  # at least 6 h of readings
        with np.errstate(all="ignore"):
            level = np.nanquantile(np.where(enough[:, None], vals, 0.0), self.eq_quantile, axis=1)
        return np.where(enough, level, ps.gb)

    def meal_effect_series(self, ps: PatientSeries) -> np.ndarray:
        """Glucose deviation attributable to logged meals, at every 5-min step (causal)."""
        n_min = ps.n * STEP_MIN
        ra = np.zeros(n_min)
        tau = np.arange(GUT_KERNEL_MIN, dtype=float)
        for m, c in zip(ps.meal_min, ps.meal_carbs):
            m0 = int(math.ceil(m))
            if not 0 <= m0 < n_min:
                continue
            span = slice(m0, min(n_min, m0 + GUT_KERNEL_MIN))
            ra[span] += F_BIO * c * 1000 * gamma2(tau[: span.stop - m0] + (m0 - m), ps.tmax)
        decay = math.exp(-self.k_scale * ps.k_base)
        effect = signal.lfilter([self.gain / ps.vg], [1.0, -decay], ra)
        return effect[::STEP_MIN]

    def forecast(self, ps: PatientSeries, t_idx: np.ndarray,
                 habit_carbs: np.ndarray | None = None,
                 extra_flux: np.ndarray | None = None) -> np.ndarray:
        """Roll out 120 min from each anchor. habit_carbs (A, 24) adds expected habitual
        meals starting in each future bin. extra_flux (A, 120) is an additional glucose
        flux in mg/min per future minute, not scaled by the meal gain (the inference
        service uses it for exercise uptake in what-if scenarios). Returns (A, 24) mg/dL."""
        a = t_idx.size
        t_min = t_idx * float(STEP_MIN)
        s = np.arange(1, HORIZON * STEP_MIN + 1, dtype=float)
        ra = np.zeros((a, s.size))
        for m, c in zip(ps.meal_min, ps.meal_carbs):
            age = t_min - m
            sel = (age >= 0) & (age < GUT_KERNEL_MIN)
            if sel.any():
                ra[sel] += F_BIO * c * 1000 * gamma2(age[sel, None] + s[None, :], ps.tmax)
        if habit_carbs is not None:
            for j in range(HORIZON):
                start = STEP_MIN * (j + 1)
                ra += habit_carbs[:, j, None] * (F_BIO * 1000) * gamma2(s[None, :] - start, ps.tmax)
        decay = math.exp(-self.k_scale * ps.k_base)
        ge = self.equilibrium(ps, t_idx)
        dev = ps.cgm_ff[t_idx] - ge
        out = np.empty((a, HORIZON))
        for step in range(s.size):
            flux = self.gain * ra[:, step] + (extra_flux[:, step] if extra_flux is not None else 0.0)
            dev = dev * decay + flux / ps.vg
            if (step + 1) % STEP_MIN == 0:
                out[:, (step + 1) // STEP_MIN - 1] = ge + dev
        return np.clip(out, 40.0, 400.0)

    def fit(self, series: list[PatientSeries], anchors: dict[str, np.ndarray],
            rng: np.random.Generator, max_anchors: int = 4000) -> None:
        """Grid-search (k_scale, gain, equilibrium percentile) minimising RMSE of the no-meal rollout on training
        anchors. Future meals are unknown to this scenario, so the fitted gain absorbs the
        average bias honestly rather than peeking at them."""
        pool = [(ps, t) for ps in series for t in anchors[ps.pid]]
        pick = rng.choice(len(pool), size=min(max_anchors, len(pool)), replace=False)
        by_patient: dict[str, list[int]] = {}
        lookup = {ps.pid: ps for ps in series}
        for i in pick:
            by_patient.setdefault(pool[i][0].pid, []).append(pool[i][1])
        best = (math.inf, 1.0, 1.0, 0.4)
        grid = [(k, g, q) for k in (0.5, 1.0, 2.0, 3.0, 4.0, 6.0) for g in (0.25, 0.5, 0.75, 1.0)
                for q in (0.4, 0.5, 0.6)]
        for k_scale, gain, eq_q in grid:
            self.k_scale, self.gain, self.eq_quantile = k_scale, gain, eq_q
            sq, cnt = 0.0, 0
            for pid, ts in by_patient.items():
                ps, t = lookup[pid], np.asarray(ts)
                pred = self.forecast(ps, t)
                y = ps.cgm[t[:, None] + np.arange(1, HORIZON + 1)[None, :]]
                ok = np.isfinite(y)
                sq += float(((pred - y)[ok] ** 2).sum())
                cnt += int(ok.sum())
            rmse = math.sqrt(sq / max(cnt, 1))
            if rmse < best[0]:
                best = (rmse, k_scale, gain, eq_q)
        _, self.k_scale, self.gain, self.eq_quantile = best
        LOG.info("twin prior fitted on training patients: k_scale=%.2f gain=%.2f equilibrium=p%d "
                 "(RMSE %.1f mg/dL)", self.k_scale, self.gain, round(100 * self.eq_quantile), best[0])


# --------------------------------------------------------------------------- #
# Habit prior (known-future meal expectation from each patient's own history)
# --------------------------------------------------------------------------- #


BINS_PER_DAY = 1440 // STEP_MIN
HR_REST_STEPS = 288


def _smooth_circular(profile: np.ndarray) -> np.ndarray:
    """+/-30 min triangular smoothing of a per-bin daily profile."""
    kernel = np.array([1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1], dtype=float)
    kernel /= kernel.sum()
    padded = np.concatenate([profile[-6:], profile, profile[:6]])
    return np.convolve(padded, kernel, mode="valid")


def population_habit(series: list[PatientSeries]) -> tuple[np.ndarray, float]:
    counts = np.zeros(BINS_PER_DAY)
    days, carbs = 0.0, []
    for ps in series:
        bins = np.ceil(ps.meal_min / STEP_MIN).astype(int) % BINS_PER_DAY
        np.add.at(counts, bins, 1.0)
        days += ps.n / BINS_PER_DAY
        carbs.extend(ps.meal_carbs.tolist())
    return _smooth_circular(counts / max(days, 1.0)), float(np.mean(carbs)) if carbs else 40.0


def habit_features(ps: PatientSeries, t_idx: np.ndarray,
                   pop: tuple[np.ndarray, float]) -> tuple[np.ndarray, np.ndarray]:
    """Per anchor and future bin: probability a meal starts, and expected carbs (g).
    Uses only days strictly before the anchor's day (no look-ahead); day 0 falls back
    to the training-population profile."""
    n_days = int(math.ceil(ps.n / BINS_PER_DAY))
    counts = np.zeros((n_days, BINS_PER_DAY))
    carb_sum = np.zeros(n_days)
    meal_bins = np.ceil(ps.meal_min / STEP_MIN).astype(int)
    valid = (meal_bins >= 0) & (meal_bins < ps.n)
    np.add.at(counts, (meal_bins[valid] // BINS_PER_DAY, meal_bins[valid] % BINS_PER_DAY), 1.0)
    np.add.at(carb_sum, meal_bins[valid] // BINS_PER_DAY, ps.meal_carbs[valid])
    cum_counts = np.cumsum(counts, axis=0)
    cum_carbs = np.cumsum(carb_sum)
    prob = np.empty((t_idx.size, HORIZON))
    exp_carbs = np.empty((t_idx.size, HORIZON))
    future_bins = (t_idx[:, None] + np.arange(1, HORIZON + 1)[None, :]) % BINS_PER_DAY
    profiles: dict[int, tuple[np.ndarray, float]] = {}
    for a, t in enumerate(t_idx):
        day = int(t // BINS_PER_DAY)
        if day not in profiles:
            if day == 0:
                profiles[day] = pop
            else:
                n_meals = cum_counts[day - 1].sum()
                mean_carbs = cum_carbs[day - 1] / n_meals if n_meals else pop[1]
                profiles[day] = (_smooth_circular(cum_counts[day - 1] / day), mean_carbs)
        profile, mean_carbs = profiles[day]
        prob[a] = np.clip(profile[future_bins[a]], 0.0, 1.0)
        exp_carbs[a] = prob[a] * mean_carbs
    return prob, exp_carbs


# --------------------------------------------------------------------------- #
# Anchors, normalisation and tensors
# --------------------------------------------------------------------------- #


def eligible_anchors(ps: PatientSeries, cfg: TrainConfig) -> np.ndarray:
    """Anchors with a current CGM value, enough past data and enough future targets."""
    t = np.arange(max(PAST_STEPS - 1, HR_REST_STEPS - 1), ps.n - HORIZON, cfg.stride_steps)
    finite = np.isfinite(ps.cgm).astype(float)
    csum = np.concatenate(([0.0], np.cumsum(finite)))
    past_cov = (csum[t + 1] - csum[t + 1 - PAST_STEPS]) / PAST_STEPS
    fut_cov = (csum[t + 1 + HORIZON] - csum[t + 1]) / HORIZON
    ok = np.isfinite(ps.cgm_ff[t]) & (past_cov >= cfg.min_past_coverage) & (fut_cov >= cfg.min_target_coverage)
    return t[ok]


@dataclass
class Normalizer:
    """Training-set statistics, saved with the model so inference reproduces them."""

    glu_mean: float
    glu_std: float
    past_mean: dict[str, float]
    past_std: dict[str, float]
    static_mean: dict[str, float]
    static_std: dict[str, float]
    carbs_std: float

    @classmethod
    def fit(cls, series: list[PatientSeries], meal_effect: dict[str, np.ndarray],
            extras: dict[str, dict[str, np.ndarray]] | None = None, realistic_ehr: bool = False) -> "Normalizer":
        sf = STATIC_FEATURES_REALISTIC if realistic_ehr else STATIC_FEATURES_ORACLE
        cgm = np.concatenate([ps.cgm[np.isfinite(ps.cgm)] for ps in series])
        raw = {
            "cgm_roc": np.concatenate([np.diff(ps.cgm_ff, prepend=np.nan) for ps in series]),
            "heart_rate": np.concatenate([ps.hr for ps in series]),
            "hrv": np.concatenate([ps.hrv for ps in series]),
            "step_count": np.concatenate([ps.steps for ps in series]),
            "carbs_logged": np.concatenate([_logged_carbs_series(ps) for ps in series]),
            "carbs_on_board": np.concatenate([_carbs_on_board(ps) for ps in series]),
            "twin_meal_effect": np.concatenate([meal_effect[ps.pid] for ps in series]),
        }
        for name in (next(iter(extras.values())) if extras else {}):
            raw[name] = np.concatenate([extras[ps.pid][name] for ps in series])
        mean = {k: float(np.nanmean(v)) for k, v in raw.items()}
        std = {k: float(np.nanstd(v)) or 1.0 for k, v in raw.items()}
        static = pd.DataFrame([ps.static_raw for ps in series])
        s_mean = {c: float(static[c].mean()) if c in (STATIC_CONTINUOUS + ("basal_glucose", "insulin_sensitivity_rel", "tmax0_min")) else 0.0 for c in sf}
        s_std = {c: float(static[c].std(ddof=0)) or 1.0 if c in (STATIC_CONTINUOUS + ("basal_glucose", "insulin_sensitivity_rel", "tmax0_min")) else 1.0
                 for c in sf}
        carbs = np.concatenate([ps.meal_carbs for ps in series])
        return cls(float(cgm.mean()), float(cgm.std()), mean, std, s_mean, s_std,
                   float(carbs.std()) if carbs.size else 30.0)

    def glu(self, x: np.ndarray) -> np.ndarray:
        return (x - self.glu_mean) / self.glu_std


def _logged_carbs_series(ps: PatientSeries) -> np.ndarray:
    out = np.zeros(ps.n)
    bins = np.ceil(ps.meal_min / STEP_MIN).astype(int)
    ok = (bins >= 0) & (bins < ps.n)
    np.add.at(out, bins[ok], ps.meal_carbs[ok])
    return out


def _carbs_on_board(ps: PatientSeries) -> np.ndarray:
    """Logged carbs not yet absorbed, per 5-min step (causal)."""
    out = np.zeros(ps.n)
    t = np.arange(ps.n) * float(STEP_MIN)
    for m, c in zip(ps.meal_min, ps.meal_carbs):
        k0 = max(0, int(math.ceil(m / STEP_MIN)))
        k1 = min(ps.n, k0 + GUT_KERNEL_MIN // STEP_MIN)
        if k0 < k1:
            out[k0:k1] += c * (1.0 - gamma2_absorbed(t[k0:k1] - m, ps.tmax))
    return out


def past_feature_names(cfg: TrainConfig) -> tuple[str, ...]:
    """PAST_FEATURES, plus the UKF latent states when the UKF twin is used."""
    if cfg.twin == "ukf":
        from ukf_twin import UKF_PAST_FEATURES
        return PAST_FEATURES + UKF_PAST_FEATURES
    return PAST_FEATURES


def make_twin(cfg: TrainConfig):
    if cfg.twin == "ukf":
        from ukf_twin import UKFTwinPrior
        return UKFTwinPrior(mode=cfg.twin_mode)
    return TwinPrior()


def past_matrix(ps: PatientSeries, norm: Normalizer, meal_effect: np.ndarray,
                extra: dict[str, np.ndarray] | None = None) -> np.ndarray:
    """(n, n_past) normalised past inputs for one patient; `extra` = UKF state features."""
    missing = ~np.isfinite(ps.cgm_ff)
    cgm = np.where(missing, 0.0, norm.glu(np.nan_to_num(ps.cgm_ff, nan=norm.glu_mean)))
    roc = np.nan_to_num(np.diff(ps.cgm_ff, prepend=np.nan), nan=0.0)
    hours = (ps.stamps.hour + ps.stamps.minute / 60.0).to_numpy()
    raw = {
        "cgm": cgm, "cgm_missing": missing.astype(float), "cgm_roc": roc, "heart_rate": ps.hr,
        "hrv": ps.hrv, "step_count": ps.steps, "asleep": ps.asleep,
        "carbs_logged": _logged_carbs_series(ps), "carbs_on_board": _carbs_on_board(ps),
        "twin_meal_effect": meal_effect,
        "tod_sin": np.sin(2 * np.pi * hours / 24), "tod_cos": np.cos(2 * np.pi * hours / 24),
    }
    raw.update(extra or {})
    cols = []
    for name in PAST_FEATURES + tuple(extra or {}):
        x = raw[name].astype(float)
        if name in ZSCORE_PAST or name in (extra or {}):
            x = (x - norm.past_mean[name]) / norm.past_std[name]
        cols.append(np.nan_to_num(x, nan=0.0))
    return np.stack(cols, axis=1).astype(np.float32)


def time_matrix(ps: PatientSeries) -> np.ndarray:
    """(n, 3): tod_sin, tod_cos, weekend -- known for every future step."""
    hours = (ps.stamps.hour + ps.stamps.minute / 60.0).to_numpy()
    return np.stack([np.sin(2 * np.pi * hours / 24), np.cos(2 * np.pi * hours / 24),
                     (ps.stamps.dayofweek >= 5).astype(float)], axis=1).astype(np.float32)


@dataclass
class SplitTensors:
    """All tensors of one split. Past windows are sliced lazily from per-patient arrays."""

    patient_ids: list[str]
    groups: list[str]
    past: list[torch.Tensor]  # per patient (n, P)
    time_feats: list[torch.Tensor]  # per patient (n, 3)
    targets: list[torch.Tensor]  # per patient (n,) raw CGM, NaN missing
    static: torch.Tensor  # (n_patients, S)
    anchor_patient: torch.Tensor  # (A,)
    anchor_t: torch.Tensor  # (A,)
    future_anchor: torch.Tensor  # (A, 24, 4): twin_no_meal, twin_habit, habit_prob, habit_carbs
    twin: torch.Tensor  # (A, 24) base twin scenario (cfg.twin_base), mg/dL
    g0: torch.Tensor  # (A,)
    g_min60: torch.Tensor  # (A,)
    hazard_y: torch.Tensor  # (A, 24)
    hazard_mask: torch.Tensor  # (A, 24)
    onset_any: torch.Tensor  # (A,)
    at_risk: torch.Tensor  # (A,)
    peak: torch.Tensor  # (A,) max future CGM


def build_split(series: list[PatientSeries], anchors: dict[str, np.ndarray], twin: TwinPrior,
                norm: Normalizer, pop_habit: tuple[np.ndarray, float], cfg: TrainConfig) -> SplitTensors:
    past, time_feats, targets, static = [], [], [], []
    a_pat, a_t, fut, twin_nm, g0s, gmins, hy, hm, oa, ar, pk = ([] for _ in range(11))
    k_ahead = np.arange(1, HORIZON + 1)
    for p, ps in enumerate(series):
        effect = twin.meal_effect_series(ps)
        past.append(torch.from_numpy(past_matrix(ps, norm, effect, twin.state_features(ps))))
        time_feats.append(torch.from_numpy(time_matrix(ps)))
        targets.append(torch.from_numpy(ps.cgm.astype(np.float32)))
        static.append([(ps.static_raw[c] - norm.static_mean[c]) / norm.static_std[c] for c in get_static_features(cfg)])
        t = anchors[ps.pid]
        if t.size == 0:
            continue
        prob, exp_carbs = habit_features(ps, t, pop_habit)
        nomeal = twin.forecast(ps, t)
        habit = twin.forecast(ps, t, exp_carbs)
        fut.append(np.stack([norm.glu(nomeal), norm.glu(habit), prob, exp_carbs / norm.carbs_std], -1))
        twin_nm.append(habit if cfg.twin_base == "habit" else nomeal)
        future_onset = ps.onset[t[:, None] + k_ahead[None, :]]
        first = np.where(future_onset.any(1), future_onset.argmax(1), HORIZON)
        y = np.zeros((t.size, HORIZON))
        y[np.arange(t.size)[first < HORIZON], first[first < HORIZON]] = 1.0
        mask = (k_ahead[None, :] - 1) <= first[:, None]
        risk = ps.armed[t]
        hy.append(y)
        hm.append(mask & risk[:, None])
        oa.append((first < HORIZON).astype(float))
        ar.append(risk.astype(float))
        future_cgm = ps.cgm[t[:, None] + k_ahead[None, :]]
        pk.append(np.nanmax(np.where(np.isfinite(future_cgm), future_cgm, -np.inf), axis=1))
        g0s.append(ps.cgm_ff[t])
        window = ps.cgm[t[:, None] - np.arange(RISE_STEPS)[None, :]]
        gmins.append(np.where(np.isfinite(window).any(1), np.nanmin(np.where(np.isfinite(window), window, np.inf), 1), ps.cgm_ff[t]))
        a_pat.append(np.full(t.size, p))
        a_t.append(t)

    def cat(parts, dtype=torch.float32):
        return torch.as_tensor(np.concatenate(parts), dtype=dtype)

    return SplitTensors(
        patient_ids=[ps.pid for ps in series], groups=[ps.group for ps in series],
        past=past, time_feats=time_feats, targets=targets,
        static=torch.tensor(np.array(static), dtype=torch.float32),
        anchor_patient=cat(a_pat, torch.long), anchor_t=cat(a_t, torch.long),
        future_anchor=cat(fut), twin=cat(twin_nm), g0=cat(g0s), g_min60=cat(gmins),
        hazard_y=cat(hy), hazard_mask=cat(hm), onset_any=cat(oa), at_risk=cat(ar), peak=cat(pk),
    )


class AnchorDataset(Dataset):
    """One item = one forecast anchor: 144 past steps, 24 known-future steps, static
    covariates, targets and labels."""

    def __init__(self, split: SplitTensors):
        self.s = split
        self.horizon_frac = (torch.arange(1, HORIZON + 1, dtype=torch.float32) / HORIZON)[:, None]

    def __len__(self) -> int:
        return int(self.s.anchor_t.numel())

    def __getitem__(self, i: int) -> dict[str, torch.Tensor]:
        s = self.s
        p, t = int(s.anchor_patient[i]), int(s.anchor_t[i])
        y = s.targets[p][t + 1:t + 1 + HORIZON]
        future = torch.cat([s.future_anchor[i], s.time_feats[p][t + 1:t + 1 + HORIZON], self.horizon_frac], dim=-1)
        return {
            "past": s.past[p][t + 1 - PAST_STEPS:t + 1],
            "future": future,
            "static": s.static[p],
            "y": torch.nan_to_num(y, nan=0.0),
            "y_mask": torch.isfinite(y).float(),
            "twin": s.twin[i],
            "g0": s.g0[i],
            "g_min60": s.g_min60[i],
            "hazard_y": s.hazard_y[i],
            "hazard_mask": s.hazard_mask[i].float(),
            "onset_any": s.onset_any[i],
            "at_risk": s.at_risk[i],
            "peak": s.peak[i],
            "patient": torch.tensor(p),
        }


class CGMDataModule(pl.LightningDataModule):
    def __init__(self, splits: dict[str, SplitTensors], cfg: TrainConfig):
        super().__init__()
        self.splits, self.cfg = splits, cfg

    def _loader(self, name: str, shuffle: bool) -> DataLoader:
        return DataLoader(AnchorDataset(self.splits[name]), batch_size=self.cfg.batch_size,
                          shuffle=shuffle, num_workers=self.cfg.num_workers,
                          persistent_workers=self.cfg.num_workers > 0, drop_last=False)

    def train_dataloader(self) -> DataLoader:
        return self._loader("train", True)

    def val_dataloader(self) -> DataLoader:
        return self._loader("val", False)

    def test_dataloader(self) -> DataLoader:
        return self._loader("test", False)


# --------------------------------------------------------------------------- #
# TFT building blocks (Lim et al., 2021)
# --------------------------------------------------------------------------- #


class GatedAddNorm(nn.Module):
    """LayerNorm(skip + GLU(dropout(x)))."""

    def __init__(self, d_in: int, d_out: int, dropout: float):
        super().__init__()
        self.drop = nn.Dropout(dropout)
        self.fc = nn.Linear(d_in, 2 * d_out)
        self.norm = nn.LayerNorm(d_out)

    def forward(self, x: torch.Tensor, skip: torch.Tensor) -> torch.Tensor:
        return self.norm(skip + F.glu(self.fc(self.drop(x)), dim=-1))


class GRN(nn.Module):
    """Gated residual network with optional context: LN(skip(a) + GLU(W1 ELU(W2 a + W3 c)))."""

    def __init__(self, d_in: int, d_hidden: int, d_out: int, d_context: int | None = None,
                 dropout: float = 0.1):
        super().__init__()
        self.skip = nn.Linear(d_in, d_out) if d_in != d_out else nn.Identity()
        self.fc_in = nn.Linear(d_in, d_hidden)
        self.fc_ctx = nn.Linear(d_context, d_hidden, bias=False) if d_context else None
        self.fc_hidden = nn.Linear(d_hidden, d_hidden)
        self.gate = GatedAddNorm(d_hidden, d_out, dropout)

    def forward(self, x: torch.Tensor, context: torch.Tensor | None = None) -> torch.Tensor:
        h = self.fc_in(x)
        if self.fc_ctx is not None and context is not None:
            h = h + self.fc_ctx(context)
        return self.gate(self.fc_hidden(F.elu(h)), self.skip(x))


class VariableSelectionNetwork(nn.Module):
    """Embeds each scalar variable, weights them with a context-aware softmax and mixes
    the per-variable GRN outputs. The weights are the model's variable importances."""

    def __init__(self, n_vars: int, d_model: int, d_context: int | None, dropout: float):
        super().__init__()
        self.weight = nn.Parameter(torch.randn(n_vars, d_model) * 0.1)
        self.bias = nn.Parameter(torch.zeros(n_vars, d_model))
        self.selector = GRN(n_vars * d_model, d_model, n_vars, d_context, dropout)
        self.var_grns = nn.ModuleList([GRN(d_model, d_model, d_model, None, dropout) for _ in range(n_vars)])

    def forward(self, x: torch.Tensor, context: torch.Tensor | None = None):
        emb = x.unsqueeze(-1) * self.weight + self.bias  # (..., V, D)
        weights = torch.softmax(self.selector(emb.flatten(-2), context), dim=-1)  # (..., V)
        processed = torch.stack([grn(emb[..., i, :]) for i, grn in enumerate(self.var_grns)], dim=-2)
        return (weights.unsqueeze(-1) * processed).sum(dim=-2), weights


class InterpretableMultiHeadAttention(nn.Module):
    """Per-head queries and keys, one shared value projection, heads averaged, so the
    averaged attention pattern is directly interpretable."""

    def __init__(self, d_model: int, n_heads: int, dropout: float):
        super().__init__()
        self.d_head = d_model // n_heads
        self.q = nn.ModuleList([nn.Linear(d_model, self.d_head) for _ in range(n_heads)])
        self.k = nn.ModuleList([nn.Linear(d_model, self.d_head) for _ in range(n_heads)])
        self.v = nn.Linear(d_model, self.d_head)
        self.out = nn.Linear(self.d_head, d_model)
        self.drop = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor, mask: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        v = self.v(x)
        heads, attns = [], []
        for q_proj, k_proj in zip(self.q, self.k):
            scores = q_proj(x) @ k_proj(x).transpose(-1, -2) / math.sqrt(self.d_head)
            attn = self.drop(torch.softmax(scores.masked_fill(mask, float("-inf")), dim=-1))
            heads.append(attn @ v)
            attns.append(attn)
        return self.out(torch.stack(heads).mean(0)), torch.stack(attns).mean(0)


def monotone_quantiles(raw: torch.Tensor) -> torch.Tensor:
    """Map raw (..., 7) outputs to non-crossing quantiles: the median is free, and each
    step outward adds a softplus gap, so q05 <= ... <= q95 always holds."""
    mid = raw[..., MEDIAN_IDX:MEDIAN_IDX + 1]
    up = mid + torch.cumsum(F.softplus(raw[..., MEDIAN_IDX + 1:]), dim=-1)
    down = mid - torch.cumsum(F.softplus(raw[..., :MEDIAN_IDX].flip(-1)), dim=-1)
    return torch.cat([down.flip(-1), mid, up], dim=-1)


class PRTFT(nn.Module):
    """Physics-Residual Temporal Fusion Transformer (Blueprint 7.2)."""

    def __init__(self, n_static: int, n_past: int, n_future: int, cfg: TrainConfig, glu_std: float):
        super().__init__()
        d = cfg.d_model
        self.glu_std = glu_std
        self.lstm_layers = cfg.lstm_layers
        self.static_vsn = VariableSelectionNetwork(n_static, d, None, cfg.dropout)
        self.ctx_select, self.ctx_enrich, self.ctx_h, self.ctx_c = (GRN(d, d, d, None, cfg.dropout) for _ in range(4))
        self.past_vsn = VariableSelectionNetwork(n_past, d, d, cfg.dropout)
        self.future_vsn = VariableSelectionNetwork(n_future, d, d, cfg.dropout)
        self.encoder = nn.LSTM(d, d, cfg.lstm_layers, batch_first=True, dropout=cfg.dropout if cfg.lstm_layers > 1 else 0.0)
        self.decoder = nn.LSTM(d, d, cfg.lstm_layers, batch_first=True, dropout=cfg.dropout if cfg.lstm_layers > 1 else 0.0)
        self.lstm_gate = GatedAddNorm(d, d, cfg.dropout)
        self.enrich = GRN(d, d, d, d, cfg.dropout)
        self.attention = InterpretableMultiHeadAttention(d, cfg.n_heads, cfg.dropout)
        self.attn_gate = GatedAddNorm(d, d, cfg.dropout)
        self.positionwise = GRN(d, d, d, None, cfg.dropout)
        self.final_gate = GatedAddNorm(d, d, cfg.dropout)
        self.residual_head = nn.Linear(d, len(QUANTILES))
        self.hazard_head = nn.Linear(d, 1)
        self.peak_head = nn.Linear(d, len(PEAK_QUANTILES))
        total = PAST_STEPS + HORIZON
        self.register_buffer("causal_mask", torch.triu(torch.ones(total, total, dtype=torch.bool), diagonal=1),
                             persistent=False)
        nn.init.zeros_(self.residual_head.weight)  # start exactly at the twin prior
        nn.init.zeros_(self.residual_head.bias)

    def forward(self, batch: dict[str, torch.Tensor]) -> dict[str, torch.Tensor]:
        static_emb, static_w = self.static_vsn(batch["static"])
        c_s, c_e = self.ctx_select(static_emb), self.ctx_enrich(static_emb)
        h0 = self.ctx_h(static_emb).unsqueeze(0).repeat(self.lstm_layers, 1, 1)
        c0 = self.ctx_c(static_emb).unsqueeze(0).repeat(self.lstm_layers, 1, 1)

        past_emb, past_w = self.past_vsn(batch["past"], c_s.unsqueeze(1).expand(-1, PAST_STEPS, -1))
        fut_emb, fut_w = self.future_vsn(batch["future"], c_s.unsqueeze(1).expand(-1, HORIZON, -1))
        enc_out, state = self.encoder(past_emb, (h0.contiguous(), c0.contiguous()))
        dec_out, _ = self.decoder(fut_emb, state)
        vsn_seq = torch.cat([past_emb, fut_emb], dim=1)
        lstm_seq = self.lstm_gate(torch.cat([enc_out, dec_out], dim=1), vsn_seq)

        enriched = self.enrich(lstm_seq, c_e.unsqueeze(1).expand(-1, lstm_seq.size(1), -1))
        attn_out, attn = self.attention(enriched, self.causal_mask)
        fused = self.attn_gate(attn_out, enriched)
        decoded = self.final_gate(self.positionwise(fused), lstm_seq)[:, PAST_STEPS:]  # (B, 24, d)

        residual = monotone_quantiles(self.residual_head(decoded)) * self.glu_std
        quantiles = batch["twin"].unsqueeze(-1) + residual
        hazard_logits = self.hazard_head(decoded).squeeze(-1)
        peak_raw = self.peak_head(decoded.mean(1))
        peak = batch["g0"].unsqueeze(-1) + self.glu_std * torch.cumsum(
            torch.cat([peak_raw[:, :1], F.softplus(peak_raw[:, 1:])], dim=-1), dim=-1)
        return {
            "quantiles": quantiles, "residual": residual, "hazard_logits": hazard_logits,
            "peak": peak, "attention": attn[:, PAST_STEPS:],
            "static_weights": static_w, "past_weights": past_w, "future_weights": fut_w,
        }


# --------------------------------------------------------------------------- #
# Loss (Blueprint 7.3)
# --------------------------------------------------------------------------- #


class PRTFTLoss(nn.Module):
    """Risk-weighted pinball + focal hazard + residual shrinkage + consistency + peak."""

    def __init__(self, cfg: TrainConfig, glu_std: float):
        super().__init__()
        self.cfg, self.glu_std = cfg, glu_std
        self.register_buffer("q", torch.tensor(QUANTILES).view(1, 1, -1), persistent=False)
        self.register_buffer("q_peak", torch.tensor(PEAK_QUANTILES).view(1, -1), persistent=False)
        self.register_buffer("w_horizon", torch.linspace(1.0, 1.5, HORIZON).view(1, -1), persistent=False)

    @staticmethod
    def pinball(err: torch.Tensor, q: torch.Tensor) -> torch.Tensor:
        return torch.maximum(q * err, (q - 1) * err)

    def focal(self, logits: torch.Tensor, y: torch.Tensor) -> torch.Tensor:
        p = torch.sigmoid(logits)
        ce = F.binary_cross_entropy_with_logits(logits, y, reduction="none")
        p_t = p * y + (1 - p) * (1 - y)
        alpha_t = self.cfg.focal_alpha * y + (1 - self.cfg.focal_alpha) * (1 - y)
        return alpha_t * (1 - p_t) ** self.cfg.focal_gamma * ce

    def forward(self, out: dict[str, torch.Tensor], batch: dict[str, torch.Tensor]) -> dict[str, torch.Tensor]:
        y, mask = batch["y"], batch["y_mask"]
        # 1. Risk-weighted pinball: errors near 180-250 mg/dL (and hypoglycemia) cost more.
        omega = (1.0 + kovatchev_risk(torch.where(mask > 0, y, torch.full_like(y, 120.0))) / 10.0) * self.w_horizon
        err = (y.unsqueeze(-1) - out["quantiles"]) / self.glu_std
        pin = (self.pinball(err, self.q).mean(-1) * omega * mask).sum() / mask.sum().clamp_min(1)
        # 2. Focal hazard on at-risk bins (up to and including the first onset).
        h_mask = batch["hazard_mask"]
        hazard = (self.focal(out["hazard_logits"], batch["hazard_y"]) * h_mask).sum() / h_mask.sum().clamp_min(1)
        # 3. Keep the median residual small so scenarios flow through the physics.
        resid = out["residual"][..., MEDIAN_IDX].abs().mean() / self.glu_std
        # 4. Consistency: P(onset <= 120 min) should agree with the p50 trajectory crossing the rule.
        p_bin = torch.sigmoid(out["hazard_logits"])
        p_cum = 1 - torch.prod(1 - p_bin, dim=-1)
        p50_max = out["quantiles"][..., MEDIAN_IDX].amax(-1)
        soft_cross = torch.sigmoid((p50_max - SPIKE_LEVEL) / 5.0) * torch.sigmoid(
            (p50_max - batch["g_min60"] - SPIKE_RISE) / 5.0)
        at_risk = batch["at_risk"]
        consistency = (((p_cum - soft_cross) ** 2) * at_risk).sum() / at_risk.sum().clamp_min(1)
        # 5. Peak quantiles, only on windows that contain a spike onset.
        spike = batch["onset_any"]
        peak_err = (batch["peak"].unsqueeze(-1) - out["peak"]) / self.glu_std
        peak = (self.pinball(peak_err, self.q_peak).mean(-1) * spike).sum() / spike.sum().clamp_min(1)
        total = (pin + self.cfg.lambda_hazard * hazard + self.cfg.lambda_residual * resid
                 + self.cfg.lambda_consistency * consistency + self.cfg.lambda_peak * peak)
        return {"loss": total, "pinball": pin, "hazard": hazard, "residual": resid,
                "consistency": consistency, "peak": peak}


# --------------------------------------------------------------------------- #
# Lightning module
# --------------------------------------------------------------------------- #


class PRTFTModule(pl.LightningModule):
    def __init__(self, cfg_dict: dict[str, Any], n_static: int, n_past: int, n_future: int, glu_std: float):
        super().__init__()
        self.save_hyperparameters()
        self.cfg = TrainConfig(**cfg_dict)
        self.model = PRTFT(n_static, n_past, n_future, self.cfg, glu_std)
        self.criterion = PRTFTLoss(self.cfg, glu_std)
        self._val: list[dict[str, torch.Tensor]] = []

    def forward(self, batch):
        return self.model(batch)

    def _step(self, batch, stage: str):
        out = self.model(batch)
        losses = self.criterion(out, batch)
        bs = batch["y"].size(0)
        for k, v in losses.items():
            self.log(f"{stage}_{k}", v, prog_bar=(k == "loss"), batch_size=bs, on_epoch=True,
                     on_step=(stage == "train" and k == "loss"))
        return out, losses

    def training_step(self, batch, _):
        return self._step(batch, "train")[1]["loss"]

    def validation_step(self, batch, _):
        out, _ = self._step(batch, "val")
        self._val.append(collect(out, batch))

    def on_validation_epoch_end(self):
        if not self._val:
            return
        agg = {k: torch.cat([v[k] for v in self._val]).numpy() for k in self._val[0]}
        self._val.clear()
        m = trajectory_metrics(agg)
        for name in ("rmse_30", "rmse_60", "rmse_120", "coverage_80"):
            self.log(f"val_{name}", m[name])
        auc = hazard_auroc(agg)
        if auc is not None:
            self.log("val_hazard_auroc", auc)

    def predict_step(self, batch, _):
        return collect(self.model(batch), batch)

    def configure_optimizers(self):
        opt = torch.optim.AdamW(self.parameters(), lr=self.cfg.lr, weight_decay=self.cfg.weight_decay)
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(self.trainer.max_epochs, 1))
        return {"optimizer": opt, "lr_scheduler": sched}


def collect(out: dict[str, torch.Tensor], batch: dict[str, torch.Tensor]) -> dict[str, torch.Tensor]:
    p_bin = torch.sigmoid(out["hazard_logits"])
    return {
        "q": out["quantiles"].detach().float().cpu(), "y": batch["y"].cpu(), "y_mask": batch["y_mask"].cpu(),
        "twin": batch["twin"].cpu(), "g0": batch["g0"].cpu(),
        "p_cum": (1 - torch.prod(1 - p_bin, dim=-1)).detach().float().cpu(),
        "onset_any": batch["onset_any"].cpu(), "at_risk": batch["at_risk"].cpu(),
        "patient": batch["patient"].cpu(),
    }


# --------------------------------------------------------------------------- #
# Metrics, calibration and reporting (Blueprint 7.4, 8.2)
# --------------------------------------------------------------------------- #


def _masked(pred: np.ndarray, y: np.ndarray, mask: np.ndarray, k: int):
    ok = mask[:, k] > 0
    return pred[ok, k], y[ok, k]


def trajectory_metrics(agg: dict[str, np.ndarray], q: np.ndarray | None = None) -> dict[str, float]:
    q = agg["q"] if q is None else q
    p50 = q[..., MEDIAN_IDX]
    out = {}
    for minutes in (30, 60, 120):
        k = minutes // STEP_MIN - 1
        pred, y = _masked(p50, agg["y"], agg["y_mask"], k)
        out[f"rmse_{minutes}"] = float(np.sqrt(np.mean((pred - y) ** 2)))
        out[f"mae_{minutes}"] = float(np.mean(np.abs(pred - y)))
        out[f"mard_{minutes}"] = float(np.mean(np.abs(pred - y) / y) * 100)
    m = agg["y_mask"] > 0
    inside = (agg["y"] >= q[..., P10_IDX]) & (agg["y"] <= q[..., P90_IDX])
    out["coverage_80"] = float(inside[m].mean())
    out["width_80_mg_dl"] = float((q[..., P90_IDX] - q[..., P10_IDX])[m].mean())
    return out


def point_metrics(pred: np.ndarray, agg: dict[str, np.ndarray]) -> dict[str, float]:
    """RMSE at 30/60/120 min for a point forecast (baselines)."""
    out = {}
    for minutes in (30, 60, 120):
        k = minutes // STEP_MIN - 1
        p, y = _masked(pred, agg["y"], agg["y_mask"], k)
        out[f"rmse_{minutes}"] = float(np.sqrt(np.mean((p - y) ** 2)))
    return out


def clarke_zones(ref: np.ndarray, pred: np.ndarray) -> dict[str, float]:
    """Clarke error grid zone shares (reference = actual CGM)."""
    zone = np.full(ref.shape, "B")
    d = ((ref >= 240) & (pred >= 70) & (pred <= 180)) | ((ref <= 175 / 3) & (pred >= 70) & (pred <= 180)) \
        | ((ref >= 175 / 3) & (ref <= 70) & (pred >= 1.2 * ref))
    c = ((ref >= 70) & (ref <= 290) & (pred >= ref + 110)) | ((ref >= 130) & (ref <= 180) & (pred <= 1.4 * ref - 182))
    e = ((ref <= 70) & (pred >= 180)) | ((ref >= 180) & (pred <= 70))
    a = (np.abs(pred - ref) <= 0.2 * ref) | ((ref < 70) & (pred < 70))
    zone[d], zone[c], zone[e], zone[a] = "D", "C", "E", "A"
    return {z: float((zone == z).mean()) for z in "ABCDE"}


def hazard_auroc(agg: dict[str, np.ndarray]) -> float | None:
    risk = agg["at_risk"] > 0
    y = agg["onset_any"][risk]
    if y.min() == y.max():
        return None
    return float(roc_auc_score(y, agg["p_cum"][risk]))


def expected_calibration_error(p: np.ndarray, y: np.ndarray, bins: int = 10) -> float:
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    return float(sum(abs(p[idx == b].mean() - y[idx == b].mean()) * (idx == b).mean()
                     for b in range(bins) if (idx == b).any()))


def hazard_metrics(p: np.ndarray, y: np.ndarray, thresholds: tuple[float, ...]) -> dict[str, float]:
    out = {"prevalence": float(y.mean()), "brier": float(np.mean((p - y) ** 2)),
           "ece": expected_calibration_error(p, y)}
    if y.min() != y.max():
        out["auroc"] = float(roc_auc_score(y, p))
        out["auprc"] = float(average_precision_score(y, p))
    for th in thresholds:
        flag = p >= th
        out[f"sensitivity@{th:g}"] = float(flag[y > 0].mean()) if (y > 0).any() else float("nan")
        out[f"precision@{th:g}"] = float(y[flag].mean()) if flag.any() else float("nan")
    return out


@dataclass
class Calibrators:
    """Stage-3 calibration fitted on validation patients (Blueprint 7.4)."""

    conformal_mg_dl: list[float]  # per-horizon widening of the p10-p90 interval
    iso_x: list[float]
    iso_y: list[float]

    @classmethod
    def fit(cls, agg: dict[str, np.ndarray], level: float) -> "Calibrators":
        q, y, m = agg["q"], agg["y"], agg["y_mask"] > 0
        widen = []
        for k in range(HORIZON):
            score = np.maximum(q[m[:, k], k, P10_IDX] - y[m[:, k], k], y[m[:, k], k] - q[m[:, k], k, P90_IDX])
            n = score.size
            widen.append(float(np.quantile(score, min(1.0, math.ceil((n + 1) * level) / n))) if n else 0.0)
        risk = agg["at_risk"] > 0
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        iso.fit(agg["p_cum"][risk], agg["onset_any"][risk])
        return cls(widen, iso.X_thresholds_.tolist(), iso.y_thresholds_.tolist())

    def apply_interval(self, q: np.ndarray) -> np.ndarray:
        q = q.copy()
        w = np.asarray(self.conformal_mg_dl)[None, :]
        q[..., P10_IDX] -= w
        q[..., P90_IDX] += w
        return np.sort(q, axis=-1)

    def apply_hazard(self, p: np.ndarray) -> np.ndarray:
        return np.interp(p, self.iso_x, self.iso_y)


def evaluate(agg: dict[str, np.ndarray], calib: Calibrators, split: SplitTensors,
             cfg: TrainConfig) -> dict[str, Any]:
    report: dict[str, Any] = {"n_anchors": int(agg["y"].shape[0]),
                              "n_patients": int(np.unique(agg["patient"]).size)}
    report["pr_tft"] = trajectory_metrics(agg)
    report["pr_tft_conformal"] = trajectory_metrics(agg, calib.apply_interval(agg["q"]))
    k60, k120 = 60 // STEP_MIN - 1, 120 // STEP_MIN - 1
    ref, pred = _masked(agg["q"][..., MEDIAN_IDX], agg["y"], agg["y_mask"], k60)
    report["clarke_60"] = clarke_zones(ref, pred)
    ref, pred = _masked(agg["q"][..., MEDIAN_IDX], agg["y"], agg["y_mask"], k120)
    report["clarke_120"] = clarke_zones(ref, pred)
    persistence = np.repeat(agg["g0"][:, None], HORIZON, axis=1)
    report["baseline_persistence"] = point_metrics(persistence, agg)
    report["baseline_twin_only"] = point_metrics(agg["twin"], agg)
    risk = agg["at_risk"] > 0
    report["hazard_raw"] = hazard_metrics(agg["p_cum"][risk], agg["onset_any"][risk], cfg.alert_thresholds)
    report["hazard_calibrated"] = hazard_metrics(calib.apply_hazard(agg["p_cum"][risk]), agg["onset_any"][risk],
                                                 cfg.alert_thresholds)
    groups = np.array(split.groups)[agg["patient"]]
    report["subgroup_rmse_60"] = {}
    for g in sorted(set(groups)):
        sel = groups == g
        sub = {k: v[sel] for k, v in agg.items()}
        report["subgroup_rmse_60"][g] = trajectory_metrics(sub)["rmse_60"]
    return report


def predict(trainer: pl.Trainer, module: PRTFTModule, loader: DataLoader) -> dict[str, np.ndarray]:
    parts = trainer.predict(module, loader)
    return {k: torch.cat([p[k] for p in parts]).numpy() for k in parts[0]}


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #


def split_patients(series: dict[str, PatientSeries], seed: int) -> dict[str, list[str]]:
    """Patient-level 70/15/15 split stratified by diabetes status (Blueprint 6.3)."""
    ids = sorted(series)
    groups = [series[p].group for p in ids]

    def strat(labels):
        counts = pd.Series(labels).value_counts()
        return labels if counts.min() >= 2 else None

    train, rest = train_test_split(ids, test_size=0.30, random_state=seed, stratify=strat(groups))
    rest_groups = [series[p].group for p in rest]
    val, test = train_test_split(rest, test_size=0.50, random_state=seed, stratify=strat(rest_groups))
    return {"train": sorted(train), "val": sorted(val), "test": sorted(test)}


def load_data(cfg: TrainConfig, rng: np.random.Generator, glucose_override: pd.DataFrame | None = None):
    data_dir = Path(cfg.data_dir)
    if not data_dir.exists() or not (data_dir / "patient_cgm_telemetry.csv").exists():
        raise FileNotFoundError(f"data_dir {data_dir} missing or invalid!")
    data_dir = Path(cfg.data_dir)
    telemetry = pd.read_csv(data_dir / "patient_cgm_telemetry.csv", parse_dates=["timestamp"])
    ehr = pd.read_csv(data_dir / "patients_ehr.csv")
    missing = {"meal_event", "carbs_g"} - set(telemetry.columns)
    if missing:
        raise SystemExit(f"telemetry lacks {sorted(missing)}; regenerate with generate_health_data_v2.py")
    EHR_ALLOWLIST = {
        "patient_id", "age", "gender", "bmi", "genetic_risk_score", "hba1c",
        "diabetes_status", "height_cm", "weight_kg", "egfr", "diabetes_duration_years",
        "med_classes"
    }
    # Clean Firewall: filter out any simulator-latent columns
    ehr_cols = [c for c in ehr.columns if c in EHR_ALLOWLIST]
    ehr = ehr[ehr_cols]

    # --- Competition filter: exclude Type 1 patients (target use-case is Type 2) ---
    t1_pids = set(ehr.loc[ehr["diabetes_status"] == "Type 1", "patient_id"])
    if t1_pids:
        LOG.info("excluding %d Type 1 patient(s): %s", len(t1_pids), sorted(t1_pids))
        telemetry = telemetry[~telemetry["patient_id"].isin(t1_pids)]
        ehr = ehr[~ehr["patient_id"].isin(t1_pids)]
    if cfg.limit_patients:
        keep = sorted(telemetry["patient_id"].unique())[: cfg.limit_patients]
        telemetry = telemetry[telemetry["patient_id"].isin(keep)]
    if glucose_override is not None:
        telemetry = telemetry.drop(columns="glucose_level").merge(glucose_override, on=["patient_id", "timestamp"])
    return prepare_patients(telemetry, ehr, cfg, rng)


def build_datamodule(series: dict[str, PatientSeries], split_ids: dict[str, list[str]], cfg: TrainConfig,
                     rng: np.random.Generator, twin: TwinPrior | None = None,
                     norm: Normalizer | None = None, pop: tuple[np.ndarray, float] | None = None):
    anchors = {pid: eligible_anchors(ps, cfg) for pid, ps in series.items()}
    train_series = [series[p] for p in split_ids["train"]]
    if twin is None:
        twin = make_twin(cfg)
        twin.fit(train_series, anchors, rng)
    if norm is None:
        norm = Normalizer.fit(train_series, {ps.pid: twin.meal_effect_series(ps) for ps in train_series},
                              {ps.pid: twin.state_features(ps) for ps in train_series}, realistic_ehr=(cfg.twin_mode != "oracle"))
    if pop is None:
        pop = population_habit(train_series)
    splits = {name: build_split([series[p] for p in ids], anchors, twin, norm, pop, cfg) for name, ids in split_ids.items()}
    for name, s in splits.items():
        LOG.info("%-5s %3d patients, %7d anchors, spike-onset windows %.1f%%", name, len(s.patient_ids),
                 s.anchor_t.numel(), 100 * float(s.onset_any.mean()))
    return CGMDataModule(splits, cfg), twin, norm, pop


def make_trainer(cfg: TrainConfig, out_dir: Path, max_epochs: int, name: str) -> pl.Trainer:
    return pl.Trainer(
        max_epochs=max_epochs, accelerator=cfg.accelerator, devices=1, precision=cfg.precision,
        gradient_clip_val=cfg.grad_clip, deterministic=False, log_every_n_steps=10,
        limit_train_batches=cfg.limit_train_batches, limit_val_batches=cfg.limit_val_batches,
        logger=CSVLogger(str(out_dir), name=name),
        callbacks=[
            EarlyStopping(monitor="val_loss", patience=cfg.patience, mode="min"),
            ModelCheckpoint(dirpath=str(out_dir / "checkpoints"), filename=f"{name}-{{epoch:02d}}-{{val_loss:.4f}}",
                            monitor="val_loss", mode="min", save_top_k=1),
            LearningRateMonitor(logging_interval="epoch"),
        ],
    )


def print_report(report: dict[str, Any]) -> None:
    r, b, t = report["pr_tft"], report["baseline_persistence"], report["baseline_twin_only"]
    c = report["pr_tft_conformal"]
    hz, hc = report["hazard_raw"], report["hazard_calibrated"]
    lines = [
        f"Test set: {report['n_patients']} patients, {report['n_anchors']:,} anchors",
        "",
        "RMSE (mg/dL)        30 min   60 min  120 min",
        f"  PR-TFT p50      {r['rmse_30']:7.1f}  {r['rmse_60']:7.1f}  {r['rmse_120']:7.1f}",
        f"  twin only       {t['rmse_30']:7.1f}  {t['rmse_60']:7.1f}  {t['rmse_120']:7.1f}",
        f"  persistence     {b['rmse_30']:7.1f}  {b['rmse_60']:7.1f}  {b['rmse_120']:7.1f}",
        f"MARD 60 min {r['mard_60']:.1f}% | 80% interval coverage raw {r['coverage_80']:.1%}, "
        f"conformal {c['coverage_80']:.1%} (width {c['width_80_mg_dl']:.0f} mg/dL)",
        f"Clarke 60 min A+B {report['clarke_60']['A'] + report['clarke_60']['B']:.1%} | "
        f"Clarke 120 min D+E {report['clarke_120']['D'] + report['clarke_120']['E']:.2%}",
        f"Spike onset <= 120 min (prevalence {hz['prevalence']:.1%}): AUROC {hz.get('auroc', float('nan')):.3f}, "
        f"AUPRC {hz.get('auprc', float('nan')):.3f}, ECE raw {hz['ece']:.3f} -> calibrated {hc['ece']:.3f}",
        "  " + ", ".join(f"{k} {v:.2f}" for k, v in hc.items() if "@" in k),
        "Subgroup RMSE 60 min: " + ", ".join(f"{g} {v:.1f}" for g, v in report["subgroup_rmse_60"].items()),
    ]
    print("\n".join(lines))


def parse_args() -> TrainConfig:
    ap = argparse.ArgumentParser(description="Train the PR-TFT (Blueprint Sections 7 & 8).",
                                 formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    for f in dataclasses.fields(TrainConfig):
        flag = "--" + f.name.replace("_", "-")
        default = f.default
        if isinstance(default, bool):
            ap.add_argument(flag, action=argparse.BooleanOptionalAction, default=default)
        elif isinstance(default, tuple):
            ap.add_argument(flag, type=float, nargs="+", default=list(default))
        else:
            ap.add_argument(flag, type=type(default), default=default)
    ap.add_argument("--smoke-test", action="store_true",
                    help="tiny end-to-end run: 24 patients, 2 epochs, 20 batches per epoch")
    args = ap.parse_args()
    values = {f.name: getattr(args, f.name) for f in dataclasses.fields(TrainConfig)}
    if args.config:
        with open(args.config) as c:
            for k, v in __import__("json").load(c).items():
                if k in values:
                    values[k] = v
    values["alert_thresholds"] = tuple(values["alert_thresholds"])
    cfg = TrainConfig(**values)
    if args.smoke_test:
        cfg = dataclasses.replace(cfg, limit_patients=24, max_epochs=2, pretrain_epochs=1, batch_size=128,
                                  limit_train_batches=20, limit_val_batches=10, d_model=32,
                                  out_dir=str(Path(cfg.out_dir) / "smoke"))
    return cfg



def check_hashes_and_tree(cfg: TrainConfig, split_ids: dict[str, list[str]], override_dirty: bool = False):
    try:
        status = __import__("subprocess").check_output(["git", "status", "--short"]).decode().strip()
        git_sha = __import__("subprocess").check_output(["git", "rev-parse", "HEAD"]).decode().strip()
    except Exception:
        status = ""
        git_sha = "unknown"
    if status and not override_dirty:
        raise RuntimeError("Dirty git tree! Run only from a clean checkout.")
    
    import hashlib, json
    
    def hash_file(p):
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                h.update(chunk)
        return h.hexdigest()
        
    data_dir = __import__("pathlib").Path(cfg.data_dir)
    ehr_path = data_dir / "patients_ehr.csv"
    tel_path = data_dir / "patient_cgm_telemetry.csv"
    
    ehr_hash = hash_file(ehr_path)
    tel_hash = hash_file(tel_path)
    split_hash = hashlib.sha256(json.dumps(split_ids, sort_keys=True).encode()).hexdigest()
    
    cfg_hash = hashlib.sha256(json.dumps(__import__("dataclasses").asdict(cfg), sort_keys=True).encode()).hexdigest()
    return git_sha, ehr_hash, tel_hash, split_hash, cfg_hash


def main() -> None:
    cfg = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    pl.seed_everything(cfg.seed, workers=True)
    rng = np.random.default_rng(cfg.seed)
    if torch.cuda.is_available():
        torch.set_float32_matmul_precision("medium")
    out_dir = Path(cfg.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()

    series = load_data(cfg, rng)
    split_ids = split_patients(series, cfg.seed)
    (out_dir / "split.json").write_text(json.dumps(split_ids, indent=2))
    dm, twin, norm, pop = build_datamodule(series, split_ids, cfg, rng)
    module = PRTFTModule(dataclasses.asdict(cfg), len(get_static_features(cfg)), len(past_feature_names(cfg)),
                         len(FUTURE_FEATURES), norm.glu_std)
    LOG.info("PR-TFT: %.2fM parameters", sum(p.numel() for p in module.parameters()) / 1e6)

    # Stage 1 (optional): clean pretraining on noise-free interstitial glucose (Blueprint 8.1).
    if cfg.pretrain_truth:
        truth = pd.read_csv(cfg.pretrain_truth, parse_dates=["timestamp"])
        truth = truth.rename(columns={"interstitial_glucose": "glucose_level"})[["patient_id", "timestamp", "glucose_level"]]
        clean_cfg = dataclasses.replace(cfg, log_corruption=False)
        clean_series = load_data(clean_cfg, np.random.default_rng(cfg.seed), glucose_override=truth)
        clean_dm, *_ = build_datamodule(clean_series, split_ids, clean_cfg, rng, twin, norm, pop)
        LOG.info("stage 1: clean pretraining for %d epochs", cfg.pretrain_epochs)
        make_trainer(cfg, out_dir, cfg.pretrain_epochs, "stage1_clean").fit(module, clean_dm)

    # Stage 2: main training on the observed layer (noisy CGM, corrupted meal log).
    trainer = make_trainer(cfg, out_dir, cfg.max_epochs, "stage2_observed")
    trainer.fit(module, dm)
    best_path = trainer.checkpoint_callback.best_model_path
    best = PRTFTModule.load_from_checkpoint(best_path) if best_path else module
    LOG.info("best checkpoint: %s", best_path or "(last weights)")

    # Stage 3: calibration on validation patients, then the test report.
    eval_trainer = pl.Trainer(accelerator=cfg.accelerator, devices=1, logger=False, enable_progress_bar=False)
    calib = Calibrators.fit(predict(eval_trainer, best, dm.val_dataloader()), cfg.interval_level)
    report = evaluate(predict(eval_trainer, best, dm.test_dataloader()), calib, dm.splits["test"], cfg)
    report["runtime_s"] = round(time.perf_counter() - started, 1)
    report["best_checkpoint"] = best_path
    report["twin_prior"] = twin.describe()

    (out_dir / "calibration.json").write_text(json.dumps(dataclasses.asdict(calib), indent=2))
    (out_dir / "normalization.json").write_text(json.dumps(dataclasses.asdict(norm), indent=2))
    (out_dir / "config.json").write_text(json.dumps(dataclasses.asdict(cfg), indent=2))
    (out_dir / "metrics_test.json").write_text(json.dumps(report, indent=2))
    print_report(report)
    LOG.info("artifacts in %s (%.0f s)", out_dir, report["runtime_s"])


if __name__ == "__main__":
    main()

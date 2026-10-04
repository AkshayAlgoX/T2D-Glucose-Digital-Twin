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
    Frozen patient-level split (split_293.json, verified against data_manifest.json);
    optional stage-1 pretraining on noise-free interstitial glucose (pretrain_truth);
    training with AdamW + cosine decay, gradient clipping and early stopping; stage-3
    calibration on the validation patients (conformal widening of the 80 % interval,
    isotonic hazard). This script never touches the test patients' outcomes: the test
    report is produced only by evaluate_run.py, under the locked model-selection rule.

Inputs and causality (input_contract.py)
    * Realistic modes (s2, s3) read only observable EHR columns; oracle mode adds the
      simulator latents and is a reference arm. There is no default mode and no fallback.
    * Meals become known at ceil(log minute / 5); resting HR uses the first day only and no
      anchor precedes step 287; the at-risk flag uses CGM up to the decision time only.
    * The generator exports true carbohydrates; they are corrupted into a realistic meal *log*
      (missed logs, under-estimation, logging delay; Blueprint 3.4) with a per-patient
      random stream, so a patient's log never depends on which other patients are loaded.

Usage (run from backend/; the config pins every hyperparameter and every input hash)
    python train_pr_tft.py --config final_config.json --check-only    # all pre-training checks
    python train_pr_tft.py --config final_config.json --smoke-test    # UKF/S3 smoke, 24 patients
    python train_pr_tft.py --config final_config.json                 # the full run
    python evaluate_run.py --run-dir runs/pr_tft_final                # authoritative test report

Requires: torch, lightning, numpy, pandas, scipy, scikit-learn, jax (UKF twin).
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import logging
import math
import os
import time
import warnings
import zlib
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

import provenance as prov
from input_contract import (HR_REST_STEPS, ORACLE_LATENT_COLUMNS, REALISTIC_EHR_COLUMNS, STEP_MIN, TWIN_MODES,
                            check_twin_mode, meal_step_index)

LOG = logging.getLogger("train_pr_tft")
warnings.filterwarnings("ignore", message=".*does not have many workers.*")
warnings.filterwarnings("ignore", message=".*LeafSpec.*")

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

PAST_STEPS = 144  # 12 h encoder window (Blueprint 6)
FIRST_ANCHOR = max(PAST_STEPS, HR_REST_STEPS) - 1  # first step with a full window and a known resting HR
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
STATIC_FEATURES_REALISTIC = (STATIC_CONTINUOUS + ("sex_male",) + tuple(f"status_{s}" for s in STATUS_LEVELS)
                             + tuple(f"med_{m}" for m in MED_CLASSES))  # 18 observable features
STATIC_LATENT = ("basal_glucose", "insulin_sensitivity_rel", "tmax0_min")
STATIC_FEATURES_ORACLE = STATIC_FEATURES_REALISTIC + STATIC_LATENT  # 21: privileged reference arm


def get_static_features(cfg_or_mode) -> tuple[str, ...]:
    """Model static inputs for a twin mode: 18 observable features, or 21 in oracle mode."""
    mode = check_twin_mode(getattr(cfg_or_mode, "twin_mode", cfg_or_mode))
    return STATIC_FEATURES_ORACLE if mode == "oracle" else STATIC_FEATURES_REALISTIC


# z-scored past features; the rest are binary or already bounded.
ZSCORE_PAST = ("cgm_roc", "heart_rate", "hrv", "step_count", "carbs_logged", "carbs_on_board",
               "twin_meal_effect")


@dataclass
class TrainConfig:
    """Hyperparameters of a run. A run config file (final_config.json) must list every field;
    the defaults here exist for tests and are never used silently by the trainer."""

    data_dir: str = ""
    out_dir: str = ""
    pretrain_truth: str = ""  # patient_cgm_truth.csv for stage-1 clean pretraining ("" = none)
    pretrain_epochs: int = 0  # must be > 0 exactly when pretrain_truth is set
    seed: int = 20260930
    stride_steps: int = 3  # anchor every 15 min (Blueprint 6.3)
    min_past_coverage: float = 0.70
    min_target_coverage: float = 0.50
    log_corruption: bool = True
    twin_base: str = "habit"  # forecast base scenario: "habit" or "no_meal"
    twin: str = ""  # twin prior: "linear" (TwinPrior) or "ukf" (ukf_twin.UKFTwinPrior); no default
    twin_mode: str = ""  # "s2" / "s3" (observable EHR) or "oracle" (simulator latents); no default
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

    A spike onset at step k: CGM[k] >= 180 mg/dL, a rise of >= 50 mg/dL over the preceding
    60 min, and CGM stays >= 180 for 15 min (k, k+1, k+2). After an onset no new onset can
    occur until CGM has been < 160 mg/dL for 30 consecutive minutes (refractory), so one
    physiological spike yields exactly one onset.

    Returns (onset, at_risk):
        onset[k]    label; it uses CGM up to k + 2 (the persistence window) and is only ever
                    used as a target, never as an input.
        at_risk[k]  what a real-time system knows at step k: False from the step at which an
                    onset is confirmed (k_onset + 2) until the refractory condition re-arms.
                    It uses CGM[: k + 1] only, so it may mask losses and select alert times.
    """
    n = cgm.size
    onset = np.zeros(n, dtype=bool)
    at_risk = np.ones(n, dtype=bool)
    armed = True  # labelling state: may a new onset start at the current step?
    causal_armed = True  # at-risk state as seen in real time
    below = 0
    for k in range(n):
        vk = cgm[k]
        if not np.isnan(vk):
            below = below + 1 if vk < REFRACTORY_LEVEL else 0
            if below >= REFRACTORY_STEPS:
                armed = causal_armed = True
        confirmed = k - (PERSIST_STEPS - 1)  # an onset at k-2 becomes known at k
        if confirmed >= 0 and onset[confirmed]:
            causal_armed = False
        at_risk[k] = causal_armed
        if armed and not np.isnan(vk) and vk >= SPIKE_LEVEL and k >= RISE_STEPS:
            prior = cgm[k - RISE_STEPS:k]
            persist = cgm[k:k + PERSIST_STEPS]
            if (np.isfinite(prior).any() and vk - np.nanmin(prior) >= SPIKE_RISE
                    and persist.size == PERSIST_STEPS and np.all(persist >= SPIKE_LEVEL)):
                onset[k] = True
                armed = False
    return onset, at_risk


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


def patient_rng(seed: int, pid: str) -> np.random.Generator:
    """Random stream for one patient, a function of (seed, patient id) only: the corrupted meal
    log is identical whether a patient is loaded with the full cohort, a validation subset or
    a smoke subset, and in every pipeline (training, S2/S3 selection, evaluation, serving)."""
    return np.random.default_rng(np.random.SeedSequence([seed, zlib.crc32(pid.encode())]))


def observed_meal_log(pid: str, meal_event: np.ndarray, carbs_g: np.ndarray, seed: int,
                      log_corruption: bool) -> tuple[np.ndarray, np.ndarray]:
    """(minutes from series start, grams) of the meal log the model sees for one patient."""
    carbs = np.nan_to_num(np.asarray(carbs_g, dtype=float), nan=0.0)
    idx = np.flatnonzero((np.nan_to_num(np.asarray(meal_event, dtype=float), nan=0.0) > 0) & (carbs > 0))
    minutes, grams = idx * float(STEP_MIN), carbs[idx]
    if log_corruption:
        minutes, grams = corrupt_meal_log(minutes, grams, patient_rng(seed, pid))
    return minutes, grams


def meal_log_sha256(series: dict[str, "PatientSeries"]) -> str:
    """Fingerprint of the meal logs of a set of patients (proves two pipelines saw the same logs)."""
    h = hashlib.sha256()
    for pid in sorted(series):
        ps = series[pid]
        h.update(pid.encode())
        h.update(np.asarray(ps.meal_min, dtype=np.float64).tobytes())
        h.update(np.asarray(ps.meal_carbs, dtype=np.float64).tobytes())
    return h.hexdigest()


def static_vector(row: pd.Series, mode: str) -> dict[str, float]:
    """Raw static values for one patient. Realistic modes return exactly the 18 observable
    features. Oracle mode adds the 3 latent static features and tau_isf_min (the latter feeds
    the oracle UKF only, it is not a model input); a missing latent raises KeyError."""
    mode = check_twin_mode(mode)
    meds = set(str(row.get("med_classes", "")).split(";")) - {"", "nan"}
    out = {c: float(row[c]) for c in STATIC_CONTINUOUS}
    out["sex_male"] = float(row["gender"] == "M")
    for s in STATUS_LEVELS:
        out[f"status_{s}"] = float(row["diabetes_status"] == s)
    for m in MED_CLASSES:
        out[f"med_{m}"] = float(m in meds)
    if mode == "oracle":
        missing = [c for c in ORACLE_LATENT_COLUMNS if c not in row.index or not np.isfinite(float(row[c]))]
        if missing:
            raise KeyError(f"oracle mode requires latent fields {missing}")
        for c in ORACLE_LATENT_COLUMNS:
            out[c] = float(row[c])
    return out


def prepare_patients(telemetry: pd.DataFrame, ehr: pd.DataFrame, cfg: TrainConfig) -> dict[str, PatientSeries]:
    """Align each patient to a regular 5-min grid and derive the twin parameters."""
    ehr = ehr.set_index("patient_id")
    series: dict[str, PatientSeries] = {}
    for pid, g in telemetry.groupby("patient_id", sort=True):
        if pid not in ehr.index:
            raise KeyError(f"patient {pid} has telemetry but no EHR row")
        g = g.set_index("timestamp").sort_index()
        grid = pd.date_range(g.index[0], g.index[-1], freq=f"{STEP_MIN}min")
        g = g[~g.index.duplicated()].reindex(grid)
        cgm = g["glucose_level"].to_numpy(dtype=float)
        meal_min, meal_carbs = observed_meal_log(pid, g["meal_event"].to_numpy(), g["carbs_g"].to_numpy(),
                                                 cfg.seed, cfg.log_corruption)
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

    def parameter_summary(self, ps: PatientSeries) -> dict[str, float]:
        """Displayable twin parameters, derived from observable EHR (never simulator latents)."""
        return {"insulin_sensitivity_rel": (ps.k_base - 0.01) / 0.01, "t_max_min": ps.tmax}

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
        bins = meal_step_index(ps.meal_min) % BINS_PER_DAY
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
    meal_bins = meal_step_index(ps.meal_min)
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
    """Training/forecast-scoring anchors: a current CGM value, enough past data and enough
    future targets. Never earlier than FIRST_ANCHOR (resting HR needs the first full day)."""
    t = np.arange(FIRST_ANCHOR, ps.n - HORIZON, cfg.stride_steps)
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
            extras: dict[str, dict[str, np.ndarray]] | None, twin_mode: str) -> "Normalizer":
        sf = get_static_features(twin_mode)
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
        continuous = STATIC_CONTINUOUS + STATIC_LATENT
        s_mean = {c: float(static[c].mean()) if c in continuous else 0.0 for c in sf}
        s_std = {c: float(static[c].std(ddof=0)) or 1.0 if c in continuous else 1.0 for c in sf}
        carbs = np.concatenate([ps.meal_carbs for ps in series])
        return cls(float(cgm.mean()), float(cgm.std()), mean, std, s_mean, s_std,
                   float(carbs.std()) if carbs.size else 30.0)

    def glu(self, x: np.ndarray) -> np.ndarray:
        return (x - self.glu_mean) / self.glu_std


def _logged_carbs_series(ps: PatientSeries) -> np.ndarray:
    """Logged carbs (g) placed on the step at which each log becomes known (causal)."""
    out = np.zeros(ps.n)
    bins = meal_step_index(ps.meal_min)
    ok = (bins >= 0) & (bins < ps.n)
    np.add.at(out, bins[ok], ps.meal_carbs[ok])
    return out


def _carbs_on_board(ps: PatientSeries) -> np.ndarray:
    """Logged carbs not yet absorbed, per 5-min step (causal)."""
    out = np.zeros(ps.n)
    t = np.arange(ps.n) * float(STEP_MIN)
    for m, c in zip(ps.meal_min, ps.meal_carbs):
        k0 = max(0, int(meal_step_index(m)))
        k1 = min(ps.n, k0 + GUT_KERNEL_MIN // STEP_MIN)
        if k0 < k1:
            out[k0:k1] += c * (1.0 - gamma2_absorbed(t[k0:k1] - m, ps.tmax))
    return out


TWIN_KINDS = ("linear", "ukf", "persistence", "generic")


def past_feature_names(cfg: TrainConfig) -> tuple[str, ...]:
    """PAST_FEATURES, plus the UKF or ablation state features when state twins are used."""
    if cfg.twin == "ukf":
        from ukf_twin import UKF_PAST_FEATURES
        return PAST_FEATURES + UKF_PAST_FEATURES
    if cfg.twin == "persistence":
        from ablation_twins import PERSISTENCE_PAST_FEATURES
        return PAST_FEATURES + PERSISTENCE_PAST_FEATURES
    if cfg.twin == "generic":
        from ablation_twins import GENERIC_PAST_FEATURES
        return PAST_FEATURES + GENERIC_PAST_FEATURES
    if cfg.twin == "linear":
        return PAST_FEATURES
    raise ValueError(f"twin must be one of {TWIN_KINDS}, got {cfg.twin!r}")


def make_twin(cfg: TrainConfig):
    check_twin_mode(cfg.twin_mode)
    if cfg.twin == "ukf":
        from ukf_twin import UKFTwinPrior
        return UKFTwinPrior(mode=cfg.twin_mode)
    if cfg.twin == "persistence":
        from ablation_twins import PersistenceTwinPrior
        return PersistenceTwinPrior(mode=cfg.twin_mode)
    if cfg.twin == "generic":
        from ablation_twins import GenericCausalTwinPrior
        return GenericCausalTwinPrior(mode=cfg.twin_mode)
    if cfg.twin == "linear":
        return TwinPrior()
    raise ValueError(f"twin must be one of {TWIN_KINDS}, got {cfg.twin!r}")


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


def _masked(pred: np.ndarray, y: np.ndarray, mask: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    """(prediction, reference) at horizon index k where the target exists -- in that order."""
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
    """RMSE / MAE at 30/60/120 min for a point forecast (baselines)."""
    out = {}
    for minutes in (30, 60, 120):
        k = minutes // STEP_MIN - 1
        p, y = _masked(pred, agg["y"], agg["y_mask"], k)
        out[f"rmse_{minutes}"] = float(np.sqrt(np.mean((p - y) ** 2)))
        out[f"mae_{minutes}"] = float(np.mean(np.abs(p - y)))
    return out


def clarke_at(point_forecast: np.ndarray, agg: dict[str, np.ndarray], minutes: int) -> dict[str, float]:
    """Clarke zones of a point forecast at one horizon, with the measured CGM as reference."""
    pred, ref = _masked(point_forecast, agg["y"], agg["y_mask"], minutes // STEP_MIN - 1)
    return clarke_zones(ref=ref, pred=pred)


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


def hazard_discrimination(p: np.ndarray, y: np.ndarray) -> dict[str, float]:
    """Anchor-level discrimination/calibration of P(onset within 120 min). Alert precision and
    sensitivity are event-level quantities and are reported only by evaluate_run.py."""
    out = {"n": int(y.size), "prevalence": float(y.mean()), "brier": float(np.mean((p - y) ** 2)),
           "ece": expected_calibration_error(p, y)}
    if y.min() != y.max():
        out["auroc"] = float(roc_auc_score(y, p))
        out["auprc"] = float(average_precision_score(y, p))
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


TELEMETRY_COLUMNS = ("patient_id", "timestamp", "glucose_level", "heart_rate", "hrv", "sleep_stage", "step_count",
                     "meal_event", "carbs_g")  # never the generator's label columns (e.g. future_spike_2h)


def load_data(cfg: TrainConfig, patient_ids: list[str] | set[str] | None = None,
              glucose_override: pd.DataFrame | None = None) -> dict[str, PatientSeries]:
    """Load the active cohort through the latent firewall.

    Realistic modes read REALISTIC_EHR_COLUMNS only; oracle mode also reads
    ORACLE_LATENT_COLUMNS and fails if any is missing. Type 1 patients are excluded (no
    bolus-insulin log; outside the target population). `patient_ids` restricts the cohort
    without changing any patient's data. A missing directory or file raises; there is no
    fallback dataset."""
    mode = check_twin_mode(cfg.twin_mode)
    data_dir = Path(cfg.data_dir)
    for name in ("patients_ehr.csv", "patient_cgm_telemetry.csv"):
        if not (data_dir / name).is_file():
            raise FileNotFoundError(f"{data_dir / name} is missing; data_dir must point at the locked dataset")
    ehr = pd.read_csv(data_dir / "patients_ehr.csv")
    columns = REALISTIC_EHR_COLUMNS + (ORACLE_LATENT_COLUMNS if mode == "oracle" else ())
    missing = [c for c in columns if c not in ehr.columns]
    if missing:
        raise KeyError(f"patients_ehr.csv lacks {missing}, required in twin_mode={mode!r}")
    ehr = ehr[list(columns)]
    t1 = set(ehr.loc[ehr["diabetes_status"] == "Type 1", "patient_id"])
    ehr = ehr[~ehr["patient_id"].isin(t1)]
    keep = set(ehr["patient_id"]) if patient_ids is None else set(patient_ids)
    unknown = keep - set(ehr["patient_id"])
    if unknown:
        raise KeyError(f"requested patients are not in the active cohort: {sorted(unknown)[:5]}")
    telemetry = pd.read_csv(data_dir / "patient_cgm_telemetry.csv", parse_dates=["timestamp"],
                            usecols=list(TELEMETRY_COLUMNS))
    telemetry = telemetry[telemetry["patient_id"].isin(keep)]
    if glucose_override is not None:
        telemetry = telemetry.drop(columns="glucose_level").merge(glucose_override, on=["patient_id", "timestamp"])
    return prepare_patients(telemetry, ehr[ehr["patient_id"].isin(keep)], cfg)


def excluded_type1_pids(data_dir: str | Path) -> list[str]:
    ehr = pd.read_csv(Path(data_dir) / "patients_ehr.csv", usecols=["patient_id", "diabetes_status"])
    return sorted(ehr.loc[ehr["diabetes_status"] == "Type 1", "patient_id"])


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
                              {ps.pid: twin.state_features(ps) for ps in train_series}, cfg.twin_mode)
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


# --------------------------------------------------------------------------- #
# Run configuration and pre-training checks
# --------------------------------------------------------------------------- #

RUN_CONFIG_SCHEMA = "pr_tft_run_config/v1"
RUN_MANIFEST_SCHEMA = "pr_tft_run_manifest/v1"
EXPECT_KEYS = ("n_static", "n_past", "n_future", "active_patients", "split_counts", "type1_excluded_pids")
INPUT_FILE_KEYS = ("data_manifest", "split_file", "model_selection_rule", "model_selection_rule_md")
INPUT_KEYS = INPUT_FILE_KEYS + ("model_selection_rule_sha256", "model_selection_rule_md_sha256")
SMOKE_PATIENTS = {"train": 16, "val": 4, "test": 4}


@dataclass
class RunConfig:
    """A parsed run config file: hyperparameters, the expectations they must meet, and the
    locked inputs (paths resolved relative to the config file)."""

    path: Path
    sha256: str
    cfg: TrainConfig
    expect: dict[str, Any]
    inputs: dict[str, Any]
    data_dir_overridden: bool


def validate_train_config(cfg: TrainConfig) -> TrainConfig:
    """Reject configurations that are inconsistent or unsafe; return cfg unchanged."""
    err = []
    if cfg.twin not in TWIN_KINDS:
        err.append(f"twin must be one of {TWIN_KINDS}")
    if cfg.twin_mode not in TWIN_MODES:
        err.append(f"twin_mode must be one of {TWIN_MODES}")
    if cfg.twin == "ukf" and cfg.num_workers != 0:
        err.append("num_workers must be 0 with the UKF twin (JAX is not fork-safe in DataLoader workers)")
    if not isinstance(cfg.num_workers, int) or cfg.num_workers < 0:
        err.append("num_workers must be a non-negative integer")
    if not isinstance(cfg.stride_steps, int) or not 1 <= cfg.stride_steps <= 12:
        err.append("stride_steps must be an integer in [1, 12] (5-60 min between anchors)")
    for name in ("min_past_coverage", "min_target_coverage"):
        if not 0.0 < getattr(cfg, name) <= 1.0:
            err.append(f"{name} must be in (0, 1]")
    if cfg.twin_base not in ("habit", "no_meal"):
        err.append("twin_base must be 'habit' or 'no_meal'")
    if (cfg.pretrain_epochs > 0) != bool(cfg.pretrain_truth):
        err.append("pretraining must be explicit: pretrain_epochs > 0 exactly when pretrain_truth is set")
    if cfg.pretrain_truth and not Path(cfg.pretrain_truth).is_file():
        err.append(f"pretrain_truth {cfg.pretrain_truth} does not exist")
    if not cfg.data_dir or not cfg.out_dir:
        err.append("data_dir and out_dir must be set")
    for name in ("max_epochs", "patience", "batch_size", "d_model", "n_heads", "lstm_layers"):
        if not isinstance(getattr(cfg, name), int) or getattr(cfg, name) < 1:
            err.append(f"{name} must be a positive integer")
    if isinstance(cfg.d_model, int) and isinstance(cfg.n_heads, int) and cfg.n_heads > 0 and cfg.d_model % cfg.n_heads:
        err.append("d_model must be divisible by n_heads")
    if not 0.0 <= cfg.dropout < 1.0:
        err.append("dropout must be in [0, 1)")
    if cfg.lr <= 0 or cfg.weight_decay < 0 or cfg.grad_clip <= 0:
        err.append("lr and grad_clip must be > 0, weight_decay >= 0")
    if not 0.0 < cfg.interval_level < 1.0:
        err.append("interval_level must be in (0, 1)")
    th = list(cfg.alert_thresholds)
    if not th or any(not 0.0 < x < 1.0 for x in th) or th != sorted(set(th)):
        err.append("alert_thresholds must be strictly increasing values in (0, 1)")
    if cfg.accelerator not in ("auto", "cpu", "gpu", "cuda", "mps"):
        err.append("accelerator must be auto/cpu/gpu/cuda/mps")
    if cfg.precision not in ("32-true", "64-true", "16-mixed", "bf16-mixed"):
        err.append("precision must be 32-true/64-true/16-mixed/bf16-mixed")
    if err:
        raise ValueError("invalid training config: " + "; ".join(err))
    return cfg


def load_run_config(path: str | Path, data_dir: str | Path | None = None) -> RunConfig:
    """Parse a run config. Every TrainConfig field must be present (no silent defaults) and no
    unknown key is accepted. `data_dir` overrides train.data_dir; the directory is still
    identified by its hashes in preflight(), so an override can never switch datasets."""
    path = Path(path).resolve()
    text = path.read_text()
    raw = json.loads(text)
    if set(raw) != {"schema", "train", "expect", "inputs"}:
        raise ValueError(f"{path}: top-level keys must be schema/train/expect/inputs, got {sorted(raw)}")
    if raw["schema"] != RUN_CONFIG_SCHEMA:
        raise ValueError(f"{path}: schema must be {RUN_CONFIG_SCHEMA!r}")
    fields = {f.name: f for f in dataclasses.fields(TrainConfig)}
    train = dict(raw["train"])
    missing, unknown = sorted(set(fields) - set(train)), sorted(set(train) - set(fields))
    if missing or unknown:
        raise ValueError(f"{path}: train section must list every TrainConfig field exactly; "
                         f"missing {missing}, unknown {unknown}")
    for name, f in fields.items():
        default, value = f.default, train[name]
        if isinstance(default, bool):
            ok = isinstance(value, bool)
        elif isinstance(default, int):
            ok = isinstance(value, int) and not isinstance(value, bool)
        elif isinstance(default, float):
            ok = isinstance(value, (int, float)) and not isinstance(value, bool)
        elif isinstance(default, tuple):
            ok = isinstance(value, list) and all(isinstance(v, (int, float)) for v in value)
        else:
            ok = isinstance(value, type(default))
        if not ok:
            raise ValueError(f"{path}: train.{name}={value!r} has the wrong type (expected {type(default).__name__})")
    train["alert_thresholds"] = tuple(float(v) for v in train["alert_thresholds"])
    for name, f in fields.items():
        if isinstance(f.default, float):
            train[name] = float(train[name])
    cfg = TrainConfig(**train)
    if data_dir is not None:
        cfg = dataclasses.replace(cfg, data_dir=str(Path(data_dir).resolve()))
    validate_train_config(cfg)
    if set(raw["expect"]) != set(EXPECT_KEYS):
        raise ValueError(f"{path}: expect keys must be {sorted(EXPECT_KEYS)}")
    if set(raw["inputs"]) != set(INPUT_KEYS):
        raise ValueError(f"{path}: inputs keys must be {sorted(INPUT_KEYS)}")
    inputs = dict(raw["inputs"])
    for key in INPUT_FILE_KEYS:
        inputs[key] = (path.parent / inputs[key]).resolve()
    return RunConfig(path=path, sha256=hashlib.sha256(text.encode()).hexdigest(), cfg=cfg, expect=dict(raw["expect"]),
                     inputs=inputs, data_dir_overridden=data_dir is not None)


def model_dims(cfg: TrainConfig) -> dict[str, int]:
    return {"n_static": len(get_static_features(cfg)), "n_past": len(past_feature_names(cfg)),
            "n_future": len(FUTURE_FEATURES)}


def preflight(run: RunConfig, allow_dirty: bool) -> tuple[dict[str, Any], dict[str, list[str]]]:
    """Every check that must pass before data is used: clean source tree, data and split hashes,
    rule lock, and the config's expectations. Returns (record, frozen split)."""
    git = prov.require_clean(prov.git_state(), allow_dirty)
    manifest_path = run.inputs["data_manifest"]
    manifest = prov.load_json(manifest_path)
    data = prov.verify_data(run.cfg.data_dir, manifest)
    if run.cfg.pretrain_truth:
        got = prov.sha256_file(run.cfg.pretrain_truth)
        if got != manifest["files"].get(prov.TRUTH_FILE):
            raise prov.DataIntegrityError(f"pretrain_truth {run.cfg.pretrain_truth} does not match the data manifest")
        data[prov.TRUTH_FILE] = got
    split = prov.verify_split(run.inputs["split_file"], manifest)
    rule = prov.verify_rule(run.inputs["model_selection_rule"], run.inputs["model_selection_rule_md"],
                            run.inputs["model_selection_rule_sha256"], run.inputs["model_selection_rule_md_sha256"])
    exp, err = run.expect, []
    dims = model_dims(run.cfg)
    for k, v in dims.items():
        if exp[k] != v:
            err.append(f"{k}: config produces {v}, expected {exp[k]}")
    if exp["active_patients"] != manifest["active_patients"]:
        err.append(f"active_patients: manifest {manifest['active_patients']}, expected {exp['active_patients']}")
    if exp["split_counts"] != manifest["split_counts"]:
        err.append(f"split_counts: manifest {manifest['split_counts']}, expected {exp['split_counts']}")
    if sorted(exp["type1_excluded_pids"]) != sorted(manifest["type1_excluded_pids"]):
        err.append("type1_excluded_pids differ from the data manifest")
    rule_thresholds = prov.load_json(run.inputs["model_selection_rule"])["alerting"]["thresholds"]
    if [float(x) for x in rule_thresholds] != list(run.cfg.alert_thresholds):
        err.append(f"alert_thresholds {list(run.cfg.alert_thresholds)} != rule thresholds {rule_thresholds}")
    if err:
        raise ValueError("run config expectations not met: " + "; ".join(err))
    record = {
        "git": git,
        "config_file": run.path.name, "config_sha256": run.sha256,
        "data_dir": run.cfg.data_dir, "data_dir_overridden": run.data_dir_overridden,
        "data_manifest_sha256": prov.sha256_file(manifest_path), "data_sha256": data,
        "split_file": run.inputs["split_file"].name, "split_sha256": manifest["split_sha256"],
        **rule,
        "source_sha256": prov.source_hashes(),
        "expect": exp, "dims": dims,
    }
    return record, split


def check_cohort(series: dict[str, PatientSeries], split: dict[str, list[str]], run: RunConfig) -> dict[str, Any]:
    """The loaded cohort must be exactly the locked one, and the frozen split must be the one
    split_patients() derives from it with the configured seed."""
    err = []
    union = set().union(*map(set, split.values()))
    if set(series) != union:
        err.append(f"loaded patients != split patients ({len(series)} vs {len(union)})")
    if len(series) != run.expect["active_patients"]:
        err.append(f"{len(series)} active patients, expected {run.expect['active_patients']}")
    t1 = excluded_type1_pids(run.cfg.data_dir)
    if t1 != sorted(run.expect["type1_excluded_pids"]):
        err.append(f"Type 1 exclusions in the data {t1} != expected")
    recomputed = split_patients(series, run.cfg.seed)
    if recomputed != {k: sorted(v) for k, v in split.items()}:
        err.append("split_patients(seed) does not reproduce the frozen split")
    if err:
        raise ValueError("cohort check failed: " + "; ".join(err))
    return {"active_patients": len(series), "type1_excluded_pids": t1, "split_reproduces_from_seed": True,
            "onsets_total": int(sum(int(ps.onset.sum()) for ps in series.values()))}


def smoke_split(split: dict[str, list[str]]) -> dict[str, list[str]]:
    return {k: sorted(v)[:SMOKE_PATIENTS[k]] for k, v in split.items()}


def smoke_config(cfg: TrainConfig) -> TrainConfig:
    """Same architecture and inputs, tiny budget: proves the full pipeline end to end."""
    return dataclasses.replace(cfg, max_epochs=2, patience=2, batch_size=128, limit_train_batches=20,
                               limit_val_batches=10, pretrain_epochs=0, pretrain_truth="",
                               out_dir=cfg.out_dir.rstrip("/") + "_smoke")


def environment() -> dict[str, str]:
    import platform
    import sklearn

    env = {"python": platform.python_version(), "platform": platform.platform(), "torch": torch.__version__,
           "lightning": pl.__version__, "numpy": np.__version__, "pandas": pd.__version__, "sklearn": sklearn.__version__}
    try:
        import jax

        env["jax"] = jax.__version__
    except ImportError:
        pass
    return env


def write_json(path: Path, obj: Any) -> str:
    path.write_text(json.dumps(obj, indent=2) + "\n")
    return prov.sha256_file(path)


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Train the PR-TFT (Blueprint Sections 7 & 8).")
    ap.add_argument("--config", type=Path, required=True, help="run config (e.g. final_config.json)")
    ap.add_argument("--data-dir", type=Path, default=None,
                    help="read the data from here instead of train.data_dir; the files must still match data_manifest.json")
    ap.add_argument("--smoke-test", action="store_true",
                    help=f"same model and inputs on {sum(SMOKE_PATIENTS.values())} frozen-split patients, 2 short epochs")
    ap.add_argument("--check-only", action="store_true",
                    help="run every pre-training check, build the datamodule and one forward pass, then exit")
    ap.add_argument("--allow-dirty", action="store_true",
                    help="permit an uncommitted working tree (recorded as dirty in the run manifest)")
    return ap.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    started = time.perf_counter()
    run = load_run_config(args.config, data_dir=args.data_dir)
    record, split = preflight(run, allow_dirty=args.allow_dirty)
    series = load_data(run.cfg)
    cohort = check_cohort(series, split, run)
    cfg = run.cfg
    kind = "smoke" if args.smoke_test else "full"
    if args.smoke_test:
        split, cfg = smoke_split(split), smoke_config(cfg)
        series = {p: series[p] for ids in split.values() for p in ids}
    out_dir = Path(cfg.out_dir)
    if not args.check_only and out_dir.exists() and any(out_dir.iterdir()):
        raise FileExistsError(f"{out_dir} is not empty; every run gets a fresh directory")
    LOG.info("preflight passed: git %s (dirty=%s), data/split/rule hashes verified, %d active patients, %d onsets",
             record["git"]["git_sha"][:12], record["git"]["dirty"], cohort["active_patients"], cohort["onsets_total"])

    pl.seed_everything(cfg.seed, workers=True)
    rng = np.random.default_rng(cfg.seed)
    if torch.cuda.is_available():
        torch.set_float32_matmul_precision("medium")
    dm, twin, norm, pop = build_datamodule(series, split, cfg, rng)
    dims = model_dims(cfg)
    module = PRTFTModule(dataclasses.asdict(cfg), dims["n_static"], dims["n_past"], dims["n_future"], norm.glu_std)
    LOG.info("PR-TFT: %.2fM parameters; twin %s", sum(p.numel() for p in module.parameters()) / 1e6, twin.describe())

    if args.check_only:
        batch = next(iter(dm.train_dataloader()))
        with torch.no_grad():
            out = module.eval()(batch)
        shapes = {"past": list(batch["past"].shape), "future": list(batch["future"].shape),
                  "static": list(batch["static"].shape), "quantiles": list(out["quantiles"].shape)}
        if (shapes["past"][-1], shapes["future"][-1], shapes["static"][-1]) != (dims["n_past"], dims["n_future"], dims["n_static"]):
            raise RuntimeError(f"batch shapes {shapes} do not match model dims {dims}")
        print(json.dumps({"check": "passed", "preflight": record, "cohort": cohort, "twin": twin.describe(),
                          "anchors": {k: int(s.anchor_t.numel()) for k, s in dm.splits.items()},
                          "batch_shapes": shapes}, indent=2))
        return

    out_dir.mkdir(parents=True, exist_ok=True)
    # Stage 1 (optional, explicit in the config): clean pretraining on noise-free interstitial glucose.
    if cfg.pretrain_epochs > 0:
        truth = pd.read_csv(cfg.pretrain_truth, parse_dates=["timestamp"])
        truth = truth.rename(columns={"interstitial_glucose": "glucose_level"})[["patient_id", "timestamp", "glucose_level"]]
        clean_cfg = dataclasses.replace(cfg, log_corruption=False)
        clean_series = load_data(clean_cfg, patient_ids=list(series), glucose_override=truth)
        clean_dm, *_ = build_datamodule(clean_series, split, clean_cfg, rng, twin, norm, pop)
        LOG.info("stage 1: clean pretraining for %d epochs", cfg.pretrain_epochs)
        make_trainer(cfg, out_dir, cfg.pretrain_epochs, "stage1_clean").fit(module, clean_dm)

    # Stage 2: main training on the observed layer (noisy CGM, corrupted meal log).
    trainer = make_trainer(cfg, out_dir, cfg.max_epochs, "stage2_observed")
    trainer.fit(module, dm)
    best_path = trainer.checkpoint_callback.best_model_path
    if not best_path:
        raise RuntimeError("no checkpoint was saved")
    best = PRTFTModule.load_from_checkpoint(best_path, map_location="cpu")
    LOG.info("best checkpoint: %s", best_path)

    # Stage 3: calibration on validation patients. The test split is not scored here.
    eval_trainer = pl.Trainer(accelerator=cfg.accelerator, devices=1, logger=False, enable_progress_bar=False)
    val = predict(eval_trainer, best, dm.val_dataloader())
    calib = Calibrators.fit(val, cfg.interval_level)
    risk = val["at_risk"] > 0
    validation = {"trajectory_raw": trajectory_metrics(val),
                  "trajectory_conformal": trajectory_metrics(val, calib.apply_interval(val["q"])),
                  "hazard_raw": hazard_discrimination(val["p_cum"][risk], val["onset_any"][risk]),
                  "hazard_calibrated": hazard_discrimination(calib.apply_hazard(val["p_cum"][risk]), val["onset_any"][risk]),
                  "max_calibrated_probability": float(max(calib.iso_y)) if calib.iso_y else 0.0}

    files = {
        "split.json": write_json(out_dir / "split.json", split),
        "config.json": write_json(out_dir / "config.json", dataclasses.asdict(cfg)),
        "normalization.json": write_json(out_dir / "normalization.json", dataclasses.asdict(norm)),
        "calibration.json": write_json(out_dir / "calibration.json", dataclasses.asdict(calib)),
    }
    ckpt = Path(best_path)
    manifest = {
        "schema": RUN_MANIFEST_SCHEMA, "run_kind": kind,
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runtime_s": round(time.perf_counter() - started, 1),
        "preflight": record, "cohort": cohort,
        "split_effective_sha256": prov.sha256_json(split),
        "meal_log_sha256": meal_log_sha256(series),
        "population_habit_sha256": prov.sha256_json([np.round(pop[0], 12).tolist(), round(pop[1], 9)]),
        "twin": twin.describe(), "dims": dims, "files": files,
        "checkpoint": {"path": os.path.relpath(os.path.realpath(ckpt), os.path.realpath(out_dir)),
                       "sha256": prov.sha256_file(ckpt),
                       "best_val_loss": float(trainer.checkpoint_callback.best_model_score)},
        "validation": validation,
        "environment": environment(),
    }
    write_json(out_dir / "run_manifest.json", manifest)
    LOG.info("run artifacts in %s (%.0f s); evaluate with: python evaluate_run.py --run-dir %s",
             out_dir, manifest["runtime_s"], out_dir)


if __name__ == "__main__":
    main()

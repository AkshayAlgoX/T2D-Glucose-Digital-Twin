#!/usr/bin/env python3
"""Blueprint Section 5: validation gates for a synthetic CGM cohort.

Implements the ship gates from "T2D Glucose Digital Twin - Engineering
Blueprint", Section 5. A synthetic cohort may be used for model training only
when every gate passes.

  Gate 1  EHR consistency       Simulated mean glucose vs. the ADAG target implied
                                by each patient's HbA1c (bias, slope, residual
                                scatter, outliers) and glycemic variability (CV).
  Gate 2  Population realism    Postprandial time-to-peak lands in 60-90 min.
  Gate 3  Indistinguishability  An XGBoost discriminator must not separate
                                synthetic 6-h CGM windows from real ones
                                (AUROC <= 0.65), backed by a null control and a
                                power control.

Decision rule for every statistical check
    The estimate's two-sided confidence interval at --ci-level (default 0.90,
    i.e. two one-sided tests at alpha = 0.05) is compared with the acceptance
    band:
        PASS          interval entirely inside the band
        FAIL          interval entirely outside the band
        INCONCLUSIVE  interval straddles a band edge (collect more data)
    A gate FAILs when any check fails and is INCONCLUSIVE when none fails but
    any is inconclusive. INFO checks are diagnostics and never change a status.

Inputs
    --telemetry  Long CSV, one row per reading: patient_id, timestamp, glucose
                 (mg/dL). Other columns are ignored, except a meal column
                 (meal_event, meal_flag, carbs_g, ...) that Gate 2 can use.
    --ehr        CSV, one row per patient: patient_id, hba1c (% NGSP, or IFCC
                 mmol/mol, which is detected and converted), and optionally
                 diabetes_status, used to select cohorts.
    --meals      Optional CSV of meal start times: patient_id, timestamp.
                 Without any meal log, Gate 2 falls back to CGM-detected
                 excursions with bounded-lag inference, which is weaker.
    --real       Optional long CSV of real CGM (for example CGMacros or
                 ShanghaiT2DM converted to patient_id, timestamp, glucose).
                 Without it, Gate 3 builds an HbA1c-matched mock-real cohort.
                 That run verifies the pipeline end to end; it is not evidence
                 of realism.

Outputs (--out-dir, default validation_out/)
    validation_report.json         every check, estimate, interval and setting
    gate1_patients.csv             per-patient CGM and EHR metrics
    gate2_meal_responses.csv       every meal or excursion and why it was kept
    gate3_windows.csv              discriminator features and out-of-fold scores
    gate3_feature_importance.csv   mean |SHAP| per feature: where the tells are

Exit codes
    0 all gates PASS    1 any gate FAILs    2 command-line usage error
    3 INCONCLUSIVE      4 input or data error

Example
    python validation_gates.py --telemetry patient_cgm_telemetry.csv \\
        --ehr patients_ehr.csv --out-dir validation_out

Requires numpy, pandas, scipy, scikit-learn and xgboost.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import logging
import math
import platform
import sys
import textwrap
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Iterable

import numpy as np
import pandas as pd
import scipy
import sklearn
import xgboost as xgb
from scipy import signal, stats
from sklearn.model_selection import StratifiedGroupKFold

LOG = logging.getLogger("validation_gates")

# Published relations used as targets. Verify them against the primary sources
# before locking thresholds (blueprint, Sources section).
ADAG_SLOPE = 28.7  # mg/dL per HbA1c point (Nathan et al., Diabetes Care 2008)
ADAG_INTERCEPT = -46.7  # mg/dL
GMI_INTERCEPT = 3.31  # % (Bergenstal et al., Diabetes Care 2018)
GMI_SLOPE = 0.02392  # % per mg/dL of mean glucose
IFCC_TO_NGSP_SLOPE = 0.09148  # NGSP % = 0.09148 x IFCC mmol/mol + 2.152
IFCC_TO_NGSP_INTERCEPT = 2.152

EXIT_PASS, EXIT_FAIL, EXIT_USAGE, EXIT_INCONCLUSIVE, EXIT_INPUT = 0, 1, 2, 3, 4

MEAL_COLUMN_CANDIDATES = (
    "meal_event", "meal_flag", "meal_start", "meal", "carbs_g", "logged_carbs_g", "meal_carbs_g",
)
DEVICE_FEATURES = ("frac_missing", "n_gaps", "frac_integer")
META_COLUMNS = ("source", "patient_id", "group_id", "window_start", "label", "oof_score")
RESPONSE_COLUMNS = (
    "patient_id", "mode", "event_time", "peak_time", "baseline_mg_dl", "peak_mg_dl",
    "rise_mg_dl", "time_to_peak_min", "status",
)
# Relative spectral power bands, in cycles per minute.
SPECTRAL_BANDS = {
    "psd_slow": (0.0, 1 / 180),
    "psd_meal": (1 / 180, 1 / 60),
    "psd_mid": (1 / 60, 1 / 20),
    "psd_fast": (1 / 20, math.inf),
}
XGB_PARAMS: dict[str, Any] = {
    "n_estimators": 300,
    "max_depth": 4,
    "learning_rate": 0.05,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "min_child_weight": 5.0,
    "reg_lambda": 1.0,
    "objective": "binary:logistic",
    "eval_metric": "auc",
    "tree_method": "hist",
}
# Mock-real meal plan: (mean clock hour, SD in hours, skip probability, relative size).
MOCK_MEAL_PLAN = (
    (7.75, 0.60, 0.15, 1.00),  # breakfast
    (12.75, 0.70, 0.05, 1.10),  # lunch
    (19.00, 0.80, 0.05, 1.25),  # dinner
    (16.00, 0.80, 0.50, 0.40),  # afternoon snack
)


class Status(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    INCONCLUSIVE = "INCONCLUSIVE"
    INFO = "INFO"


class InputError(Exception):
    """Unusable input file or schema; exits with code 4."""


class InsufficientData(Exception):
    """Too little data for a check to reach a decision."""


@dataclass(frozen=True)
class Config:
    """Every threshold the gates use. Defaults follow the blueprint."""

    # Input schema
    id_col: str = "patient_id"
    time_col: str = "timestamp"
    glucose_col: str = "glucose_level"
    hba1c_col: str = "hba1c"
    group_col: str = "diabetes_status"
    plausible_mg_dl: tuple[float, float] = (20.0, 600.0)

    # Statistics
    ci_level: float = 0.90
    n_boot: int = 2000
    seed: int = 20260930
    min_patients: int = 10

    # Data sufficiency: 14 days with >= 70 % of readings (consensus for CGM metrics)
    min_days: float = 14.0
    min_coverage: float = 0.70
    max_interp_gap_min: float = 15.0

    # Gate 1: EHR consistency
    adag_groups: tuple[str, ...] = ()  # empty = all patients; ADAG spans T1D, T2D and non-diabetic
    adag_bias_tolerance_mg_dl: float = 10.0
    adag_slope_rel_tolerance: float = 0.20
    min_hba1c_sd: float = 0.5
    residual_sd_band_mg_dl: tuple[float, float] = (10.0, 18.0)
    glycation_gap_sd_mg_dl: float = 12.0
    outlier_sd_multiple: float = 3.0
    max_outlier_fraction: float = 0.05
    cv_groups: tuple[str, ...] = ("Type 2",)
    cv_median_band_pct: tuple[float, float] = (20.0, 30.0)
    cv_patient_band_pct: tuple[float, float] = (15.0, 40.0)

    # Gate 2: postprandial peak timing
    peak_band_min: tuple[float, float] = (60.0, 90.0)
    peak_horizon_min: float = 180.0
    baseline_window_min: float = 15.0
    meal_merge_min: float = 30.0
    meal_isolation_before_min: float = 120.0
    min_meal_rise_mg_dl: float = 15.0
    min_window_coverage: float = 0.80
    min_meals: int = 30
    detect_min_rise_mg_dl: float = 30.0
    detect_lookback_min: float = 180.0
    detect_hysteresis_mg_dl: float = 5.0  # about one SD of CGM sensor noise
    max_onset_lag_min: float = 30.0

    # Gate 3: discriminator
    window_hours: float = 6.0
    auroc_max: float = 0.65
    n_folds: int = 5
    power_noise_sd_mg_dl: float = 5.0
    power_min_auroc: float = 0.80
    null_tolerance: float = 0.10  # null AUROC may wander this far from 0.5 before it signals a leak
    harmonize_device: bool = False
    discriminator_groups: tuple[str, ...] = ()
    n_jobs: int | None = None


@dataclass
class CheckResult:
    check_id: str
    title: str
    status: Status
    message: str
    estimate: float | None = None
    ci: tuple[float, float] | None = None
    acceptance: str = ""
    n: int = 0
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class GateResult:
    gate_id: str
    title: str
    checks: list[CheckResult]
    notes: list[str] = field(default_factory=list)

    @property
    def status(self) -> Status:
        return combine_statuses(check.status for check in self.checks)


# --------------------------------------------------------------------------- #
# Statistics
# --------------------------------------------------------------------------- #


def combine_statuses(statuses: Iterable[Status]) -> Status:
    decisive = [s for s in statuses if s is not Status.INFO]
    if any(s is Status.FAIL for s in decisive):
        return Status.FAIL
    if not decisive or any(s is Status.INCONCLUSIVE for s in decisive):
        return Status.INCONCLUSIVE
    return Status.PASS


def interval_decision(lo: float, hi: float, band: tuple[float, float]) -> Status:
    """Three-way decision of a confidence interval against an acceptance band."""
    band_lo, band_hi = band
    if not (math.isfinite(lo) and math.isfinite(hi)):
        return Status.INCONCLUSIVE
    if band_lo <= lo and hi <= band_hi:
        return Status.PASS
    if hi < band_lo or lo > band_hi:
        return Status.FAIL
    return Status.INCONCLUSIVE


def t_interval_mean(x: np.ndarray, level: float) -> tuple[float, float, float]:
    n = x.size
    mean = float(np.mean(x))
    half = float(stats.t.ppf(0.5 + level / 2, n - 1) * np.std(x, ddof=1) / math.sqrt(n))
    return mean, mean - half, mean + half


def chi2_interval_sd(x: np.ndarray, level: float) -> tuple[float, float, float]:
    n = x.size
    sd = float(np.std(x, ddof=1))
    alpha = 1.0 - level
    lo = sd * math.sqrt((n - 1) / stats.chi2.ppf(1 - alpha / 2, n - 1))
    hi = sd * math.sqrt((n - 1) / stats.chi2.ppf(alpha / 2, n - 1))
    return sd, lo, hi


def percentile_interval(draws: np.ndarray, level: float) -> tuple[float, float]:
    finite = draws[np.isfinite(draws)]
    if finite.size == 0:
        return math.nan, math.nan
    lo, hi = np.quantile(finite, [(1 - level) / 2, (1 + level) / 2])
    return float(lo), float(hi)


def cluster_bootstrap(
    values: np.ndarray,
    clusters: np.ndarray,
    statistic: Callable[[np.ndarray], float],
    n_boot: int,
    level: float,
    rng: np.random.Generator,
) -> tuple[float, float]:
    """Percentile CI that resamples whole patients, so correlated observations
    from one patient are never treated as independent."""
    values = np.asarray(values, dtype=float)
    _, inverse = np.unique(np.asarray(clusters), return_inverse=True)
    members = [np.flatnonzero(inverse == k) for k in range(inverse.max() + 1)]
    draws = np.empty(n_boot)
    for b in range(n_boot):
        pick = rng.integers(0, len(members), len(members))
        draws[b] = statistic(values[np.concatenate([members[k] for k in pick])])
    return percentile_interval(draws, level)


def auroc(y: np.ndarray, score: np.ndarray) -> float:
    """Mann-Whitney AUROC with tie correction; NaN when a class is absent."""
    positive = np.asarray(y).astype(bool)
    n_pos = int(positive.sum())
    n_neg = positive.size - n_pos
    if n_pos == 0 or n_neg == 0:
        return math.nan
    ranks = stats.rankdata(score)
    return float((ranks[positive].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def stratified_cluster_bootstrap_auroc(
    y: np.ndarray,
    score: np.ndarray,
    clusters: np.ndarray,
    n_boot: int,
    level: float,
    rng: np.random.Generator,
) -> tuple[float, float]:
    """AUROC CI resampling patients within each class, so every draw keeps both."""
    y = np.asarray(y).astype(int)
    score = np.asarray(score, dtype=float)
    clusters = np.asarray(clusters)
    per_class = [
        [np.flatnonzero(clusters == c) for c in np.unique(clusters[y == cls])] for cls in (0, 1)
    ]
    draws = np.empty(n_boot)
    for b in range(n_boot):
        idx = np.concatenate(
            [members[j] for members in per_class for j in rng.integers(0, len(members), len(members))]
        )
        draws[b] = auroc(y[idx], score[idx])
    return percentile_interval(draws, level)


# --------------------------------------------------------------------------- #
# Input loading
# --------------------------------------------------------------------------- #


def read_header(path: Path) -> list[str]:
    if not path.is_file():
        raise InputError(f"file not found: {path}")
    return list(pd.read_csv(path, nrows=0).columns)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_timestamps(values: pd.Series) -> pd.Series:
    """Parse to naive timestamps; timezone-aware input is converted to UTC first."""
    try:
        parsed = pd.to_datetime(values, errors="coerce")
    except (TypeError, ValueError):
        parsed = pd.to_datetime(values, errors="coerce", utc=True)
    if isinstance(parsed.dtype, pd.DatetimeTZDtype):
        parsed = parsed.dt.tz_convert("UTC").dt.tz_localize(None)
    return parsed


def load_cgm(
    path: Path,
    id_col: str,
    time_col: str,
    glucose_col: str,
    plausible: tuple[float, float],
    label: str,
    extra_cols: Iterable[str] = (),
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Load a long CGM table as columns patient_id, timestamp, glucose (+ extras)."""
    header = read_header(path)
    needed = [id_col, time_col, glucose_col]
    missing = [c for c in needed if c not in header]
    if missing:
        raise InputError(f"{label} {path}: missing column(s) {missing}; found {header}")
    extra = [c for c in extra_cols if c and c not in needed]
    df = pd.read_csv(path, usecols=needed + extra, dtype={id_col: "str"})
    df = df.rename(columns={id_col: "patient_id", time_col: "timestamp", glucose_col: "glucose"})
    n_rows = len(df)
    df["patient_id"] = df["patient_id"].str.strip()
    df["timestamp"] = parse_timestamps(df["timestamp"])
    df["glucose"] = pd.to_numeric(df["glucose"], errors="coerce")

    lo, hi = plausible
    bad_time = int(df["timestamp"].isna().sum())
    no_glucose = int(df["glucose"].isna().sum())
    implausible = int((df["glucose"].notna() & ~df["glucose"].between(lo, hi)).sum())
    df = df[df["timestamp"].notna() & df["glucose"].between(lo, hi) & df["patient_id"].notna()]
    duplicates = int(df.duplicated(["patient_id", "timestamp"]).sum())
    if duplicates:
        aggregations = {"glucose": "mean", **{c: "max" for c in extra}}
        df = df.groupby(["patient_id", "timestamp"], as_index=False).agg(aggregations)
    df = df.sort_values(["patient_id", "timestamp"], ignore_index=True)
    if df.empty:
        raise InputError(f"{label} {path}: no usable readings after cleaning")

    qc = {
        "rows_read": n_rows,
        "rows_used": len(df),
        "patients": int(df["patient_id"].nunique()),
        "unparseable_timestamps": bad_time,
        "missing_glucose": no_glucose,
        "implausible_glucose": implausible,
        "duplicate_timestamps_averaged": duplicates,
    }
    for key in ("unparseable_timestamps", "missing_glucose", "implausible_glucose",
                "duplicate_timestamps_averaged"):
        if qc[key]:
            LOG.warning("%s: %d rows with %s", label, qc[key], key.replace("_", " "))
    LOG.info("%s: %s readings from %d patients", label, f"{len(df):,}", qc["patients"])
    return df, qc


def load_ehr(path: Path, cfg: Config) -> pd.DataFrame:
    header = read_header(path)
    missing = [c for c in (cfg.id_col, cfg.hba1c_col) if c not in header]
    if missing:
        raise InputError(f"EHR {path}: missing column(s) {missing}; found {header}")
    raw = pd.read_csv(path, dtype={cfg.id_col: "str"})
    ehr = pd.DataFrame({
        "patient_id": raw[cfg.id_col].astype("str").str.strip(),
        "hba1c_pct": pd.to_numeric(raw[cfg.hba1c_col], errors="coerce"),
    })
    if cfg.group_col in raw.columns:
        ehr["group"] = raw[cfg.group_col].astype("str").str.strip()
    else:
        ehr["group"] = "unspecified"
    duplicated = ehr["patient_id"].duplicated()
    if duplicated.any():
        raise InputError(
            f"EHR {path}: {int(duplicated.sum())} duplicate patient rows. Supply one HbA1c per "
            "patient: the value measured at the end of the CGM period."
        )
    median = ehr["hba1c_pct"].median()
    if median > 20:
        LOG.warning("HbA1c median %.1f looks like IFCC mmol/mol; converting to NGSP %%", median)
        ehr["hba1c_pct"] = IFCC_TO_NGSP_SLOPE * ehr["hba1c_pct"] + IFCC_TO_NGSP_INTERCEPT
    implausible = ~ehr["hba1c_pct"].between(3.0, 20.0)
    if implausible.any():
        LOG.warning("EHR: dropping %d rows with missing or implausible HbA1c", int(implausible.sum()))
        ehr = ehr[~implausible]
    LOG.info("EHR: %d patients", len(ehr))
    return ehr.reset_index(drop=True)


def detect_meal_column(path: Path, explicit: str | None) -> str | None:
    header = read_header(path)
    if explicit:
        if explicit not in header:
            raise InputError(f"--meal-col {explicit!r} is not a column of {path}")
        return explicit
    return next((c for c in MEAL_COLUMN_CANDIDATES if c in header), None)


def meals_from_column(cgm: pd.DataFrame, column: str) -> pd.DataFrame:
    """Meal starts are rows where the meal column is positive or true."""
    flag = pd.to_numeric(cgm[column], errors="coerce")
    if flag.isna().all():
        flag = cgm[column].astype("str").str.strip().str.lower().isin({"true", "yes", "y"}).astype(float)
    meals = cgm.loc[flag.fillna(0.0) > 0, ["patient_id", "timestamp"]]
    return meals.rename(columns={"timestamp": "meal_time"}).reset_index(drop=True)


def load_meals(path: Path, cfg: Config, time_col: str) -> pd.DataFrame:
    header = read_header(path)
    missing = [c for c in (cfg.id_col, time_col) if c not in header]
    if missing:
        raise InputError(f"meals {path}: missing column(s) {missing}; found {header}")
    raw = pd.read_csv(path, usecols=[cfg.id_col, time_col], dtype={cfg.id_col: "str"})
    meals = pd.DataFrame({
        "patient_id": raw[cfg.id_col].astype("str").str.strip(),
        "meal_time": parse_timestamps(raw[time_col]),
    })
    unparseable = int(meals["meal_time"].isna().sum())
    if unparseable:
        LOG.warning("meals: dropping %d rows with unparseable timestamps", unparseable)
    meals = meals.dropna().sort_values(["patient_id", "meal_time"], ignore_index=True)
    LOG.info("meals: %d meal starts for %d patients", len(meals), meals["patient_id"].nunique())
    return meals


def in_groups(groups: pd.Series, allowed: tuple[str, ...]) -> pd.Series:
    if not allowed:
        return pd.Series(True, index=groups.index)
    wanted = {g.strip().casefold() for g in allowed}
    return groups.astype("str").str.strip().str.casefold().isin(wanted)


def describe_groups(groups: tuple[str, ...]) -> str:
    return "all patients" if not groups else "group " + ", ".join(repr(g) for g in groups)


# --------------------------------------------------------------------------- #
# Per-patient summaries and regular grids
# --------------------------------------------------------------------------- #


def summarize_patients(cgm: pd.DataFrame, cfg: Config) -> pd.DataFrame:
    rows = []
    for pid, g in cgm.groupby("patient_id", sort=True):
        values = g["glucose"].to_numpy(dtype=float)
        stamps = g["timestamp"].to_numpy()
        steps = np.diff(stamps) / np.timedelta64(1, "m")  # resolution-agnostic minutes
        interval = float(np.median(steps)) if steps.size else math.nan
        if steps.size and interval > 0:
            span_min = float((stamps[-1] - stamps[0]) / np.timedelta64(1, "m")) + interval
            coverage = min(1.0, values.size * interval / span_min)
        else:
            span_min, coverage = 0.0, 0.0
        mean = float(values.mean())
        sd = float(values.std(ddof=1)) if values.size > 1 else math.nan
        rows.append({
            "patient_id": pid,
            "n_readings": int(values.size),
            "interval_min": interval,
            "days_covered": span_min / 1440.0,
            "coverage": coverage,
            "mean_glucose_mg_dl": mean,
            "sd_mg_dl": sd,
            "cv_pct": 100.0 * sd / mean if mean > 0 else math.nan,
        })
    summary = pd.DataFrame(rows)
    reasons = []
    for row in summary.itertuples(index=False):
        why = []
        # Compare at 0.1-day resolution so one missing final reading cannot exclude a full wear.
        if round(row.days_covered, 1) < cfg.min_days:
            why.append(f"{row.days_covered:.1f} d < {cfg.min_days:g} d")
        if row.coverage + 1e-9 < cfg.min_coverage:
            why.append(f"coverage {row.coverage:.0%} < {cfg.min_coverage:.0%}")
        reasons.append("; ".join(why))
    summary["exclusion_reason"] = reasons
    return summary


def true_runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Half-open (start, stop) index pairs for each run of True values."""
    padded = np.concatenate(([0], np.asarray(mask).astype(np.int8), [0]))
    edges = np.flatnonzero(np.diff(padded))
    return list(zip(edges[0::2].tolist(), edges[1::2].tolist()))


def fill_short_gaps(values: np.ndarray, max_steps: int) -> np.ndarray:
    """Linearly interpolate interior NaN runs of at most max_steps samples.
    Longer gaps, and gaps at either end, stay missing."""
    out = values.astype(float, copy=True)
    if max_steps <= 0:
        return out
    for start, stop in true_runs(~np.isfinite(out)):
        if start == 0 or stop == out.size or stop - start > max_steps:
            continue
        out[start:stop] = np.linspace(out[start - 1], out[stop], stop - start + 2)[1:-1]
    return out


def to_grid(cgm: pd.DataFrame, grid_min: int, max_gap_min: float) -> dict[str, pd.DataFrame]:
    """Resample each patient onto a clock-aligned grid. Column g is glucose with
    short gaps interpolated; obs is True where a reading fell in the bin.

    Each bin keeps its first reading rather than the mean. Downsampling then acts
    like a device sampling at the coarser interval: averaging would smooth the
    noise and hand the discriminator a tell no real 15-min device has.
    """
    max_steps = int(max_gap_min // grid_min)
    grids: dict[str, pd.DataFrame] = {}
    for pid, g in cgm.groupby("patient_id", sort=True):
        binned = (
            g.set_index("timestamp")["glucose"]
            .resample(f"{grid_min}min", origin="start_day")
            .first()
        )
        grids[pid] = pd.DataFrame(
            {"g": fill_short_gaps(binned.to_numpy(dtype=float), max_steps),
             "obs": binned.notna().to_numpy()},
            index=binned.index,
        )
    return grids


def native_grid_minutes(summary: pd.DataFrame) -> int:
    return max(1, int(round(float(np.nanmedian(summary["interval_min"])))))


# --------------------------------------------------------------------------- #
# Gate 1: EHR consistency
# --------------------------------------------------------------------------- #


def too_few(check_id: str, title: str, n: int, cfg: Config, acceptance: str) -> CheckResult:
    return CheckResult(
        check_id, title, Status.INCONCLUSIVE,
        f"Only {n} eligible patients; at least {cfg.min_patients} are needed for a decision.",
        acceptance=acceptance, n=n,
    )


def check_adag_bias(df: pd.DataFrame, cfg: Config) -> CheckResult:
    tol = cfg.adag_bias_tolerance_mg_dl
    level = f"{cfg.ci_level:.0%}"
    title = "ADAG bias: simulated mean glucose vs. HbA1c target"
    acceptance = f"{level} CI of mean(CGM mean - ADAG target) within +/-{tol:g} mg/dL"
    resid = df["adag_residual_mg_dl"].to_numpy(dtype=float)
    if resid.size < cfg.min_patients:
        return too_few("G1.1", title, resid.size, cfg, acceptance)
    mean, lo, hi = t_interval_mean(resid, cfg.ci_level)
    return CheckResult(
        "G1.1", title, interval_decision(lo, hi, (-tol, tol)),
        f"Mean residual {mean:+.1f} mg/dL ({level} CI {lo:+.1f} to {hi:+.1f}) "
        f"across {resid.size} patients.",
        estimate=mean, ci=(lo, hi), acceptance=acceptance, n=resid.size,
        details={"p_value_vs_zero": float(stats.ttest_1samp(resid, 0.0).pvalue)},
    )


def check_adag_slope(df: pd.DataFrame, cfg: Config) -> CheckResult:
    tol = cfg.adag_slope_rel_tolerance
    band = (ADAG_SLOPE * (1 - tol), ADAG_SLOPE * (1 + tol))
    level = f"{cfg.ci_level:.0%}"
    title = "ADAG slope: mean glucose per HbA1c point"
    acceptance = (f"{level} CI of OLS slope within {band[0]:.1f}-{band[1]:.1f} mg/dL per point "
                  f"(ADAG {ADAG_SLOPE:g} +/-{tol:.0%})")
    n = len(df)
    if n < cfg.min_patients:
        return too_few("G1.2", title, n, cfg, acceptance)
    a1c = df["hba1c_pct"].to_numpy(dtype=float)
    mean_glucose = df["mean_glucose_mg_dl"].to_numpy(dtype=float)
    spread = float(np.std(a1c, ddof=1))
    if spread < cfg.min_hba1c_sd:
        return CheckResult(
            "G1.2", title, Status.INCONCLUSIVE,
            f"HbA1c SD is {spread:.2f} points, below {cfg.min_hba1c_sd:g}: "
            "too narrow a range to estimate a slope.",
            acceptance=acceptance, n=n,
        )
    fit = stats.linregress(a1c, mean_glucose)
    q = float(stats.t.ppf(0.5 + cfg.ci_level / 2, n - 2))
    lo, hi = fit.slope - q * fit.stderr, fit.slope + q * fit.stderr
    return CheckResult(
        "G1.2", title, interval_decision(lo, hi, band),
        f"Slope {fit.slope:.1f} mg/dL per HbA1c point ({level} CI {lo:.1f}-{hi:.1f}); "
        f"intercept {fit.intercept:.1f} mg/dL; r = {fit.rvalue:.2f}.",
        estimate=float(fit.slope), ci=(float(lo), float(hi)), acceptance=acceptance, n=n,
        details={"intercept_mg_dl": float(fit.intercept),
                 "intercept_stderr": float(fit.intercept_stderr),
                 "r": float(fit.rvalue), "hba1c_sd": spread},
    )


def check_residual_scatter(df: pd.DataFrame, cfg: Config) -> CheckResult:
    band = cfg.residual_sd_band_mg_dl
    level = f"{cfg.ci_level:.0%}"
    title = "ADAG residual scatter (glycation gap)"
    acceptance = f"{level} CI of residual SD within {band[0]:g}-{band[1]:g} mg/dL"
    resid = df["adag_residual_mg_dl"].to_numpy(dtype=float)
    if resid.size < cfg.min_patients:
        return too_few("G1.3", title, resid.size, cfg, acceptance)
    sd, lo, hi = chi2_interval_sd(resid, cfg.ci_level)
    return CheckResult(
        "G1.3", title, interval_decision(lo, hi, band),
        f"Residual SD {sd:.1f} mg/dL ({level} CI {lo:.1f}-{hi:.1f}). Real cohorts scatter "
        "around the ADAG line, so near-zero scatter is as unrealistic as too much.",
        estimate=sd, ci=(lo, hi), acceptance=acceptance, n=resid.size,
        details={"shapiro_p_value": float(stats.shapiro(resid).pvalue)},
    )


def check_adag_outliers(df: pd.DataFrame, cfg: Config) -> CheckResult:
    limit = cfg.outlier_sd_multiple * cfg.glycation_gap_sd_mg_dl
    title = "Per-patient ADAG outliers"
    acceptance = (f"<= {cfg.max_outlier_fraction:.0%} of patients beyond "
                  f"{cfg.outlier_sd_multiple:g} x {cfg.glycation_gap_sd_mg_dl:g} mg/dL")
    n = len(df)
    if n == 0:
        return too_few("G1.4", title, 0, cfg, acceptance)
    flagged = df.loc[df["adag_residual_mg_dl"].abs() > limit,
                     ["patient_id", "hba1c_pct", "mean_glucose_mg_dl", "adag_residual_mg_dl"]]
    fraction = len(flagged) / n
    status = Status.PASS if fraction <= cfg.max_outlier_fraction else Status.FAIL
    return CheckResult(
        "G1.4", title, status,
        f"{len(flagged)} of {n} patients ({fraction:.0%}) sit more than {limit:g} mg/dL "
        "from their ADAG target.",
        estimate=fraction, acceptance=acceptance, n=n,
        details={"flagged": flagged.round(1).to_dict("records")},
    )


def check_cv_median(df: pd.DataFrame, cfg: Config, rng: np.random.Generator) -> CheckResult:
    band = cfg.cv_median_band_pct
    level = f"{cfg.ci_level:.0%}"
    title = "Glycemic variability: cohort median CV"
    acceptance = f"{level} CI of median CV within {band[0]:g}-{band[1]:g}%"
    cv = df["cv_pct"].to_numpy(dtype=float)
    if cv.size < cfg.min_patients:
        return too_few("G1.5", title, cv.size, cfg, acceptance)
    median = float(np.median(cv))
    lo, hi = cluster_bootstrap(cv, df["patient_id"].to_numpy(), np.median,
                               cfg.n_boot, cfg.ci_level, rng)
    return CheckResult(
        "G1.5", title, interval_decision(lo, hi, band),
        f"Median CV {median:.1f}% ({level} CI {lo:.1f}-{hi:.1f}) across {cv.size} patients "
        f"in {describe_groups(cfg.cv_groups)}.",
        estimate=median, ci=(lo, hi), acceptance=acceptance, n=cv.size,
        details={"cv_quartiles_pct": df["cv_pct"].quantile([0.25, 0.5, 0.75]).round(2).to_dict()},
    )


def check_cv_patients(df: pd.DataFrame, cfg: Config) -> CheckResult:
    band = cfg.cv_patient_band_pct
    title = "Glycemic variability: every patient's CV"
    acceptance = f"every patient's CV within {band[0]:g}-{band[1]:g}%"
    n = len(df)
    if n == 0:
        return too_few("G1.6", title, 0, cfg, acceptance)
    outside = df.loc[~df["cv_pct"].between(*band), ["patient_id", "group", "cv_pct"]]
    return CheckResult(
        "G1.6", title, Status.PASS if outside.empty else Status.FAIL,
        f"{n - len(outside)} of {n} patients have CV inside {band[0]:g}-{band[1]:g}%.",
        estimate=(n - len(outside)) / n, acceptance=acceptance, n=n,
        details={"outside_band": outside.round(2).to_dict("records")},
    )


def info_gmi(df: pd.DataFrame) -> CheckResult:
    gap = df["gmi_minus_hba1c"].abs()
    share_05 = float((gap >= 0.5).mean()) if len(gap) else math.nan
    share_10 = float((gap >= 1.0).mean()) if len(gap) else math.nan
    return CheckResult(
        "G1.7", "GMI vs. HbA1c discordance", Status.INFO,
        f"|GMI - HbA1c| >= 0.5 points in {share_05:.0%} of patients and >= 1.0 in "
        f"{share_10:.0%}. Compare with the published discordance rate before making "
        "this a gate.",
        estimate=share_05, n=len(gap),
        details={"share_ge_0_5": share_05, "share_ge_1_0": share_10},
    )


def run_gate1(summary: pd.DataFrame, ehr: pd.DataFrame, cfg: Config,
              rng: np.random.Generator) -> tuple[GateResult, pd.DataFrame]:
    df = summary.merge(ehr, on="patient_id", how="left", validate="one_to_one")
    df["adag_target_mg_dl"] = ADAG_SLOPE * df["hba1c_pct"] + ADAG_INTERCEPT
    df["adag_residual_mg_dl"] = df["mean_glucose_mg_dl"] - df["adag_target_mg_dl"]
    df["gmi_pct"] = GMI_INTERCEPT + GMI_SLOPE * df["mean_glucose_mg_dl"]
    df["gmi_minus_hba1c"] = df["gmi_pct"] - df["hba1c_pct"]
    no_ehr = df["hba1c_pct"].isna().to_numpy()
    reason = df["exclusion_reason"].to_numpy(dtype=object)
    df["exclusion_reason"] = [
        (r + "; no EHR HbA1c" if r else "no EHR HbA1c") if missing else r
        for r, missing in zip(reason, no_ehr)
    ]
    df["included"] = df["exclusion_reason"] == ""
    df["adag_outlier"] = (df["adag_residual_mg_dl"].abs()
                          > cfg.outlier_sd_multiple * cfg.glycation_gap_sd_mg_dl)
    df["cv_in_patient_band"] = df["cv_pct"].between(*cfg.cv_patient_band_pct)

    included = df[df["included"]]
    adag_df = included[in_groups(included["group"], cfg.adag_groups)]
    cv_df = included[in_groups(included["group"], cfg.cv_groups)]
    ehr_only = sorted(set(ehr["patient_id"]) - set(df["patient_id"]))
    excluded = df.loc[~df["included"], ["patient_id", "exclusion_reason"]]

    sufficiency = CheckResult(
        "G1.0", "Data sufficiency", Status.INFO,
        f"{len(included)} of {len(df)} patients with telemetry are eligible "
        f"(>= {cfg.min_days:g} days, >= {cfg.min_coverage:.0%} of readings, HbA1c on file)."
        + (f" {len(ehr_only)} EHR patients have no telemetry." if ehr_only else ""),
        n=len(included),
        details={"excluded": excluded.to_dict("records"), "ehr_without_telemetry": ehr_only},
    )
    checks = [
        sufficiency,
        check_adag_bias(adag_df, cfg),
        check_adag_slope(adag_df, cfg),
        check_residual_scatter(adag_df, cfg),
        check_adag_outliers(adag_df, cfg),
        check_cv_median(cv_df, cfg, rng),
        check_cv_patients(cv_df, cfg),
        info_gmi(adag_df),
    ]
    notes = [f"ADAG checks use {describe_groups(cfg.adag_groups)} ({len(adag_df)}); "
             f"CV checks use {describe_groups(cfg.cv_groups)} ({len(cv_df)})."]
    return GateResult("GATE 1", "EHR consistency", checks, notes), df


# --------------------------------------------------------------------------- #
# Gate 2: postprandial time-to-peak
# --------------------------------------------------------------------------- #


def merge_meal_onsets(times: Iterable[pd.Timestamp], merge_min: float) -> list[pd.Timestamp]:
    """Collapse meal records that start within merge_min of a meal onset."""
    onsets: list[pd.Timestamp] = []
    for t in sorted(times):
        if onsets and (t - onsets[-1]) / pd.Timedelta(minutes=1) < merge_min:
            continue
        onsets.append(t)
    return onsets


def meal_responses(grids: dict[str, pd.DataFrame], meals: pd.DataFrame, cfg: Config,
                   grid_min: int) -> pd.DataFrame:
    """Measure each logged meal's excursion: baseline, peak, rise and time-to-peak."""
    horizon = pd.Timedelta(minutes=cfg.peak_horizon_min)
    baseline_span = pd.Timedelta(minutes=cfg.baseline_window_min)
    expected_points = int(cfg.peak_horizon_min // grid_min) + 1
    rows = []
    for pid, patient_meals in meals.groupby("patient_id", sort=True):
        onsets = merge_meal_onsets(patient_meals["meal_time"], cfg.meal_merge_min)
        grid = grids.get(pid)
        smooth = None
        if grid is not None:
            smooth = grid["g"].rolling(3, center=True, min_periods=2).median()
        for i, t0 in enumerate(onsets):
            row = {"patient_id": pid, "mode": "logged_meal", "event_time": t0,
                   "peak_time": pd.NaT, "baseline_mg_dl": math.nan, "peak_mg_dl": math.nan,
                   "rise_mg_dl": math.nan, "time_to_peak_min": math.nan}
            if grid is None:
                rows.append({**row, "status": "no_cgm"})
                continue
            window = smooth.loc[t0:t0 + horizon]
            n_valid = int(window.notna().sum())
            if n_valid:
                peak_time = window.idxmax()
                before = grid["g"].loc[t0 - baseline_span:t0 - pd.Timedelta(seconds=1)]
                baseline = float(before.median()) if before.notna().any() else float(window.dropna().iloc[0])
                peak = float(window.max())
                row.update(peak_time=peak_time, baseline_mg_dl=baseline, peak_mg_dl=peak,
                           rise_mg_dl=peak - baseline,
                           time_to_peak_min=(peak_time - t0) / pd.Timedelta(minutes=1))
            gap_before = (t0 - onsets[i - 1]) / pd.Timedelta(minutes=1) if i else math.inf
            gap_after = (onsets[i + 1] - t0) / pd.Timedelta(minutes=1) if i + 1 < len(onsets) else math.inf
            if gap_before < cfg.meal_isolation_before_min:
                status = "prior_meal_within_isolation"
            elif gap_after <= cfg.peak_horizon_min:
                status = "next_meal_within_horizon"
            elif n_valid / expected_points < cfg.min_window_coverage:
                status = "insufficient_cgm"
            elif row["time_to_peak_min"] >= cfg.peak_horizon_min - grid_min:
                status = "peak_at_horizon"
            elif row["rise_mg_dl"] < cfg.min_meal_rise_mg_dl:
                status = "non_responsive"
            else:
                status = "ok"
            rows.append({**row, "status": status})
    unmatched = sorted(set(meals["patient_id"]) - set(grids))
    if unmatched:
        LOG.warning("Gate 2: %d patients in the meal log have no telemetry", len(unmatched))
    return pd.DataFrame(rows, columns=list(RESPONSE_COLUMNS))


def detected_excursions(grids: dict[str, pd.DataFrame], cfg: Config,
                        grid_min: int) -> pd.DataFrame:
    """Meal-like excursions found from CGM alone, for cohorts without a meal log.

    For each peak with prominence >= detect_min_rise_mg_dl, walk back from the
    peak while glucose keeps falling. The walk stops at the first reversal larger
    than detect_hysteresis_mg_dl, so noise on a flat pre-meal baseline cannot
    drag the onset hours early, as a plain minimum over the lookback would. The
    walk never passes the previous peak. The measured interval is onset-to-peak;
    the true meal start comes earlier by an unknown lag, which run_gate2 bounds.
    Non-meal rises (stress, dawn) are counted too, which is why this mode is
    weaker than a meal log.
    """
    distance = max(1, int(round(60.0 / grid_min)))
    lookback = max(2, int(round(cfg.detect_lookback_min / grid_min)))
    rows = []
    for pid, grid in grids.items():
        smooth = grid["g"].rolling(3, center=True, min_periods=2).median().to_numpy(dtype=float)
        index = grid.index
        for start, stop in true_runs(np.isfinite(smooth)):
            seg = smooth[start:stop]
            if seg.size < 3:
                continue
            peaks, _ = signal.find_peaks(seg, prominence=cfg.detect_min_rise_mg_dl, distance=distance)
            floor = 0
            for p in peaks.tolist():
                lb = max(floor, p - lookback)
                floor = p
                onset, running_min, reversed_ = p, seg[p], False
                for i in range(p - 1, lb - 1, -1):
                    if seg[i] < running_min:
                        onset, running_min = i, seg[i]
                    elif seg[i] - running_min > cfg.detect_hysteresis_mg_dl:
                        reversed_ = True
                        break
                if onset >= p:
                    continue
                rise = float(seg[p] - seg[onset])
                if rise < cfg.detect_min_rise_mg_dl:
                    status = "rise_below_threshold"
                elif onset == 0:
                    status = "onset_censored_by_gap"
                elif not reversed_ and lb == p - lookback:
                    status = "onset_at_lookback_limit"
                else:
                    status = "ok"
                rows.append({
                    "patient_id": pid, "mode": "cgm_detected",
                    "event_time": index[start + onset], "peak_time": index[start + p],
                    "baseline_mg_dl": float(seg[onset]), "peak_mg_dl": float(seg[p]),
                    "rise_mg_dl": rise, "time_to_peak_min": float((p - onset) * grid_min),
                    "status": status,
                })
    return pd.DataFrame(rows, columns=list(RESPONSE_COLUMNS))


def run_gate2(responses: pd.DataFrame, mode: str, cfg: Config,
              rng: np.random.Generator) -> GateResult:
    band = cfg.peak_band_min
    level = f"{cfg.ci_level:.0%}"
    ok = responses[responses["status"] == "ok"]
    n_ok, n_patients = len(ok), int(ok["patient_id"].nunique())
    logged = mode == "logged_meal"
    title = ("Postprandial time-to-peak (logged meals)" if logged
             else "Postprandial time-to-peak (CGM-detected excursions)")
    lag = cfg.max_onset_lag_min
    acceptance = (f"{level} CI of the median within {band[0]:g}-{band[1]:g} min" if logged else
                  f"implied interval [CI low, CI high + {lag:g} min onset lag] within "
                  f"{band[0]:g}-{band[1]:g} min")
    checks: list[CheckResult] = []
    notes: list[str] = []
    if n_ok < cfg.min_meals or n_patients < 3:
        checks.append(CheckResult(
            "G2.1", title, Status.INCONCLUSIVE,
            f"Only {n_ok} usable events from {n_patients} patients; need >= {cfg.min_meals} "
            "events from >= 3 patients.",
            acceptance=acceptance, n=n_ok,
        ))
    else:
        ttp = ok["time_to_peak_min"].to_numpy(dtype=float)
        median = float(np.median(ttp))
        lo, hi = cluster_bootstrap(ttp, ok["patient_id"].to_numpy(), np.median,
                                   cfg.n_boot, cfg.ci_level, rng)
        if logged:
            status = interval_decision(lo, hi, band)
            message = (f"Median time from meal start to peak {median:.0f} min ({level} CI "
                       f"{lo:.0f}-{hi:.0f}) over {n_ok} isolated meals in {n_patients} patients.")
        else:
            status = interval_decision(lo, hi + lag, band)
            message = (f"Median onset-to-peak rise time {median:.0f} min ({level} CI "
                       f"{lo:.0f}-{hi:.0f}) over {n_ok} excursions in {n_patients} patients. "
                       f"Allowing up to {lag:g} min between meal start and a detectable rise, "
                       f"time-to-peak from meal start lies in {lo:.0f}-{hi + lag:.0f} min.")
            notes.append("No meal log was found, so meals were inferred from CGM excursions. "
                         "This can fail a cohort decisively but rarely passes one. Export meal "
                         "start times (a meal_event column or --meals CSV) for a definitive "
                         "result.")
        checks.append(CheckResult("G2.1", title, status, message, estimate=median, ci=(lo, hi),
                                  acceptance=acceptance, n=n_ok,
                                  details={"mode": mode, "max_onset_lag_min": None if logged else lag}))
        per_patient = ok.groupby("patient_id")["time_to_peak_min"].median()
        inside = float(per_patient.between(*band).mean())
        checks.append(CheckResult(
            "G2.2", "Per-patient median time-to-peak", Status.INFO,
            f"{inside:.0%} of {len(per_patient)} patients have a median inside "
            f"{band[0]:g}-{band[1]:g} min (per-patient medians: 10th-90th percentile "
            f"{per_patient.quantile(0.1):.0f}-{per_patient.quantile(0.9):.0f} min).",
            estimate=inside, n=len(per_patient),
            details={"quantiles_min": per_patient.quantile([0.1, 0.25, 0.5, 0.75, 0.9]).round(1).to_dict()},
        ))
        rise = ok["rise_mg_dl"]
        checks.append(CheckResult(
            "G2.3", "Postprandial rise", Status.INFO,
            f"Median rise {rise.median():.0f} mg/dL (IQR {rise.quantile(0.25):.0f}-"
            f"{rise.quantile(0.75):.0f}).",
            estimate=float(rise.median()), n=len(rise),
        ))
    counts = {str(k): int(v) for k, v in responses["status"].value_counts().items()}
    exclusions = ", ".join(f"{k} {v}" for k, v in counts.items() if k != "ok") or "none"
    checks.append(CheckResult(
        "G2.4", "Event accounting", Status.INFO,
        f"{n_ok} of {len(responses)} events usable; excluded: {exclusions}.",
        n=len(responses), details={"status_counts": counts},
    ))
    return GateResult("GATE 2", "Population realism: postprandial peak timing", checks, notes)


# --------------------------------------------------------------------------- #
# Gate 3: discriminator
# --------------------------------------------------------------------------- #


def mage_approx(x: np.ndarray, sd: float) -> float:
    """Mean amplitude of swings larger than 1 SD between successive turning
    points of a 3-point moving average (MAGE-like)."""
    if x.size < 5 or not sd > 0:
        return 0.0
    smooth = np.convolve(x, np.ones(3) / 3.0, mode="valid")
    slope = np.sign(np.diff(smooth))
    if not slope.any():
        return 0.0
    # Carry the last non-zero slope across plateaus so a flat run is not a turning point.
    slope = pd.Series(np.where(slope != 0, slope, np.nan)).ffill().bfill().to_numpy()
    turns = np.flatnonzero(np.diff(slope) != 0) + 1
    extrema = smooth[np.concatenate(([0], turns, [smooth.size - 1]))]
    swings = np.abs(np.diff(extrema))
    large = swings[swings > sd]
    return float(large.mean()) if large.size else 0.0


def window_features(values: np.ndarray, observed: np.ndarray, grid_min: int,
                    start: pd.Timestamp) -> dict[str, float]:
    """Distribution, dynamics, spectral and device features of one CGM window."""
    n = values.size
    feats: dict[str, float] = {}
    feats["frac_missing"] = float(1.0 - observed.mean())
    feats["n_gaps"] = float(len(true_runs(~observed)))
    raw = values[observed & np.isfinite(values)]
    feats["frac_integer"] = float(np.mean(np.abs(raw - np.round(raw)) < 1e-6)) if raw.size else math.nan

    finite = np.isfinite(values)
    x = values.astype(float) if finite.all() else np.interp(
        np.arange(n), np.flatnonzero(finite), values[finite])
    mean = float(x.mean())
    sd = float(x.std(ddof=1))
    flat = sd < 1e-9
    q10, q25, q50, q75, q90 = np.percentile(x, [10, 25, 50, 75, 90])
    feats.update(
        mean=mean, sd=sd, cv=100.0 * sd / mean if mean > 0 else math.nan,
        min=float(x.min()), max=float(x.max()), p10=float(q10), p25=float(q25), p50=float(q50),
        p75=float(q75), p90=float(q90), iqr=float(q75 - q25),
        skew=0.0 if flat else float(stats.skew(x)),
        kurtosis=0.0 if flat else float(stats.kurtosis(x)),
        tbr_70=float(np.mean(x < 70)), tir_70_180=float(np.mean((x >= 70) & (x <= 180))),
        tar_180=float(np.mean(x > 180)), tar_250=float(np.mean(x > 250)),
    )
    roc = np.diff(x) / grid_min
    roc_sd = float(roc.std(ddof=1))
    jerk = np.diff(x, 2) / grid_min**2
    jerk_sd = float(jerk.std(ddof=1))
    feats.update(
        roc_sd=roc_sd, roc_mean_abs=float(np.abs(roc).mean()), roc_max_rise=float(roc.max()),
        roc_max_fall=float(roc.min()), roc_frac_flat=float(np.mean(np.abs(roc) < 1e-9)),
        jerk_sd=jerk_sd, roughness=jerk_sd / roc_sd if roc_sd > 1e-12 else math.nan,
    )
    centred = x - mean
    denom = float(np.dot(centred, centred))
    for lag_min in (15, 30, 60, 120):
        lag = int(round(lag_min / grid_min))
        feats[f"acf_{lag_min}m"] = (float(np.dot(centred[:-lag], centred[lag:]) / denom)
                                    if 0 < lag < n // 2 and denom > 0 else math.nan)
    power = np.abs(np.fft.rfft(signal.detrend(x))) ** 2
    freq = np.fft.rfftfreq(n, d=grid_min)
    power, freq = power[1:], freq[1:]
    total = float(power.sum())
    for name, (f_lo, f_hi) in SPECTRAL_BANDS.items():
        band_power = float(power[(freq >= f_lo) & (freq < f_hi)].sum())
        feats[name] = band_power / total if total > 0 else math.nan
    peaks, props = signal.find_peaks(x, prominence=10.0)
    feats["n_peaks_10"] = float(peaks.size)
    feats["mean_prominence"] = float(props["prominences"].mean()) if peaks.size else 0.0
    feats["mage_approx"] = mage_approx(x, sd)
    hour = start.hour + start.minute / 60.0
    feats["tod_sin"] = math.sin(2 * math.pi * hour / 24.0)
    feats["tod_cos"] = math.cos(2 * math.pi * hour / 24.0)
    return feats


def extract_windows(grids: dict[str, pd.DataFrame], source: str, grid_min: int,
                    cfg: Config) -> pd.DataFrame:
    """Non-overlapping windows with at least min_window_coverage of values."""
    n_win = int(round(cfg.window_hours * 60 / grid_min))
    rows = []
    for pid, grid in grids.items():
        g = grid["g"].to_numpy(dtype=float)
        obs = grid["obs"].to_numpy(dtype=bool)
        for k in range(0, g.size - n_win + 1, n_win):
            window = g[k:k + n_win]
            if np.isfinite(window).mean() < cfg.min_window_coverage:
                continue
            start = grid.index[k]
            rows.append({"source": source, "patient_id": pid, "group_id": f"{source}:{pid}",
                         "window_start": start,
                         **window_features(window, obs[k:k + n_win], grid_min, start)})
    return pd.DataFrame(rows)


def discriminate(windows: pd.DataFrame, feature_cols: list[str], cfg: Config,
                 rng: np.random.Generator) -> dict[str, Any]:
    """Patient-disjoint cross-validated XGBoost discriminator (label 1 vs. 0)."""
    y = windows["label"].to_numpy(dtype=int)
    groups = windows["group_id"].to_numpy()
    X = windows[feature_cols].astype(float)
    patients_per_class = [int(np.unique(groups[y == c]).size) for c in (0, 1)]
    n_splits = min(cfg.n_folds, *patients_per_class)
    if n_splits < 2:
        raise InsufficientData(f"need >= 2 patients per class; have {patients_per_class}")
    splitter = StratifiedGroupKFold(n_splits=n_splits, shuffle=True, random_state=cfg.seed)
    oof = np.full(y.size, math.nan)
    fold_aurocs: list[float] = []
    shap_sum = np.zeros(len(feature_cols))
    for fold, (train, test) in enumerate(splitter.split(X, y, groups)):
        counts = np.bincount(y[train], minlength=2)
        if counts.min() == 0:
            raise InsufficientData(f"fold {fold} has a single class in training")
        weights = (y[train].size / (2.0 * counts))[y[train]]
        model = xgb.XGBClassifier(**XGB_PARAMS, random_state=cfg.seed + fold, n_jobs=cfg.n_jobs)
        model.fit(X.iloc[train], y[train], sample_weight=weights, verbose=False)
        oof[test] = model.predict_proba(X.iloc[test])[:, 1]
        fold_aurocs.append(auroc(y[test], oof[test]))
        contributions = model.get_booster().predict(xgb.DMatrix(X.iloc[test]), pred_contribs=True)
        shap_sum += np.abs(contributions[:, :-1]).sum(axis=0)
    lo, hi = stratified_cluster_bootstrap_auroc(y, oof, groups, cfg.n_boot, cfg.ci_level, rng)
    return {
        "auroc": auroc(y, oof),
        "ci": (lo, hi),
        "fold_aurocs": fold_aurocs,
        "n_windows": [int((y == c).sum()) for c in (0, 1)],
        "n_patients": patients_per_class,
        "oof": oof,
        "importance": pd.Series(shap_sum / y.size, index=feature_cols).sort_values(ascending=False),
    }


def gamma_response(tau_min: np.ndarray, peak_min: float, shape: float = 3.0) -> np.ndarray:
    """Gamma-variate meal response, zero before the meal and 1.0 at its mode."""
    theta = peak_min / (shape - 1.0)
    z = np.clip(tau_min, 0.0, None) / theta
    return z ** (shape - 1.0) * np.exp(-z) / ((shape - 1.0) ** (shape - 1.0) * math.exp(1.0 - shape))


def ar2_noise(n: int, sd: float, phi1: float, phi2: float, rng: np.random.Generator) -> np.ndarray:
    """Stationary AR(2) noise with marginal standard deviation sd."""
    unit_variance = (1 - phi2) / ((1 + phi2) * ((1 - phi2) ** 2 - phi1 ** 2))
    shocks = rng.normal(0.0, sd / math.sqrt(unit_variance), n + 300)
    return signal.lfilter([1.0], [1.0, -phi1, -phi2], shocks)[300:]


def build_mock_cohort(hba1c: np.ndarray, days: float, seed: int, grid_min: int = 5,
                      id_prefix: str = "MOCK") -> tuple[pd.DataFrame, pd.DataFrame]:
    """HbA1c-matched stand-in for a real CGM cohort, from a generator that is
    structurally independent of the synthetic one.

    Plasma glucose = basal + gamma-variate meal responses + dawn rise + AR(1)
    drift, with the mean pinned to the ADAG target plus glycation-gap scatter.
    The observed stream adds interstitial lag, per-session calibration error,
    AR(2) sensor noise, dropouts, warm-up gaps, integer rounding and the
    40-400 mg/dL reporting range. Returns (cgm, meal_starts).
    """
    rng = np.random.default_rng(seed)
    n = int(round(days * 1440 / grid_min))
    t = np.arange(n) * float(grid_min)
    clock_h = (t / 60.0) % 24.0
    origin = pd.Timestamp("2026-01-05")
    stamps = origin + pd.to_timedelta(t, unit="min")
    kernel_len = int(360 // grid_min)
    session_len = int(10 * 1440 // grid_min)
    isf_alpha = 1.0 - math.exp(-grid_min / 8.0)  # first-order interstitial lag, tau = 8 min
    drift_phi = math.exp(-grid_min / 180.0)
    cgm_parts, meal_rows = [], []
    for i, a1c in enumerate(np.asarray(hba1c, dtype=float)):
        pid = f"{id_prefix}{i + 1:04d}"
        target = max(ADAG_SLOPE * a1c + ADAG_INTERCEPT + rng.normal(0.0, 12.0), 80.0)
        peak_min = float(np.clip(rng.normal(65.0, 10.0), 45.0, 90.0))
        amplitude = max(30.0, 50.0 + 15.0 * (a1c - 5.5))
        meal = np.zeros(n)
        for day in range(int(math.ceil(days))):
            for mean_h, sd_h, p_skip, rel_size in MOCK_MEAL_PLAN:
                if rng.random() < p_skip:
                    continue
                t_meal = day * 1440.0 + 60.0 * rng.normal(mean_h, sd_h)
                k0 = int(math.ceil(t_meal / grid_min))
                if not 0 <= k0 < n:
                    continue
                span = slice(k0, min(n, k0 + kernel_len))
                meal[span] += (rel_size * amplitude * rng.lognormal(0.0, 0.3)
                               * gamma_response(t[span] - t_meal,
                                                peak_min * math.exp(rng.normal(0.0, 0.12))))
                meal_rows.append((pid, origin + pd.Timedelta(minutes=t_meal)))
        dawn = rng.uniform(0.0, 25.0) * np.exp(-((clock_h - 5.5) ** 2) / (2 * 1.2 ** 2))
        drift_sd = rng.uniform(8.0, 16.0)
        drift = signal.lfilter([1.0], [1.0, -drift_phi],
                               rng.normal(0.0, drift_sd * math.sqrt(1 - drift_phi ** 2), n + 300))[300:]
        basal = max(target - float(np.mean(meal + dawn)), 65.0)
        plasma = basal + meal + dawn + drift
        interstitial, _ = signal.lfilter([isf_alpha], [1.0, isf_alpha - 1.0], plasma,
                                         zi=[(1.0 - isf_alpha) * plasma[0]])
        observed = np.empty(n)
        for s0 in range(0, n, session_len):
            s1 = min(n, s0 + session_len)
            observed[s0:s1] = rng.normal(1.0, 0.04) * interstitial[s0:s1] + rng.normal(0.0, 4.0)
        observed += ar2_noise(n, 5.0, 1.2, -0.4, rng)
        missing = np.zeros(n, dtype=bool)
        for _ in range(rng.poisson(0.3 * days)):
            g0 = int(rng.integers(0, n))
            missing[g0:g0 + int(rng.geometric(1 / 5))] = True
        for s0 in range(session_len, n, session_len):
            missing[s0:s0 + int(rng.uniform(30.0, 60.0) // grid_min)] = True
        keep = ~missing
        cgm_parts.append(pd.DataFrame({
            "patient_id": pid,
            "timestamp": stamps[keep],
            "glucose": np.clip(np.round(observed[keep]), 40.0, 400.0),
        }))
    cgm = pd.concat(cgm_parts, ignore_index=True)
    meals = pd.DataFrame(meal_rows, columns=["patient_id", "meal_time"])
    return cgm, meals


def harmonize_device(cgm: pd.DataFrame) -> pd.DataFrame:
    """Give both sources identical device semantics (integer mg/dL, 40-400
    reporting range) so the discriminator can only use physiology."""
    out = cgm.copy()
    out["glucose"] = out["glucose"].round().clip(40.0, 400.0)
    return out


def run_gate3(synthetic: pd.DataFrame, ehr: pd.DataFrame | None, real: pd.DataFrame | None,
              cfg: Config, rng: np.random.Generator,
              synthetic_grid_min: int) -> tuple[GateResult, pd.DataFrame, pd.DataFrame]:
    level = f"{cfg.ci_level:.0%}"
    title = "Discriminator: synthetic vs. real windows"
    acceptance = f"{level} CI of AUROC <= {cfg.auroc_max:g}"
    notes: list[str] = []
    empty = pd.DataFrame()

    synth = synthetic
    if cfg.discriminator_groups:
        keep = ehr.loc[in_groups(ehr["group"], cfg.discriminator_groups), "patient_id"]
        synth = synthetic[synthetic["patient_id"].isin(set(keep))]
    if synth.empty:
        check = CheckResult("G3.1", title, Status.INCONCLUSIVE,
                            f"No synthetic patients in {describe_groups(cfg.discriminator_groups)}.",
                            acceptance=acceptance)
        return GateResult("GATE 3", "Indistinguishability from real CGM", [check]), empty, empty

    if real is None:
        a1c = (ehr.set_index("patient_id")["hba1c_pct"]
               .reindex(sorted(synth["patient_id"].unique())).dropna())
        days = float(synth.groupby("patient_id")["timestamp"].agg(lambda s: (s.max() - s.min()) / pd.Timedelta(days=1)).median())
        real, _ = build_mock_cohort(a1c.to_numpy(), max(days, 1.0), seed=cfg.seed + 7)
        real_label, evidence, real_grid_min = "mock_real", "mock", 5
        title = "Discriminator: synthetic vs. mock-real windows"
        notes.append("No --real data, so the comparison used an HbA1c-matched mock-real cohort "
                     "from an independent generator. This verifies the pipeline end to end; it is "
                     "not evidence of realism. Rerun with CGMacros or ShanghaiT2DM before relying "
                     "on this gate.")
    else:
        real_label, evidence = "real", "real"
        steps = real.groupby("patient_id")["timestamp"].diff().dropna() / pd.Timedelta(minutes=1)
        real_grid_min = max(1, int(round(float(steps.median()))))
    grid_min = max(synthetic_grid_min, real_grid_min)
    if cfg.harmonize_device:
        synth, real = harmonize_device(synth), harmonize_device(real)
        notes.append("Device semantics harmonized (integer mg/dL, 40-400 range; missingness and "
                     "quantization features dropped), so only physiology can separate the sources.")

    LOG.info("Gate 3: extracting %g-h windows on a %d-min grid", cfg.window_hours, grid_min)
    synth_windows = extract_windows(to_grid(synth, grid_min, cfg.max_interp_gap_min),
                                    "synthetic", grid_min, cfg)
    real_windows = extract_windows(to_grid(real, grid_min, cfg.max_interp_gap_min),
                                   real_label, grid_min, cfg)
    if synth_windows.empty or real_windows.empty:
        check = CheckResult("G3.1", title, Status.INCONCLUSIVE,
                            "No complete windows in one of the sources.", acceptance=acceptance)
        return GateResult("GATE 3", "Indistinguishability from real CGM", [check], notes), empty, empty
    features = [c for c in synth_windows.columns if c not in META_COLUMNS
                and not (cfg.harmonize_device and c in DEVICE_FEATURES)]
    windows = pd.concat([synth_windows.assign(label=1), real_windows.assign(label=0)],
                        ignore_index=True)

    try:
        LOG.info("Gate 3: main test, %d vs %d windows", len(synth_windows), len(real_windows))
        main = discriminate(windows, features, cfg, rng)
        patients = np.array(sorted(synth_windows["patient_id"].unique()))
        rng.shuffle(patients)
        half = set(patients[: patients.size // 2].tolist())
        LOG.info("Gate 3: null control (two random halves of the synthetic cohort)")
        null = discriminate(synth_windows.assign(label=synth_windows["patient_id"].isin(half).astype(int)),
                            features, cfg, rng)
        LOG.info("Gate 3: power control (+%g mg/dL white noise on one half)", cfg.power_noise_sd_mg_dl)
        perturbed = synth.copy()
        mask = perturbed["patient_id"].isin(half).to_numpy()
        perturbed.loc[mask, "glucose"] = (perturbed.loc[mask, "glucose"].to_numpy()
                                          + rng.normal(0.0, cfg.power_noise_sd_mg_dl, int(mask.sum())))
        if cfg.harmonize_device:
            perturbed = harmonize_device(perturbed)
        power_windows = extract_windows(to_grid(perturbed, grid_min, cfg.max_interp_gap_min),
                                        "synthetic", grid_min, cfg)
        power = discriminate(power_windows.assign(label=power_windows["patient_id"].isin(half).astype(int)),
                             features, cfg, rng)
    except InsufficientData as exc:
        check = CheckResult("G3.1", title, Status.INCONCLUSIVE, f"Cannot run the discriminator: {exc}.",
                            acceptance=acceptance)
        return GateResult("GATE 3", "Indistinguishability from real CGM", [check], notes), empty, empty

    lo, hi = main["ci"]
    status = interval_decision(lo, hi, (0.0, cfg.auroc_max))
    # Patient-grouped CV scatters the null AUROC around 0.5 (including anti-learning
    # below it), so only a clear departure beyond the tolerance marks a leak.
    null_band = (0.5 - cfg.null_tolerance, 0.5 + cfg.null_tolerance)
    null_valid = interval_decision(*null["ci"], null_band) is not Status.FAIL
    power_valid = power["ci"][0] >= cfg.power_min_auroc
    caveat = ""
    if not null_valid:
        status = Status.INCONCLUSIVE
        caveat = " Null control failed, so the pipeline may leak patient identity; decision withheld."
    elif status is Status.PASS and not power_valid:
        status = Status.INCONCLUSIVE
        caveat = " Power control failed, so a low AUROC is not evidence; decision withheld."
    if main["auroc"] < 0.40:
        notes.append("AUROC well below 0.5 means the folds disagree systematically; inspect the "
                     "per-fold AUROCs before trusting this result.")
    top = main["importance"].head(10)
    checks = [
        CheckResult(
            "G3.1", title, status,
            f"AUROC {main['auroc']:.3f} ({level} CI {lo:.3f}-{hi:.3f}) on {main['n_windows'][1]} "
            f"synthetic vs. {main['n_windows'][0]} {real_label} windows from "
            f"{main['n_patients'][1]} and {main['n_patients'][0]} patients. Top tell: "
            f"{top.index[0]}.{caveat}",
            estimate=main["auroc"], ci=(lo, hi), acceptance=acceptance, n=len(windows),
            details={"evidence": evidence, "grid_min": grid_min, "window_hours": cfg.window_hours,
                     "n_features": len(features),
                     "fold_aurocs": [round(a, 4) for a in main["fold_aurocs"]],
                     "top_tells_mean_abs_shap": top.round(4).to_dict()},
        ),
        CheckResult(
            "G3.2", "Null control: two random halves of the synthetic cohort", Status.INFO,
            f"AUROC {null['auroc']:.3f} ({level} CI {null['ci'][0]:.3f}-{null['ci'][1]:.3f}). "
            + (f"Valid: no departure from 0.5 beyond +/-{cfg.null_tolerance:g}." if null_valid else
               "INVALID: a leak-free pipeline cannot separate two halves of one cohort."),
            estimate=null["auroc"], ci=null["ci"],
            acceptance=f"CI not entirely outside {null_band[0]:g}-{null_band[1]:g}",
            n=int(sum(null["n_windows"])), details={"valid": null_valid},
        ),
        CheckResult(
            "G3.3", f"Power control: +{cfg.power_noise_sd_mg_dl:g} mg/dL sensor noise on one half",
            Status.INFO,
            f"AUROC {power['auroc']:.3f} ({level} CI {power['ci'][0]:.3f}-{power['ci'][1]:.3f}). "
            + ("Valid: the discriminator detects a known distortion." if power_valid else
               "INVALID: the discriminator misses a known distortion, so it lacks power."),
            estimate=power["auroc"], ci=power["ci"],
            acceptance=f"CI low >= {cfg.power_min_auroc:g}", n=int(sum(power["n_windows"])),
            details={"valid": power_valid},
        ),
    ]
    windows["oof_score"] = main["oof"]
    importance = main["importance"].rename("mean_abs_shap").rename_axis("feature").reset_index()
    return GateResult("GATE 3", "Indistinguishability from real CGM", checks, notes), windows, importance


# --------------------------------------------------------------------------- #
# Reporting and CLI
# --------------------------------------------------------------------------- #


def to_jsonable(obj: Any) -> Any:
    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return to_jsonable(obj.tolist())
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        value = float(obj)
        return value if math.isfinite(value) else None
    if isinstance(obj, (pd.Timestamp, np.datetime64, Path)):
        return str(obj)
    if obj is pd.NaT:
        return None
    return obj


def gate_to_dict(gate: GateResult) -> dict[str, Any]:
    return {
        "gate_id": gate.gate_id,
        "title": gate.title,
        "status": gate.status,
        "notes": gate.notes,
        "checks": [dataclasses.asdict(check) for check in gate.checks],
    }


def print_summary(gates: list[GateResult], overall: Status, out_dir: Path) -> None:
    width = 88
    wrap = textwrap.TextWrapper(width=width, initial_indent=" " * 16, subsequent_indent=" " * 16)
    print("=" * width)
    print(f"Blueprint Section 5 validation: {overall.value}")
    print("=" * width)
    for gate in gates:
        print(f"\n{gate.gate_id}  {gate.title}  [{gate.status.value}]")
        for check in gate.checks:
            print(f"  {check.check_id:<5} {check.status.value:<13}{check.title}")
            print(wrap.fill(check.message))
            if check.acceptance:
                print(wrap.fill(f"accept: {check.acceptance}"))
        for note in gate.notes:
            print(textwrap.fill(f"note: {note}", width=width, initial_indent="  ",
                                subsequent_indent="        "))
    print(f"\nReport: {out_dir / 'validation_report.json'}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="validation_gates.py",
        description="Blueprint Section 5 validation gates for a synthetic CGM cohort.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    io = parser.add_argument_group("inputs and outputs")
    io.add_argument("--telemetry", type=Path, default=Path("patient_cgm_telemetry.csv"),
                    help="long CGM CSV of the synthetic cohort")
    io.add_argument("--ehr", type=Path, default=Path("patients_ehr.csv"),
                    help="EHR CSV with one HbA1c per patient")
    io.add_argument("--meals", type=Path, help="CSV of meal start times (patient_id, timestamp)")
    io.add_argument("--meal-col", help="telemetry column flagging meal starts (auto-detected if omitted)")
    io.add_argument("--meal-time-col", default="timestamp", help="timestamp column in --meals")
    io.add_argument("--real", type=Path, help="long CSV of real CGM; omit to use a mock-real cohort")
    io.add_argument("--real-id-col", help="patient column in --real (default: --id-col)")
    io.add_argument("--real-time-col", help="timestamp column in --real (default: --time-col)")
    io.add_argument("--real-glucose-col", help="glucose column in --real (default: --glucose-col)")
    io.add_argument("--out-dir", type=Path, default=Path("validation_out"), help="output directory")

    schema = parser.add_argument_group("column names")
    schema.add_argument("--id-col", default=Config.id_col)
    schema.add_argument("--time-col", default=Config.time_col)
    schema.add_argument("--glucose-col", default=Config.glucose_col)
    schema.add_argument("--hba1c-col", default=Config.hba1c_col)
    schema.add_argument("--group-col", default=Config.group_col)

    run = parser.add_argument_group("run control")
    run.add_argument("--gates", type=int, nargs="+", choices=(1, 2, 3), default=[1, 2, 3])
    run.add_argument("--seed", type=int, default=Config.seed)
    run.add_argument("--ci-level", type=float, default=Config.ci_level)
    run.add_argument("--n-boot", type=int, default=Config.n_boot)
    run.add_argument("--n-jobs", type=int, default=None, help="XGBoost threads (default: all)")
    run.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    run.add_argument("-q", "--quiet", action="store_true", help="warnings and errors only")

    th = parser.add_argument_group("thresholds")
    th.add_argument("--min-days", type=float, default=Config.min_days)
    th.add_argument("--min-coverage", type=float, default=Config.min_coverage)
    th.add_argument("--min-patients", type=int, default=Config.min_patients)
    th.add_argument("--adag-groups", nargs="*", default=list(Config.adag_groups),
                    help="diagnosis groups for the ADAG checks (none = all)")
    th.add_argument("--cv-groups", nargs="*", default=list(Config.cv_groups),
                    help="diagnosis groups for the CV checks (none = all)")
    th.add_argument("--cv-median-band", type=float, nargs=2, metavar=("LO", "HI"),
                    default=list(Config.cv_median_band_pct))
    th.add_argument("--cv-patient-band", type=float, nargs=2, metavar=("LO", "HI"),
                    default=list(Config.cv_patient_band_pct))
    th.add_argument("--peak-band", type=float, nargs=2, metavar=("LO", "HI"),
                    default=list(Config.peak_band_min))
    th.add_argument("--auroc-max", type=float, default=Config.auroc_max)
    th.add_argument("--discriminator-groups", nargs="*", default=list(Config.discriminator_groups),
                    help="synthetic groups compared in Gate 3 (none = all)")
    th.add_argument("--harmonize-device", action="store_true",
                    help="round and clip both sources identically before Gate 3")
    return parser


def config_from_args(args: argparse.Namespace, parser: argparse.ArgumentParser) -> Config:
    for name in ("cv_median_band", "cv_patient_band", "peak_band"):
        lo, hi = getattr(args, name)
        if not lo < hi:
            parser.error(f"--{name.replace('_', '-')} needs LO < HI")
    if not 0.5 <= args.ci_level < 1.0:
        parser.error("--ci-level must be in [0.5, 1)")
    if args.n_boot < 200:
        parser.error("--n-boot must be at least 200")
    return dataclasses.replace(
        Config(),
        id_col=args.id_col, time_col=args.time_col, glucose_col=args.glucose_col,
        hba1c_col=args.hba1c_col, group_col=args.group_col,
        ci_level=args.ci_level, n_boot=args.n_boot, seed=args.seed,
        min_patients=args.min_patients, min_days=args.min_days, min_coverage=args.min_coverage,
        adag_groups=tuple(args.adag_groups), cv_groups=tuple(args.cv_groups),
        cv_median_band_pct=tuple(args.cv_median_band),
        cv_patient_band_pct=tuple(args.cv_patient_band),
        peak_band_min=tuple(args.peak_band), auroc_max=args.auroc_max,
        discriminator_groups=tuple(args.discriminator_groups),
        harmonize_device=args.harmonize_device, n_jobs=args.n_jobs,
    )


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S", stream=sys.stderr,
    )
    cfg = config_from_args(args, parser)
    gates_wanted = sorted(set(args.gates))
    started = time.perf_counter()
    rng_gate1, rng_gate2, rng_gate3 = (np.random.default_rng(s)
                                       for s in np.random.SeedSequence(cfg.seed).spawn(3))

    inputs: dict[str, Any] = {}
    try:
        meal_col = detect_meal_column(args.telemetry, args.meal_col) if 2 in gates_wanted else None
        cgm, qc = load_cgm(args.telemetry, cfg.id_col, cfg.time_col, cfg.glucose_col,
                           cfg.plausible_mg_dl, "telemetry", extra_cols=[meal_col] if meal_col else [])
        inputs["telemetry"] = {"path": args.telemetry, "sha256": file_sha256(args.telemetry), **qc}
        need_ehr = 1 in gates_wanted or (3 in gates_wanted and (args.real is None or cfg.discriminator_groups))
        ehr = load_ehr(args.ehr, cfg) if need_ehr else None
        if ehr is not None:
            inputs["ehr"] = {"path": args.ehr, "sha256": file_sha256(args.ehr), "patients": len(ehr)}
        meals = None
        if 2 in gates_wanted:
            if args.meals:
                meals = load_meals(args.meals, cfg, args.meal_time_col)
                inputs["meals"] = {"path": args.meals, "sha256": file_sha256(args.meals), "rows": len(meals)}
            elif meal_col:
                meals = meals_from_column(cgm, meal_col)
                inputs["meals"] = {"telemetry_column": meal_col, "rows": len(meals)}
                LOG.info("meals: %d meal flags from telemetry column %r", len(meals), meal_col)
        real = None
        if 3 in gates_wanted and args.real:
            real, real_qc = load_cgm(args.real, args.real_id_col or cfg.id_col,
                                     args.real_time_col or cfg.time_col,
                                     args.real_glucose_col or cfg.glucose_col,
                                     cfg.plausible_mg_dl, "real")
            inputs["real"] = {"path": args.real, "sha256": file_sha256(args.real), **real_qc}
    except InputError as exc:
        LOG.error("%s", exc)
        return EXIT_INPUT

    args.out_dir.mkdir(parents=True, exist_ok=True)
    summary = summarize_patients(cgm, cfg)
    grid_min = native_grid_minutes(summary)
    gates: list[GateResult] = []
    artifacts: list[str] = []

    if 1 in gates_wanted:
        LOG.info("Gate 1: EHR consistency")
        gate1, patients = run_gate1(summary, ehr, cfg, rng_gate1)
        gates.append(gate1)
        patients.to_csv(args.out_dir / "gate1_patients.csv", index=False)
        artifacts.append("gate1_patients.csv")

    if 2 in gates_wanted:
        grids = to_grid(cgm, grid_min, cfg.max_interp_gap_min)
        if meals is not None and not meals.empty:
            LOG.info("Gate 2: time-to-peak from %d logged meal records", len(meals))
            mode, responses = "logged_meal", meal_responses(grids, meals, cfg, grid_min)
        else:
            LOG.warning("Gate 2: no meal log found; inferring meals from CGM excursions")
            mode, responses = "cgm_detected", detected_excursions(grids, cfg, grid_min)
        gates.append(run_gate2(responses, mode, cfg, rng_gate2))
        responses.to_csv(args.out_dir / "gate2_meal_responses.csv", index=False)
        artifacts.append("gate2_meal_responses.csv")

    if 3 in gates_wanted:
        gate3, windows, importance = run_gate3(cgm, ehr, real, cfg, rng_gate3, grid_min)
        gates.append(gate3)
        if not windows.empty:
            windows.to_csv(args.out_dir / "gate3_windows.csv", index=False)
            importance.to_csv(args.out_dir / "gate3_feature_importance.csv", index=False)
            artifacts += ["gate3_windows.csv", "gate3_feature_importance.csv"]

    overall = combine_statuses(g.status for g in gates)
    report = {
        "tool": "validation_gates.py",
        "blueprint_section": "5. Validating the synthetic data",
        "generated_at": pd.Timestamp.now(tz="UTC").isoformat(),
        "runtime_s": round(time.perf_counter() - started, 2),
        "overall_status": overall,
        "environment": {"python": platform.python_version(), "numpy": np.__version__,
                        "pandas": pd.__version__, "scipy": scipy.__version__,
                        "scikit_learn": sklearn.__version__, "xgboost": xgb.__version__},
        "inputs": inputs,
        "config": dataclasses.asdict(cfg),
        "gates": [gate_to_dict(g) for g in gates],
        "artifacts": artifacts,
    }
    report_path = args.out_dir / "validation_report.json"
    report_path.write_text(json.dumps(to_jsonable(report), indent=2, allow_nan=False) + "\n")
    print_summary(gates, overall, args.out_dir)
    return {Status.PASS: EXIT_PASS, Status.FAIL: EXIT_FAIL}.get(overall, EXIT_INCONCLUSIVE)


if __name__ == "__main__":
    sys.exit(main())

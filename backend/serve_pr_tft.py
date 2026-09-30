#!/usr/bin/env python3
"""serve_pr_tft.py -- Blueprint Section 9: PR-TFT inference service (FastAPI).

Serves a model trained by train_pr_tft.py behind the v1 JSON contract in contracts/v1/.

Endpoints (Blueprint 9.1)
    POST /v1/forecasts                      ForecastRequest -> ForecastResponse
    GET  /v1/subjects/{subject_id}/stream   Server-sent events (StreamEvent), replaying the
                                            cohort's CGM as if it arrived live
    GET  /v1/subjects/{subject_id}/twin     TwinCard
    GET  /v1/health                         liveness plus model and contract versions
    GET  /v1/subjects                       demo helper: subject UUIDs and patient ids

Data source
    This proof of concept serves the synthetic cohort the model was trained on
    (patient_cgm_telemetry.csv + patients_ehr.csv). "as_of" picks the replay time; without
    it, a request forecasts from each subject's last reading. Meal logs are rebuilt exactly
    as in training (same seed), so the model sees the same kind of imperfect log.

Per request (Blueprint 10.2)
    data-quality gate -> twin rollouts -> PR-TFT -> conformal + isotonic calibration ->
    alert policy -> contract validation. If the network fails, the twin-only forecast is
    served and model.fallback_used says so. If data are insufficient, forecast and
    spike_risk are null with the reasons in data_quality.

Honest limits
    * Scenarios are handled by the linearized twin (meals, activity uptake, skipping a
      habitual meal) and then re-scored by the network. Medication scenarios return
      SCENARIO_UNSUPPORTED because the linearized twin has no drug terms.
    * TwinCard parameters are the generator's values; their 80 % intervals are degenerate
      until nightly MAP fitting (Blueprint 7.5) exists, and calibration_stage says so.
    * unannounced_meal.probability is a heuristic: a CGM rise over 45 min that logged meals
      do not explain.

Run
    python serve_pr_tft.py --run-dir runs/pr_tft_demo --port 8001
    # optional shared-secret auth (production: OAuth2 client credentials over mTLS)
    PR_TFT_SERVICE_TOKEN=... python serve_pr_tft.py --run-dir runs/pr_tft_demo
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import datetime as dt
import hashlib
import json
import logging
import math
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, Literal, Optional, Union

import numpy as np
import torch
from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

import train_pr_tft as T

LOG = logging.getLogger("serve_pr_tft")

SERVICE_VERSION = "0.1.0"
CONTRACT_VERSION = "1.0.0"
ALERT_POLICY_VERSION = "ap-1.0"
SIMULATOR_VERSION = "generate_health_data_v2"
SUBJECT_NAMESPACE = uuid.UUID("6f0c3a52-9d1e-4c57-8a2b-3e41d7b9c0aa")
INTENDED_USE = "research_only_not_for_clinical_decisions"

# Alert policy (Blueprint 8.5)
WATCH_P, WARNING_P, CLEAR_P = 0.35, 0.60, 0.25
SUPPRESS_MIN = 60
# Exercise uptake for activity scenarios: U = ALPHA_EX * dHR * G * V_G (generator constants).
ALPHA_EX = 6.7e-5
INTENSITY_DHR = {"light": 15.0, "moderate": 30.0, "vigorous": 50.0}
MEAL_SLOTS_H = {"breakfast": (5.0, 10.0), "lunch": (11.0, 14.5), "dinner": (17.0, 21.5)}


# --------------------------------------------------------------------------- #
# Contract models (Pydantic v2 mirror of contracts/v1/*.json)
# --------------------------------------------------------------------------- #

Glucose = Annotated[float, Field(ge=20, le=600)]
Prob = Annotated[float, Field(ge=0, le=1)]
Offset = Annotated[int, Field(ge=5, le=120, multiple_of=5)]
FutureOffset = Annotated[int, Field(ge=0, le=120)]
MedClass = Literal["metformin", "sglt2i", "glp1_ra", "dpp4i", "sulfonylurea", "tzd",
                   "basal_insulin", "prandial_insulin", "corticosteroid"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SimulatorInfo(Strict):
    version: str
    seed: int
    param_set_id: str


class Subject(Strict):
    subject_id: uuid.UUID
    synthetic: Literal[True]
    cohort: Optional[str] = None
    simulator: Optional[SimulatorInfo] = None


class ModelInfo(Strict):
    name: str
    version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    run_id: str
    trained_at: Optional[dt.datetime] = None
    simulator_version: Optional[str] = None
    calibration_id: Optional[str] = None
    alert_policy_version: str
    fallback_used: Optional[Literal["xgboost", "twin_only", "persistence"]] = None


Reason = Literal["cgm_gap", "stale_data", "sensor_warmup", "sensor_day1", "compression_low_suspected",
                 "ood_subject", "no_recent_meal_logs", "twin_not_calibrated"]


class DataQuality(Strict):
    status: Literal["ok", "degraded", "insufficient"]
    cgm_coverage_6h_pct: float = Field(ge=0, le=100)
    last_cgm_at: dt.datetime
    staleness_min: int = Field(ge=0)
    sensor_day: Optional[int] = Field(default=None, ge=0, le=15)
    in_warmup: Optional[bool] = None
    ood_score: Optional[float] = Field(default=None, ge=0)
    reasons: list[Reason] = []


class CurrentGlucose(Strict):
    value_mg_dl: Optional[Glucose]
    flag: Literal["in_range", "LOW", "HIGH"]
    measured_at: dt.datetime
    trend_mg_dl_per_min: Optional[float] = None
    trend_arrow: Literal["rising_fast", "rising", "rising_slow", "flat", "falling_slow", "falling",
                         "falling_fast", "unknown"]


class QuantilePoint(Strict):
    offset_min: Offset
    t: dt.datetime
    p05: Glucose
    p10: Glucose
    p25: Glucose
    p50: Glucose
    p75: Glucose
    p90: Glucose
    p95: Glucose
    twin_p50: Optional[Glucose] = None


class Forecast(Strict):
    units: Literal["mg/dL"]
    step_min: Literal[5]
    horizon_min: Literal[120]
    conformal_adjusted: Optional[bool] = None
    points: list[QuantilePoint] = Field(min_length=24, max_length=24)


class SpikeDefinition(Strict):
    threshold_mg_dl: float
    min_rise_mg_dl: float
    rise_window_min: int
    persistence_min: int


class CumulativePoint(Strict):
    offset_min: Offset
    p: Prob


class OnsetQuartiles(Strict):
    p25: int
    p50: int
    p75: int


class PeakQuantiles(Strict):
    p50: Glucose
    p90: Glucose


class SpikeRisk(Strict):
    probability_120m: Prob
    tier: Literal["low", "elevated", "high"]
    calibrated: bool
    spike_in_progress: bool
    definition: SpikeDefinition
    cumulative: list[CumulativePoint] = Field(min_length=24, max_length=24)
    onset_offset_min: Optional[OnsetQuartiles] = None
    peak_mg_dl: Optional[PeakQuantiles] = None
    time_to_peak_min: Optional[int] = None


class Alert(Strict):
    state: Literal["none", "watch", "warning"]
    alert_id: Optional[uuid.UUID] = None
    since: Optional[dt.datetime] = None
    suppressed_until: Optional[dt.datetime] = None
    message_key: Optional[str] = None


class Driver(Strict):
    feature_key: str
    label_key: str
    direction: Literal["raises", "lowers"]
    impact_mg_dl: float
    source: Optional[Literal["twin", "residual", "both"]] = None


class MealInput(Strict):
    kind: Literal["meal"]
    offset_min: FutureOffset
    carbs_g: float = Field(ge=0, le=250)
    fat_g: Optional[float] = Field(default=None, ge=0)
    protein_g: Optional[float] = Field(default=None, ge=0)
    fiber_g: Optional[float] = Field(default=None, ge=0)
    glycemic_index: Optional[Literal["low", "medium", "high"]] = None


class ActivityInput(Strict):
    kind: Literal["activity"]
    offset_min: FutureOffset
    duration_min: int = Field(ge=5, le=120)
    intensity: Literal["light", "moderate", "vigorous"]


class SkipMealInput(Strict):
    kind: Literal["skip_habitual_meal"]
    meal_slot: Literal["breakfast", "lunch", "dinner", "snack"]


class MedicationInput(Strict):
    kind: Literal["medication"]
    offset_min: FutureOffset
    med_class: MedClass
    taken: bool


ScenarioInput = Annotated[Union[MealInput, ActivityInput, SkipMealInput, MedicationInput],
                          Field(discriminator="kind")]


class ScenarioPoint(Strict):
    offset_min: Offset
    p10: Glucose
    p50: Glucose
    p90: Glucose


class ScenarioResult(Strict):
    scenario_id: str
    label: Optional[str] = Field(default=None, max_length=60)
    inputs: list[ScenarioInput] = Field(min_length=1)
    points: list[ScenarioPoint] = Field(min_length=24, max_length=24)
    probability_120m: Prob
    delta_probability: float = Field(ge=-1, le=1)
    delta_peak_mg_dl: float


class UnannouncedMeal(Strict):
    probability: Prob
    estimated_carbs_g: Optional[float] = None
    estimated_at: Optional[dt.datetime] = None


class TwinState(Strict):
    insulin_sensitivity_rel: Optional[float] = Field(default=None, ge=0)
    beta_cell_rel: Optional[float] = Field(default=None, ge=0)
    carbs_on_board_g: Optional[float] = Field(default=None, ge=0)
    insulin_on_board_u: Optional[float] = Field(default=None, ge=0)
    unannounced_meal: Optional[UnannouncedMeal] = None
    last_calibrated_at: Optional[dt.datetime] = None


class EhrContext(Strict):
    age_years: int = Field(ge=18, le=110)
    sex: Literal["female", "male", "other", "unknown"]
    bmi: float = Field(ge=12, le=80)
    hba1c_pct: float = Field(ge=4, le=18)
    hba1c_date: dt.date
    t2d_duration_years: Optional[float] = Field(default=None, ge=0)
    egfr: Optional[float] = Field(default=None, ge=0)
    med_classes: list[MedClass] = []


class Problem(BaseModel):
    type: str
    title: str
    code: str
    status: Optional[int] = None
    detail: Optional[str] = None


class ForecastResponse(Strict):
    schema_version: Literal["1.0.0"]
    request_id: uuid.UUID
    generated_at: dt.datetime
    as_of: dt.datetime
    subject: Subject
    model: ModelInfo
    data_quality: DataQuality
    current: CurrentGlucose
    forecast: Optional[Forecast]
    spike_risk: Optional[SpikeRisk]
    alert: Alert
    drivers: Optional[list[Driver]] = Field(default=None, max_length=8)
    scenarios: Optional[list[ScenarioResult]] = Field(default=None, max_length=4)
    twin_state: Optional[TwinState] = None
    ehr_context: Optional[EhrContext] = None
    intended_use: Literal["research_only_not_for_clinical_decisions"]
    warnings: Optional[list[Problem]] = None


IncludeKey = Literal["drivers", "scenarios", "twin_state", "ehr_context", "twin_overlay"]


class ScenarioRequest(Strict):
    scenario_id: str = Field(pattern=r"^[a-z0-9_-]{1,32}$")
    label: Optional[str] = Field(default=None, max_length=60)
    inputs: list[ScenarioInput] = Field(min_length=1, max_length=6)


class ForecastRequest(Strict):
    schema_version: Literal["1.0.0"]
    request_id: uuid.UUID
    subject_id: uuid.UUID
    as_of: Optional[dt.datetime] = None
    include: list[IncludeKey] = ["drivers", "twin_state"]
    scenarios: list[ScenarioRequest] = Field(default=[], max_length=4)
    alert_policy_version: Optional[str] = None


class TwinParameter(Strict):
    key: Literal["insulin_sensitivity_rel", "beta_cell_rel", "first_phase_rel", "egp_basal_mg_per_min",
                 "t_max_min", "tau_isf_min", "dawn_amplitude"]
    value: float
    unit: str
    ci80: tuple[float, float]
    prior_value: float


class FitQuality(Strict):
    rmse_60m_14d_mg_dl: Optional[float] = None
    coverage_80_pct_14d: Optional[float] = Field(default=None, ge=0, le=100)


class TwinCard(Strict):
    schema_version: Literal["1.0.0"]
    subject_id: uuid.UUID
    synthetic: Literal[True]
    calibrated_at: dt.datetime
    calibration_stage: Literal["ehr_prior", "nightly_map", "adapter_finetuned"]
    parameters: list[TwinParameter] = Field(min_length=1)
    fit_quality: Optional[FitQuality] = None


class StreamEvent(Strict):
    event: Literal["forecast.updated", "alert.raised", "alert.cleared", "data_quality.changed",
                   "twin.recalibrated"]
    event_id: str
    subject_id: uuid.UUID
    emitted_at: dt.datetime
    payload: dict[str, Any]


# --------------------------------------------------------------------------- #
# Errors (RFC 9457 problem details)
# --------------------------------------------------------------------------- #


class ServiceError(Exception):
    def __init__(self, status: int, code: str, title: str, detail: str = ""):
        super().__init__(detail or title)
        self.status, self.code, self.title, self.detail = status, code, title, detail


def problem_response(status: int, code: str, title: str, detail: str = "") -> JSONResponse:
    body = {"type": f"https://schemas.glucose-twin.dev/problems/{code.lower()}", "title": title,
            "status": status, "code": code}
    if detail:
        body["detail"] = detail
    return JSONResponse(body, status_code=status, media_type="application/problem+json")


# --------------------------------------------------------------------------- #
# Model context: artifacts, cohort, per-patient caches
# --------------------------------------------------------------------------- #


def utc(ts) -> dt.datetime:
    """Cohort timestamps are naive UTC."""
    return ts.to_pydatetime().replace(tzinfo=dt.timezone.utc)


@dataclasses.dataclass
class PatientCache:
    ps: T.PatientSeries
    subject_id: uuid.UUID
    past: np.ndarray  # (n, P) normalised past features
    cob: np.ndarray  # carbs on board, g
    meal_effect: np.ndarray  # twin meal effect, mg/dL
    static: np.ndarray  # (S,) normalised


class ServiceContext:
    """Everything loaded once at startup: the model, calibrators and the cohort."""

    def __init__(self, run_dir: Path, data_dir: Path | None = None, simulator_seed: int = 101):
        t0 = time.perf_counter()
        self.run_dir = run_dir
        self.cfg = T.TrainConfig(**{k: tuple(v) if isinstance(v, list) else v
                                    for k, v in json.loads((run_dir / "config.json").read_text()).items()})
        if data_dir is not None:
            self.cfg = dataclasses.replace(self.cfg, data_dir=str(data_dir))
        self.norm = T.Normalizer(**json.loads((run_dir / "normalization.json").read_text()))
        calib_text = (run_dir / "calibration.json").read_text()
        self.calib = T.Calibrators(**json.loads(calib_text))
        self.calibration_id = "cal-" + hashlib.sha256(calib_text.encode()).hexdigest()[:10]
        report = json.loads((run_dir / "metrics_test.json").read_text())
        tw = report["twin_prior"]
        if tw.get("kind") == "ukf":
            from ukf_twin import UKFTwinPrior
            self.twin = UKFTwinPrior()
        else:
            self.twin = T.TwinPrior(tw["k_scale"], tw["gain"], tw.get("eq_quantile", 0.5))
        ckpts = sorted((run_dir / "checkpoints").glob("stage2_observed-*.ckpt"), key=lambda p: p.stat().st_mtime)
        if not ckpts:
            raise FileNotFoundError(f"no stage2 checkpoint in {run_dir / 'checkpoints'}")
        self.ckpt = ckpts[-1]
        self.module = T.PRTFTModule.load_from_checkpoint(str(self.ckpt), map_location="cpu").eval()
        self.trained_at = dt.datetime.fromtimestamp(self.ckpt.stat().st_mtime, tz=dt.timezone.utc)
        self.run_id = f"{run_dir.name}/{self.ckpt.stem}"
        self.simulator_seed = simulator_seed

        # Same seed and order as training, so the corrupted meal log is identical.
        series = T.load_data(self.cfg, np.random.default_rng(self.cfg.seed))
        split = json.loads((run_dir / "split.json").read_text())
        self.split_of = {pid: name for name, ids in split.items() for pid in ids}
        self.pop = T.population_habit([series[p] for p in split["train"] if p in series])
        self.patients: dict[uuid.UUID, PatientCache] = {}
        self.by_pid: dict[str, uuid.UUID] = {}
        for pid, ps in series.items():
            sid = uuid.uuid5(SUBJECT_NAMESPACE, pid)
            effect = self.twin.meal_effect_series(ps)
            static = np.array([(ps.static_raw[c] - self.norm.static_mean[c]) / self.norm.static_std[c]
                               for c in T.STATIC_FEATURES], dtype=np.float32)
            self.patients[sid] = PatientCache(ps, sid, T.past_matrix(ps, self.norm, effect, self.twin.state_features(ps)),
                                              T._carbs_on_board(ps), effect, static)
            self.by_pid[pid] = sid
        self.ood_ref = float(np.sqrt(np.mean(np.stack([p.static[:len(T.STATIC_CONTINUOUS)] ** 2
                                                        for p in self.patients.values()]))))
        LOG.info("loaded %s and %d subjects in %.1f s", self.ckpt.name, len(self.patients), time.perf_counter() - t0)

    # ---- lookups ---------------------------------------------------------- #

    def patient(self, subject_id: uuid.UUID) -> PatientCache:
        pc = self.patients.get(subject_id)
        if pc is None:
            raise ServiceError(404, "SUBJECT_NOT_FOUND", "Subject not found", f"No subject {subject_id}.")
        return pc

    def anchor_index(self, pc: PatientCache, as_of: dt.datetime | None) -> int:
        ps = pc.ps
        last = ps.n - 1
        if as_of is None:
            return last
        stamp = as_of.astimezone(dt.timezone.utc).replace(tzinfo=None)
        first_ok = ps.stamps[T.PAST_STEPS - 1]
        if stamp < first_ok or stamp > ps.stamps[last] + dt.timedelta(minutes=T.STEP_MIN):
            raise ServiceError(422, "AS_OF_OUT_OF_RANGE", "as_of outside the replay window",
                               f"as_of must lie between {first_ok.isoformat()}Z and {ps.stamps[last].isoformat()}Z.")
        return int(min(last, ps.stamps.searchsorted(stamp, side="right") - 1))

    # ---- inference -------------------------------------------------------- #

    def rollouts(self, pc: PatientCache, t: int, extra_carbs: np.ndarray | None = None,
                 extra_flux: np.ndarray | None = None, habit_scale: np.ndarray | None = None):
        """Twin rollouts and future-input block for one anchor (optionally a scenario)."""
        ps, idx = pc.ps, np.array([t])
        prob, carbs = T.habit_features(ps, idx, self.pop)
        if habit_scale is not None:
            prob, carbs = prob * habit_scale, carbs * habit_scale
        if extra_carbs is not None:
            carbs = carbs + extra_carbs
            prob = np.maximum(prob, (extra_carbs > 0).astype(float))
        nomeal = self.twin.forecast(ps, idx, extra_flux=extra_flux)
        habit = self.twin.forecast(ps, idx, carbs, extra_flux=extra_flux)
        base = habit if self.cfg.twin_base == "habit" else nomeal
        stamp = ps.stamps[t]
        future = [stamp + dt.timedelta(minutes=T.STEP_MIN * k) for k in range(1, T.HORIZON + 1)]
        hours = np.array([f.hour + f.minute / 60 for f in future])
        time_feats = np.stack([np.sin(2 * np.pi * hours / 24), np.cos(2 * np.pi * hours / 24),
                               np.array([f.weekday() >= 5 for f in future], dtype=float),
                               np.arange(1, T.HORIZON + 1) / T.HORIZON], axis=1)
        fut = np.concatenate([np.stack([self.norm.glu(nomeal[0]), self.norm.glu(habit[0]), prob[0],
                                        carbs[0] / self.norm.carbs_std], axis=1), time_feats], axis=1)
        return base[0], nomeal[0], habit[0], fut.astype(np.float32), future

    def run_model(self, pc: PatientCache, t: int, twin_base: np.ndarray, fut: np.ndarray) -> dict[str, np.ndarray]:
        ps = pc.ps
        window = ps.cgm[max(0, t - T.RISE_STEPS + 1):t + 1]
        g0 = float(ps.cgm_ff[t])
        g_min60 = float(np.nanmin(window)) if np.isfinite(window).any() else g0
        batch = {
            "past": torch.from_numpy(pc.past[t + 1 - T.PAST_STEPS:t + 1]).unsqueeze(0),
            "future": torch.from_numpy(fut).unsqueeze(0),
            "static": torch.from_numpy(pc.static).unsqueeze(0),
            "twin": torch.tensor(twin_base, dtype=torch.float32).unsqueeze(0),
            "g0": torch.tensor([g0]), "g_min60": torch.tensor([g_min60]),
        }
        with torch.inference_mode():
            out = self.module.model(batch)
        q = out["quantiles"][0].numpy()
        return {"q": self.calib.apply_interval(q[None])[0], "q_raw": q,
                "p_bin": torch.sigmoid(out["hazard_logits"][0]).numpy(), "peak": out["peak"][0].numpy()}

    def twin_only(self, twin_base: np.ndarray) -> dict[str, np.ndarray]:
        """Fallback: twin p50 with the calibrated interval widths around it."""
        w = np.asarray(self.calib.conformal_mg_dl)
        q = np.stack([twin_base - 1.6 * w, twin_base - w, twin_base - 0.5 * w, twin_base,
                      twin_base + 0.5 * w, twin_base + w, twin_base + 1.6 * w], axis=-1)
        return {"q": q, "q_raw": q, "p_bin": np.zeros(T.HORIZON), "peak": np.array([twin_base.max()] * 2)}


# --------------------------------------------------------------------------- #
# Response assembly
# --------------------------------------------------------------------------- #


def clamp_g(x: float) -> float:
    return round(float(min(max(x, 20.0), 600.0)), 1)


def trend_arrow(slope: float | None) -> str:
    if slope is None or not math.isfinite(slope):
        return "unknown"
    for limit, name in ((3, "rising_fast"), (2, "rising"), (1, "rising_slow")):
        if slope >= limit:
            return name
    for limit, name in ((-1, "flat"), (-2, "falling_slow"), (-3, "falling")):
        if slope > limit:
            return name
    return "falling_fast"


def tier_of(p: float) -> str:
    return "high" if p >= WARNING_P else "elevated" if p >= WATCH_P else "low"


def calibrated_hazard(ctx: ServiceContext, p_bin: np.ndarray) -> tuple[np.ndarray, float]:
    """Cumulative onset curve, rescaled so its 120-min value is isotonic-calibrated.
    Scaling keeps the curve monotone and preserves the model's timing."""
    cum = 1 - np.cumprod(1 - p_bin)
    raw = float(cum[-1])
    cal = float(ctx.calib.apply_hazard(np.array([raw]))[0])
    scale = cal / raw if raw > 1e-9 else 0.0
    return np.clip(cum * scale, 0.0, 1.0), cal


def onset_quartiles(cum: np.ndarray) -> dict[str, int] | None:
    if cum[-1] < 0.05:
        return None
    cond = cum / cum[-1]
    return {f"p{int(q * 100)}": int((np.searchsorted(cond, q) + 1) * T.STEP_MIN) for q in (0.25, 0.5, 0.75)}


def alert_for(p: float, p50: np.ndarray, subject: uuid.UUID, stamp: dt.datetime) -> dict[str, Any]:
    """Stateless policy for one-off requests (the stream adds hysteresis and suppression)."""
    if p >= WARNING_P and p50.max() >= T.SPIKE_LEVEL:
        state, key = "warning", "alert.spike.warning"
    elif p >= WATCH_P:
        state, key = "watch", "alert.spike.watch"
    else:
        return {"state": "none", "alert_id": None, "since": None, "suppressed_until": None, "message_key": None}
    return {"state": state, "alert_id": str(uuid.uuid5(subject, f"{state}-{stamp.isoformat()}")),
            "since": stamp.isoformat(), "suppressed_until": None, "message_key": key}


def data_quality(ctx: ServiceContext, pc: PatientCache, t: int) -> dict[str, Any]:
    ps = pc.ps
    recent = ps.cgm[max(0, t - 71):t + 1]
    coverage = float(np.isfinite(recent).mean() * 100)
    past_cov = float(np.isfinite(ps.cgm[max(0, t - T.PAST_STEPS + 1):t + 1]).mean())
    valid = np.flatnonzero(np.isfinite(ps.cgm[:t + 1]))
    last_idx = int(valid[-1]) if valid.size else t
    staleness = (t - last_idx) * T.STEP_MIN
    ood = float(np.sqrt(np.mean(pc.static[:len(T.STATIC_CONTINUOUS)] ** 2)))
    reasons = []
    if coverage < 80:
        reasons.append("cgm_gap")
    if staleness > 15:
        reasons.append("stale_data")
    if ood > 2.5 * ctx.ood_ref:
        reasons.append("ood_subject")
    logged_24h = ((ps.meal_min <= t * T.STEP_MIN) & (ps.meal_min > (t - 288) * T.STEP_MIN)).any()
    if not logged_24h:
        reasons.append("no_recent_meal_logs")
    if t < T.BINS_PER_DAY // 4:
        reasons.append("twin_not_calibrated")
    insufficient = (not np.isfinite(ps.cgm_ff[t])) or past_cov < ctx.cfg.min_past_coverage or t < T.PAST_STEPS - 1
    status = "insufficient" if insufficient else ("degraded" if {"cgm_gap", "ood_subject"} & set(reasons) else "ok")
    return {"status": status, "cgm_coverage_6h_pct": round(coverage, 1),
            "last_cgm_at": utc(ps.stamps[last_idx]).isoformat(), "staleness_min": int(staleness),
            "ood_score": round(ood, 3), "reasons": reasons}


def build_forecast(ctx: ServiceContext, req: ForecastRequest, t_override: int | None = None) -> dict[str, Any]:
    """The whole per-request pipeline; returns a contract-valid ForecastResponse dict."""
    pc = ctx.patient(req.subject_id)
    ps = pc.ps
    t = ctx.anchor_index(pc, req.as_of) if t_override is None else t_override
    stamp = utc(ps.stamps[t])
    include = set(req.include)
    warnings: list[dict[str, Any]] = []
    if req.alert_policy_version and req.alert_policy_version != ALERT_POLICY_VERSION:
        warnings.append({"type": "about:blank", "title": "Alert policy version not served",
                         "code": "ALERT_POLICY_MISMATCH",
                         "detail": f"Requested {req.alert_policy_version}; served {ALERT_POLICY_VERSION}."})

    dq = data_quality(ctx, pc, t)
    g_now = ps.cgm[t]
    prev = ps.cgm[t - 3] if t >= 3 else np.nan
    slope = float((g_now - prev) / 15.0) if np.isfinite(g_now) and np.isfinite(prev) else None
    current = {
        "value_mg_dl": clamp_g(g_now) if np.isfinite(g_now) else None,
        "flag": "LOW" if np.isfinite(g_now) and g_now <= 40 else "HIGH" if np.isfinite(g_now) and g_now >= 400 else "in_range",
        "measured_at": stamp.isoformat(), "trend_mg_dl_per_min": round(slope, 2) if slope is not None else None,
        "trend_arrow": trend_arrow(slope),
    }
    resp: dict[str, Any] = {
        "schema_version": CONTRACT_VERSION, "request_id": str(req.request_id),
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(), "as_of": stamp.isoformat(),
        "subject": {"subject_id": str(pc.subject_id), "synthetic": True,
                    "cohort": f"synthetic-v2/{ctx.split_of.get(ps.pid, 'unsplit')}",
                    "simulator": {"version": SIMULATOR_VERSION, "seed": ctx.simulator_seed, "param_set_id": ps.pid}},
        "model": {"name": "pr-tft", "version": SERVICE_VERSION, "run_id": ctx.run_id,
                  "trained_at": ctx.trained_at.isoformat(), "simulator_version": SIMULATOR_VERSION,
                  "calibration_id": ctx.calibration_id, "alert_policy_version": ALERT_POLICY_VERSION,
                  "fallback_used": None},
        "data_quality": dq, "current": current, "intended_use": INTENDED_USE,
    }
    if "ehr_context" in include:
        resp["ehr_context"] = ehr_context(ps)

    if dq["status"] == "insufficient":
        resp.update(forecast=None, spike_risk=None,
                    alert={"state": "none", "alert_id": None, "since": None, "suppressed_until": None,
                           "message_key": None})
        if "twin_state" in include:
            resp["twin_state"] = twin_state(ctx, pc, t)
        if warnings:
            resp["warnings"] = warnings
        return resp

    base, nomeal, habit, fut, future_stamps = ctx.rollouts(pc, t)
    try:
        out = ctx.run_model(pc, t, base, fut)
    except Exception:  # noqa: BLE001 -- the fallback chain must catch anything the network raises
        LOG.exception("PR-TFT inference failed; serving twin-only fallback")
        out = ctx.twin_only(base)
        resp["model"]["fallback_used"] = "twin_only"
    q = out["q"]
    cum, p120 = calibrated_hazard(ctx, out["p_bin"])
    fallback = resp["model"]["fallback_used"] is not None
    points = []
    for k in range(T.HORIZON):
        row = {"offset_min": (k + 1) * T.STEP_MIN, "t": utc(future_stamps[k]).isoformat()}
        row.update({name: clamp_g(q[k, i]) for i, name in enumerate(("p05", "p10", "p25", "p50", "p75", "p90", "p95"))})
        if "twin_overlay" in include:
            row["twin_p50"] = clamp_g(base[k])
        points.append(row)
    p50 = q[:, T.MEDIAN_IDX]
    peak_idx = int(np.argmax(p50))
    in_progress = not bool(ps.armed[t])
    resp["forecast"] = {"units": "mg/dL", "step_min": 5, "horizon_min": 120, "conformal_adjusted": not fallback,
                        "points": points}
    resp["spike_risk"] = {
        "probability_120m": round(p120, 3), "tier": tier_of(p120), "calibrated": not fallback,
        "spike_in_progress": in_progress,
        "definition": {"threshold_mg_dl": T.SPIKE_LEVEL, "min_rise_mg_dl": T.SPIKE_RISE,
                       "rise_window_min": T.RISE_STEPS * T.STEP_MIN, "persistence_min": T.PERSIST_STEPS * T.STEP_MIN},
        "cumulative": [{"offset_min": (k + 1) * T.STEP_MIN, "p": round(float(cum[k]), 3)} for k in range(T.HORIZON)],
        "onset_offset_min": onset_quartiles(cum),
        "peak_mg_dl": ({"p50": clamp_g(out["peak"][0]), "p90": clamp_g(out["peak"][1])} if p120 >= 0.05 else None),
        "time_to_peak_min": (peak_idx + 1) * T.STEP_MIN if p50.max() >= T.SPIKE_LEVEL else None,
    }
    resp["alert"] = alert_for(p120, p50, pc.subject_id, stamp)
    if "drivers" in include:
        resp["drivers"] = drivers(ctx, pc, t, base, nomeal, habit, p50, peak_idx)
    if "twin_state" in include:
        resp["twin_state"] = twin_state(ctx, pc, t)
    if req.scenarios:
        results, scenario_warnings = scenarios(ctx, pc, t, req.scenarios, p50, p120)
        resp["scenarios"] = results
        warnings.extend(scenario_warnings)
    if warnings:
        resp["warnings"] = warnings
    return resp


def drivers(ctx: ServiceContext, pc: PatientCache, t: int, base: np.ndarray, nomeal: np.ndarray,
            habit: np.ndarray, p50: np.ndarray, peak_idx: int) -> list[dict[str, Any]]:
    """Additive decomposition of the p50 forecast at its peak into physics terms and the
    learned correction. Each impact is in mg/dL at the forecast peak."""
    ps = pc.ps
    no_meals_at_all = ctx.twin.forecast_without_gut(ps, np.array([t]))[0]
    terms = [
        ("logged_meals_absorbing", "driver.recent_meal", "twin", nomeal[peak_idx] - no_meals_at_all[peak_idx]),
        ("expected_habitual_meal", "driver.expected_meal", "twin",
         (habit[peak_idx] - nomeal[peak_idx]) if ctx.cfg.twin_base == "habit" else 0.0),
        ("return_to_personal_baseline", "driver.return_to_baseline", "twin",
         no_meals_at_all[peak_idx] - float(ps.cgm_ff[t])),
        ("learned_correction", "driver.learned_correction", "residual", p50[peak_idx] - base[peak_idx]),
    ]
    out = [{"feature_key": key, "label_key": label, "direction": "raises" if v >= 0 else "lowers",
            "impact_mg_dl": round(float(v), 1), "source": src}
           for key, label, src, v in terms if abs(v) >= 0.5]
    return sorted(out, key=lambda d: -abs(d["impact_mg_dl"]))


def twin_state(ctx: ServiceContext, pc: PatientCache, t: int) -> dict[str, Any]:
    ps = pc.ps
    lookback = 9  # 45 min
    state: dict[str, Any] = {
        "insulin_sensitivity_rel": round(ps.static_raw["insulin_sensitivity_rel"], 3),
        "carbs_on_board_g": round(float(pc.cob[t]), 1),
        "insulin_on_board_u": None,
        "last_calibrated_at": utc(ps.stamps[0]).isoformat(),
    }
    if t >= lookback and np.isfinite(ps.cgm_ff[t]) and np.isfinite(ps.cgm_ff[t - lookback]):
        unexplained = (ps.cgm_ff[t] - ps.cgm_ff[t - lookback]) - (pc.meal_effect[t] - pc.meal_effect[t - lookback])
        prob = 1 / (1 + math.exp(-(unexplained - 25.0) / 8.0))
        state["unannounced_meal"] = {"probability": round(prob, 3), "estimated_carbs_g": None,
                                     "estimated_at": utc(ps.stamps[t - lookback]).isoformat() if prob >= 0.5 else None}
    return state


def ehr_context(ps: T.PatientSeries) -> dict[str, Any]:
    s = ps.static_raw
    meds = [m for m in T.MED_CLASSES if s.get(f"med_{m}", 0) > 0]
    return {"age_years": int(min(max(s["age"], 18), 110)), "sex": "male" if s["sex_male"] else "female",
            "bmi": round(s["bmi"], 1), "hba1c_pct": round(min(max(s["hba1c"], 4.0), 18.0), 1),
            "hba1c_date": ps.stamps[0].date().isoformat(),  # synthetic: dated to cohort start
            "t2d_duration_years": round(s["diabetes_duration_years"], 1), "egfr": round(s["egfr"], 0),
            "med_classes": meds}


def scenarios(ctx: ServiceContext, pc: PatientCache, t: int, reqs: list[ScenarioRequest],
              base_p50: np.ndarray, base_p120: float) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    ps = pc.ps
    results, notes = [], []
    g_now = float(ps.cgm_ff[t])
    for sc in reqs:
        extra_carbs = np.zeros((1, T.HORIZON))
        extra_flux = np.zeros((1, T.HORIZON * T.STEP_MIN))
        habit_scale = np.ones((1, T.HORIZON))
        for item in sc.inputs:
            if isinstance(item, MedicationInput):
                raise ServiceError(422, "SCENARIO_UNSUPPORTED", "Scenario input not supported",
                                   f"Scenario {sc.scenario_id}: medication changes need the full twin; "
                                   "the linearized twin served here has no drug terms.")
            if isinstance(item, MealInput):
                extra_carbs[0, min(T.HORIZON - 1, item.offset_min // T.STEP_MIN)] += item.carbs_g
            elif isinstance(item, ActivityInput):
                start, stop = item.offset_min, min(T.HORIZON * T.STEP_MIN, item.offset_min + item.duration_min)
                extra_flux[0, start:stop] -= ALPHA_EX * INTENSITY_DHR[item.intensity] * g_now * ps.vg
            elif isinstance(item, SkipMealInput):
                hours = np.array([(ps.stamps[t] + dt.timedelta(minutes=T.STEP_MIN * (k + 1))).hour
                                  + (ps.stamps[t] + dt.timedelta(minutes=T.STEP_MIN * (k + 1))).minute / 60
                                  for k in range(T.HORIZON)])
                lo, hi = MEAL_SLOTS_H.get(item.meal_slot, (0.0, 24.0))
                in_slot = (hours >= lo) & (hours < hi)
                if item.meal_slot == "snack":
                    in_slot = ~np.any([(hours >= a) & (hours < b) for a, b in MEAL_SLOTS_H.values()], axis=0)
                habit_scale[0, in_slot] = 0.0
        base, _, _, fut, _ = ctx.rollouts(pc, t, extra_carbs, extra_flux, habit_scale)
        try:
            out = ctx.run_model(pc, t, base, fut)
        except Exception:  # noqa: BLE001
            out = ctx.twin_only(base)
        _, p120 = calibrated_hazard(ctx, out["p_bin"])
        q = out["q"]
        results.append({
            "scenario_id": sc.scenario_id, **({"label": sc.label} if sc.label else {}),
            "inputs": [i.model_dump(exclude_none=True) for i in sc.inputs],
            "points": [{"offset_min": (k + 1) * T.STEP_MIN, "p10": clamp_g(q[k, T.P10_IDX]),
                        "p50": clamp_g(q[k, T.MEDIAN_IDX]), "p90": clamp_g(q[k, T.P90_IDX])} for k in range(T.HORIZON)],
            "probability_120m": round(p120, 3),
            "delta_probability": round(max(-1.0, min(1.0, p120 - base_p120)), 3),
            "delta_peak_mg_dl": round(float(q[:, T.MEDIAN_IDX].max() - base_p50.max()), 1),
        })
        if any(isinstance(i, ActivityInput) for i in sc.inputs):
            notes.append({"type": "about:blank", "title": "Activity modelled as immediate uptake",
                          "code": "SCENARIO_APPROXIMATION",
                          "detail": f"Scenario {sc.scenario_id}: exercise lowers glucose through insulin-independent "
                                    "uptake only; the delayed sensitivity boost is not modelled."})
    return results, notes


def twin_card(ctx: ServiceContext, pc: PatientCache) -> dict[str, Any]:
    ps = pc.ps
    t = T.eligible_anchors(ps, ctx.cfg)
    fit = {}
    if t.size:
        pred = ctx.twin.forecast(ps, t)
        y = ps.cgm[t[:, None] + np.arange(1, T.HORIZON + 1)[None, :]]
        k = 60 // T.STEP_MIN - 1
        ok = np.isfinite(y[:, k])
        fit["rmse_60m_14d_mg_dl"] = round(float(np.sqrt(np.mean((pred[ok, k] - y[ok, k]) ** 2))), 1)
    params = [
        ("insulin_sensitivity_rel", ps.static_raw["insulin_sensitivity_rel"], "relative to healthy"),
        ("t_max_min", ps.static_raw["tmax0_min"], "min"),
    ]
    return {"schema_version": CONTRACT_VERSION, "subject_id": str(pc.subject_id), "synthetic": True,
            "calibrated_at": utc(ps.stamps[0]).isoformat(), "calibration_stage": "ehr_prior",
            "parameters": [{"key": k, "value": round(v, 3), "unit": u, "ci80": [round(v, 3), round(v, 3)],
                            "prior_value": round(v, 3)} for k, v, u in params],
            "fit_quality": fit}


# --------------------------------------------------------------------------- #
# Streaming (SSE) with the stateful alert policy
# --------------------------------------------------------------------------- #


@dataclasses.dataclass
class AlertMachine:
    """Blueprint 8.5: watch >= 0.35, warning >= 0.60 with p50 >= 180, clear below 0.25,
    at most one warning per 60 min."""

    state: str = "none"
    since: dt.datetime | None = None
    alert_id: str | None = None
    suppressed_until: dt.datetime | None = None

    def step(self, p: float, p50_max: float, subject: uuid.UUID, now: dt.datetime) -> tuple[dict[str, Any], str | None]:
        previous = self.state
        wants_warning = p >= WARNING_P and p50_max >= T.SPIKE_LEVEL
        if wants_warning and (self.suppressed_until is None or now >= self.suppressed_until):
            target = "warning"
        elif p >= WATCH_P or (previous != "none" and p >= CLEAR_P):
            target = "watch" if previous != "warning" or not wants_warning else "warning"
        else:
            target = "none"
        if target != previous:
            self.state = target
            if target == "none":
                self.since = self.alert_id = None
            else:
                self.since = now
                self.alert_id = str(uuid.uuid5(subject, f"{target}-{now.isoformat()}"))
            if target == "warning":
                self.suppressed_until = now + dt.timedelta(minutes=SUPPRESS_MIN)
        event = None
        if target != previous:
            event = "alert.cleared" if target == "none" else "alert.raised"
        alert = {"state": self.state, "alert_id": self.alert_id,
                 "since": self.since.isoformat() if self.since else None,
                 "suppressed_until": self.suppressed_until.isoformat() if self.suppressed_until and self.state != "none" else None,
                 "message_key": f"alert.spike.{self.state}" if self.state != "none" else None}
        return alert, event


def sse(event: dict[str, Any]) -> str:
    StreamEvent.model_validate(event)
    return f"id: {event['event_id']}\nevent: {event['event']}\ndata: {json.dumps(event)}\n\n"


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #


def create_app(run_dir: Path, data_dir: Path | None = None, simulator_seed: int = 101) -> FastAPI:
    state: dict[str, ServiceContext] = {}

    @asynccontextmanager
    async def lifespan(app_: FastAPI):
        state["ctx"] = await run_in_threadpool(ServiceContext, run_dir, data_dir, simulator_seed)
        app_.state.ctx = state["ctx"]  # exposed for tests and admin tooling
        yield

    app = FastAPI(title="PR-TFT inference service", version=SERVICE_VERSION, lifespan=lifespan,
                  description="Blueprint Section 9 contract v1. Research use only.")

    def ctx() -> ServiceContext:
        return state["ctx"]

    def auth(authorization: Optional[str] = Header(default=None)) -> None:
        token = os.environ.get("PR_TFT_SERVICE_TOKEN")
        if token and authorization != f"Bearer {token}":
            raise ServiceError(401, "UNAUTHORIZED", "Missing or invalid bearer token")

    @app.exception_handler(ServiceError)
    async def _service_error(_: Request, exc: ServiceError):
        return problem_response(exc.status, exc.code, exc.title, exc.detail)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", []))
        return problem_response(422, "REQUEST_INVALID", "Request does not match ForecastRequest v1",
                                f"{where}: {first.get('msg', 'invalid')}")

    @app.get("/v1/health")
    def health(c: ServiceContext = Depends(ctx)):
        return {"status": "ok", "model_version": f"{SERVICE_VERSION} ({c.run_id})",
                "simulator_version": SIMULATOR_VERSION, "contract_version": CONTRACT_VERSION,
                "subjects": len(c.patients)}

    @app.get("/v1/subjects", dependencies=[Depends(auth)])
    def subjects(c: ServiceContext = Depends(ctx)):
        return [{"subject_id": str(sid), "patient_id": pc.ps.pid, "group": pc.ps.group,
                 "split": c.split_of.get(pc.ps.pid), "first_as_of": utc(pc.ps.stamps[T.PAST_STEPS - 1]).isoformat(),
                 "last_as_of": utc(pc.ps.stamps[-1]).isoformat()} for sid, pc in c.patients.items()]

    @app.post("/v1/forecasts", dependencies=[Depends(auth)])
    async def forecasts(req: ForecastRequest, c: ServiceContext = Depends(ctx)):
        started = time.perf_counter()
        body = await run_in_threadpool(build_forecast, c, req)
        validated = ForecastResponse.model_validate(body)
        LOG.info("forecast %s in %.0f ms", req.subject_id, 1000 * (time.perf_counter() - started))
        return JSONResponse(validated.model_dump(mode="json", exclude_unset=True))

    @app.get("/v1/subjects/{subject_id}/twin", dependencies=[Depends(auth)])
    async def twin(subject_id: uuid.UUID, c: ServiceContext = Depends(ctx)):
        card = await run_in_threadpool(twin_card, c, c.patient(subject_id))
        return JSONResponse(TwinCard.model_validate(card).model_dump(mode="json", exclude_unset=True))

    @app.get("/v1/subjects/{subject_id}/stream", dependencies=[Depends(auth)])
    async def stream(subject_id: uuid.UUID, as_of: Optional[dt.datetime] = None, speed: float = 300.0,
                     max_events: int = 0, last_event_id: Optional[str] = Header(default=None),
                     c: ServiceContext = Depends(ctx)):
        """Replay: one forecast per 5-min reading from as_of, paced at `speed` x real time
        (300 -> one reading per second). Resumes after Last-Event-ID when given."""
        pc = c.patient(subject_id)
        t = c.anchor_index(pc, as_of) if as_of else T.PAST_STEPS - 1
        if last_event_id:
            try:
                t = int(last_event_id.split("-")[0]) + 1
            except ValueError as exc:
                raise ServiceError(422, "REQUEST_INVALID", "Bad Last-Event-ID", last_event_id) from exc
        pause = max(0.0, T.STEP_MIN * 60 / speed) if speed > 0 else 0.0

        async def events():
            machine, sent, quality = AlertMachine(), 0, None
            for idx in range(t, pc.ps.n):
                req = ForecastRequest(schema_version="1.0.0", request_id=uuid.uuid4(), subject_id=subject_id)
                body = await run_in_threadpool(build_forecast, c, req, idx)
                stamp = dt.datetime.fromisoformat(body["as_of"])
                if body["spike_risk"] is not None:
                    p50_max = max(pt["p50"] for pt in body["forecast"]["points"])
                    body["alert"], alert_event = machine.step(body["spike_risk"]["probability_120m"], p50_max,
                                                              subject_id, stamp)
                else:
                    alert_event = None
                payload = ForecastResponse.model_validate(body).model_dump(mode="json", exclude_unset=True)
                now = dt.datetime.now(dt.timezone.utc).isoformat()
                yield sse({"event": "forecast.updated", "event_id": f"{idx:06d}-forecast",
                           "subject_id": str(subject_id), "emitted_at": now, "payload": payload})
                if alert_event:
                    yield sse({"event": alert_event, "event_id": f"{idx:06d}-alert", "subject_id": str(subject_id),
                               "emitted_at": now, "payload": payload["alert"]})
                if quality is not None and body["data_quality"]["status"] != quality:
                    yield sse({"event": "data_quality.changed", "event_id": f"{idx:06d}-quality",
                               "subject_id": str(subject_id), "emitted_at": now, "payload": payload["data_quality"]})
                quality = body["data_quality"]["status"]
                sent += 1
                if max_events and sent >= max_events:
                    break
                await asyncio.sleep(pause)

        return StreamingResponse(events(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return app


def main() -> None:
    import uvicorn

    ap = argparse.ArgumentParser(description="PR-TFT inference service (Blueprint Section 9).")
    ap.add_argument("--run-dir", type=Path, default=Path("runs/pr_tft_demo"))
    ap.add_argument("--data-dir", type=Path, default=None, help="override the data dir in the run's config.json")
    ap.add_argument("--simulator-seed", type=int, default=101)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8001)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    uvicorn.run(create_app(args.run_dir, args.data_dir, args.simulator_seed), host=args.host, port=args.port)


if __name__ == "__main__":
    main()

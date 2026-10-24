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
    (patient_cgm_telemetry.csv + patients_ehr.csv), restricted to the run's split patients and
    read through the same latent firewall as training. "as_of" picks the replay time; without
    it, a request forecasts from each subject's last reading. Meal logs are rebuilt exactly
    as in training (per-patient seed), and the data files must match the hashes the run
    recorded; the checkpoint is the one named (and hashed) in run_manifest.json.

Per request (Blueprint 10.2)
    data-quality gate -> twin rollouts -> PR-TFT -> conformal + isotonic calibration ->
    alert policy -> contract validation. If the network fails, the twin-only forecast is
    served and model.fallback_used says so. If data are insufficient, forecast and
    spike_risk are null with the reasons in data_quality.

Honest limits
    * Scenarios are handled by the linearized twin (meals, activity uptake, skipping a
      habitual meal) and then re-scored by the network. Medication scenarios return
      SCENARIO_UNSUPPORTED because the linearized twin has no drug terms.
    * TwinCard parameters are the twin's own EHR-derived priors (never simulator latents in a
      realistic run); their 80 % intervals are degenerate until nightly MAP fitting
      (Blueprint 7.5) exists, and calibration_stage says so.
    * unannounced_meal.probability is a heuristic: a CGM rise over 45 min that logged meals
      do not explain.

Run
    python serve_pr_tft.py --run-dir runs/pr_tft_final --port 8001
    # optional shared-secret auth (production: OAuth2 client credentials over mTLS)
    PR_TFT_SERVICE_TOKEN=... python serve_pr_tft.py --run-dir runs/pr_tft_final
"""

from __future__ import annotations

import os
# Bound resource consumption for 1GB Blitz container
os.environ["JAX_PLATFORMS"] = "cpu"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["VECLIB_MAXIMUM_THREADS"] = "1"
os.environ["NUMEXPR_NUM_THREADS"] = "1"

import argparse
import asyncio
import dataclasses
import datetime as dt
import hashlib
import json
import logging
import math
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, Literal, Optional, Union

import numpy as np
import torch
torch.set_num_threads(1)

try:
    import ctypes
    _libc = ctypes.CDLL("libc.so.6")
    def _malloc_trim():
        _libc.malloc_trim(0)
except Exception:
    def _malloc_trim():
        pass

from fastapi import Depends, FastAPI, Header, Request, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

import provenance as prov
import train_pr_tft as T

LOG = logging.getLogger("serve_pr_tft")

SERVICE_VERSION = "0.1.0"
CONTRACT_VERSION = "1.0.0"
ALERT_POLICY_VERSION = "ap-1.0"
SIMULATOR_VERSION = "generate_health_data_v2"
# Held-out partitions the service must not expose (enumeration, forecasts, twin cards, streams).
SEALED_SPLITS = frozenset({"test"})
SUBJECT_NAMESPACE = uuid.UUID("6f0c3a52-9d1e-4c57-8a2b-3e41d7b9c0aa")
INTENDED_USE = "research_only_not_for_clinical_decisions"

# Alert policy (Locked Evaluated Policy from model_selection_rule.json)
# - Evaluator uses independent thresholds with a 120-min cooldown and a causal filter.
WATCH_P, WARNING_P, CLEAR_P = 0.35, 0.60, 0.25
SUPPRESS_MIN = 120
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
    twin_p50: Optional[Glucose] = None  # the physiology twin's own rollout under this scenario


class ScenarioResult(Strict):
    scenario_id: str
    label: Optional[str] = Field(default=None, max_length=60)
    inputs: list[ScenarioInput] = Field(min_length=1)
    points: list[ScenarioPoint] = Field(min_length=24, max_length=24)
    probability_120m: Optional[Prob] = None
    delta_probability: Optional[float] = Field(default=None, ge=-1, le=1)
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


class ObservedInputs(Strict):
    """The wearable and log readings at as_of, exactly as the network consumed them (gaps filled as in training)."""
    heart_rate_bpm: Optional[float] = Field(default=None, ge=0, le=300)
    hrv_rmssd_ms: Optional[float] = Field(default=None, ge=0, le=500)
    steps_5min: float = Field(ge=0)
    asleep: bool
    carbs_logged_g: float = Field(ge=0)


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
    observed_inputs: Optional[ObservedInputs] = None
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


class PatientCache:
    """Per-subject cached data with on-demand lazy property evaluation."""
    def __init__(
        self,
        ps: T.PatientSeries,
        subject_id: uuid.UUID,
        past: np.ndarray | None = None,
        cob: np.ndarray | None = None,
        meal_effect: np.ndarray | None = None,
        static: np.ndarray | None = None,
        ukf_mean: np.ndarray | None = None,
        fit_quality: dict[str, Any] | None = None,
        carbs_logged: np.ndarray | None = None,
        _ctx: Any | None = None,
    ):
        self.ps = ps
        self.subject_id = subject_id
        self._past = past
        self._cob = cob
        self._meal_effect = meal_effect
        self.static = static
        self._ukf_mean = ukf_mean
        self.fit_quality = fit_quality
        self.carbs_logged = carbs_logged
        self._ctx = _ctx

    @property
    def past(self) -> np.ndarray:
        if self._past is None and self._ctx is not None:
            self._ctx._materialize_patient(self)
        return self._past

    @past.setter
    def past(self, val: np.ndarray):
        self._past = val

    @property
    def cob(self) -> np.ndarray:
        if self._cob is None and self._ctx is not None:
            self._ctx._materialize_patient(self)
        return self._cob

    @cob.setter
    def cob(self, val: np.ndarray):
        self._cob = val

    @property
    def meal_effect(self) -> np.ndarray:
        if self._meal_effect is None and self._ctx is not None:
            self._ctx._materialize_patient(self)
        return self._meal_effect

    @meal_effect.setter
    def meal_effect(self, val: np.ndarray):
        self._meal_effect = val

    @property
    def ukf_mean(self) -> np.ndarray | None:
        if self._ukf_mean is None and self._past is None and self._ctx is not None:
            self._ctx._materialize_patient(self)
        return self._ukf_mean

    @ukf_mean.setter
    def ukf_mean(self, val: np.ndarray | None):
        self._ukf_mean = val


class ServiceContext:
    """Everything loaded once at startup: the model, calibrators and the cohort."""

    def __init__(self, run_dir: Path, data_dir: Path | None = None, simulator_seed: int = 101):
        t0 = time.perf_counter()
        self.run_dir = run_dir
        manifest = json.loads((run_dir / "run_manifest.json").read_text())
        if manifest.get("schema") != T.RUN_MANIFEST_SCHEMA:
            raise ValueError(f"{run_dir / 'run_manifest.json'} is not a {T.RUN_MANIFEST_SCHEMA} manifest")
        for name, sha in manifest["files"].items():
            if prov.sha256_file(run_dir / name) != sha:
                raise ValueError(f"{run_dir / name} changed after training")
        self.cfg = T.validate_train_config(T.TrainConfig(**{
            k: tuple(v) if isinstance(v, list) else v for k, v in json.loads((run_dir / "config.json").read_text()).items()}))
        if data_dir is not None:
            self.cfg = dataclasses.replace(self.cfg, data_dir=str(data_dir))
        prov.verify_data(self.cfg.data_dir, {"files": manifest["preflight"]["data_sha256"]})
        self.norm = T.Normalizer(**json.loads((run_dir / "normalization.json").read_text()))
        calib_text = (run_dir / "calibration.json").read_text()
        self.calib = T.Calibrators(**json.loads(calib_text))
        self.calibration_id = "cal-" + hashlib.sha256(calib_text.encode()).hexdigest()[:10]
        self.twin = T.make_twin(self.cfg)
        if self.cfg.twin == "linear":
            tw = manifest["twin"]
            self.twin = T.TwinPrior(tw["k_scale"], tw["gain"], tw["eq_quantile"])
        if json.loads(json.dumps(self.twin.describe())) != manifest["twin"]:
            raise ValueError(f"twin {self.twin.describe()} does not match the run manifest {manifest['twin']}")
        self.ckpt = run_dir / manifest["checkpoint"]["path"]
        if prov.sha256_file(self.ckpt) != manifest["checkpoint"]["sha256"]:
            raise ValueError(f"{self.ckpt} does not match the checkpoint hash in the run manifest")
        self.static_features = T.get_static_features(self.cfg)
        self.module = T.load_inference_model(self.ckpt, self.cfg)
        if self.module.hparams.n_static != len(self.static_features):
            raise ValueError(f"checkpoint has {self.module.hparams.n_static} static inputs, twin_mode "
                             f"{self.cfg.twin_mode} provides {len(self.static_features)}")
        self.trained_at = dt.datetime.fromtimestamp(self.ckpt.stat().st_mtime, tz=dt.timezone.utc)
        self.run_id = f"{run_dir.name}/{self.ckpt.stem}"
        self.simulator_seed = simulator_seed

        # The run's patients, through the same firewall and per-patient meal-log seed as training.
        split = json.loads((run_dir / "split.json").read_text())
        series = T.load_data(self.cfg, patient_ids=[p for ids in split.values() for p in ids])
        
        canonical_file = run_dir / "canonical_meal_log.npz"
        if canonical_file.exists():
            canonical_meals = np.load(canonical_file, allow_pickle=False)
            if len(canonical_meals.keys()) != len(series) * 2:
                raise ValueError(f"Canonical artifact contains {len(canonical_meals.keys())} arrays, expected {len(series) * 2}")
            for pid, ps in series.items():
                min_key, carbs_key = f"{pid}_min", f"{pid}_carbs"
                if min_key not in canonical_meals or carbs_key not in canonical_meals:
                    raise KeyError(f"Canonical meal artifact missing keys for {pid}")
                
                c_min, c_carbs = canonical_meals[min_key], canonical_meals[carbs_key]
                
                if c_min.dtype != np.float64 or c_carbs.dtype != np.float64:
                    raise TypeError("Canonical artifact arrays must be float64")
                if c_min.ndim != 1 or c_carbs.ndim != 1:
                    raise ValueError("Canonical artifact arrays must be 1-D")
                if len(c_min) != len(ps.meal_min) or len(c_carbs) != len(ps.meal_carbs):
                    raise ValueError(f"Canonical array length mismatch for {pid}")
                if not c_min.flags.c_contiguous or not c_carbs.flags.c_contiguous:
                    raise ValueError(f"Canonical artifact arrays for {pid} must be C-contiguous")
                
                ps.meal_min = c_min
                ps.meal_carbs = c_carbs
        
        if T.meal_log_sha256(series) != manifest["meal_log_sha256"]:
            raise ValueError("meal logs differ from the ones the run was trained on")
        self.split_of = {pid: name for name, ids in split.items() for pid in ids}
        # Sealed partitions stay loaded (the meal-log hash and OOD reference cover the whole run) but are
        # never served: patient() refuses them exactly as it refuses unknown ids.
        self.sealed_pids = frozenset(pid for pid, name in self.split_of.items() if name in SEALED_SPLITS)
        self.pop = T.population_habit([series[p] for p in split["train"]])
        self.patients: dict[uuid.UUID, PatientCache] = {}
        self.by_pid: dict[str, uuid.UUID] = {}
        self._train_split = list(split["train"])
        self._scenario_range: tuple[float, float] | None = None
        
        ukf_file = run_dir / "canonical_ukf_state.npz"
        self._ukf_npz = None
        if ukf_file.exists():
            ukf_prov = json.loads((run_dir / "canonical_ukf_provenance.json").read_text())
            h = hashlib.sha256()
            with open(ukf_file, "rb") as f:
                while chunk := f.read(65536):
                    h.update(chunk)
            if ukf_prov["canonical_ukf_state_sha256"] != h.hexdigest():
                raise ValueError("Canonical UKF artifact SHA256 mismatch")
            self._ukf_npz = np.load(ukf_file, allow_pickle=False)

        self._materialized_sids: list[uuid.UUID] = []
        for pid, ps in series.items():
            sid = uuid.uuid5(SUBJECT_NAMESPACE, pid)
            static = np.array([(ps.static_raw[c] - self.norm.static_mean[c]) / self.norm.static_std[c]
                               for c in self.static_features], dtype=np.float32)
            self.patients[sid] = PatientCache(ps=ps, subject_id=sid, static=static, _ctx=self)
            self.by_pid[pid] = sid

        self.ood_ref = float(np.sqrt(np.mean(np.stack([p.static[:len(T.STATIC_CONTINUOUS)] ** 2
                                                        for p in self.patients.values()]))))
        if "canonical_meals" in locals() and hasattr(canonical_meals, "close"):
            canonical_meals.close()
        import gc
        gc.collect()
        _malloc_trim()
        LOG.info("loaded %s and %d subjects in %.1f s", self.ckpt.name, len(self.patients), time.perf_counter() - t0)

    def _materialize_patient(self, pc: PatientCache) -> None:
        """Lazily load UKF states and compute past matrix and COB for this patient."""
        if pc._past is not None:
            return
        pid = pc.ps.pid
        if self._ukf_npz is not None and f"{pid}_meal_effect" in self._ukf_npz:
            effect = self._ukf_npz[f"{pid}_meal_effect"]
            feats = {
                "ukf_insulin_action": self._ukf_npz[f"{pid}_ukf_insulin_action"],
                "ukf_plasma_insulin": self._ukf_npz[f"{pid}_ukf_plasma_insulin"],
                "ukf_gut_glucose": self._ukf_npz[f"{pid}_ukf_gut_glucose"],
                "ukf_sensitivity_boost": self._ukf_npz[f"{pid}_ukf_sensitivity_boost"],
                "ukf_theta_si": self._ukf_npz[f"{pid}_ukf_theta_si"],
                "ukf_theta_egp": self._ukf_npz[f"{pid}_ukf_theta_egp"],
                "ukf_innovation_z": self._ukf_npz[f"{pid}_ukf_innovation_z"],
                "ukf_unlogged_carbs": self._ukf_npz[f"{pid}_ukf_unlogged_carbs"],
            }
            ukf_mean = self._ukf_npz.get(f"{pid}_ukf_mean")
        else:
            effect = self.twin.meal_effect_series(pc.ps)
            feats = self.twin.state_features(pc.ps)
            ukf_mean = None

        pc._past = T.past_matrix(pc.ps, self.norm, effect, feats)
        pc._cob = T._carbs_on_board(pc.ps)
        pc._meal_effect = effect
        pc._ukf_mean = ukf_mean

        self._materialized_sids.append(pc.subject_id)
        if len(self._materialized_sids) > 64:
            oldest_sid = self._materialized_sids.pop(0)
            if oldest_sid != pc.subject_id and oldest_sid in self.patients:
                old_pc = self.patients[oldest_sid]
                old_pc._past = None
                old_pc._cob = None
                old_pc._meal_effect = None
                old_pc._ukf_mean = None

    # ---- lookups ---------------------------------------------------------- #

    def patient(self, subject_id: uuid.UUID) -> PatientCache:
        pc = self.patients.get(subject_id)
        if pc is None or pc.ps.pid in self.sealed_pids:
            raise ServiceError(404, "SUBJECT_NOT_FOUND", "Subject not found", f"No subject {subject_id}.")
        return pc

    def scenario_input_range(self) -> tuple[float, float]:
        """Largest future meal probability and expected carbs per 5-min bin the network saw in training
        (the habit prior on every eligible training anchor). Computed once, on first use."""
        if self._scenario_range is None:
            p_max, c_max = 0.0, 0.0
            for pid in self._train_split:
                pc = self.patients[self.by_pid[pid]]
                prob, carbs = T.habit_features(pc.ps, T.eligible_anchors(pc.ps, self.cfg), self.pop)
                p_max, c_max = max(p_max, float(prob.max())), max(c_max, float(carbs.max()))
            self._scenario_range = (p_max, c_max)
        return self._scenario_range

    def served_patients(self) -> list[tuple[uuid.UUID, PatientCache]]:
        return [(sid, pc) for sid, pc in self.patients.items() if pc.ps.pid not in self.sealed_pids]

    def anchor_index(self, pc: PatientCache, as_of: dt.datetime | None) -> int:
        ps = pc.ps
        last = ps.n - 1
        if as_of is None:
            return last
        if as_of.tzinfo is not None:
            stamp = as_of.astimezone(dt.timezone.utc).replace(tzinfo=None)
        else:
            stamp = as_of
        first_ok = ps.stamps[T.FIRST_ANCHOR]
        if stamp < first_ok or stamp > ps.stamps[last] + dt.timedelta(minutes=T.STEP_MIN):
            raise ServiceError(422, "AS_OF_OUT_OF_RANGE", "as_of outside the replay window",
                               f"as_of must lie between {first_ok.isoformat()}Z and {ps.stamps[last].isoformat()}Z.")
        return int(min(last, ps.stamps.searchsorted(stamp, side="right") - 1))

    # ---- inference -------------------------------------------------------- #

    def rollouts(self, pc: PatientCache, t: int, extra_carbs: np.ndarray | None = None,
                 extra_flux: np.ndarray | None = None, habit_scale: np.ndarray | None = None):
        """Twin rollouts and future-input block for one anchor (optionally a scenario)."""
        if t < T.FIRST_ANCHOR:
            raise ValueError(f"Cannot compute rollouts before FIRST_ANCHOR ({T.FIRST_ANCHOR}), got {t}")
        ps, idx = pc.ps, np.array([t])
        prob, carbs = T.habit_features(ps, idx, self.pop)
        if habit_scale is not None:
            prob, carbs = prob * habit_scale, carbs * habit_scale
        if extra_carbs is not None:
            carbs = carbs + extra_carbs
            prob = np.maximum(prob, (extra_carbs > 0).astype(float))
        nomeal = self.twin.forecast(ps, idx, extra_flux=extra_flux, cached_mean=pc.ukf_mean)
        habit = self.twin.forecast(ps, idx, carbs, extra_flux=extra_flux, cached_mean=pc.ukf_mean)
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
        if t < T.FIRST_ANCHOR:
            raise ValueError(f"Cannot run model before FIRST_ANCHOR ({T.FIRST_ANCHOR}), got {t}")
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
        calibrated_q = self.calib.apply_interval(q[None])[0]
        if not (np.diff(calibrated_q, axis=-1) >= -1e-6).all():
            raise RuntimeError("Calibrated quantiles crossed and failed monotonic validation")
        return {"q": calibrated_q, "q_raw": q,
                "p_bin": torch.sigmoid(out["hazard_logits"][0]).numpy(), "peak": out["peak"][0].numpy()}

    def twin_only(self, twin_base: np.ndarray) -> dict[str, np.ndarray]:
        """Fallback: deterministic twin physiological trajectory without invented neural uncertainty bands."""
        q = np.stack([twin_base] * 7, axis=-1)
        peak = np.array([float(twin_base.max()), float(twin_base.max())])
        return {"q": q, "q_raw": q, "p_bin": np.zeros(T.HORIZON), "peak": peak}


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


def decide_alert_state(p: float, in_progress: bool) -> str:
    """Unified alert decision policy: warning at WARNING_P (0.60) when at-risk, watch at WATCH_P (0.35) when at-risk."""
    at_risk = not in_progress
    if p >= WARNING_P and at_risk:
        return "warning"
    if p >= WATCH_P and at_risk:
        return "watch"
    return "none"


def alert_for(p: float, in_progress: bool, subject: uuid.UUID, stamp: dt.datetime) -> dict[str, Any]:
    """Stateless policy for one-off requests matching streaming policy thresholds."""
    state = decide_alert_state(p, in_progress)
    if state == "warning":
        key = "alert.spike.warning"
    elif state == "watch":
        key = "alert.spike.watch"
    else:
        return {"state": "none", "alert_id": None, "since": None, "suppressed_until": None, "message_key": None}
    s = stamp.isoformat()
    since_str = s[:-6] + "Z" if s.endswith("+00:00") else (s if s.endswith("Z") else s + "Z")
    return {"state": state, "alert_id": str(uuid.uuid5(subject, f"{state}-{stamp.isoformat()}")),
            "since": since_str, "suppressed_until": None, "message_key": key}


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
    in_warmup = t < T.FIRST_ANCHOR
    if in_warmup:
        reasons.append("sensor_warmup")
        reasons.append("sensor_day1")
    insufficient = (not np.isfinite(ps.cgm_ff[t])) or past_cov < ctx.cfg.min_past_coverage or in_warmup
    status = "insufficient" if insufficient else ("degraded" if {"cgm_gap", "ood_subject"} & set(reasons) else "ok")
    return {"status": status, "cgm_coverage_6h_pct": round(coverage, 1),
            "last_cgm_at": utc(ps.stamps[last_idx]).isoformat(), "staleness_min": int(staleness),
            "sensor_day": int(t // T.BINS_PER_DAY), "in_warmup": in_warmup,
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
    resp["observed_inputs"] = observed_inputs(pc, t)

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
    if fallback:
        resp["spike_risk"] = None
        resp["alert"] = {"state": "none", "alert_id": None, "since": None, "suppressed_until": None, "message_key": None}
        p120 = None
    else:
        cum, p120 = calibrated_hazard(ctx, out["p_bin"])
        resp["spike_risk"] = {
            "probability_120m": round(p120, 3), "tier": tier_of(p120), "calibrated": True,
            "spike_in_progress": in_progress,
            "definition": {"threshold_mg_dl": T.SPIKE_LEVEL, "min_rise_mg_dl": T.SPIKE_RISE,
                           "rise_window_min": T.RISE_STEPS * T.STEP_MIN, "persistence_min": T.PERSIST_STEPS * T.STEP_MIN},
            "cumulative": [{"offset_min": (k + 1) * T.STEP_MIN, "p": round(float(cum[k]), 3)} for k in range(T.HORIZON)],
            "onset_offset_min": onset_quartiles(cum),
            "peak_mg_dl": ({"p50": clamp_g(out["peak"][0]), "p90": clamp_g(out["peak"][1])} if p120 >= 0.05 else None),
            "time_to_peak_min": (peak_idx + 1) * T.STEP_MIN if p50.max() >= T.SPIKE_LEVEL else None,
        }
        resp["alert"] = alert_for(p120, in_progress, pc.subject_id, stamp)
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
    no_meals_at_all = ctx.twin.forecast_without_gut(ps, np.array([t]), cached_mean=pc.ukf_mean)[0]
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
        "insulin_sensitivity_rel": round(ctx.twin.parameter_summary(ps)["insulin_sensitivity_rel"], 3),
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


def observed_inputs(pc: PatientCache, t: int) -> dict[str, Any]:
    ps = pc.ps
    if pc.carbs_logged is None:
        pc.carbs_logged = T._logged_carbs_series(ps)
    finite = lambda v: round(float(v), 1) if np.isfinite(v) else None  # noqa: E731
    return {"heart_rate_bpm": finite(ps.hr[t]), "hrv_rmssd_ms": finite(ps.hrv[t]),
            "steps_5min": round(float(ps.steps[t]), 1), "asleep": bool(ps.asleep[t] > 0),
            "carbs_logged_g": round(float(pc.carbs_logged[t]), 1)}


def subject_card(ps: T.PatientSeries) -> dict[str, Any]:
    """The observable EHR fields a directory row shows (a subset of ehr_context)."""
    e = ehr_context(ps)
    return {"age_years": e["age_years"], "sex": e["sex"], "bmi": e["bmi"], "hba1c_pct": e["hba1c_pct"],
            "on_medication": bool(e["med_classes"])}


def ehr_context(ps: T.PatientSeries) -> dict[str, Any]:
    s = ps.static_raw
    meds = [m for m in T.MED_CLASSES if s.get(f"med_{m}", 0) > 0]
    return {"age_years": int(min(max(s["age"], 18), 110)), "sex": "male" if s["sex_male"] else "female",
            "bmi": round(s["bmi"], 1), "hba1c_pct": round(min(max(s["hba1c"], 4.0), 18.0), 1),
            "hba1c_date": ps.stamps[0].date().isoformat(),  # synthetic: dated to cohort start
            "t2d_duration_years": round(s["diabetes_duration_years"], 1), "egfr": round(s["egfr"], 0),
            "med_classes": meds}


def scenario_meal_row(offset_min: int) -> int:
    """Future-block row for a meal `offset_min` after the anchor, binned as logged meals are in training.

    Row k is the 5-min step at anchor + 5(k+1) min, and a meal at minute m is known at step ceil(m / 5)
    (input_contract.meal_step_index), so the row is ceil(offset / 5) - 1. A meal at the anchor itself
    (offset 0) goes in the first future row, the earliest the future block can represent.
    """
    return min(T.HORIZON - 1, max(0, math.ceil(offset_min / T.STEP_MIN) - 1))


def scenarios(ctx: ServiceContext, pc: PatientCache, t: int, reqs: list[ScenarioRequest],
              base_p50: np.ndarray, base_p120: float | None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
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
                extra_carbs[0, scenario_meal_row(item.offset_min)] += item.carbs_g
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
        if any(isinstance(i, MealInput) for i in sc.inputs):
            p_max, c_max = ctx.scenario_input_range()
            prob_s, carbs_s = float(fut[:, 2].max()), float(fut[:, 3].max() * ctx.norm.carbs_std)
            if prob_s > p_max + 1e-6 or carbs_s > c_max + 1e-6:
                notes.append({"type": "about:blank", "title": "Scenario inputs outside the training range",
                              "code": "SCENARIO_OUT_OF_RANGE",
                              "detail": f"Scenario {sc.scenario_id}: the future meal channel reaches probability "
                                        f"{prob_s:.2f} and {carbs_s:.0f} g in one 5-min step; in training it never "
                                        f"exceeded {p_max:.2f} and {c_max:.0f} g. The learned adjustment is "
                                        "extrapolating here, so read the whole curve against the physiology "
                                        "twin's own response."})
        try:
            out = ctx.run_model(pc, t, base, fut)
            is_model_fallback = False
        except Exception:  # noqa: BLE001 -- model failure falls back to twin-only
            LOG.exception("PR-TFT scenario inference failed; serving twin-only fallback")
            out = ctx.twin_only(base)
            is_model_fallback = True

        if is_model_fallback:
            sc_p120_val = None
        else:
            try:
                _, sc_p120 = calibrated_hazard(ctx, out["p_bin"])
                sc_p120_val = float(sc_p120)
            except Exception as exc:
                LOG.exception("Scenario calibration failed")
                raise ServiceError(
                    500,
                    "CALIBRATION_FAILED",
                    "Scenario calibration failed",
                    f"Scenario {sc.scenario_id}: calibration failed: {exc}",
                ) from exc
        q = out["q"]
        delta_p = (
            round(max(-1.0, min(1.0, sc_p120_val - base_p120)), 3)
            if (sc_p120_val is not None and base_p120 is not None)
            else None
        )
        results.append({
            "scenario_id": sc.scenario_id, **({"label": sc.label} if sc.label else {}),
            "inputs": [i.model_dump(exclude_none=True) for i in sc.inputs],
            "points": [{"offset_min": (k + 1) * T.STEP_MIN, "p10": clamp_g(q[k, T.P10_IDX]),
                        "p50": clamp_g(q[k, T.MEDIAN_IDX]), "p90": clamp_g(q[k, T.P90_IDX]),
                        "twin_p50": clamp_g(base[k])} for k in range(T.HORIZON)],
            "probability_120m": round(sc_p120_val, 3) if sc_p120_val is not None else None,
            "delta_probability": delta_p,
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
    if pc.fit_quality is not None:
        fit = pc.fit_quality
    else:
        t = T.eligible_anchors(ps, ctx.cfg)
        fit = {}
        if t.size:
            pred = ctx.twin.forecast(ps, t, cached_mean=pc.ukf_mean)
            y = ps.cgm[t[:, None] + np.arange(1, T.HORIZON + 1)[None, :]]
            k = 60 // T.STEP_MIN - 1
            ok = np.isfinite(y[:, k])
            fit["rmse_60m_14d_mg_dl"] = round(float(np.sqrt(np.mean((pred[ok, k] - y[ok, k]) ** 2))), 1)
        pc.fit_quality = fit
    summary = ctx.twin.parameter_summary(ps)
    params = [
        ("insulin_sensitivity_rel", summary["insulin_sensitivity_rel"], "relative to healthy"),
        ("t_max_min", summary["t_max_min"], "min"),
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
    """Locked Policy (model_selection_rule.json): alert when at risk (causal flag) and the trigger holds; 
    at most one alert per 120 min. Evaluated statelessly without UI hysteresis."""

    state: str = "none"
    since: dt.datetime | None = None
    alert_id: str | None = None
    suppressed_until: dt.datetime | None = None

    def step(self, p: float, in_progress: bool, subject: uuid.UUID, now: dt.datetime) -> tuple[dict[str, Any], str | None]:
        target = decide_alert_state(p, in_progress)
        event = None
        if target != "none":
            if self.suppressed_until is None or now >= self.suppressed_until:
                self.state = target
                self.since = now
                self.alert_id = str(uuid.uuid5(subject, f"{target}-{now.isoformat()}"))
                self.suppressed_until = now + dt.timedelta(minutes=120)
                event = "alert.raised"
            elif target != self.state:
                self.state = target
        else:
            if self.state != "none":
                event = "alert.cleared"
                self.state = "none"
                self.since = self.alert_id = None

        def _iso(d: dt.datetime | None) -> str | None:
            if not d:
                return None
            s = d.isoformat()
            return s[:-6] + "Z" if s.endswith("+00:00") else (s if s.endswith("Z") else s + "Z")

        alert = {"state": self.state, "alert_id": self.alert_id,
                 "since": _iso(self.since),
                 "suppressed_until": _iso(self.suppressed_until) if self.state != "none" else None,
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
                "subjects": len(c.served_patients())}

    @app.get("/v1/subjects", dependencies=[Depends(auth)])
    def subjects(c: ServiceContext = Depends(ctx)):
        return [{"subject_id": str(sid), "patient_id": pc.ps.pid, "group": pc.ps.group,
                 "split": c.split_of.get(pc.ps.pid), "first_as_of": utc(pc.ps.stamps[T.FIRST_ANCHOR]).isoformat(),
                 "last_as_of": utc(pc.ps.stamps[-1]).isoformat(), "ehr": subject_card(pc.ps)}
                for sid, pc in c.served_patients()]

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
                     catch_up: int = Query(default=0, ge=0, le=288),
                     include: list[str] = Query(default=["drivers", "twin_state"]),
                     c: ServiceContext = Depends(ctx)):
        """Replay: one forecast per 5-min reading from as_of, paced at `speed` x real time
        (300 -> one reading per second). Resumes after Last-Event-ID when given.
        The first `catch_up` readings after the replay start are sent unpaced so a viewer opens on
        real recent history; every one is still a full forecast. The window is by reading index, so a
        resume past it is paced normally."""
        parsed_include: list[IncludeKey] = []
        for item in include:
          for part in item.split(","):
            part = part.strip()
            if part:
              if part not in ("drivers", "scenarios", "twin_state", "ehr_context", "twin_overlay"):
                raise ServiceError(422, "REQUEST_INVALID", "Invalid include key", f"Unknown include key: {part}")
              if part not in parsed_include:
                parsed_include.append(part)  # type: ignore

        pc = c.patient(subject_id)
        start_t = c.anchor_index(pc, as_of) if as_of else T.FIRST_ANCHOR
        resume_idx = None
        resume_type = None
        if last_event_id:
            try:
                parts = last_event_id.strip().split("-")
                resume_idx = int(parts[0])
                resume_type = parts[1] if len(parts) > 1 else "forecast"
                if resume_type not in ("forecast", "alert", "quality"):
                    raise ValueError("Unknown event type")
                if resume_idx < start_t or resume_idx >= pc.ps.n:
                    raise ServiceError(422, "REQUEST_INVALID", "Last-Event-ID out of range", last_event_id)
            except (ValueError, IndexError) as exc:
                if isinstance(exc, ServiceError):
                    raise
                raise ServiceError(422, "REQUEST_INVALID", "Bad Last-Event-ID", last_event_id) from exc
        pause = max(0.0, T.STEP_MIN * 60 / speed) if speed > 0 else 0.0

        async def events():
            machine, sent, quality = AlertMachine(), 0, None
            # Fast-forward machine state deterministically up to resume_idx to preserve alert hysteresis and 120-min cooldown
            if resume_idx is not None and resume_idx > start_t:
                for past_i in range(start_t, resume_idx):
                    req = ForecastRequest(schema_version="1.0.0", request_id=uuid.uuid4(), subject_id=subject_id, include=[])
                    past_body = await run_in_threadpool(build_forecast, c, req, past_i)
                    if past_body["spike_risk"] is not None:
                        past_stamp = dt.datetime.fromisoformat(past_body["as_of"])
                        in_progress = past_body["spike_risk"]["spike_in_progress"]
                        machine.step(past_body["spike_risk"]["probability_120m"], in_progress, subject_id, past_stamp)
                    quality = past_body["data_quality"]["status"]

            begin_idx = resume_idx if resume_idx is not None else start_t
            for idx in range(begin_idx, pc.ps.n):
                req = ForecastRequest(schema_version="1.0.0", request_id=uuid.uuid4(), subject_id=subject_id, include=parsed_include)
                body = await run_in_threadpool(build_forecast, c, req, idx)
                stamp = dt.datetime.fromisoformat(body["as_of"])
                if body["spike_risk"] is not None:
                    in_progress = body["spike_risk"]["spike_in_progress"]
                    body["alert"], alert_event = machine.step(body["spike_risk"]["probability_120m"], in_progress,
                                                              subject_id, stamp)
                else:
                    alert_event = None
                payload = ForecastResponse.model_validate(body).model_dump(mode="json", exclude_unset=True)
                now = dt.datetime.now(dt.timezone.utc).isoformat()
                is_resume_anchor = (resume_idx is not None and idx == resume_idx)

                if not is_resume_anchor or resume_type not in ("forecast", "alert", "quality"):
                    yield sse({"event": "forecast.updated", "event_id": f"{idx:06d}-forecast",
                               "subject_id": str(subject_id), "emitted_at": now, "payload": payload})
                    sent += 1
                    if max_events and sent >= max_events:
                        break

                if alert_event and (not is_resume_anchor or resume_type == "forecast"):
                    yield sse({"event": alert_event, "event_id": f"{idx:06d}-alert", "subject_id": str(subject_id),
                               "emitted_at": now, "payload": payload["alert"]})
                    sent += 1
                    if max_events and sent >= max_events:
                        break

                if quality is not None and body["data_quality"]["status"] != quality:
                    if not is_resume_anchor or resume_type in ("forecast", "alert"):
                        yield sse({"event": "data_quality.changed", "event_id": f"{idx:06d}-quality",
                                   "subject_id": str(subject_id), "emitted_at": now, "payload": payload["data_quality"]})
                        sent += 1
                        if max_events and sent >= max_events:
                            break

                quality = body["data_quality"]["status"]
                await asyncio.sleep(0.0 if idx < start_t + catch_up else pause)

        return StreamingResponse(events(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return app


def main() -> None:
    import uvicorn

    ap = argparse.ArgumentParser(description="PR-TFT inference service (Blueprint Section 9).")
    ap.add_argument("--run-dir", type=Path, required=True, help="a run directory written by train_pr_tft.py")
    ap.add_argument("--data-dir", type=Path, default=None,
                    help="data location if it moved; the files must match the hashes the run recorded")
    ap.add_argument("--simulator-seed", type=int, default=101)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8001)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    uvicorn.run(create_app(args.run_dir, args.data_dir, args.simulator_seed), host=args.host, port=args.port)


if __name__ == "__main__":
    main()

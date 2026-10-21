#!/usr/bin/env python3
"""evaluate_run.py -- the one authoritative test-set evaluator for a PR-TFT run.

Nothing else in the repository scores the test patients. The evaluator

  1. verifies provenance: a clean source tree (or explicit --allow-dirty), the same commit
     the run was trained from (or explicit --allow-source-mismatch), the data files against
     the hashes the trainer recorded, and the model-selection rule against the hashes the
     trainer recorded -- so the rule cannot change between training and test evaluation;
  2. verifies identity before scoring: checkpoint file hash; checkpoint hyperparameters vs
     config.json (twin, twin_mode, n_static, n_past, n_future -- an oracle checkpoint is never
     scored as a realistic arm or vice versa); twin description; meal logs; the normaliser
     refitted on the training patients and the calibrators refitted on validation
     predictions must reproduce the saved ones;
  3. scores the test patients
       forecast   RMSE / MAE / MARD at 30-60-120 min, raw and conformal 80 % interval
                  coverage and width, Clarke zones (reference = measured CGM), for PR-TFT,
                  twin-only and persistence, on the training anchor grid;
       hazard     anchor-level AUROC / AUPRC / Brier / ECE of P(onset <= 120 min), raw and
                  calibrated, on at-risk anchors;
       alerts     every 5-min decision time from step 287 that passes the causal past-coverage
                  filter (there is no future-coverage filter): an alert is raised when the
                  patient is at risk (causal flag) and the trigger holds, at most one per
                  120 min. Event sensitivity, alert precision (alerts followed by an onset
                  within 120 min / alerts raised -- one unit, reported once), lead time, alerts
                  and false alerts per patient-day. PR-TFT triggers on calibrated
                  P >= threshold; twin-only triggers when its forecast meets the spike rule;
       uncertainty  paired patient-level bootstrap, stratified by diabetes status;
  4. applies model_selection_rule.json mechanically and writes evaluation_report.json.

Usage (from backend/)
    python evaluate_run.py --run-dir runs/pr_tft_final [--data-dir DIR] [--out FILE]
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import time
from pathlib import Path
from typing import Any

import lightning.pytorch as pl
import numpy as np
import torch

import provenance as prov
import train_pr_tft as T
from input_contract import STEP_MIN

LOG = logging.getLogger("evaluate_run")
EVAL_SCHEMA = "pr_tft_evaluation/v1"
HORIZON = T.HORIZON
COOLDOWN_STEPS = HORIZON  # at most one alert per 120 min
POPULATIONS = {"primary": ("Prediabetes", "Type 2"), "secondary": ("Healthy",),
               "all": ("Healthy", "Prediabetes", "Type 2")}


class IdentityError(prov.ProvenanceError):
    """The checkpoint, config, twin, normaliser or calibrators do not belong together."""


def _canon(obj: Any) -> Any:
    return json.loads(json.dumps(obj))


def _cfg_from_dict(d: dict[str, Any]) -> T.TrainConfig:
    return T.TrainConfig(**{k: tuple(v) if isinstance(v, list) else v for k, v in d.items()})


# --------------------------------------------------------------------------- #
# Identity
# --------------------------------------------------------------------------- #


def verify_identity(cfg_dict: dict[str, Any], hparams: dict[str, Any], manifest: dict[str, Any],
                    glu_std: float) -> dict[str, Any]:
    """Checkpoint hyperparameters vs run config vs run manifest. Raises IdentityError listing
    every mismatch (wrong arm, wrong dims, different training config, different twin)."""
    cfg = T.validate_train_config(_cfg_from_dict(cfg_dict))
    dims = T.model_dims(cfg)
    err = []
    for k, v in dims.items():
        if hparams.get(k) != v:
            err.append(f"checkpoint {k}={hparams.get(k)} but config twin={cfg.twin}/twin_mode={cfg.twin_mode} needs {v}")
        if manifest["dims"].get(k) != v:
            err.append(f"run manifest {k}={manifest['dims'].get(k)} but config needs {v}")
    ck_cfg = _canon(hparams.get("cfg_dict") or {})
    if ck_cfg != _canon(cfg_dict):
        keys = sorted(k for k in set(ck_cfg) | set(cfg_dict) if ck_cfg.get(k) != _canon(cfg_dict).get(k))
        err.append(f"checkpoint training config differs from config.json in {keys}")
    twin = manifest["twin"]
    if twin.get("kind") != cfg.twin:
        err.append(f"run manifest twin kind {twin.get('kind')} != config twin {cfg.twin}")
    if cfg.twin == "ukf" and twin.get("mode") != cfg.twin_mode:
        err.append(f"run manifest twin mode {twin.get('mode')} != config twin_mode {cfg.twin_mode}")
    if abs(float(hparams.get("glu_std", np.nan)) - glu_std) > 1e-9:
        err.append(f"checkpoint glu_std {hparams.get('glu_std')} != normalization.json {glu_std}")
    if err:
        raise IdentityError("; ".join(err))
    return {"dims": dims, "twin_mode": cfg.twin_mode, "twin": cfg.twin}


CALIBRATION_TOLERANCE = {"conformal_mg_dl": 0.25, "hazard_map": 0.02}


def calibration_distance(a: T.Calibrators, b: T.Calibrators) -> dict[str, float]:
    """How far apart two fitted calibrations are as functions: largest difference of the conformal
    widening (mg/dL) and of the isotonic hazard map on a fine probability grid. CPU inference is
    reproducible only to float rounding across builds, which can move isotonic steps slightly;
    a different checkpoint, dataset or code path moves them far more."""
    grid = np.linspace(0.0, 1.0, 2001)
    widen = np.abs(np.asarray(a.conformal_mg_dl) - np.asarray(b.conformal_mg_dl))
    return {"conformal_mg_dl": float(widen.max()) if widen.size else 0.0,
            "hazard_map": float(np.abs(a.apply_hazard(grid) - b.apply_hazard(grid)).max())}


def _max_abs_diff(a: Any, b: Any) -> float:
    """Largest absolute difference between two nested numeric structures (inf if shapes differ)."""
    if isinstance(a, dict):
        if set(a) != set(b):
            return float("inf")
        return max([_max_abs_diff(a[k], b[k]) for k in a] or [0.0])
    if isinstance(a, (list, tuple)):
        if len(a) != len(b):
            return float("inf")
        return max([_max_abs_diff(x, y) for x, y in zip(a, b)] or [0.0])
    return abs(float(a) - float(b))


# --------------------------------------------------------------------------- #
# Event-level alert evaluation (pure functions, unit-tested)
# --------------------------------------------------------------------------- #


def causal_decision_mask(ps: T.PatientSeries, cfg: T.TrainConfig) -> tuple[np.ndarray, int, int]:
    """Decision times first..last (inclusive) and which of them the model can act on, using
    data up to t only: a current CGM value and enough past coverage. last = n - 1 - HORIZON so
    every alert's 120-min outcome window is observed."""
    first, last = T.FIRST_ANCHOR, ps.n - 1 - HORIZON
    t = np.arange(first, last + 1)
    finite = np.isfinite(ps.cgm).astype(float)
    csum = np.concatenate(([0.0], np.cumsum(finite)))
    past_cov = (csum[t + 1] - csum[t + 1 - T.PAST_STEPS]) / T.PAST_STEPS
    ok = np.isfinite(ps.cgm_ff[t]) & (past_cov >= cfg.min_past_coverage)
    return t[ok], first, last


def raise_alerts(trigger: np.ndarray, at_risk: np.ndarray, cooldown: int = COOLDOWN_STEPS) -> np.ndarray:
    """Alerts actually raised: trigger and at risk, unless one was raised in the last `cooldown` steps."""
    raised = np.zeros(trigger.shape, dtype=bool)
    last = -(10 ** 9)
    for t in np.flatnonzero(trigger & at_risk):
        if t - last >= cooldown:
            raised[t] = True
            last = t
    return raised


def event_counts(raised: np.ndarray, onset: np.ndarray, first: int, last: int,
                 horizon: int = HORIZON) -> dict[str, Any]:
    """Per-patient event counts for raised alerts over decision times first..last.

    monitored onset  k with first + horizon <= k <= last + 1: its whole warning window
                     [k - horizon, k - 1] lies inside the decision period;
    detected         matched 1-to-1 with an alert raised in [k - horizon, k - 1];
                     lead = (k - t) * STEP_MIN;
    true alert       an alert matched 1-to-1 to an eligible monitored onset;
    false alert      an alert not matched to any monitored onset.

    Deterministic 1-to-1 matching rule:
      Pairs (alert t, onset k) are eligible if t in [k - horizon, k - 1] (lead in 5..120 min).
      Matching proceeds chronologically by monitored onset k (earliest onset first).
      For each onset, the earliest available (unmatched) eligible alert t is assigned.
      Once matched, neither the alert nor the onset can be reused.
      Any unmatched alert is a false alert; any unmatched onset is missed.
    """
    raised = raised.copy()
    raised[:first] = False
    raised[last + 1:] = False
    alerts = np.flatnonzero(raised)
    onsets = [k for k in np.flatnonzero(onset) if first + horizon <= k <= last + 1]

    unmatched_alerts = set(alerts.tolist())
    leads = []
    matched_alerts = set()
    for k in onsets:
        eligible = [t for t in unmatched_alerts if k - horizon <= t <= k - 1]
        if eligible:
            earliest_t = min(eligible)
            matched_alerts.add(earliest_t)
            unmatched_alerts.remove(earliest_t)
            leads.append(int((k - earliest_t) * STEP_MIN))

    true = len(matched_alerts)
    return {"monitored_onsets": len(onsets), "detected_onsets": len(leads), "alerts_raised": int(alerts.size),
            "true_alerts": int(true), "false_alerts": int(alerts.size - true),
            "patient_days": (last - first + 1) * STEP_MIN / 1440.0, "lead_times_min": leads}


def forecast_meets_spike_rule(history: np.ndarray, forecast: np.ndarray) -> bool:
    """Twin-only trigger: does the observed CGM up to t followed by a point forecast contain a
    spike onset (Blueprint rule) inside the forecast horizon?"""
    seq = np.concatenate([history, forecast])
    onset, _ = T.detect_spike_onsets(seq)
    return bool(onset[history.size:].any())


# --------------------------------------------------------------------------- #
# Paired, stratified, patient-level bootstrap
# --------------------------------------------------------------------------- #


def bootstrap_weights(groups: list[str], n_boot: int, seed: int) -> np.ndarray:
    """(n_boot, n_patients) multiplicity weights: within each group, draw as many patients as
    the group has, with replacement. A patient drawn twice counts twice. The same weights are
    used for every model, so differences are paired."""
    rng = np.random.default_rng(seed)
    groups = np.asarray(groups)
    w = np.zeros((n_boot, groups.size))
    for g in sorted(set(groups.tolist())):
        idx = np.flatnonzero(groups == g)
        draws = rng.integers(0, idx.size, size=(n_boot, idx.size))
        for b in range(n_boot):
            np.add.at(w[b], idx[draws[b]], 1.0)
    return w


def _ratio(num: np.ndarray, den: np.ndarray, w: np.ndarray) -> np.ndarray:
    n, d = w @ num, w @ den
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(d > 0, n / d, np.nan)


def weighted_median(values: list[list[float]], w: np.ndarray) -> np.ndarray:
    """Median of pooled per-patient value lists, each patient weighted by its multiplicity."""
    flat = np.array([v for vs in values for v in vs], dtype=float)
    owner = np.array([i for i, vs in enumerate(values) for _ in vs], dtype=int)
    out = np.full(w.shape[0], np.nan)
    if flat.size == 0:
        return out
    order = np.argsort(flat)
    flat, owner = flat[order], owner[order]
    for b in range(w.shape[0]):
        ew = w[b, owner]
        tot = ew.sum()
        if tot > 0:
            out[b] = flat[np.searchsorted(np.cumsum(ew), 0.5 * tot)]
    return out


def summarize(point: float, draws: np.ndarray, ci: float) -> dict[str, Any]:
    lo, hi = (np.nanpercentile(draws, [50 * (1 - ci), 50 * (1 + ci)]) if np.isfinite(draws).any()
              else (np.nan, np.nan))
    f = lambda x: None if not np.isfinite(x) else round(float(x), 6)
    return {"estimate": f(point), "ci_low": f(lo), "ci_high": f(hi)}


def metric_draws(stats: dict[str, Any], w: np.ndarray) -> dict[str, np.ndarray]:
    """Bootstrap draws (or the point estimate, for w = ones) of every metric of one model."""
    out = {}
    if "sse_60" in stats:
        for h in (30, 60, 120):
            out[f"rmse_{h}"] = np.sqrt(_ratio(stats[f"sse_{h}"], stats[f"n_{h}"], w))
            out[f"mae_{h}"] = _ratio(stats[f"ae_{h}"], stats[f"n_{h}"], w)
    if "cov_in_raw" in stats:
        out["coverage_80_raw"] = _ratio(stats["cov_in_raw"], stats["cov_n"], w)
        out["coverage_80_conformal"] = _ratio(stats["cov_in_conf"], stats["cov_n"], w)
    if "monitored_onsets" in stats:
        out["event_sensitivity"] = _ratio(stats["detected_onsets"], stats["monitored_onsets"], w)
        out["alert_precision"] = _ratio(stats["true_alerts"], stats["alerts_raised"], w)
        out["alerts_per_patient_day"] = _ratio(stats["alerts_raised"], stats["patient_days"], w)
        out["false_alerts_per_patient_day"] = _ratio(stats["false_alerts"], stats["patient_days"], w)
        out["lead_time_median_min"] = weighted_median(stats["lead_times_min"], w)
    return out


# --------------------------------------------------------------------------- #
# The locked selection rule, applied mechanically
# --------------------------------------------------------------------------- #


def _beats(diff: dict[str, Any], direction: str, tol: float) -> bool:
    """A beats B when the whole CI of (A - B) lies beyond the tie band on A's favourable side."""
    if diff["ci_low"] is None or diff["ci_high"] is None:
        return False
    return diff["ci_low"] > tol if direction == "higher" else diff["ci_high"] < -tol


def _not_worse(diff: dict[str, Any], direction: str, tol: float) -> bool:
    if diff["ci_low"] is None or diff["ci_high"] is None:
        return False
    return diff["ci_low"] >= -tol if direction == "higher" else diff["ci_high"] <= tol


def apply_selection_rule(rule: dict[str, Any], primary: dict[str, Any], reachable: dict[str, bool]) -> dict[str, Any]:
    """Select between PR-TFT and twin-only on the primary population, per model_selection_rule.json."""
    sel = rule["final_model_selection"]
    th = f"{rule['alerting']['primary_threshold']:g}"
    trace = []
    if not reachable.get(th, False):
        return {"selected": "twin_only", "reason": f"PR-TFT primary threshold {th} unreachable after calibration",
                "trace": trace}
    cov = primary["models"]["pr_tft"]["coverage_80_conformal"]["estimate"]
    lo, hi = sel["coverage_window"]
    if cov is None or not lo <= cov <= hi:
        return {"selected": "twin_only", "reason": f"PR-TFT conformal coverage {cov} outside [{lo}, {hi}] (downgraded)",
                "trace": trace}
    diffs = primary["paired_differences"]["pr_tft_minus_twin_only"]
    metrics = rule["metrics"]
    for m in sel["non_inferiority"]:
        ok = _not_worse(diffs[m], metrics[m]["direction"], metrics[m]["tie_tolerance"])
        trace.append({"check": "non_inferior", "metric": m, "diff": diffs[m], "passed": ok})
        if not ok:
            return {"selected": "twin_only", "reason": f"PR-TFT inferior to twin-only on {m}", "trace": trace}
    wins = []
    for m in sel["superiority_any_of"]:
        ok = _beats(diffs[m], metrics[m]["direction"], metrics[m]["tie_tolerance"])
        trace.append({"check": "superior", "metric": m, "diff": diffs[m], "passed": ok})
        if ok:
            wins.append(m)
    if not wins:
        return {"selected": "twin_only", "reason": "all comparisons tied; the simpler model is selected", "trace": trace}
    return {"selected": "pr_tft", "reason": f"non-inferior on {sel['non_inferiority']} and superior on {wins}",
            "trace": trace}


# --------------------------------------------------------------------------- #
# Evaluation
# --------------------------------------------------------------------------- #


def _predict(module: T.PRTFTModule, split: T.SplitTensors, cfg: T.TrainConfig) -> dict[str, np.ndarray]:
    loader = torch.utils.data.DataLoader(T.AnchorDataset(split), batch_size=cfg.batch_size, shuffle=False,
                                         num_workers=0)
    trainer = pl.Trainer(accelerator=cfg.accelerator, devices=1, logger=False, enable_progress_bar=False,
                         enable_model_summary=False)
    return T.predict(trainer, module, loader)


def patient_stats(agg: dict[str, np.ndarray], q_conf: np.ndarray, n_patients: int) -> dict[str, dict[str, Any]]:
    """Per-patient sufficient statistics for the forecast metrics of the three models."""
    preds = {"pr_tft": agg["q"][..., T.MEDIAN_IDX], "twin_only": agg["twin"],
             "persistence": np.repeat(agg["g0"][:, None], HORIZON, axis=1)}
    pat = agg["patient"]
    out: dict[str, dict[str, Any]] = {}
    for name, pred in preds.items():
        s: dict[str, Any] = {}
        for h in (30, 60, 120):
            k = h // STEP_MIN - 1
            ok = agg["y_mask"][:, k] > 0
            err = (pred[:, k] - agg["y"][:, k])[ok]
            s[f"sse_{h}"] = np.bincount(pat[ok], err ** 2, n_patients)
            s[f"ae_{h}"] = np.bincount(pat[ok], np.abs(err), n_patients)
            s[f"n_{h}"] = np.bincount(pat[ok], None, n_patients).astype(float)
        out[name] = s
    m = agg["y_mask"] > 0
    y = agg["y"]
    for key, q in (("raw", agg["q"]), ("conf", q_conf)):
        inside = ((y >= q[..., T.P10_IDX]) & (y <= q[..., T.P90_IDX]) & m).sum(1)
        out["pr_tft"][f"cov_in_{key}"] = np.bincount(pat, inside, n_patients)
    out["pr_tft"]["cov_n"] = np.bincount(pat, m.sum(1), n_patients).astype(float)
    return out


def evaluate(run_dir: Path, data_dir: Path | None, allow_dirty: bool, allow_source_mismatch: bool,
             out_path: Path) -> dict[str, Any]:
    started = time.perf_counter()
    manifest_path = run_dir / "run_manifest.json"
    manifest = prov.load_json(manifest_path)
    if manifest.get("schema") != T.RUN_MANIFEST_SCHEMA:
        raise IdentityError(f"{manifest_path} is not a {T.RUN_MANIFEST_SCHEMA} manifest")
    pre = manifest["preflight"]

    # 1. Provenance -------------------------------------------------------------------
    git = prov.require_clean(prov.git_state(), allow_dirty)
    if git["git_sha"] != pre["git"]["git_sha"] and not allow_source_mismatch:
        raise prov.ProvenanceError(f"evaluator commit {git['git_sha'][:12]} != training commit "
                                   f"{pre['git']['git_sha'][:12]}; pass --allow-source-mismatch to evaluate anyway")
    for name, sha in manifest["files"].items():
        if prov.sha256_file(run_dir / name) != sha:
            raise IdentityError(f"{run_dir / name} changed after training")
    cfg_dict = prov.load_json(run_dir / "config.json")
    cfg = T.validate_train_config(_cfg_from_dict(cfg_dict))
    if data_dir is not None:
        cfg = dataclasses.replace(cfg, data_dir=str(Path(data_dir).resolve()))
    data = prov.verify_data(cfg.data_dir, {"files": pre["data_sha256"]})
    rule_json, rule_md = prov.BACKEND_DIR / "model_selection_rule.json", prov.BACKEND_DIR / "model_selection_rule.md"
    rule_hashes = prov.verify_rule(rule_json, rule_md, pre["model_selection_rule_json_sha256"],
                                   pre["model_selection_rule_md_sha256"])
    rule = prov.load_json(rule_json)
    split = prov.load_json(run_dir / "split.json")
    if prov.sha256_json(split) != manifest["split_effective_sha256"]:
        raise IdentityError("split.json does not match the run manifest")

    # 2. Identity -----------------------------------------------------------------------
    ckpt = run_dir / manifest["checkpoint"]["path"]
    if prov.sha256_file(ckpt) != manifest["checkpoint"]["sha256"]:
        raise IdentityError(f"{ckpt} does not match the checkpoint hash recorded at training time")
    raw_ckpt = torch.load(ckpt, map_location="cpu", weights_only=False)
    norm_saved = prov.load_json(run_dir / "normalization.json")
    ident = verify_identity(cfg_dict, raw_ckpt["hyper_parameters"], manifest, float(norm_saved["glu_std"]))
    del raw_ckpt
    module = T.PRTFTModule.load_from_checkpoint(str(ckpt), map_location="cpu").eval()

    patients = sorted(p for ids in split.values() for p in ids)
    series = T.load_data(cfg, patient_ids=patients)
    if T.meal_log_sha256(series) != manifest["meal_log_sha256"]:
        raise IdentityError("meal logs differ from training (corruption seed or code changed)")
    twin = T.make_twin(cfg)
    if cfg.twin == "linear":
        tw = manifest["twin"]
        twin = T.TwinPrior(tw["k_scale"], tw["gain"], tw["eq_quantile"])
    if _canon(twin.describe()) != _canon(manifest["twin"]):
        raise IdentityError(f"twin {twin.describe()} != run manifest {manifest['twin']}")
    train = [series[p] for p in split["train"]]
    norm_refit = T.Normalizer.fit(train, {ps.pid: twin.meal_effect_series(ps) for ps in train},
                                  {ps.pid: twin.state_features(ps) for ps in train}, cfg.twin_mode)
    norm_diff = _max_abs_diff(_canon(dataclasses.asdict(norm_refit)), norm_saved)
    if not norm_diff <= 1e-6:
        raise IdentityError(f"normaliser refitted on the training patients differs from normalization.json ({norm_diff})")
    norm = T.Normalizer(**norm_saved)
    pop = T.population_habit(train)
    if prov.sha256_json([np.round(pop[0], 12).tolist(), round(pop[1], 9)]) != manifest["population_habit_sha256"]:
        raise IdentityError("habit prior refitted on the training patients differs from training")

    calib_saved = prov.load_json(run_dir / "calibration.json")
    val_anchors = {p: T.eligible_anchors(series[p], cfg) for p in split["val"]}
    val = _predict(module, T.build_split([series[p] for p in split["val"]], val_anchors, twin, norm, pop, cfg), cfg)
    calib_refit = T.Calibrators.fit(val, cfg.interval_level)
    calib = T.Calibrators(**calib_saved)
    calib_diff = calibration_distance(calib_refit, calib)
    if any(not calib_diff[k] <= tol for k, tol in CALIBRATION_TOLERANCE.items()):
        raise IdentityError(f"calibration refitted on validation predictions differs from calibration.json "
                            f"({calib_diff}, tolerance {CALIBRATION_TOLERANCE}); checkpoint, data or code is not "
                            "the one that produced this run")
    max_cal = float(max(calib.iso_y)) if calib.iso_y else 0.0
    reachable = {f"{th:g}": bool(max_cal >= th) for th in rule["alerting"]["thresholds"]}
    LOG.info("identity verified (normaliser diff %.2g, calibration distance %s)", norm_diff, calib_diff)

    # 3. Test predictions at every causal decision time ---------------------------------
    test_ids = sorted(split["test"])
    test_series = [series[p] for p in test_ids]
    decisions = {}
    for ps in test_series:
        t_ok, first, last = causal_decision_mask(ps, cfg)
        decisions[ps.pid] = (t_ok, first, last)
    split_test = T.build_split(test_series, {p: decisions[p][0] for p in test_ids}, twin, norm, pop, cfg)
    agg = _predict(module, split_test, cfg)
    a_t = split_test.anchor_t.numpy()
    a_p = split_test.anchor_patient.numpy()
    p_cal = calib.apply_hazard(agg["p_cum"])
    n_pat = len(test_ids)

    # forecast metrics on the training anchor grid (a subset of the decision times)
    grid = np.zeros(a_t.size, dtype=bool)
    for i, ps in enumerate(test_series):
        sel = a_p == i
        grid[sel] = np.isin(a_t[sel], T.eligible_anchors(ps, cfg))
    fc = {k: v[grid] for k, v in agg.items()}
    q_conf = calib.apply_interval(fc["q"])
    stats = patient_stats(fc, q_conf, n_pat)

    # event metrics per patient
    thresholds = [float(x) for x in rule["alerting"]["thresholds"]]
    prim = f"pr_tft@{rule['alerting']['primary_threshold']:g}"
    ev: dict[str, list[dict[str, Any]]] = {f"pr_tft@{th:g}": [] for th in thresholds} | {"twin_only": []}
    hist_len = T.RISE_STEPS + 1
    for i, ps in enumerate(test_series):
        _, first, last = decisions[ps.pid]
        sel = np.flatnonzero(a_p == i)
        ts = a_t[sel]
        at_risk = np.zeros(ps.n, dtype=bool)
        at_risk[ts] = ps.armed[ts]
        for th in thresholds:
            trig = np.zeros(ps.n, dtype=bool)
            trig[ts] = p_cal[sel] >= th
            ev[f"pr_tft@{th:g}"].append(event_counts(raise_alerts(trig, at_risk), ps.onset, first, last))
        trig = np.zeros(ps.n, dtype=bool)
        for j, t in zip(sel, ts):
            if at_risk[t] and agg["twin"][j].max() >= T.SPIKE_LEVEL:  # necessary for a forecast spike
                trig[t] = forecast_meets_spike_rule(ps.cgm[t - hist_len + 1:t + 1], agg["twin"][j])
        ev["twin_only"].append(event_counts(raise_alerts(trig, at_risk), ps.onset, first, last))
    for m, rows in ev.items():
        target = stats.setdefault(m, {})
        for key in ("monitored_onsets", "detected_onsets", "alerts_raised", "true_alerts", "false_alerts", "patient_days"):
            target[key] = np.array([r[key] for r in rows], dtype=float)
        target["lead_times_min"] = [r["lead_times_min"] for r in rows]

    # 4. Populations, paired bootstrap, rule -------------------------------------------
    unc = rule["uncertainty"]
    groups_all = np.array([ps.group for ps in test_series])
    alert_keys = ("event_sensitivity", "alert_precision", "alerts_per_patient_day", "false_alerts_per_patient_day")
    populations = {}
    for pop_name, members in POPULATIONS.items():
        idx = np.flatnonzero(np.isin(groups_all, members))
        if idx.size == 0:
            continue
        sub = {m: {k: (v[idx] if isinstance(v, np.ndarray) else [v[i] for i in idx]) for k, v in s.items()}
               for m, s in stats.items()}
        w = bootstrap_weights(groups_all[idx].tolist(), unc["resamples"], unc["seed"])
        ones = np.ones((1, idx.size))
        point = {m: metric_draws(s, ones) for m, s in sub.items()}
        draws = {m: metric_draws(s, w) for m, s in sub.items()}
        models: dict[str, Any] = {}
        for m in sub:
            if m.startswith("pr_tft@") and not reachable[m.split("@")[1]]:
                models[m] = {"unreachable": True}
            else:
                models[m] = {k: summarize(point[m][k][0], draws[m][k], unc["ci"]) for k in draws[m]}

        def diff(a: str, b: str, k: str) -> dict[str, Any]:
            return summarize(point[a][k][0] - point[b][k][0], draws[a][k] - draws[b][k], unc["ci"])

        none = {"estimate": None, "ci_low": None, "ci_high": None}
        vs_twin = {k: diff("pr_tft", "twin_only", k) for k in ("rmse_60", "rmse_120", "mae_60", "mae_120")}
        vs_twin.update({k: diff(prim, "twin_only", k) if reachable[prim.split("@")[1]] else none for k in alert_keys})
        vs_pers = {k: diff("pr_tft", "persistence", k) for k in ("rmse_60", "rmse_120", "mae_60", "mae_120")}
        populations[pop_name] = {
            "patients": int(idx.size), "groups": {g: int((groups_all[idx] == g).sum()) for g in members},
            "monitored_onsets": int(sub["twin_only"]["monitored_onsets"].sum()),
            "models": models,
            "paired_differences": {"pr_tft_minus_twin_only": vs_twin, "pr_tft_minus_persistence": vs_pers},
        }
    gsel = np.isin(np.array(split_test.groups)[agg["patient"]], POPULATIONS["primary"])
    fsel = np.isin(np.array(split_test.groups)[fc["patient"]], POPULATIONS["primary"])
    risk = (agg["at_risk"] > 0) & grid
    extra = {
        "clarke_primary": {f"{h}min": T.clarke_at(fc["q"][fsel][..., T.MEDIAN_IDX], {k: v[fsel] for k, v in fc.items()}, h)
                           for h in (60, 120)},
        "hazard_primary": {
            "raw": T.hazard_discrimination(agg["p_cum"][risk & gsel], agg["onset_any"][risk & gsel]),
            "calibrated": T.hazard_discrimination(p_cal[risk & gsel], agg["onset_any"][risk & gsel]),
        },
        "interval_width_80_primary": {
            "raw": float((fc["q"][fsel][..., T.P90_IDX] - fc["q"][fsel][..., T.P10_IDX])[fc["y_mask"][fsel] > 0].mean()),
            "conformal": float((q_conf[fsel][..., T.P90_IDX] - q_conf[fsel][..., T.P10_IDX])[fc["y_mask"][fsel] > 0].mean()),
        },
    }
    primary = populations["primary"]
    selection = apply_selection_rule(rule, primary, reachable)
    s_rmse = primary["paired_differences"]["pr_tft_minus_persistence"]
    selection["pr_tft_beats_persistence"] = {k: _beats(s_rmse[k], "lower", rule["metrics"][k]["tie_tolerance"])
                                             for k in ("rmse_60", "rmse_120")}
    if manifest["run_kind"] != "full":
        selection["note"] = f"{manifest['run_kind']} run: pipeline check only, not evidence"

    report = {
        "schema": EVAL_SCHEMA,
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runtime_s": round(time.perf_counter() - started, 1),
        "provenance": {
            "evaluator_git": git, "training_git_sha": pre["git"]["git_sha"], "training_tree_dirty": pre["git"]["dirty"],
            "same_commit_as_training": git["git_sha"] == pre["git"]["git_sha"],
            "allow_source_mismatch": allow_source_mismatch,
            "run_dir": str(run_dir), "run_kind": manifest["run_kind"],
            "run_manifest_sha256": prov.sha256_file(manifest_path),
            "checkpoint_sha256": manifest["checkpoint"]["sha256"], "data_sha256": data,
            "split_sha256": pre["split_sha256"], **rule_hashes, "source_sha256": prov.source_hashes(),
        },
        "identity": {**ident, "normaliser_max_abs_diff": norm_diff, "calibration_distance": calib_diff,
                     "calibration_tolerance": CALIBRATION_TOLERANCE,
                     "meal_log_sha256": manifest["meal_log_sha256"]},
        "definitions": {
            "decision_times": "every 5-min step from 287 to n-1-24 with a current CGM value and past coverage >= "
                              f"{cfg.min_past_coverage}; no future-coverage filter",
            "alert": "raised when at risk (causal) and the trigger holds; at most one per 120 min",
            "pr_tft_trigger": "isotonic-calibrated P(onset within 120 min) >= threshold",
            "twin_only_trigger": "observed CGM up to t + twin forecast satisfy the spike rule within 120 min",
            "persistence": "forecast-accuracy baseline only; no alerting",
            "alert_precision": "alerts followed by an onset within 120 min / alerts raised",
            "event_sensitivity": "monitored onsets with >= 1 alert in the preceding 120 min / monitored onsets",
            "lead_time": "onset time - earliest alert in its 120-min warning window",
            "forecast_metrics": f"training anchor grid (stride {cfg.stride_steps}, eligible_anchors)",
            "bootstrap": f"paired, patient-level, stratified by diabetes status; {unc['resamples']} resamples; "
                         f"{int(100 * unc['ci'])}% percentile CI",
        },
        "operating_points": {"max_calibrated_probability": max_cal, "reachable": reachable,
                             "primary_threshold": rule["alerting"]["primary_threshold"]},
        "populations": populations,
        "primary_extra": extra,
        "selection": selection,
    }
    out_path.write_text(json.dumps(report, indent=2) + "\n")
    return report


def print_summary(r: dict[str, Any]) -> None:
    p = r["populations"]["primary"]
    m = p["models"]
    f = lambda d: "n/a" if d.get("estimate") is None else f"{d['estimate']:.3f} [{d['ci_low']:.3f}, {d['ci_high']:.3f}]"
    lines = [f"Primary population (Prediabetes + Type 2): {p['patients']} test patients, {p['monitored_onsets']} monitored onsets",
             f"  RMSE60  PR-TFT {f(m['pr_tft']['rmse_60'])} | twin {f(m['twin_only']['rmse_60'])} | persistence {f(m['persistence']['rmse_60'])}",
             f"  RMSE120 PR-TFT {f(m['pr_tft']['rmse_120'])} | twin {f(m['twin_only']['rmse_120'])} | persistence {f(m['persistence']['rmse_120'])}",
             f"  80% coverage raw {f(m['pr_tft']['coverage_80_raw'])} | conformal {f(m['pr_tft']['coverage_80_conformal'])}"]
    for k, v in m.items():
        if k.startswith("pr_tft@") or k == "twin_only":
            if v.get("unreachable"):
                lines.append(f"  {k}: unreachable after calibration")
            elif "event_sensitivity" in v:
                lines.append(f"  {k}: sensitivity {f(v['event_sensitivity'])}, precision {f(v['alert_precision'])}, "
                             f"false alerts/day {f(v['false_alerts_per_patient_day'])}, lead {f(v['lead_time_median_min'])} min")
    lines.append(f"Selection: {r['selection']['selected']} -- {r['selection']['reason']}")
    print("\n".join(lines))


def main() -> None:
    ap = argparse.ArgumentParser(description="Authoritative test-set evaluation of a PR-TFT run.")
    ap.add_argument("--run-dir", type=Path, required=True)
    ap.add_argument("--data-dir", type=Path, default=None, help="data location; files must match the run's hashes")
    ap.add_argument("--out", type=Path, default=None, help="default: <run-dir>/evaluation_report.json")
    ap.add_argument("--overwrite", action="store_true", help="replace an existing report")
    ap.add_argument("--allow-dirty", action="store_true", help="evaluate from an uncommitted tree (recorded)")
    ap.add_argument("--allow-source-mismatch", action="store_true",
                    help="evaluate with a different commit than the one that trained the run (recorded)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    out = args.out or args.run_dir / "evaluation_report.json"
    if out.exists() and not args.overwrite:
        raise FileExistsError(f"{out} exists; pass --overwrite to replace it")
    report = evaluate(args.run_dir, args.data_dir, args.allow_dirty, args.allow_source_mismatch, out)
    print_summary(report)
    LOG.info("report written to %s", out)


if __name__ == "__main__":
    main()

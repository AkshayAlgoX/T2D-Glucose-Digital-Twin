#!/usr/bin/env python3
"""evaluate_events_validation.py -- event-level early-warning evaluation on the validation patients.

The headline task is "warn about a glucose spike up to 2 hours ahead". evaluate_run.py scores
that on the sealed test split; this script applies the *same locked policy* to the validation
split, which is the only held-out partition that may be opened without a separate authorisation.

Locked inputs, none tuned here (backend/model_selection_rule.json):
  thresholds 0.35 / 0.60 on isotonic-calibrated P(onset within 120 min); an alert when the patient
  is at risk (causal flag) and the trigger holds, at most one per 120 min; detected onset = an alert
  within [onset - 120 min, onset - 5 min]; paired patient-level bootstrap stratified by diabetes
  status, 2000 resamples, 95 % CI, seed 20260930. Spike onsets use the Blueprint rule
  (train_pr_tft.detect_spike_onsets).

Decision times: every 5-min step from step 287 to n-1-24 with a current CGM value and enough past
coverage (evaluate_run.causal_decision_mask). Nothing after t is used to decide at t.

What is and is not independent:
  * the validation patients chose the checkpoint (early stopping on validation loss) and fitted the
    isotonic calibration, so the "as served" rows are development evidence, not an independent test;
  * the "cross-fitted" rows remove the calibration leak: validation patients are split into two
    folds (stratified by diabetes status, fixed seed), the isotonic map is refitted on one fold's
    training-grid anchors and applied to the other fold, and vice versa. The checkpoint choice
    still saw all validation patients.

Triggers compared under the same alert policy:
  pr_tft@th            calibrated hazard >= th (as served, and cross-fitted)
  pr_tft_median_rule   observed CGM up to t + PR-TFT median forecast contains a spike onset
  twin_only            observed CGM up to t + physiology-twin forecast contains a spike onset
  linear_trend_rule    observed CGM up to t + a straight-line extrapolation of the last 30 min
                       contains a spike onset (a parameter-free CGM-only baseline)

The test split is never loaded: only train (for the habit prior) and validation patients are read.

Usage (repo root)
    python backend/evaluate_events_validation.py --run-dir runs/pr_tft_ablation_arm_d \
        --out docs/evidence/event_eval/validation_event_report.json \
        --decisions docs/evidence/event_eval/validation_decisions.npz
    python backend/evaluate_events_validation.py --from-decisions docs/evidence/event_eval/validation_decisions.npz ...
        recomputes every metric from the saved per-decision triggers without the model.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import provenance as prov  # noqa: E402
import train_pr_tft as T  # noqa: E402
from evaluate_run import (HORIZON, POPULATIONS, _cfg_from_dict, bootstrap_weights,  # noqa: E402
                          causal_decision_mask, event_counts, forecast_meets_spike_rule, metric_draws,
                          raise_alerts, summarize)
from input_contract import STEP_MIN  # noqa: E402

LOG = logging.getLogger("evaluate_events_validation")
SCHEMA = "pr_tft_validation_event_evaluation/v1"
CROSSFIT_SEED = 20261021
TREND_STEPS = 6  # 30 min of CGM history for the straight-line baseline
CURVE_THRESHOLDS = tuple(round(x, 2) for x in np.arange(0.05, 1.0, 0.05))
EVENT_KEYS = ("event_sensitivity", "alert_precision", "alerts_per_patient_day", "false_alerts_per_patient_day",
              "lead_time_median_min")


# --------------------------------------------------------------------------- #
# Pure helpers (unit-tested in backend/tests/test_event_validation.py)
# --------------------------------------------------------------------------- #


def crossfit_folds(pids: list[str], groups: list[str], seed: int = CROSSFIT_SEED) -> dict[str, int]:
    """Two patient folds, stratified by diabetes status, from a fixed seed."""
    rng = np.random.default_rng(seed)
    fold: dict[str, int] = {}
    for g in sorted(set(groups)):
        members = sorted(p for p, gg in zip(pids, groups) if gg == g)
        order = rng.permutation(len(members))
        for rank, i in enumerate(order):
            fold[members[i]] = rank % 2
    return fold


def linear_trend_forecast(history: np.ndarray, steps: int = HORIZON, window: int = TREND_STEPS) -> np.ndarray | None:
    """Least-squares line through the last `window` + 1 finite readings (30 min), extended `steps` ahead.
    None when fewer than three of those readings are present."""
    h = np.asarray(history[-(window + 1):], dtype=float)
    x = np.arange(h.size, dtype=float)
    ok = np.isfinite(h)
    if ok.sum() < 3:
        return None
    slope, intercept = np.polyfit(x[ok], h[ok], 1)
    return intercept + slope * (h.size - 1 + np.arange(1, steps + 1))


def lead_time_summary(leads: list[list[float]]) -> dict[str, Any]:
    flat = np.array([v for vs in leads for v in vs], dtype=float)
    if flat.size == 0:
        return {"n": 0}
    q = np.percentile(flat, [10, 25, 50, 75, 90])
    return {"n": int(flat.size), "p10": float(q[0]), "p25": float(q[1]), "median": float(q[2]), "p75": float(q[3]),
            "p90": float(q[4]), "share_ge_30_min": float((flat >= 30).mean()), "share_ge_60_min": float((flat >= 60).mean()),
            "histogram_min": {f"{lo}-{lo + 25}": int(((flat >= lo) & (flat <= lo + 25)).sum())
                              for lo in (5, 35, 65, 95)}}


def stack_counts(rows: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {k: np.array([r[k] for r in rows], dtype=float)
                           for k in ("monitored_onsets", "detected_onsets", "alerts_raised", "true_alerts",
                                     "false_alerts", "patient_days")}
    out["lead_times_min"] = [r["lead_times_min"] for r in rows]
    return out


def events_for(trigger_by_patient: list[np.ndarray], at_risk_by_patient: list[np.ndarray],
               onset_by_patient: list[np.ndarray], bounds: list[tuple[int, int]]) -> list[dict[str, Any]]:
    return [event_counts(raise_alerts(trig, risk), onset, first, last)
            for trig, risk, onset, (first, last) in zip(trigger_by_patient, at_risk_by_patient, onset_by_patient, bounds)]


# --------------------------------------------------------------------------- #
# Model pass: per-decision triggers
# --------------------------------------------------------------------------- #


def model_decisions(run_dir: Path, limit: int | None = None) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    """Predict at every causal decision time of every validation patient; return per-decision arrays."""
    import torch  # noqa: F401  (imported here so --from-decisions needs no model stack)
    from evaluate_run import _predict, calibration_distance

    manifest = prov.load_json(run_dir / "run_manifest.json")
    pre = manifest["preflight"]
    cfg = T.validate_train_config(_cfg_from_dict(prov.load_json(run_dir / "config.json")))
    data = prov.verify_data(cfg.data_dir, {"files": pre["data_sha256"]})
    split = prov.load_json(run_dir / "split.json")
    if prov.sha256_json(split) != manifest["split_effective_sha256"]:
        raise prov.ProvenanceError("split.json does not match the run manifest")
    ckpt = run_dir / manifest["checkpoint"]["path"]
    if prov.sha256_file(ckpt) != manifest["checkpoint"]["sha256"]:
        raise prov.ProvenanceError(f"{ckpt} does not match the checkpoint hash recorded at training time")

    val_ids, train_ids = sorted(split["val"]), sorted(split["train"])
    if limit:  # smoke runs only; a limited run is labelled in its report
        val_ids = val_ids[:limit]
    if set(split["test"]) & (set(val_ids) | set(train_ids)):
        raise prov.ProvenanceError("test patients overlap train/validation")
    series = T.load_data(cfg, patient_ids=train_ids + val_ids)  # never the test split
    if set(series) & set(split["test"]):
        raise prov.ProvenanceError("a test patient was loaded")
    twin = T.make_twin(cfg)
    norm = T.Normalizer(**prov.load_json(run_dir / "normalization.json"))
    pop = T.population_habit([series[p] for p in train_ids])
    module = T.PRTFTModule.load_from_checkpoint(str(ckpt), map_location="cpu").eval()
    calib = T.Calibrators(**prov.load_json(run_dir / "calibration.json"))

    cols: dict[str, list[np.ndarray]] = {k: [] for k in ("patient", "t", "p_raw", "median_rule", "twin_rule",
                                                         "trend_rule", "grid", "at_risk_anchor", "onset_any")}
    hist_len = T.RISE_STEPS + 1
    grid_parts: list[dict[str, np.ndarray]] = []
    for i, pid in enumerate(val_ids):
        ps = series[pid]
        t_ok, _, _ = causal_decision_mask(ps, cfg)
        split_i = T.build_split([ps], {pid: t_ok}, twin, norm, pop, cfg)
        agg = _predict(module, split_i, cfg)
        ts = split_i.anchor_t.numpy()
        med = agg["q"][..., T.MEDIAN_IDX]
        med_rule = np.zeros(ts.size, bool)
        twin_rule = np.zeros(ts.size, bool)
        trend_rule = np.zeros(ts.size, bool)
        for j, t in enumerate(ts):
            if not ps.armed[t]:
                continue
            past = ps.cgm[t - hist_len + 1:t + 1]
            if med[j].max() >= T.SPIKE_LEVEL:
                med_rule[j] = forecast_meets_spike_rule(past, med[j])
            if agg["twin"][j].max() >= T.SPIKE_LEVEL:
                twin_rule[j] = forecast_meets_spike_rule(past, agg["twin"][j])
            line = linear_trend_forecast(ps.cgm[:t + 1])
            if line is not None and line.max() >= T.SPIKE_LEVEL:
                trend_rule[j] = forecast_meets_spike_rule(past, line)
        grid = np.isin(ts, T.eligible_anchors(ps, cfg))
        grid_parts.append({k: v[grid] for k, v in agg.items() if isinstance(v, np.ndarray) and v.shape[0] == ts.size})
        for k, v in (("patient", np.full(ts.size, i)), ("t", ts), ("p_raw", agg["p_cum"]), ("median_rule", med_rule),
                     ("twin_rule", twin_rule), ("trend_rule", trend_rule), ("grid", grid),
                     ("at_risk_anchor", agg["at_risk"]), ("onset_any", agg["onset_any"])):
            cols[k].append(np.asarray(v))
        LOG.info("%s (%d/%d): %d decision times", pid, i + 1, len(val_ids), ts.size)

    # Identity: the isotonic map refitted on validation training-grid predictions must reproduce calibration.json.
    pooled = {k: np.concatenate([g[k] for g in grid_parts]) for k in grid_parts[0]}
    refit = T.Calibrators.fit(pooled, cfg.interval_level)
    dist = calibration_distance(refit, calib)
    if limit is None and dist["hazard_map"] > 0.02:
        raise prov.ProvenanceError(f"calibration refit differs from calibration.json ({dist})")

    dec = {k: np.concatenate(v) for k, v in cols.items()}
    dec["pids"] = np.array(val_ids)
    dec["groups"] = np.array([series[p].group for p in val_ids])
    dec["n_steps"] = np.array([series[p].n for p in val_ids])
    dec["onset_steps"] = np.concatenate([np.flatnonzero(series[p].onset) for p in val_ids])
    dec["onset_owner"] = np.concatenate([np.full(int(series[p].onset.sum()), i) for i, p in enumerate(val_ids)])
    dec["armed"] = np.concatenate([series[p].armed for p in val_ids]).astype(bool)
    dec["first_last"] = np.array([causal_decision_mask(series[p], cfg)[1:] for p in val_ids])
    meta = {"run_dir": str(run_dir), "checkpoint_sha256": manifest["checkpoint"]["sha256"],
            "run_manifest_sha256": prov.sha256_file(run_dir / "run_manifest.json"),
            "split_sha256": pre["split_sha256"], "data_sha256": data, "calibration_refit_distance": dist,
            "git": prov.git_state()}
    return dec, meta


# --------------------------------------------------------------------------- #
# Metrics from per-decision triggers (no model needed)
# --------------------------------------------------------------------------- #


def crossfit_hazard(dec: dict[str, np.ndarray], folds: np.ndarray) -> np.ndarray:
    """Isotonic map fitted on the other fold's training-grid, at-risk anchors; applied to this fold."""
    from sklearn.isotonic import IsotonicRegression

    owner_fold = folds[dec["patient"]]
    fit_rows = dec["grid"] & (dec["at_risk_anchor"] > 0)
    out = np.empty_like(dec["p_raw"], dtype=float)
    for f in (0, 1):
        train = fit_rows & (owner_fold != f)
        sel = owner_fold == f
        if not sel.any():
            continue
        if not train.any():  # only in smoke runs with too few patients for two folds
            out[sel] = np.nan
            continue
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        iso.fit(dec["p_raw"][train], dec["onset_any"][train])
        out[sel] = iso.predict(dec["p_raw"][sel])
    return out


def evaluate_decisions(dec: dict[str, np.ndarray], calib: T.Calibrators, rule: dict[str, Any]) -> dict[str, Any]:
    pids = [str(p) for p in dec["pids"]]
    groups = [str(g) for g in dec["groups"]]
    n_pat = len(pids)
    fold_of = crossfit_folds(pids, groups)
    folds = np.array([fold_of[p] for p in pids])

    # Per-patient full-length arrays.
    offsets = np.concatenate(([0], np.cumsum(dec["n_steps"])))
    armed = [dec["armed"][offsets[i]:offsets[i + 1]] for i in range(n_pat)]
    onset = [np.zeros(int(n), bool) for n in dec["n_steps"]]
    for k, i in zip(dec["onset_steps"], dec["onset_owner"]):
        onset[int(i)][int(k)] = True
    bounds = [(int(a), int(b)) for a, b in dec["first_last"]]
    at_risk = []
    for i in range(n_pat):
        r = np.zeros(int(dec["n_steps"][i]), bool)
        ts = dec["t"][dec["patient"] == i]
        r[ts] = armed[i][ts]
        at_risk.append(r)

    def per_patient(values: np.ndarray) -> list[np.ndarray]:
        out = []
        for i in range(n_pat):
            trig = np.zeros(int(dec["n_steps"][i]), bool)
            sel = dec["patient"] == i
            trig[dec["t"][sel]] = values[sel]
            out.append(trig)
        return out

    p_served = calib.apply_hazard(dec["p_raw"])
    p_cross = crossfit_hazard(dec, folds)
    max_cal = float(max(calib.iso_y))
    triggers: dict[str, np.ndarray] = {}
    for th in rule["alerting"]["thresholds"]:
        triggers[f"pr_tft@{th:g}"] = p_served >= th
        triggers[f"pr_tft_crossfit@{th:g}"] = p_cross >= th
    triggers["pr_tft_median_rule"] = dec["median_rule"].astype(bool)
    triggers["twin_only"] = dec["twin_rule"].astype(bool)
    triggers["linear_trend_rule"] = dec["trend_rule"].astype(bool)

    counts = {name: stack_counts(events_for(per_patient(v), at_risk, onset, bounds)) for name, v in triggers.items()}

    unc = rule["uncertainty"]
    garr = np.array(groups)
    populations: dict[str, Any] = {}
    for pop_name, members in POPULATIONS.items():
        idx = np.flatnonzero(np.isin(garr, members))
        if idx.size == 0:
            continue
        sub = {m: {k: (v[idx] if isinstance(v, np.ndarray) else [v[i] for i in idx]) for k, v in s.items()}
               for m, s in counts.items()}
        w = bootstrap_weights(garr[idx].tolist(), unc["resamples"], unc["seed"])
        ones = np.ones((1, idx.size))
        point = {m: metric_draws(s, ones) for m, s in sub.items()}
        draws = {m: metric_draws(s, w) for m, s in sub.items()}
        models = {}
        for m, s in sub.items():
            models[m] = {k: summarize(point[m][k][0], draws[m][k], unc["ci"]) for k in EVENT_KEYS}
            models[m]["counts"] = {k: int(s[k].sum()) for k in ("monitored_onsets", "detected_onsets", "alerts_raised",
                                                                "true_alerts", "false_alerts")}
            models[m]["counts"]["missed_onsets"] = models[m]["counts"]["monitored_onsets"] - models[m]["counts"]["detected_onsets"]
            models[m]["patient_days"] = round(float(s["patient_days"].sum()), 2)
            models[m]["lead_time_distribution_min"] = lead_time_summary(s["lead_times_min"])

        def diff(a: str, b: str, k: str) -> dict[str, Any]:
            return summarize(point[a][k][0] - point[b][k][0], draws[a][k] - draws[b][k], unc["ci"])

        prim = f"pr_tft_crossfit@{rule['alerting']['primary_threshold']:g}"
        paired = {f"{prim}_minus_{b}": {k: diff(prim, b, k) for k in EVENT_KEYS[:4]}
                  for b in ("twin_only", "linear_trend_rule", "pr_tft_median_rule")}
        populations[pop_name] = {"patients": int(idx.size),
                                 "groups": {g: int((garr[idx] == g).sum()) for g in members},
                                 "models": models, "paired_differences": paired}

    # Descriptive operating curve on the cross-fitted hazard (no threshold is chosen from it).
    curve = []
    prim_idx = np.flatnonzero(np.isin(garr, POPULATIONS["primary"]))
    for th in CURVE_THRESHOLDS:
        c = stack_counts(events_for(per_patient(p_cross >= th), at_risk, onset, bounds))
        s = {k: (v[prim_idx] if isinstance(v, np.ndarray) else [v[i] for i in prim_idx]) for k, v in c.items()}
        pt = metric_draws(s, np.ones((1, prim_idx.size)))
        curve.append({"threshold": th, **{k: (None if not np.isfinite(pt[k][0]) else round(float(pt[k][0]), 4))
                                          for k in ("event_sensitivity", "alert_precision", "false_alerts_per_patient_day",
                                                    "lead_time_median_min")}})
    return {"populations": populations, "operating_curve_primary_crossfit": curve,
            "crossfit_folds": {p: int(fold_of[p]) for p in pids},
            "max_served_calibrated_probability": max_cal}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--run-dir", type=Path, default=Path("runs/pr_tft_ablation_arm_d"))
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--decisions", type=Path, help="write the per-decision triggers here (npz)")
    ap.add_argument("--from-decisions", type=Path, help="recompute metrics from a saved npz without the model")
    ap.add_argument("--limit", type=int, default=None, help="smoke run on the first N validation patients (not evidence)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    started = time.perf_counter()
    rule = prov.load_json(prov.BACKEND_DIR / "model_selection_rule.json")
    calib = T.Calibrators(**prov.load_json(args.run_dir / "calibration.json"))
    if args.from_decisions:
        z = np.load(args.from_decisions, allow_pickle=False)
        dec = {k: z[k] for k in z.files}
        meta = json.loads(str(dec.pop("meta_json")))
        meta["decisions_sha256"] = prov.sha256_file(args.from_decisions)
    else:
        dec, meta = model_decisions(args.run_dir, args.limit)
        meta["limited_to_patients"] = args.limit
        if args.decisions:
            args.decisions.parent.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(args.decisions, meta_json=np.array(json.dumps(meta)), **dec)
            meta["decisions_sha256"] = prov.sha256_file(args.decisions)
    result = evaluate_decisions(dec, calib, rule)
    report = {
        "schema": SCHEMA,
        "split": "validation (44 patients); the test split is never loaded",
        "independence": "Development evidence. Validation patients chose the checkpoint and fitted the served "
                        "isotonic calibration; 'pr_tft_crossfit' rows refit the isotonic map on the other patient "
                        "fold, removing the calibration leak but not the checkpoint-selection one. Synthetic data only.",
        "locked_policy": {"source": "backend/model_selection_rule.json",
                          "rule_sha256": prov.sha256_file(prov.BACKEND_DIR / "model_selection_rule.json"),
                          "alerting": rule["alerting"], "uncertainty": rule["uncertainty"]},
        "definitions": {
            "decision_times": "every 5-min step from 287 to n-1-24 with a current CGM value and enough past coverage",
            "spike_onset": "CGM >= 180 mg/dL after a >= 50 mg/dL rise within 60 min, staying >= 180 for 15 min; "
                           "re-armed after 30 min below 160 (train_pr_tft.detect_spike_onsets)",
            "matching_rule": "deterministic 1-to-1 alert-to-event matching: chronological by monitored onset, "
                           "each matched to earliest available alert in [onset - 120 min, onset - 5 min]",
            "detected_onset": "monitored onset matched 1-to-1 to an alert in its 120-min warning window",
            "missed_onset": "monitored onset with no unmatched alert in its 120-min warning window",
            "true_alert": "alert matched 1-to-1 to an eligible monitored onset",
            "false_alert": "alert not matched 1-to-1 to any monitored onset within the next 120 min",
            "linear_trend_rule": f"least-squares line through the last {TREND_STEPS * STEP_MIN} min of CGM, extended 120 min",
            "crossfit": f"2 patient folds stratified by diabetes status, seed {CROSSFIT_SEED}",
            "operating_curve": "descriptive only; no threshold is selected from it",
        },
        "provenance": meta,
        **result,
        "runtime_s": round(time.perf_counter() - started, 1),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    p = report["populations"]["primary"]["models"]
    for name, m in p.items():
        f = lambda d: "n/a" if d["estimate"] is None else f"{d['estimate']:.3f} [{d['ci_low']:.3f}, {d['ci_high']:.3f}]"
        LOG.info("%-24s sens %s | prec %s | FA/day %s | lead %s | %s", name, f(m["event_sensitivity"]),
                 f(m["alert_precision"]), f(m["false_alerts_per_patient_day"]), f(m["lead_time_median_min"]), m["counts"])


if __name__ == "__main__":
    main()

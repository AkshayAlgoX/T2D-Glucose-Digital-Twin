#!/usr/bin/env python3
"""twin_mode_selection.py -- reproducible S2/S3 twin-mode selection, validation patients only.

Runs the UKF in the candidate modes s2 and s3, and in oracle mode as a privileged reference,
on the validation patients of the frozen split, with exactly the inputs the PR-TFT training
pipeline uses (train_pr_tft.load_data: same per-patient meal-log corruption, ceil meal timing,
first-day resting HR). The selected mode is computed from these results by the locked
`twin_mode_selection` clause of model_selection_rule.json -- nothing is hard-coded -- and the
script exits with status 3 if the run config's twin_mode disagrees with the selection.

    python twin_mode_selection.py --config final_config.json [--out FILE] [--data-dir DIR]
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

import provenance as prov
import train_pr_tft as T
import ukf_twin as U

LOG = logging.getLogger("twin_mode_selection")
REPORT_SCHEMA = "s2_s3_validation_report/v2"


def metric_value(result: dict[str, Any], metric: str) -> float:
    if metric != "ukf_forecast_rmse_60min_mg_dl":
        raise ValueError(f"unsupported selection metric {metric!r}")
    return float(result["forecast_rmse_mg_dl"]["ukf"]["60min"])


def select_twin_mode(results: dict[str, dict[str, Any]], clause: dict[str, Any]) -> dict[str, Any]:
    """Apply the rule clause: lower metric wins; within the tie tolerance, mean NIS closer to 1
    wins; an exact tie goes to the clause's final tie-break."""
    a, b = clause["candidates"]
    if clause["direction"] != "lower" or clause["tie_break"] != "mean_nis_closest_to_1":
        raise ValueError("unsupported twin_mode_selection clause")
    va, vb = metric_value(results[a], clause["metric"]), metric_value(results[b], clause["metric"])
    values = {a: va, b: vb}
    if abs(va - vb) > clause["tie_tolerance_mg_dl"]:
        winner = a if va < vb else b
        reason = f"{clause['metric']}: {winner} {values[winner]:.3f} vs {values[b if winner == a else a]:.3f} mg/dL"
    else:
        da = abs(results[a]["consistency"]["mean_nis"] - 1.0)
        db = abs(results[b]["consistency"]["mean_nis"] - 1.0)
        if abs(da - db) > 1e-9:
            winner = a if da < db else b
            reason = (f"{clause['metric']} tied within {clause['tie_tolerance_mg_dl']} mg/dL; "
                      f"mean NIS closer to 1 ({winner})")
        else:
            winner = clause["final_tie_break"]
            reason = "metric and NIS tied; final tie-break"
    return {"selected_mode": winner, "reason": reason, "metric_values": values}


def truth_by_patient(data_dir: str, series: dict[str, T.PatientSeries]) -> dict[str, np.ndarray]:
    """True plasma glucose on each patient's 5-min grid (diagnostic only; never a selection input)."""
    truth = pd.read_csv(Path(data_dir) / prov.TRUTH_FILE, parse_dates=["timestamp"],
                        usecols=["patient_id", "timestamp", "plasma_glucose"])
    truth = truth[truth["patient_id"].isin(series)]
    out = {}
    for pid, g in truth.groupby("patient_id"):
        g = g.drop_duplicates("timestamp").set_index("timestamp")["plasma_glucose"]
        out[pid] = g.reindex(series[pid].stamps).to_numpy(float)
    return out


def build_report(config: Path, data_dir: Path | None, allow_dirty: bool) -> dict[str, Any]:
    run = T.load_run_config(config, data_dir=data_dir)
    record, split = T.preflight(run, allow_dirty=allow_dirty)
    manifest = prov.load_json(run.inputs["data_manifest"])
    truth_sha = prov.verify_data(run.cfg.data_dir, manifest, include_truth=True)[prov.TRUTH_FILE]
    rule = prov.load_json(run.inputs["model_selection_rule"])
    clause = rule["twin_mode_selection"]
    val = sorted(split["val"])
    if set(val) & (set(split["train"]) | set(split["test"])):
        raise prov.SplitIntegrityError("validation patients overlap train/test")

    realistic = T.load_data(dataclasses.replace(run.cfg, twin_mode="s2"), patient_ids=val)
    oracle = T.load_data(dataclasses.replace(run.cfg, twin_mode="oracle"), patient_ids=val)
    meal_sha = T.meal_log_sha256(realistic)
    if T.meal_log_sha256(oracle) != meal_sha:
        raise RuntimeError("oracle and realistic loads produced different meal logs")
    truth = truth_by_patient(run.cfg.data_dir, realistic)

    results = {}
    for mode in (*clause["candidates"], "oracle"):
        src = oracle if mode == "oracle" else realistic
        LOG.info("UKF mode=%s on %d validation patients", mode, len(val))
        results[mode] = U.validate_series([src[p] for p in val], mode, truth)
    selection = select_twin_mode({m: results[m] for m in clause["candidates"]}, clause)
    return {
        "schema": REPORT_SCHEMA,
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "evaluation_scope": "validation_split_only",
        "validation_patient_count": len(val),
        "validation_patient_ids": val,
        "pipeline": "train_pr_tft.load_data -> ukf_twin.UKFTwinPrior inputs (training pipeline)",
        "meal_log_sha256": meal_sha,
        "provenance": {**record, "truth_sha256": truth_sha},
        "rule_clause": clause,
        "modes": results,
        "decision_rule": selection,
        "config_twin_mode": run.cfg.twin_mode,
        "config_consistent_with_selection": run.cfg.twin_mode == selection["selected_mode"],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="S2/S3 twin-mode selection on validation patients.")
    ap.add_argument("--config", type=Path, required=True)
    ap.add_argument("--data-dir", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=Path("runs/twin_mode_selection/s2_s3_validation_report.json"))
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--allow-dirty", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    if args.out.exists() and not args.overwrite:
        raise FileExistsError(f"{args.out} exists; pass --overwrite to replace it")
    report = build_report(args.config, args.data_dir, args.allow_dirty)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    sel = report["decision_rule"]
    for m, r in report["modes"].items():
        print(f"{m:7s} RMSE60 {r['forecast_rmse_mg_dl']['ukf']['60min']:.2f} mg/dL | mean NIS {r['consistency']['mean_nis']:.3f}"
              f" | persistence RMSE60 {r['forecast_rmse_mg_dl']['persistence']['60min']:.2f}")
    print(f"selected: {sel['selected_mode']} ({sel['reason']}); config twin_mode={report['config_twin_mode']}; "
          f"report: {args.out}")
    if not report["config_consistent_with_selection"]:
        sys.exit(3)


if __name__ == "__main__":
    main()

"""Validation event-level evaluation: fixed folds, the parameter-free trend baseline, the locked
alert policy applied unchanged, and that the committed report can be recomputed from its saved
per-decision triggers without the model."""

from __future__ import annotations

import ast
import json
from pathlib import Path

import numpy as np
import pytest

import evaluate_events_validation as V
import train_pr_tft as T
from conftest import BACKEND

REPO = BACKEND.parent
EVIDENCE = REPO / "docs" / "evidence" / "event_eval"


def test_crossfit_folds_are_fixed_balanced_and_stratified():
    pids = [f"P{i:03d}" for i in range(12)]
    groups = ["Healthy"] * 4 + ["Prediabetes"] * 5 + ["Type 2"] * 3
    a, b = V.crossfit_folds(pids, groups), V.crossfit_folds(list(reversed(pids)), list(reversed(groups)))
    assert a == b  # independent of input order
    for g in set(groups):
        sizes = [sum(1 for p, gg in zip(pids, groups) if gg == g and a[p] == f) for f in (0, 1)]
        assert abs(sizes[0] - sizes[1]) <= 1


def test_linear_trend_forecast_extends_the_last_30_minutes():
    hist = np.array([100, 102, 104, 106, 108, 110, 112], dtype=float)  # +2 mg/dL per 5 min
    line = V.linear_trend_forecast(hist)
    assert line.shape == (T.HORIZON,)
    assert line[0] == pytest.approx(114.0)
    assert line[-1] == pytest.approx(112.0 + 2.0 * T.HORIZON)
    assert V.linear_trend_forecast(np.array([np.nan] * 5 + [100.0, 101.0])) is None


def test_trend_baseline_uses_only_the_past():
    hist = np.r_[np.full(20, 120.0), np.linspace(120, 150, 7)]
    full = np.r_[hist, np.full(30, 400.0)]
    assert np.array_equal(V.linear_trend_forecast(hist), V.linear_trend_forecast(full[: hist.size]))


def test_lead_time_summary():
    s = V.lead_time_summary([[120.0, 60.0], [], [5.0]])
    assert s["n"] == 3 and s["median"] == 60.0
    assert s["share_ge_30_min"] == pytest.approx(2 / 3)
    assert sum(s["histogram_min"].values()) == 3
    assert V.lead_time_summary([[]]) == {"n": 0}


def test_script_never_names_the_test_split_for_loading():
    src = (BACKEND / "evaluate_events_validation.py").read_text()
    tree = ast.parse(src)
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "load_data"]
    assert len(calls) == 1
    assert "train_ids + val_ids" in ast.unparse(calls[0])


@pytest.mark.skipif(not (EVIDENCE / "validation_decisions.npz").exists(), reason="committed decisions absent")
def test_committed_report_recomputes_from_saved_decisions(tmp_path):
    rule = json.loads((BACKEND / "model_selection_rule.json").read_text())
    report = json.loads((EVIDENCE / "validation_event_report.json").read_text())
    calib = T.Calibrators(**json.loads((REPO / "runs/pr_tft_ablation_arm_d/calibration.json").read_text()))
    z = np.load(EVIDENCE / "validation_decisions.npz", allow_pickle=False)
    dec = {k: z[k] for k in z.files if k != "meta_json"}
    again = V.evaluate_decisions(dec, calib, rule)
    assert again["populations"] == json.loads(json.dumps(report["populations"]))
    assert again["operating_curve_primary_crossfit"] == report["operating_curve_primary_crossfit"]
    assert report["locked_policy"]["alerting"] == rule["alerting"]
    assert report["provenance"]["limited_to_patients"] is None
    assert len(dec["pids"]) == 44

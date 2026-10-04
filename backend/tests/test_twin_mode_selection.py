"""S2/S3 selection is computed from validation results by the locked rule clause, on
validation patients only, with the training pipeline's meal logs."""

from __future__ import annotations

import dataclasses
import json

import train_pr_tft as T
import twin_mode_selection as S
from conftest import BACKEND

CLAUSE = json.loads((BACKEND / "model_selection_rule.json").read_text())["twin_mode_selection"]


def result(rmse60: float, nis: float) -> dict:
    return {"forecast_rmse_mg_dl": {"ukf": {"60min": rmse60}}, "consistency": {"mean_nis": nis}}


def test_selection_is_computed_from_results():
    assert S.select_twin_mode({"s2": result(25.83, 1.298), "s3": result(25.40, 1.274)}, CLAUSE)["selected_mode"] == "s3"
    assert S.select_twin_mode({"s2": result(25.40, 1.298), "s3": result(25.83, 1.274)}, CLAUSE)["selected_mode"] == "s2"


def test_tie_break_and_final_tie_break():
    tie = {"s2": result(25.40, 1.30), "s3": result(25.45, 1.10)}  # within 0.1 mg/dL
    assert S.select_twin_mode(tie, CLAUSE)["selected_mode"] == "s3"  # NIS closer to 1
    exact = {"s2": result(25.40, 1.20), "s3": result(25.40, 1.20)}
    assert S.select_twin_mode(exact, CLAUSE)["selected_mode"] == CLAUSE["final_tie_break"] == "s2"


def test_clause_candidates_and_scope():
    assert CLAUSE["candidates"] == ["s2", "s3"] and CLAUSE["direction"] == "lower"
    assert "validation" in CLAUSE["scope"]


def test_all_modes_see_the_same_meal_logs(run_config, frozen_split, cohort):
    pids = frozen_split["val"][:4]
    logs = {m: T.meal_log_sha256(T.load_data(dataclasses.replace(run_config.cfg, twin_mode=m), patient_ids=pids))
            for m in ("s2", "s3", "oracle")}
    assert len(set(logs.values())) == 1
    # a patient's log does not depend on which other patients are loaded
    assert T.meal_log_sha256({p: cohort[p] for p in pids}) == logs["s3"]

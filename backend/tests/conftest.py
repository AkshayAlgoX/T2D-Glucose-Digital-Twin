"""Shared fixtures. Tests import backend modules by file name, exactly as the scripts do, so
the suite runs the same from the repository root or from backend/.

The locked dataset is required: its location is T2D_DATA_DIR or, by default, train.data_dir of
final_config.json. If it is missing the data-dependent tests fail rather than skip."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

import train_pr_tft as T  # noqa: E402

FINAL_CONFIG = BACKEND / "final_config.json"


def locked_data_dir() -> Path:
    return Path(os.environ.get("T2D_DATA_DIR") or json.loads(FINAL_CONFIG.read_text())["train"]["data_dir"])


@pytest.fixture(scope="session")
def real_data_dir() -> Path:
    d = locked_data_dir()
    if not (d / "patient_cgm_telemetry.csv").is_file():
        pytest.fail(f"locked dataset not found at {d}; set T2D_DATA_DIR")
    return d


@pytest.fixture(scope="session")
def run_config(real_data_dir):
    return T.load_run_config(FINAL_CONFIG, data_dir=real_data_dir)


@pytest.fixture(scope="session")
def frozen_split() -> dict[str, list[str]]:
    return json.loads((BACKEND / "split_293.json").read_text())


@pytest.fixture(scope="session")
def cohort(run_config):
    """The active cohort through the realistic (s3) firewall, loaded once."""
    return T.load_data(run_config.cfg)

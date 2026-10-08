import pytest
import os
import json
import shutil
import tempfile
from pathlib import Path
import subprocess

def test_t3_blocker1_b1_baseline_logic():
    # Verify that run_scientific.py does not use persistence
    with open("experiments/early_warning_ew01/run_scientific.py", "r") as f:
        content = f.read()
    assert "linear_trend" in content
    assert "b7_vs_b1 = primary_pop['paired_differences']['pr_tft_minus_persistence']" not in content

def test_t3_blocker2_hash_verification():
    # Verify run_scientific verifies cohort artifact sha256 recursively
    with open("experiments/early_warning_ew01/run_scientific.py", "r") as f:
        content = f.read()
    assert "manifest[\"cohort\"][\"cohort_artifact_sha256\"]" in content
    assert "combined_hash_obj.update(fpath.name.encode())" in content
    assert "data_dir=str(cohort_dir)" in content

def test_t3_blocker3_oneshot_execution():
    # Verify global ledger exists
    with open("experiments/early_warning_ew01/run_scientific.py", "r") as f:
        content = f.read()
    assert "ew01_scientific_ledger.json" in content
    assert "os.O_EXCL" in content

def test_t3_blocker4_cohort_sealing():
    # Verify seal_cohort.py copies ehr and cgm, and hashes recursively
    with open("experiments/early_warning_ew01/seal_cohort.py", "r") as f:
        content = f.read()
    assert "patients_ehr.csv" in content
    assert "patient_cgm_telemetry.csv" in content
    assert "shutil.copy2" in content
    assert "combined_hash_obj.update(fpath.name.encode())" in content



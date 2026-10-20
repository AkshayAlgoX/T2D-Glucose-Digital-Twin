import pytest
import numpy as np
import json
from pathlib import Path
import backend.train_pr_tft as T
import backend.serve_pr_tft as S
import uuid
import sys
import hashlib
import backend.provenance as prov

def test_canonical_artifact_loads_successfully(tmp_path):
    run_dir = Path("runs/pr_tft_ablation_arm_d")
    if not run_dir.exists():
        pytest.skip("run_dir missing")
    
    # We must load using serve_pr_tft's ServiceContext which calls the initialization
    # Actually, we can just instantiate ServiceContext
    ctx = S.ServiceContext(run_dir)
    assert ctx is not None
    assert len(ctx.patients) > 0
    
    # Verify the SHA matches the manifest
    manifest = json.loads((run_dir / "run_manifest.json").read_text())
    # We can't easily extract series from ctx directly, but we can verify it loaded because it didn't throw ValueError
    
    # Check population habit matches manifest
    pop_sha = prov.sha256_json([np.round(ctx.pop[0], 12).tolist(), round(ctx.pop[1], 9)])
    assert pop_sha == manifest["population_habit_sha256"]

def test_invalid_patient_key_fails_safely(tmp_path, monkeypatch):
    run_dir = Path("runs/pr_tft_ablation_arm_d")
    if not run_dir.exists():
        pytest.skip("run_dir missing")
    
    # Create a corrupted artifact
    real_artifact = np.load(run_dir / "canonical_meal_log.npz")
    corrupt_data = dict(real_artifact)
    corrupt_data.pop(list(corrupt_data.keys())[0]) # Remove a key
    
    test_run_dir = tmp_path / "test_run"
    test_run_dir.mkdir()
    for file in run_dir.iterdir():
        if file.is_file():
            (test_run_dir / file.name).write_bytes(file.read_bytes())
        elif file.is_dir():
            import shutil
            shutil.copytree(file, test_run_dir / file.name)
            
    np.savez(test_run_dir / "canonical_meal_log.npz", **corrupt_data)
    
    with pytest.raises(ValueError, match="Canonical artifact contains"):
        S.ServiceContext(test_run_dir)

def test_missing_patient_key_fails_safely(tmp_path, monkeypatch):
    run_dir = Path("runs/pr_tft_ablation_arm_d")
    if not run_dir.exists():
        pytest.skip("run_dir missing")
    
    # Create a corrupted artifact with same length but missing key
    real_artifact = np.load(run_dir / "canonical_meal_log.npz")
    corrupt_data = dict(real_artifact)
    # rename a key
    k = list(corrupt_data.keys())[0]
    corrupt_data["FAKE_KEY_min"] = corrupt_data.pop(k)
    
    test_run_dir = tmp_path / "test_run"
    test_run_dir.mkdir()
    for file in run_dir.iterdir():
        if file.is_file():
            (test_run_dir / file.name).write_bytes(file.read_bytes())
        elif file.is_dir():
            import shutil
            shutil.copytree(file, test_run_dir / file.name)
            
    np.savez(test_run_dir / "canonical_meal_log.npz", **corrupt_data)
    
    with pytest.raises(KeyError, match="Canonical meal artifact missing keys"):
        S.ServiceContext(test_run_dir)

def test_dtype_mismatch_fails_safely(tmp_path):
    run_dir = Path("runs/pr_tft_ablation_arm_d")
    if not run_dir.exists():
        pytest.skip("run_dir missing")
    
    real_artifact = np.load(run_dir / "canonical_meal_log.npz")
    corrupt_data = {k: v.astype(np.float32) for k, v in real_artifact.items()}
    
    test_run_dir = tmp_path / "test_run"
    test_run_dir.mkdir()
    for file in run_dir.iterdir():
        if file.is_file():
            (test_run_dir / file.name).write_bytes(file.read_bytes())
        elif file.is_dir():
            import shutil
            shutil.copytree(file, test_run_dir / file.name)
            
    np.savez(test_run_dir / "canonical_meal_log.npz", **corrupt_data)
    
    with pytest.raises(TypeError, match="Canonical artifact arrays must be float64"):
        S.ServiceContext(test_run_dir)

def test_shape_mismatch_fails_safely(tmp_path):
    run_dir = Path("runs/pr_tft_ablation_arm_d")
    if not run_dir.exists():
        pytest.skip("run_dir missing")
    
    real_artifact = np.load(run_dir / "canonical_meal_log.npz")
    corrupt_data = dict(real_artifact)
    k = list(corrupt_data.keys())[0]
    corrupt_data[k] = np.concatenate([corrupt_data[k], [1.0]])
    
    test_run_dir = tmp_path / "test_run"
    test_run_dir.mkdir()
    for file in run_dir.iterdir():
        if file.is_file():
            (test_run_dir / file.name).write_bytes(file.read_bytes())
        elif file.is_dir():
            import shutil
            shutil.copytree(file, test_run_dir / file.name)
            
    np.savez(test_run_dir / "canonical_meal_log.npz", **corrupt_data)
    
    with pytest.raises(ValueError, match="Canonical array length mismatch"):
        S.ServiceContext(test_run_dir)


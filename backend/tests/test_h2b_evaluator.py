import json
import numpy as np
if not hasattr(np, "long"):
    np.long = int
if not hasattr(np, "ulong"):
    np.ulong = int
import sys
import types
if not hasattr(np, "exceptions"):
    np.exceptions = types.ModuleType("exceptions")
    sys.modules["numpy.exceptions"] = np.exceptions
if not hasattr(np.exceptions, "RankWarning"):
    class RankWarning(UserWarning): pass
    np.exceptions.RankWarning = RankWarning
from pathlib import Path
import tempfile
import hashlib
import os

from evaluate_h2b import evaluate_h2b, IdentityError, sha256_file
import train_pr_tft as T
import evaluate_run as ER

def create_synthetic_artifact(path: Path, pids: list[str]):
    data = {"h2b_schema": "v1", "pids": np.array(pids)}
    series = {}
    for pid in pids:
        # Minimum required to pass build_split and evaluation
        data[f"{pid}/group"] = "Prediabetes"
        static_feats = {k: 0.0 for k in T.get_static_features("s3")}
        static_feats.update({"age": 50, "bmi": 25})
        data[f"{pid}/static_raw"] = json.dumps(static_feats)
        
        # 1 day of 5-min intervals
        n = 288
        stamps = np.arange(np.datetime64("2026-01-01"), np.datetime64("2026-01-02"), np.timedelta64(5, 'm'))
        data[f"{pid}/stamps"] = stamps.astype("datetime64[ns]")
        
        cgm = np.full(n, 100.0)
        cgm[0] = np.nan
        data[f"{pid}/cgm"] = cgm
        data[f"{pid}/cgm_ff"] = np.nan_to_num(cgm, nan=100.0)
        data[f"{pid}/hr"] = np.full(n, 70.0)
        data[f"{pid}/hrv"] = np.full(n, 30.0)
        data[f"{pid}/steps"] = np.zeros(n)
        data[f"{pid}/asleep"] = np.zeros(n)
        
        # Deterministic meal
        data[f"{pid}/meal_min"] = np.array([60.0])
        data[f"{pid}/meal_carbs"] = np.array([45.0])
        
        data[f"{pid}/gb"] = 100.0
        data[f"{pid}/k_base"] = 0.01
        data[f"{pid}/tmax"] = 40.0
        data[f"{pid}/vg"] = 150.0
        
        data[f"{pid}/onset"] = np.zeros(n, dtype=bool)
        data[f"{pid}/armed"] = np.ones(n, dtype=bool)

        ps = T.PatientSeries(
            pid=pid, group="Prediabetes", stamps=stamps, cgm=data[f"{pid}/cgm"], cgm_ff=data[f"{pid}/cgm_ff"],
            hr=data[f"{pid}/hr"], hrv=data[f"{pid}/hrv"], steps=data[f"{pid}/steps"], asleep=data[f"{pid}/asleep"],
            meal_min=data[f"{pid}/meal_min"], meal_carbs=data[f"{pid}/meal_carbs"],
            static_raw=static_feats, gb=100.0, k_base=0.01, tmax=40.0, vg=150.0,
            onset=data[f"{pid}/onset"], armed=data[f"{pid}/armed"]
        )
        series[pid] = ps
        
    np.savez(path, **data)
    meal_hash = T.meal_log_sha256(series)
    return meal_hash

def h2b_setup():
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        run_dir = tdp / "run_dir"
        run_dir.mkdir()
        
        # mock checkpoint
        ckpt_dir = run_dir / "checkpoints"
        ckpt_dir.mkdir()
        ckpt_path = ckpt_dir / "model.ckpt"
        ckpt_path.write_text("fake_weights")
        
        # mock config
        (run_dir / "config.json").write_text(json.dumps({
            "data_dir": "dummy", "out_dir": "dummy",
            "twin_base": "habit", "twin": "linear", "twin_mode": "s3",
            "stride_steps": 3, "min_past_coverage": 0.7, "min_target_coverage": 0.5,
            "interval_level": 0.8, "alert_thresholds": [0.35, 0.6]
        }))
        
        # mock normalization
        (run_dir / "normalization.json").write_text(json.dumps({
            "glu_mean": 120.0, "glu_std": 30.0,
            "past_mean": {k: 0.0 for k in T.PAST_FEATURES},
            "past_std": {k: 1.0 for k in T.PAST_FEATURES},
            "static_mean": {k: 0.0 for k in T.get_static_features("s3")},
            "static_std": {k: 1.0 for k in T.get_static_features("s3")},
            "carbs_std": 20.0
        }))
        
        (run_dir / "calibration.json").write_text(json.dumps({
            "conformal_mg_dl": [10.0] * 24,
            "iso_x": [0.0, 1.0], "iso_y": [0.0, 1.0]
        }))
        
        # mock split
        (run_dir / "split.json").write_text(json.dumps({
            "train": ["p1"], "val": ["p1"], "test": ["p1"]
        }))
        
        # mock population habit
        np.savez(run_dir / "canonical_population_habit.npz", profile=np.ones(T.BINS_PER_DAY)/T.BINS_PER_DAY, mean_carbs=40.0)

        # Artifact
        artifact_path = tdp / "cohort.npz"
        meal_hash = create_synthetic_artifact(artifact_path, ["p1"])
        
        manifest_path = tdp / "h2b_manifest.json"
        manifest_data = {
            "h2b_protocol_version": "v2.4",
            "cohort_id": "synthetic_1",
            "run_dir": str(run_dir),
            "model": {
                "checkpoint_name": "model.ckpt",
                "checkpoint_sha256": sha256_file(ckpt_path)
            },
            "artifacts": {
                "cohort_npz": {
                    "path": "cohort.npz",
                    "sha256": sha256_file(artifact_path)
                }
            },
            "hashes": {
                "meal_log_sha256": meal_hash
            },
            "patient_ordering": ["p1"],
            "metric_config": {
                "thresholds": [0.35, 0.6]
            }
        }
        manifest_path.write_text(json.dumps(manifest_data))
        
        yield tdp, manifest_path, artifact_path, run_dir

def test_h2b_valid_synthetic_load(h2b_setup, monkeypatch):
    tdp, manifest_path, artifact_path, run_dir = h2b_setup
    
    # Mock inference to avoid loading full PR-TFT model for unit tests
    def mock_predict(module, split_test, cfg):
        a = split_test.anchor_t.shape[0]
        return {
            "q": np.full((a, T.HORIZON, 7), 100.0),
            "p_cum": np.full(a, 0.1),
            "onset_any": np.zeros(a),
            "twin": np.full((a, T.HORIZON), 100.0),
            "g0": np.full(a, 100.0),
            "at_risk": np.ones(a),
            "y": np.full((a, T.HORIZON), 100.0),
            "y_mask": np.ones((a, T.HORIZON), dtype=bool),
            "patient": split_test.anchor_patient.numpy()
        }
    monkeypatch.setattr(T, "predict", mock_predict)
    monkeypatch.setattr("evaluate_h2b.causal_decision_mask", lambda ps, cfg: (np.array([146]), 143, 263))
    monkeypatch.setattr("evaluate_h2b._predict", mock_predict)
    monkeypatch.setattr(T.PRTFTModule, "load_from_checkpoint", lambda *a, **kw: type("MockMod", (), {"eval": lambda s: s})())
    
    out_path = tdp / "out.json"
    report = evaluate_h2b(manifest_path, out_path)
    
    assert report["schema"] == "h2b_research_evaluation/v1"
    assert "rmse_60" in report["populations"].get("all", {}).get("models", {}).get("pr_tft", {})

def test_h2b_wrong_hash_fails(h2b_setup):
    tdp, manifest_path, artifact_path, run_dir = h2b_setup
    # Tamper with artifact
    with open(artifact_path, "ab") as f:
        f.write(b"tamper")
        
    try:
        evaluate_h2b(manifest_path, tdp / "out.json")
        assert False, "Expected IdentityError"
    except IdentityError as e:
        assert "H2B Artifact hash mismatch" in str(e)

def test_h2b_missing_artifact_fails(h2b_setup):
    tdp, manifest_path, artifact_path, run_dir = h2b_setup
    os.remove(artifact_path)
    
    try:
        evaluate_h2b(manifest_path, tdp / "out.json")
        assert False, "Expected IdentityError"
    except IdentityError as e:
        assert "Missing H2B artifact" in str(e)

def test_h2b_schema_mismatch_fails(h2b_setup):
    tdp, manifest_path, artifact_path, run_dir = h2b_setup
    data = json.loads(manifest_path.read_text())
    data["h2b_protocol_version"] = "v1.0" # Unsupported
    manifest_path.write_text(json.dumps(data))
    
    try:
        evaluate_h2b(manifest_path, tdp / "out.json")
        assert False, "Expected IdentityError"
    except IdentityError as e:
        assert "Unsupported H2B protocol version" in str(e)

def test_h2b_ordering_mismatch_fails(h2b_setup):
    tdp, manifest_path, artifact_path, run_dir = h2b_setup
    data = json.loads(manifest_path.read_text())
    data["patient_ordering"] = ["p2"] # Mismatch
    manifest_path.write_text(json.dumps(data))
    
    try:
        evaluate_h2b(manifest_path, tdp / "out.json")
        assert False, "Expected IdentityError"
    except IdentityError as e:
        assert "Patient IDs in artifact do not match manifest ordering" in str(e)

def test_h2b_no_evaluator_modifications():
    # Ensure evaluate_run.py hasn't been changed to accommodate H2B
    import inspect
    src = inspect.getsource(ER.evaluate)
    assert "h2b" not in src.lower(), "evaluate_run.py should not contain H2B specific logic"

if __name__ == "__main__":
    print("Running tests manually...")
    
    # We need a manual runner for the fixture
    class MockMonkeypatch:
        def __init__(self):
            self.old = {}
        def setattr(self, obj, name_or_val=None, value=None):
            if isinstance(obj, str):
                import importlib
                mod_name, attr = obj.rsplit(".", 1)
                mod = importlib.import_module(mod_name)
                self.old[obj] = (mod, attr, getattr(mod, attr, None))
                setattr(mod, attr, name_or_val)
            else:
                self.old[(obj, name_or_val)] = (obj, name_or_val, getattr(obj, name_or_val, None))
                setattr(obj, name_or_val, value)
        def undo(self):
            for (obj, name, old_val) in self.old.values():
                if old_val is None:
                    delattr(obj, name)
                else:
                    setattr(obj, name, old_val)

    # run h2b_setup fixture manually
    gen = h2b_setup()
    setup_data = next(gen)
    
    try:
        mp = MockMonkeypatch()
        test_h2b_valid_synthetic_load(setup_data, mp)
        mp.undo()
        print("test_h2b_valid_synthetic_load passed")
        
        test_h2b_wrong_hash_fails(setup_data)
        print("test_h2b_wrong_hash_fails passed")
        
        test_h2b_missing_artifact_fails(setup_data)
        print("test_h2b_missing_artifact_fails passed")
        
        # Restore artifact for next tests
        create_synthetic_artifact(setup_data[2], ["p1"])
        
        test_h2b_schema_mismatch_fails(setup_data)
        print("test_h2b_schema_mismatch_fails passed")
        
        # Restore manifest for next test
        import json
        man_data = json.loads(setup_data[1].read_text())
        man_data["h2b_protocol_version"] = "v2.4"
        setup_data[1].write_text(json.dumps(man_data))
        
        test_h2b_ordering_mismatch_fails(setup_data)
        print("test_h2b_ordering_mismatch_fails passed")
        
        test_h2b_no_evaluator_modifications()
        print("test_h2b_no_evaluator_modifications passed")
        
    finally:
        try:
            next(gen)
        except StopIteration:
            pass
    print("All manual tests passed!")

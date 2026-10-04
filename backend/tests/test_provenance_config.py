"""Input locks, source provenance and the run config: tampering, wrong data paths, dirty
trees and incomplete or unsafe configs are refused before any training or evaluation."""

from __future__ import annotations

import dataclasses
import json
import shutil
import subprocess
import sys

import pytest

import provenance as prov
import train_pr_tft as T
from conftest import BACKEND, FINAL_CONFIG

PY = sys.executable


def write_config(tmp_path, mutate) -> str:
    """A copy of final_config.json with absolute input paths, mutated by `mutate(dict)`."""
    raw = json.loads(FINAL_CONFIG.read_text())
    for key in T.INPUT_FILE_KEYS:
        raw["inputs"][key] = str(BACKEND / raw["inputs"][key])
    mutate(raw)
    path = tmp_path / "cfg.json"
    path.write_text(json.dumps(raw))
    return str(path)


# --------------------------------------------------------------------------- #
# Data and split identity
# --------------------------------------------------------------------------- #


def test_committed_manifest_matches_the_locked_dataset(real_data_dir):
    manifest = prov.load_json(BACKEND / "data_manifest.json")
    has_truth = (real_data_dir / prov.TRUTH_FILE).is_file()
    got = prov.verify_data(real_data_dir, manifest, include_truth=has_truth)
    expected_files = {
        "patients_ehr.csv",
        "patient_cgm_telemetry.csv",
    } | ({"patient_cgm_truth.csv"} if has_truth else set())
    assert set(got) == expected_files
    split = prov.verify_split(BACKEND / "split_293.json", manifest)
    assert {k: len(v) for k, v in split.items()} == {"train": 205, "val": 44, "test": 44}
    assert manifest["active_patients"] == 293 and len(manifest["type1_excluded_pids"]) == 7


def make_dataset(root):
    root.mkdir()
    (root / "patients_ehr.csv").write_text("patient_id,diabetes_status\nP1,Type 2\n")
    (root / "patient_cgm_telemetry.csv").write_text("patient_id,timestamp,glucose_level\nP1,2026-01-01,100\n")
    return {"files": {n: prov.sha256_file(root / n) for n in prov.DATA_FILES}}


def test_data_tampering_is_detected(tmp_path):
    manifest = make_dataset(tmp_path / "d")
    prov.verify_data(tmp_path / "d", manifest)
    tele = tmp_path / "d" / "patient_cgm_telemetry.csv"
    tele.write_text(tele.read_text().replace("100", "101"))
    with pytest.raises(prov.DataIntegrityError):
        prov.verify_data(tmp_path / "d", manifest)


def test_wrong_data_path_is_refused(tmp_path, run_config):
    with pytest.raises(FileNotFoundError):
        prov.verify_data(tmp_path / "missing", {"files": {}})
    with pytest.raises(FileNotFoundError):
        T.load_data(dataclasses.replace(run_config.cfg, data_dir=str(tmp_path / "missing")))
    make_dataset(tmp_path / "other")  # a different dataset at a valid path
    with pytest.raises(prov.DataIntegrityError):
        prov.verify_data(tmp_path / "other", prov.load_json(BACKEND / "data_manifest.json"))
    with pytest.raises(prov.DataIntegrityError):
        T.preflight(T.load_run_config(FINAL_CONFIG, data_dir=tmp_path / "other"), allow_dirty=True)


def test_split_tampering_is_detected(tmp_path):
    manifest = prov.load_json(BACKEND / "data_manifest.json")
    split = json.loads((BACKEND / "split_293.json").read_text())
    split["train"].append(split["val"].pop())  # move one validation patient into training
    bad = tmp_path / "split.json"
    bad.write_text(json.dumps(split, indent=2))
    with pytest.raises(prov.SplitIntegrityError):
        prov.verify_split(bad, manifest)
    swapped = json.loads((BACKEND / "split_293.json").read_text())
    swapped["train"][0], swapped["val"][0] = swapped["val"][0], swapped["train"][0]  # same counts, still disjoint
    bad.write_text(json.dumps(swapped, indent=2))
    with pytest.raises(prov.SplitIntegrityError, match="sha256"):
        prov.verify_split(bad, manifest)
    overlap = json.loads((BACKEND / "split_293.json").read_text())
    overlap["test"][0] = overlap["train"][0]
    bad.write_text(json.dumps(overlap))
    with pytest.raises(prov.SplitIntegrityError):
        prov.verify_split(bad, {**manifest, "split_sha256": prov.sha256_file(bad)})


def test_rule_lock(tmp_path):
    for name in ("model_selection_rule.json", "model_selection_rule.md"):
        shutil.copy(BACKEND / name, tmp_path / name)
    pins = json.loads(FINAL_CONFIG.read_text())["inputs"]
    args = (tmp_path / "model_selection_rule.json", tmp_path / "model_selection_rule.md",
            pins["model_selection_rule_sha256"], pins["model_selection_rule_md_sha256"])
    prov.verify_rule(*args)
    (tmp_path / "model_selection_rule.json").write_text((tmp_path / "model_selection_rule.json").read_text()
                                                        .replace('"tie_tolerance": 0.02', '"tie_tolerance": 0.05', 1))
    with pytest.raises(prov.RuleLockError):
        prov.verify_rule(*args)


# --------------------------------------------------------------------------- #
# Source identity
# --------------------------------------------------------------------------- #


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def test_dirty_tree_is_refused(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "t@t")
    git(repo, "config", "user.name", "t")
    (repo / "a.py").write_text("x = 1\n")
    git(repo, "add", "a.py")
    git(repo, "commit", "-qm", "init")
    state = prov.git_state(repo)
    assert len(state["git_sha"]) == 40 and not state["dirty"]
    prov.require_clean(state, allow_dirty=False)
    (repo / "a.py").write_text("x = 2\n")  # tracked change
    with pytest.raises(prov.DirtyTreeError):
        prov.require_clean(prov.git_state(repo), allow_dirty=False)
    git(repo, "checkout", "-q", "a.py")
    (repo / "b.py").write_text("y = 1\n")  # untracked file
    with pytest.raises(prov.DirtyTreeError):
        prov.require_clean(prov.git_state(repo), allow_dirty=False)
    assert prov.require_clean(prov.git_state(repo), allow_dirty=True)["allow_dirty"] is True
    plain = tmp_path / "not_a_repo"
    plain.mkdir()
    with pytest.raises(prov.ProvenanceError):
        prov.git_state(plain)


# --------------------------------------------------------------------------- #
# Run config
# --------------------------------------------------------------------------- #


def test_final_config_is_complete_and_meets_its_expectations(run_config):
    cfg = run_config.cfg
    assert (cfg.twin, cfg.twin_mode) == ("ukf", "s3")
    assert T.model_dims(cfg) == {"n_static": 18, "n_past": 20, "n_future": 8}
    assert (cfg.seed, cfg.max_epochs, cfg.d_model, cfg.num_workers, cfg.stride_steps) == (20260930, 30, 96, 0, 3)
    assert (cfg.pretrain_epochs, cfg.pretrain_truth) == (0, "")
    raw = json.loads(FINAL_CONFIG.read_text())
    assert set(raw["train"]) == {f.name for f in dataclasses.fields(T.TrainConfig)}
    record, split = T.preflight(run_config, allow_dirty=True)
    assert record["dims"] == T.model_dims(cfg) and record["git"]["git_sha"]
    assert set(record["source_sha256"]) == set(prov.SOURCE_FILES)
    assert record["model_selection_rule_json_sha256"] == raw["inputs"]["model_selection_rule_sha256"]


def test_frozen_split_reproduces_and_cohort_is_locked(cohort, frozen_split, run_config):
    info = T.check_cohort(cohort, frozen_split, run_config)
    assert info["active_patients"] == 293 and info["split_reproduces_from_seed"]


@pytest.mark.parametrize("mutate,needle", [
    (lambda r: r["train"].pop("stride_steps"), "missing"),
    (lambda r: r["train"].update(limit_patients=0), "unknown"),
    (lambda r: r.update(extra=1), "top-level"),
    (lambda r: r["train"].update(max_epochs="30"), "wrong type"),
    (lambda r: r["train"].update(num_workers=4), "num_workers"),
    (lambda r: r["train"].update(pretrain_epochs=3), "pretraining must be explicit"),
    (lambda r: r["train"].update(twin_mode="realistic"), "twin_mode"),
    (lambda r: r["train"].update(stride_steps=0), "stride_steps"),
])
def test_config_rejects_incomplete_or_unsafe(tmp_path, mutate, needle):
    with pytest.raises(ValueError, match=needle):
        T.load_run_config(write_config(tmp_path, mutate))


def test_expectation_mismatch_is_refused(tmp_path, real_data_dir):
    path = write_config(tmp_path, lambda r: r["expect"].update(n_past=12))
    with pytest.raises(ValueError, match="n_past"):
        T.preflight(T.load_run_config(path, data_dir=real_data_dir), allow_dirty=True)
    path = write_config(tmp_path, lambda r: r["inputs"].update(model_selection_rule_sha256="0" * 64))
    with pytest.raises(prov.RuleLockError):
        T.preflight(T.load_run_config(path, data_dir=real_data_dir), allow_dirty=True)


def test_trainer_cli_consumes_the_config_and_refuses_bad_data(tmp_path, real_data_dir):
    r = subprocess.run([PY, str(BACKEND / "train_pr_tft.py")], capture_output=True, text=True)
    assert r.returncode == 2 and "--config" in r.stderr  # the config is required
    r = subprocess.run([PY, str(BACKEND / "provenance.py"), "verify", "--config", str(FINAL_CONFIG),
                        "--data-dir", str(real_data_dir), "--allow-dirty"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout[r.stdout.index("{"):])["dims"] == {"n_static": 18, "n_past": 20, "n_future": 8}
    r = subprocess.run([PY, str(BACKEND / "train_pr_tft.py"), "--config", str(FINAL_CONFIG),
                        "--data-dir", str(tmp_path / "nowhere"), "--allow-dirty"], capture_output=True, text=True)
    assert r.returncode != 0 and "does not exist" in r.stderr

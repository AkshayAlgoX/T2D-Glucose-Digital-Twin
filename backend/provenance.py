#!/usr/bin/env python3
"""provenance.py -- input locks and source provenance for every result-producing entry point.

train_pr_tft.py, evaluate_run.py and twin_mode_selection.py call these checks before they
touch data, and record what they verified next to their outputs:

    data identity    sha256 of patients_ehr.csv, patient_cgm_telemetry.csv (and the truth
                     file when it is used) must equal backend/data_manifest.json. A data
                     directory is identified by its hashes, never by its name or path.
    split identity   the frozen split file must match its hash and the manifest's counts,
                     and its train/val/test lists must be disjoint.
    rule lock        sha256 of model_selection_rule.json and .md must equal the values pinned
                     in the run config.
    source identity  git HEAD and a clean working tree (tracked changes, or untracked files
                     that .gitignore does not cover, make it dirty). A dirty tree is refused
                     unless the caller explicitly allows it, and the decision is recorded.
                     If git cannot be queried the check fails; there is no "unknown" SHA.

Usage
    python provenance.py write-data-manifest --data-dir /path/to/synthetic_v2_300
    python provenance.py verify --config final_config.json [--data-dir DIR]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parent
DATA_FILES = ("patients_ehr.csv", "patient_cgm_telemetry.csv")
TRUTH_FILE = "patient_cgm_truth.csv"
SOURCE_FILES = ("input_contract.py", "provenance.py", "train_pr_tft.py", "ukf_twin.py",
                "generate_health_data_v2.py", "evaluate_run.py", "twin_mode_selection.py")


class ProvenanceError(RuntimeError):
    """Base class: an input or source check failed; nothing may be trained or reported."""


class DataIntegrityError(ProvenanceError):
    pass


class SplitIntegrityError(ProvenanceError):
    pass


class RuleLockError(ProvenanceError):
    pass


class DirtyTreeError(ProvenanceError):
    pass


def sha256_file(path: Path | str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_json(obj: Any) -> str:
    """Hash of a JSON-serialisable object in canonical form (sorted keys, no whitespace)."""
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


# --------------------------------------------------------------------------- #
# Source identity
# --------------------------------------------------------------------------- #


def _git(args: list[str], cwd: Path) -> str:
    try:
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout
    except (OSError, subprocess.CalledProcessError) as e:
        raise ProvenanceError(f"cannot query git in {cwd} ({e}); results must come from a git checkout") from e


def git_state(repo_dir: Path | str = BACKEND_DIR) -> dict[str, Any]:
    """HEAD SHA and working-tree status. Raises if `repo_dir` is not inside a git checkout."""
    repo_dir = Path(repo_dir)
    sha = _git(["rev-parse", "HEAD"], repo_dir).strip()
    status = _git(["status", "--porcelain=v1", "--untracked-files=all"], repo_dir)
    dirty_paths = [line[3:] for line in status.splitlines() if line.strip()]
    return {"git_sha": sha, "dirty": bool(dirty_paths), "dirty_paths": dirty_paths[:50],
            "n_dirty_paths": len(dirty_paths)}


def require_clean(state: dict[str, Any], allow_dirty: bool) -> dict[str, Any]:
    """Refuse a dirty tree unless explicitly allowed; return the state with the decision."""
    if state["dirty"] and not allow_dirty:
        shown = ", ".join(state["dirty_paths"][:8])
        raise DirtyTreeError(f"working tree has {state['n_dirty_paths']} uncommitted/untracked path(s): {shown}. "
                             "Commit or remove them, or pass --allow-dirty (recorded in the outputs).")
    return {**state, "allow_dirty": bool(allow_dirty)}


def source_hashes(backend_dir: Path = BACKEND_DIR) -> dict[str, str]:
    return {name: sha256_file(backend_dir / name) for name in SOURCE_FILES if (backend_dir / name).exists()}


# --------------------------------------------------------------------------- #
# Data and split identity
# --------------------------------------------------------------------------- #


def load_json(path: Path | str) -> Any:
    with open(path) as f:
        return json.load(f)


def verify_data(data_dir: Path | str, manifest: dict[str, Any], include_truth: bool = False) -> dict[str, str]:
    """Hash the data files and compare them with the manifest. Returns the verified hashes."""
    data_dir = Path(data_dir)
    if not data_dir.is_dir():
        raise FileNotFoundError(f"data_dir {data_dir} does not exist")
    names = DATA_FILES + ((TRUTH_FILE,) if include_truth else ())
    expected = manifest["files"]
    out = {}
    for name in names:
        path = data_dir / name
        if not path.is_file():
            raise FileNotFoundError(f"{path} is missing")
        if name not in expected:
            raise DataIntegrityError(f"data manifest has no hash for {name}")
        got = sha256_file(path)
        if got != expected[name]:
            raise DataIntegrityError(f"{path}: sha256 {got} does not match the data manifest ({expected[name]}); "
                                     "this is not the dataset the run is locked to")
        out[name] = got
    return out


def verify_split(split_path: Path | str, manifest: dict[str, Any]) -> dict[str, list[str]]:
    """Check the frozen split file against the manifest and return it."""
    split_path = Path(split_path)
    got = sha256_file(split_path)
    if got != manifest["split_sha256"]:
        raise SplitIntegrityError(f"{split_path}: sha256 {got} does not match the data manifest "
                                  f"({manifest['split_sha256']})")
    split = load_json(split_path)
    if set(split) != {"train", "val", "test"}:
        raise SplitIntegrityError(f"split must have exactly train/val/test, got {sorted(split)}")
    sets = {k: set(v) for k, v in split.items()}
    for k, v in split.items():
        if len(v) != len(sets[k]):
            raise SplitIntegrityError(f"duplicate patient ids in split '{k}'")
    if sets["train"] & sets["val"] or sets["train"] & sets["test"] or sets["val"] & sets["test"]:
        raise SplitIntegrityError("train/val/test overlap")
    counts = {k: len(v) for k, v in split.items()}
    if counts != manifest["split_counts"]:
        raise SplitIntegrityError(f"split counts {counts} != manifest {manifest['split_counts']}")
    excluded = set(manifest["type1_excluded_pids"])
    if excluded & set().union(*sets.values()):
        raise SplitIntegrityError("an excluded Type 1 patient appears in the split")
    return split


def verify_rule(rule_json: Path | str, rule_md: Path | str, json_sha: str, md_sha: str) -> dict[str, str]:
    got_json, got_md = sha256_file(rule_json), sha256_file(rule_md)
    if got_json != json_sha:
        raise RuleLockError(f"{rule_json}: sha256 {got_json} != pinned {json_sha}; the model-selection rule changed")
    if got_md != md_sha:
        raise RuleLockError(f"{rule_md}: sha256 {got_md} != pinned {md_sha}; the model-selection rule changed")
    return {"model_selection_rule_json_sha256": got_json, "model_selection_rule_md_sha256": got_md}


def write_data_manifest(data_dir: Path, split_path: Path, out_path: Path) -> dict[str, Any]:
    """Create the input lock for a dataset + frozen split (run once, then commit)."""
    import pandas as pd

    ehr = pd.read_csv(data_dir / "patients_ehr.csv")
    t1 = sorted(ehr.loc[ehr["diabetes_status"] == "Type 1", "patient_id"])
    split = load_json(split_path)
    files = {name: sha256_file(data_dir / name) for name in DATA_FILES}
    if (data_dir / TRUTH_FILE).exists():
        files[TRUTH_FILE] = sha256_file(data_dir / TRUTH_FILE)
    manifest = {
        "dataset": data_dir.name,
        "files": files,
        "split_file": split_path.name,
        "split_sha256": sha256_file(split_path),
        "split_counts": {k: len(v) for k, v in split.items()},
        "cohort_total": int(ehr["patient_id"].nunique()),
        "type1_excluded_pids": t1,
        "active_patients": int(ehr["patient_id"].nunique()) - len(t1),
    }
    out_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("write-data-manifest")
    w.add_argument("--data-dir", type=Path, required=True)
    w.add_argument("--split", type=Path, default=BACKEND_DIR / "split_293.json")
    w.add_argument("--out", type=Path, default=BACKEND_DIR / "data_manifest.json")
    v = sub.add_parser("verify")
    v.add_argument("--config", type=Path, required=True)
    v.add_argument("--data-dir", type=Path, default=None)
    v.add_argument("--allow-dirty", action="store_true")
    args = ap.parse_args()
    if args.cmd == "write-data-manifest":
        print(json.dumps(write_data_manifest(args.data_dir, args.split, args.out), indent=2))
        return
    import train_pr_tft as T  # heavy import only for the full check

    run = T.load_run_config(args.config, data_dir=args.data_dir)
    record, _ = T.preflight(run, allow_dirty=args.allow_dirty)
    print(json.dumps(record, indent=2))


if __name__ == "__main__":
    main()

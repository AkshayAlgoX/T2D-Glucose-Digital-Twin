"""EW-01 scientific runner: scores one authority-sealed cohort, exactly once.

    SCIENTIFIC_EVALUATION=true python experiments/early_warning_ew01/run_scientific.py

The runner takes no arguments and has no fallback. Everything it relies on comes from records the
designated authority signed into the registry pinned at PRODUCTION_REGISTRY_ROOT:

  * EW01_SCIENTIFIC_RUN_AUTHORIZATION binds the sealed-cohort record, the execution commit, the run's
    code and model-artifact inventory, the environment and the output directory;
  * EW01_SEALED_COHORT (the authority's signature over seal_cohort.py's manifest) binds the sealed
    directory, its inventory and every construction record the seal relied on.

`authorize_run` verifies all of it -- signatures against the trust anchor, every binding, a clean tree
at the authorized commit, the locked environment, and the sealed directory's path, read-only modes and
bytes -- and writes nothing. Only then does `run` reserve the single attempt in the registry and score
the verified sealed bytes. A missing registry, anchor or record blocks; nothing here creates one.
"""
from __future__ import annotations

import dataclasses
import io
import json
import os
import secrets
import stat
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np

EW01_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(EW01_DIR.parents[1] / "backend"))
sys.path.insert(0, str(EW01_DIR.parents[1]))
sys.path.insert(0, str(EW01_DIR))
import evaluate_run as E  # noqa: E402
import train_pr_tft as T  # noqa: E402
from ew01_trust import (AUTHORIZATION, CONSTRUCTION, EXPERIMENT, GENERATION_RECEIPT, HEX40, HEX64, LOCK_PATH,  # noqa: E402
                        PREPARATION_ATTESTATION, PREPARED_ALL, PREPARED_SCIENTIFIC, PRODUCTION_REGISTRY_ROOT,
                        REPLICA_COMPARISON, REPLICAS, SCIENTIFIC_ATTEMPT, SCIENTIFIC_RUN_AUTHORIZATION, SEALED_COHORT,
                        SEALED_COHORT_KEYS, SEED_RESERVATION, SELECTED_REPLICA, Authority, Blocked, SignedRecord,
                        _inside, canonical_json, check_output_path, cohort_artifact_digest, create_exclusive, inventory,
                        open_authority, read_regular_file, require_clean_tree, require_equal, require_hex, require_keys,
                        require_outside_repository, sha256_bytes, snapshot_directory, strict_json, sub_inventory,
                        validate_authorization, validate_inventory, verify_environment, verify_registry_layout,
                        verify_sources)
from experiments.early_warning_ew01.harness import evaluate_locked_core  # noqa: E402
from experiments.early_warning_ew01.loader import load_cohort_explicit_canonical  # noqa: E402
from freshness2 import SCHEMA_DIGEST  # noqa: E402

RUN_DIR = "runs/pr_tft_ablation_arm_d"
CONFIG = f"{RUN_DIR}/config.json"
NORMALIZATION = f"{RUN_DIR}/normalization.json"
CALIBRATION = f"{RUN_DIR}/calibration.json"
CHECKPOINT = f"{RUN_DIR}/checkpoints/stage2_observed-epoch=03-val_loss=0.2255.ckpt"
HABIT = "canonical_population_habit.npz"
SELECTION_RULE = "backend/model_selection_rule.json"

# Everything the run executes or loads; the run authorization binds each file's sha256, and the file on
# disk and in the execution commit must both match it.
RUN_SOURCES = tuple(sorted((
    "backend/ablation_twins.py", "backend/evaluate_run.py", "backend/input_contract.py", "backend/provenance.py",
    "backend/train_pr_tft.py", "backend/ukf_twin.py", SELECTION_RULE, HABIT, "experiments/baselines/point.py",
    "experiments/early_warning_ew01/EW01_FRESHNESS_2_SCHEMA.json", "experiments/early_warning_ew01/ew01_trust.py",
    "experiments/early_warning_ew01/freshness2.py", "experiments/early_warning_ew01/harness.py",
    "experiments/early_warning_ew01/loader.py", "experiments/early_warning_ew01/requirements.txt",
    "experiments/early_warning_ew01/run_scientific.py",
    "experiments/protocol_amendments/EW01_AMENDMENT_001.md",
    "experiments/protocol_amendments/EW01_AMENDMENT_002_BOOLEAN_PREDICATE.md",
    "experiments/protocol_amendments/EW01_AMENDMENT_003_EXECUTION_AND_B1_SUCCESS.md",
    CONFIG, NORMALIZATION, CALIBRATION, CHECKPOINT,
)))

# EW01_AMENDMENT_002 co-primary rule; the amendment's bytes are bound through RUN_SOURCES.
DECISION_RULE = {"co_primary_sensitivity_lower_bound_gt": 0.02,
                 "co_primary_false_alerts_per_day_upper_bound_lt": -0.10}

RUN_AUTHORIZATION_KEYS = frozenset({"record_type", "experiment", "construction", "construction_authorization_digest",
                                    "sealed_cohort_digest", "execution_commit", "run_source_inventory", "environment",
                                    "output_dir"})

PRODUCTION = "PRODUCTION"
TEST_FIXTURE = "TEST_FIXTURE_NOT_PRODUCTION_EVIDENCE"


class AttemptFailed(RuntimeError):
    """The attempt was reserved (and is spent) but did not complete; its outcome is recorded INVALID."""


def evaluate_scientific_rules(result, trace, candidate_inputs, cfg, rule, manifest, attempt_id):
    # Apply the explicit scientific Boolean rule:
    b7_vs_b9 = result["populations"]["primary"]["paired_differences"]["pr_tft_minus_twin_only"]
    
    # Sensitivity: lower bound > +0.02
    b7_sens_lb = b7_vs_b9["event_sensitivity"]["ci_low"]
    # FA/day: upper bound < -0.10
    b7_fa_ub = b7_vs_b9["false_alerts_per_patient_day"]["ci_high"]
    
    if b7_sens_lb is None or b7_fa_ub is None:
        pass_b7_vs_b9 = False
    else:
        pass_b7_vs_b9 = (b7_sens_lb > manifest["decision_rule"]["co_primary_sensitivity_lower_bound_gt"]) and \
                        (b7_fa_ub < manifest["decision_rule"]["co_primary_false_alerts_per_day_upper_bound_lt"])
                        
    # B1 conditional
    pass_b7_vs_b1 = False
    if pass_b7_vs_b9:
        from experiments.baselines.point import linear_trend
        
        # Construct B1 anchors
        a_t = trace.split_test.anchor_t.numpy()
        a_p = trace.split_test.anchor_patient.numpy()
        grid = np.zeros(a_t.size, dtype=bool)
        for i, ps in enumerate(candidate_inputs):
            sel = a_p == i
            grid[sel] = np.isin(a_t[sel], T.eligible_anchors(ps, cfg))
        
        eligible_t = a_t[grid]
        eligible_p = a_p[grid]
        
        series_dict = {ps.pid: ps for ps in candidate_inputs}
        patient_ids = [ps.pid for ps in candidate_inputs]
        
        b1_anchors = {
            "patient_ids": patient_ids,
            "t": eligible_t,
            "patient": eligible_p,
            "g0": np.array([candidate_inputs[p].cgm_ff[t] for p, t in zip(eligible_p, eligible_t)])
        }
        
        # Run baseline
        b1_preds = linear_trend(b1_anchors, series_dict)
        
        # Compute event stats for B1
        b1_ev = []
        cooldown = 24
        hist_len = T.RISE_STEPS + 1
        for i, ps in enumerate(candidate_inputs):
            _, first, last = trace.decisions[ps.pid]
            sel = np.flatnonzero(eligible_p == i)
            ts = eligible_t[sel]
            at_risk = np.zeros(ps.n, dtype=bool)
            at_risk[ts] = ps.armed[ts]
            
            trig_b1 = np.zeros(ps.n, dtype=bool)
            for j, t in zip(sel, ts):
                if at_risk[t] and b1_preds[j].max() >= T.SPIKE_LEVEL:
                    trig_b1[t] = E.forecast_meets_spike_rule(ps.cgm[t - hist_len + 1:t + 1], b1_preds[j])
                    
            raised_b1 = E.raise_alerts(trig_b1, at_risk, cooldown=cooldown)
            counts_b1 = E.event_counts(raised_b1, ps.onset, first, last)
            b1_ev.append(counts_b1)
            
        b1_stats = {}
        for key in ("monitored_onsets", "detected_onsets", "alerts_raised", "true_alerts", "false_alerts", "patient_days"):
            b1_stats[key] = np.array([r[key] for r in b1_ev], dtype=float)
        b1_stats["lead_times_min"] = [r["lead_times_min"] for r in b1_ev]
        
        primary_idx = np.flatnonzero(np.isin(np.array([ps.group for ps in candidate_inputs]), E.POPULATIONS["primary"]))
        sub_b1 = {k: v[primary_idx] if isinstance(v, np.ndarray) else [v[i] for i in primary_idx] for k, v in b1_stats.items()}
        w = trace.populations["primary"]["weights"]
        ones = np.ones((1, len(primary_idx)))
        point_b1 = E.metric_draws(sub_b1, ones)
        draws_b1 = E.metric_draws(sub_b1, w)
        
        point_b7 = trace.populations["primary"]["point"]["pr_tft@0.35"]
        draws_b7 = trace.populations["primary"]["draws"]["pr_tft@0.35"]
        
        diff_sens = E.summarize(point_b7["event_sensitivity"][0] - point_b1["event_sensitivity"][0], 
                                draws_b7["event_sensitivity"] - draws_b1["event_sensitivity"], 
                                rule["uncertainty"]["ci"])
        diff_fa = E.summarize(point_b7["false_alerts_per_patient_day"][0] - point_b1["false_alerts_per_patient_day"][0], 
                              draws_b7["false_alerts_per_patient_day"] - draws_b1["false_alerts_per_patient_day"], 
                              rule["uncertainty"]["ci"])
        
        if diff_sens["ci_low"] is not None and diff_fa["ci_high"] is not None:
            pass_b7_vs_b1 = (diff_sens["ci_low"] > 0.02) and (diff_fa["ci_high"] < -0.10)
        else:
            pass_b7_vs_b1 = "NO_PASS_UNDEFINED"
    else:
        pass_b7_vs_b1 = "B1_NOT_EVALUATED_GATE_FAILED"
            
    final_result = {
        "attempt_id": attempt_id,
        "pass_b7_vs_b9": pass_b7_vs_b9,
        "pass_b7_vs_b1": pass_b7_vs_b1,
        "b7_vs_b9_sensitivity_lb": b7_sens_lb,
        "b7_vs_b9_fa_ub": b7_fa_ub,
        "primary_metrics": result["populations"]["primary"]["models"],
        "paired_differences": result["populations"]["primary"]["paired_differences"],
        "status": "COMPLETE"
    }
    return final_result


# --------------------------------------------------------------------------- what runs after the gate


@dataclass(frozen=True)
class Stages:
    """The model-facing steps that run only after the gate has passed. Production always uses
    production_stages(); substitutes are accepted only in test-fixture mode."""
    load_cohort: Callable[..., list]  # (cfg, cohort_ids, meal_log) -> patient series
    make_twin: Callable[..., Any]     # (cfg) -> twin prior
    load_model: Callable[..., Any]    # (checkpoint) -> module
    evaluate: Callable[..., tuple]    # evaluate_locked_core
    decide: Callable[..., dict]       # evaluate_scientific_rules


def load_model(checkpoint: io.BytesIO):
    return T.PRTFTModule.load_from_checkpoint(checkpoint, map_location="cpu").eval()


def production_stages() -> Stages:
    return Stages(load_cohort_explicit_canonical, T.make_twin, load_model, evaluate_locked_core,
                  evaluate_scientific_rules)


_SCORING = (load_model, evaluate_locked_core, T.make_twin)


def _select_stages(registry_root: Path, test_fixture: bool, stages: Stages | None) -> Stages:
    """Production runs open only the pinned registry with the real stages. A test fixture never opens
    the production registry and never reaches the real model or evaluator."""
    root = os.path.abspath(registry_root)
    production = root == str(PRODUCTION_REGISTRY_ROOT) or Path(root).resolve() == PRODUCTION_REGISTRY_ROOT.resolve()
    if not test_fixture:
        if root != str(PRODUCTION_REGISTRY_ROOT):
            raise Blocked(f"BLOCKED: scientific runs use only the designated registry {PRODUCTION_REGISTRY_ROOT}; "
                          "any other registry is accepted only as an explicit test fixture")
        if stages is not None:
            raise Blocked("BLOCKED: production runs use the production evaluation stages only")
        return production_stages()
    if production:
        raise Blocked("BLOCKED: test-fixture mode never opens the production registry")
    if stages is None or any(f in _SCORING for f in (stages.make_twin, stages.load_model, stages.evaluate)):
        raise Blocked("BLOCKED: test-fixture mode never runs the real model or evaluator; supply test stages")
    return stages


# --------------------------------------------------------------------------- the gate


@dataclass(frozen=True)
class Gate:
    trust: str
    authority: Authority
    run_authorization: SignedRecord
    sealed_cohort: SignedRecord
    sealed_dir: Path
    cohort: dict[str, bytes]
    cohort_identity: tuple
    sources: dict[str, bytes]
    output_dir: Path
    environment: dict


def _absolute_path(value: Any, what: str) -> Path:
    if not isinstance(value, str) or not os.path.isabs(value) or os.path.normpath(value) != value:
        raise Blocked(f"BLOCKED: {what} must be an absolute normalized path: {value!r}")
    return Path(value)


def _validate_run_authorization(p: dict) -> dict:
    require_keys(p, RUN_AUTHORIZATION_KEYS, "scientific run authorization")
    require_equal(p["experiment"], EXPERIMENT, "run authorization experiment")
    require_equal(p["construction"], CONSTRUCTION, "run authorization construction")
    require_hex(p["construction_authorization_digest"], HEX64, "run authorization construction digest")
    require_hex(p["sealed_cohort_digest"], HEX64, "run authorization sealed cohort digest")
    require_hex(p["execution_commit"], HEX40, "run authorization execution commit")
    require_keys(p["run_source_inventory"], set(RUN_SOURCES), "authorized run source inventory")
    for v in p["run_source_inventory"].values():
        require_hex(v, HEX64, "authorized run source digest")
    env = require_keys(p["environment"], {"lock_sha256", "runtime"}, "authorized run environment")
    require_hex(env["lock_sha256"], HEX64, "authorized run lock sha256")
    _absolute_path(p["output_dir"], "authorized output directory")
    return p


def _validate_sealed_record(authority: Authority, p: dict, construction: SignedRecord, seed: SignedRecord) -> dict:
    """The authority-signed seal: its own bindings, and every construction record it relied on, which must
    still be present, authority-signed and byte-identical."""
    require_keys(p, SEALED_COHORT_KEYS, "sealed cohort record")
    a, reg = construction.payload, authority.registry
    for key, expected in [("experiment", EXPERIMENT), ("construction", CONSTRUCTION),
                          ("selected_replica", SELECTED_REPLICA), ("authorization_digest", construction.digest),
                          ("seed_reservation_digest", seed.digest),
                          ("generation_seed", a["generation"]["generation_seed"]),
                          ("trust_anchor_sha256", authority.anchor_sha256), ("registry_root", str(reg.root)),
                          ("preparation_commit", a["preparation"]["preparation_commit"]),
                          ("environment", a["environment"]), ("freshness", a["freshness"])]:
        require_equal(p[key], expected, f"sealed cohort {key}")
    cohort = require_keys(p["cohort"], {"cohort_artifact_sha256", "inventory"}, "sealed cohort")
    inv = validate_inventory(cohort["inventory"], PREPARED_ALL, "sealed cohort inventory")
    require_equal(cohort["cohort_artifact_sha256"], cohort_artifact_digest(inv), "sealed cohort artifact digest")

    verify_registry_layout(reg, sealing=True)
    attestations = {}
    for field, path_of, rtype in [("generation_receipts", reg.receipt, GENERATION_RECEIPT),
                                  ("preparation_attestations", reg.attestation, PREPARATION_ATTESTATION)]:
        require_keys(p[field], set(REPLICAS), f"sealed cohort {field}")
        for r in REPLICAS:
            rec = authority.verify(path_of(r), rtype)
            require_equal(rec.digest, p[field][r], f"sealed cohort {field}[{r}]")
            require_equal(rec.payload.get("replica"), r, f"{rtype} replica")
            require_equal(rec.payload.get("authorization_digest"), construction.digest, f"{rtype} {r} authorization")
            if rtype == PREPARATION_ATTESTATION:
                attestations[r] = rec.payload
    require_keys(p["slot_starts"], set(REPLICAS), "sealed cohort slot_starts")
    for r in REPLICAS:
        start = read_regular_file(reg.start(r), f"slot {r} start marker")
        require_equal(sha256_bytes(start), p["slot_starts"][r], f"sealed cohort slot_starts[{r}]")
    comparison = authority.verify(reg.comparison, REPLICA_COMPARISON)
    require_equal(comparison.digest, p["comparison_attestation_digest"], "sealed cohort comparison attestation")
    c = comparison.payload
    require_equal(c.get("result"), "MATCH", "replica comparison result")
    require_equal(c.get("selected_replica"), SELECTED_REPLICA, "replica comparison selected replica")
    require_equal(c.get("authorization_digest"), construction.digest, "replica comparison authorization")
    require_equal(inv, attestations[SELECTED_REPLICA].get("prepared_inventory"),
                  "sealed inventory vs the selected replica's attested preparation")
    require_equal(sub_inventory(inv, PREPARED_SCIENTIFIC), c.get("prepared_scientific_inventory"),
                  "sealed scientific inventory vs the signed replica comparison")
    return p


def _sealed_identity(path: Path) -> tuple:
    """Directory and file identities; the directory and every file must be read-only and unlinked elsewhere."""
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_mode & 0o222:
        raise Blocked(f"BLOCKED: sealed cohort directory is not a read-only real directory: {path}")
    ident = [(".", st.st_dev, st.st_ino, st.st_mtime_ns, st.st_ctime_ns)]
    for name in PREPARED_ALL:
        f = os.lstat(path / name)
        if not stat.S_ISREG(f.st_mode) or f.st_mode & 0o222 or f.st_nlink != 1:
            raise Blocked(f"BLOCKED: sealed cohort file {name} is not a read-only, singly linked regular file")
        ident.append((name, f.st_dev, f.st_ino, f.st_size, f.st_mtime_ns, f.st_ctime_ns))
    return tuple(ident)


def _verify_sealed_directory(sealed: dict, construction: dict, authority: Authority) -> tuple[Path, dict, tuple]:
    path = _absolute_path(sealed["sealed_dir"], "sealed cohort directory")
    require_outside_repository(path, "sealed cohort directory")
    if os.path.realpath(path) != str(path):
        raise Blocked(f"BLOCKED: sealed cohort directory path traverses a symlink: {path}")
    others = [Path(construction[k]["output_dirs"][r]) for k in ("generation", "preparation") for r in REPLICAS]
    for other in others + [authority.registry.root]:
        if _inside(path, other) or _inside(other, path):
            raise Blocked(f"BLOCKED: sealed cohort directory {path} overlaps {other}; only the sealed copy is scored")
    snapshot_directory(path, PREPARED_ALL, "sealed cohort")  # exact allowlist of regular files before identity
    before = _sealed_identity(path)
    cohort = snapshot_directory(path, PREPARED_ALL, "sealed cohort")
    if _sealed_identity(path) != before:
        raise Blocked("BLOCKED: sealed cohort changed while it was being verified")
    require_equal(inventory(cohort), sealed["cohort"]["inventory"],
                  "sealed cohort bytes vs the authority-signed seal inventory")
    return path, cohort, before


def _recheck_sealed(gate: Gate) -> None:
    """After the loader has read the sealed directory: nothing about it may have changed."""
    if _sealed_identity(gate.sealed_dir) != gate.cohort_identity:
        raise Blocked("BLOCKED: sealed cohort changed after verification")
    again = snapshot_directory(gate.sealed_dir, PREPARED_ALL, "sealed cohort")
    require_equal(inventory(again), inventory(gate.cohort), "sealed cohort bytes after loading")


def authorize_run(registry_root: Path, *, test_fixture: bool, lock_path: Path = LOCK_PATH) -> Gate:
    """Every check the run depends on, in order; creates and modifies nothing, and blocks on the first
    failure. Scientific inputs are opened only after all authority records have been authenticated."""
    authority = open_authority(registry_root)
    reg = authority.registry
    run_auth = authority.verify(reg.run_authorization, SCIENTIFIC_RUN_AUTHORIZATION)
    a = _validate_run_authorization(run_auth.payload)
    construction = authority.verify(reg.authorization, AUTHORIZATION)
    validate_authorization(construction.payload, SCHEMA_DIGEST)
    require_equal(construction.digest, a["construction_authorization_digest"],
                  "run authorization vs construction authorization")
    seed = authority.verify(reg.seed_reservation, SEED_RESERVATION)
    require_equal(seed.digest, construction.payload["seed_reservation_digest"], "seed reservation digest")
    sealed = authority.verify(reg.sealed_cohort, SEALED_COHORT)
    require_equal(sealed.digest, a["sealed_cohort_digest"], "run authorization vs sealed cohort record")
    _validate_sealed_record(authority, sealed.payload, construction, seed)
    environment = verify_environment(a["environment"], lock_path)
    require_clean_tree()
    sources = verify_sources(a["run_source_inventory"], a["execution_commit"], RUN_SOURCES, "execution commit")
    sealed_dir, cohort, identity = _verify_sealed_directory(sealed.payload, construction.payload, authority)
    others = tuple(Path(construction.payload[k]["output_dirs"][r]) for k in ("generation", "preparation")
                   for r in REPLICAS)
    output_dir = check_output_path(a["output_dir"], "scientific output directory", (reg.root, sealed_dir) + others)
    return Gate(TEST_FIXTURE if test_fixture else PRODUCTION, authority, run_auth, sealed, sealed_dir, cohort,
                identity, sources, output_dir, environment)


# --------------------------------------------------------------------------- the single attempt


def _plain(o):
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(f"not JSON serializable: {type(o).__name__}")


def _write(path: Path, obj: dict) -> None:
    create_exclusive(path, (json.dumps(obj, indent=2, sort_keys=True, default=_plain) + "\n").encode(), 0o444)


def _score(gate: Gate, stages: Stages, attempt_id: str) -> dict:
    src, cohort = gate.sources, gate.cohort
    cfg = T.validate_train_config(E._cfg_from_dict(json.loads(src[CONFIG])))
    cfg = dataclasses.replace(cfg, data_dir=str(gate.sealed_dir))
    cohort_ids = strict_json(cohort["cohort_ids.json"], "sealed cohort_ids.json")
    if (not isinstance(cohort_ids, list) or not all(isinstance(x, str) for x in cohort_ids)
            or len(set(cohort_ids)) != len(cohort_ids)):
        raise Blocked("BLOCKED: sealed cohort_ids.json is not a list of distinct ids")
    inputs = stages.load_cohort(cfg, sorted(cohort_ids), io.BytesIO(cohort["scientific_meal_log.npz"]))
    _recheck_sealed(gate)
    twin = stages.make_twin(cfg)
    norm = T.Normalizer(**json.loads(src[NORMALIZATION]))
    habit = np.load(io.BytesIO(src[HABIT]))
    pop = (habit["pop_counts"], float(habit["pop_mean"]))
    calib = T.Calibrators(**json.loads(src[CALIBRATION]))
    rule = json.loads(src[SELECTION_RULE])
    module = stages.load_model(io.BytesIO(src[CHECKPOINT]))
    result, trace = stages.evaluate(inputs, twin, module, cfg, norm, pop, calib, rule, trace=True)
    return stages.decide(result, trace, inputs, cfg, rule, {"decision_rule": dict(DECISION_RULE)}, attempt_id)


def run(*, registry_root: Path = PRODUCTION_REGISTRY_ROOT, test_fixture: bool = False, stages: Stages | None = None,
        lock_path: Path = LOCK_PATH) -> dict:
    """The only scoring entry point: the gate, then the single attempt's reservation, then scoring of the
    verified sealed bytes. Nothing is created unless the whole gate passes."""
    stages = _select_stages(registry_root, test_fixture, stages)
    gate = authorize_run(Path(registry_root), test_fixture=test_fixture, lock_path=lock_path)
    attempt_id = f"EW01-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(4)}"
    attempt = canonical_json({"record_type": SCIENTIFIC_ATTEMPT, "experiment": EXPERIMENT,
                              "construction": CONSTRUCTION, "attempt_id": attempt_id, "trust": gate.trust,
                              "run_authorization_digest": gate.run_authorization.digest,
                              "sealed_cohort_digest": gate.sealed_cohort.digest, "nonce": secrets.token_hex(32)})
    try:
        create_exclusive(gate.authority.registry.scientific_attempt, attempt, 0o444)
    except FileExistsError:
        raise Blocked("BLOCKED: the single EW-01 scientific attempt is already reserved; it is never repeated") from None
    bindings = {"attempt_id": attempt_id, "attempt_digest": sha256_bytes(attempt), "trust": gate.trust,
                "trust_anchor_sha256": gate.authority.anchor_sha256,
                "run_authorization_digest": gate.run_authorization.digest,
                "sealed_cohort_digest": gate.sealed_cohort.digest,
                "cohort_artifact_sha256": gate.sealed_cohort.payload["cohort"]["cohort_artifact_sha256"],
                "sealed_dir": str(gate.sealed_dir),
                "execution_commit": gate.run_authorization.payload["execution_commit"],
                "environment": gate.environment}
    out = gate.output_dir
    try:
        os.makedirs(out.parent, exist_ok=True)
        os.mkdir(out)
        _write(out / "attempt_ledger.json", {**bindings, "status": "STARTED",
                                             "started_utc": datetime.now(timezone.utc).isoformat()})
    except OSError as e:
        raise AttemptFailed(f"FATAL: attempt {attempt_id} is spent: cannot create {out}: {e}") from e
    try:
        result = {**_score(gate, stages, attempt_id), "bindings": bindings}
        _write(out / "scientific_results.json", result)
    except Exception as e:
        _write(out / "attempt_outcome.json", {**bindings, "status": f"INVALID: {e}"})
        raise AttemptFailed(f"FATAL: attempt {attempt_id} is spent and INVALID: {e}") from e
    _write(out / "attempt_outcome.json", {**bindings, "status": "COMPLETE"})
    return result


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv:
        print("BLOCKED: run_scientific.py takes no arguments; the sealed cohort, the authorization and the output "
              "location come only from authority-signed records in the designated registry", file=sys.stderr)
        return 1
    if os.environ.get("SCIENTIFIC_EVALUATION", "").lower() != "true":
        print("FATAL: SCIENTIFIC_EVALUATION=true is required.", file=sys.stderr)
        return 1
    try:
        result = run()
    except (Blocked, AttemptFailed) as e:
        print(e, file=sys.stderr)
        return 1
    print(f"Scientific evaluation COMPLETE: {result['bindings']['attempt_id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

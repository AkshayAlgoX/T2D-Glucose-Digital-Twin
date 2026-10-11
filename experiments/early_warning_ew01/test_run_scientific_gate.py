"""Security gate of the EW-01 scientific runner. Synthetic only: nothing real is loaded or scored.

The fixture authority from test_provenance builds and seals a synthetic two-replica construction, then
signs the seal and a run authorization into a temporary registry. Every test drives the runner's real
entry points (`run`, `main`, the CLI). The model-facing stages are recorders or stubs that fail the test
if they are reached, and test-fixture mode itself refuses the real model and evaluator.
"""
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519

import ew01_trust as tr
import run_scientific as rs
from ew01_trust import Blocked
from test_provenance import FixtureAuthority

EW01_DIR = Path(__file__).resolve().parent
HEAD = subprocess.run(["git", "-C", str(tr.REPO_ROOT), "rev-parse", "HEAD"], capture_output=True, text=True,
                      check=True).stdout.strip()


class Unexpected(AssertionError):
    pass


def _never(*args, **kwargs):
    raise Unexpected("a model-facing stage ran although the gate should have blocked")


NEVER = rs.Stages(_never, _never, _never, _never, _never)

_RUN_INVENTORY = {}


def run_inventory():
    if not _RUN_INVENTORY:
        _RUN_INVENTORY.update(tr.source_inventory(rs.RUN_SOURCES))
    return dict(_RUN_INVENTORY)


def tree_state(root):
    """Every entry under root: mode, and bytes digest or symlink target. None if root is absent."""
    root = Path(root)
    if not os.path.lexists(root):
        return None
    out = {".": stat.S_IMODE(os.lstat(root).st_mode)}
    for dirpath, dirnames, filenames in os.walk(root):
        for n in dirnames + filenames:
            p = Path(dirpath) / n
            st = os.lstat(p)
            body = (os.readlink(p) if stat.S_ISLNK(st.st_mode) else
                    hashlib.sha256(p.read_bytes()).hexdigest() if stat.S_ISREG(st.st_mode) else "dir")
            out[str(p.relative_to(root))] = (stat.S_IMODE(st.st_mode), body)
    return out


class RunWorld:
    """A sealed synthetic construction plus authority-signed seal and run authorization (fixture key)."""

    def __init__(self, fa: FixtureAuthority):
        self.fa, self.reg = fa, fa.reg
        fa.full()
        self.seal_record = fa.seal()
        self.sealed = fa.tmp / "sealed"
        self.output = fa.tmp / "results" / "run"
        self.sign_seal()
        self.authorize_run()

    def sign_seal(self, **over):
        self.sealed_digest = self.fa.sign(self.reg.sealed_cohort, {**self.seal_record, **over})
        return self.sealed_digest

    def run_payload(self, **over):
        p = {"record_type": tr.SCIENTIFIC_RUN_AUTHORIZATION, "experiment": tr.EXPERIMENT,
             "construction": tr.CONSTRUCTION, "construction_authorization_digest": self.fa.auth_digest,
             "sealed_cohort_digest": self.sealed_digest, "execution_commit": HEAD,
             "run_source_inventory": run_inventory(), "environment": tr.environment_identity(),
             "output_dir": str(self.output)}
        p.update(over)
        return p

    def authorize_run(self, **over):
        self.run_digest = self.fa.sign(self.reg.run_authorization, self.run_payload(**over))

    def reseal(self, **over):
        """Re-sign the seal with changed fields and re-authorize the run against it."""
        self.sign_seal(**over)
        self.authorize_run()

    def run(self, stages=NEVER, **kw):
        return rs.run(registry_root=self.fa.root, test_fixture=True, stages=stages, **kw)

    def state(self):
        t = self.fa.tmp
        return {name: tree_state(t / name) for name in ("registry", "sealed", "gen", "prep", "out", "results")}


@pytest.fixture
def world(tmp_path):
    return RunWorld(FixtureAuthority(tmp_path))


def assert_blocked(world, msg, stages=NEVER, **kw):
    """The gate blocks with msg, no stage runs, and registry, sealed copy, inputs and outputs are unchanged."""
    before = world.state()
    with pytest.raises(Blocked, match=msg):
        world.run(stages, **kw)
    assert world.state() == before


class Recorder:
    """Stand-in model stages that record what reached them. The cohort itself goes through the real
    loader, so the test shows the real data path reads only the sealed directory."""

    def __init__(self, evaluate_error=None, during_load=None):
        self.calls, self.evaluate_error, self.during_load = [], evaluate_error, during_load

    def load_cohort(self, cfg, ids, meal_log):
        self.calls.append(("load_cohort", cfg.data_dir, list(ids), meal_log.getvalue()))
        series = rs.load_cohort_explicit_canonical(cfg, ids, meal_log)
        if self.during_load:
            self.during_load()
        return series

    def make_twin(self, cfg):
        self.calls.append(("make_twin",))
        return "synthetic-twin"

    def load_model(self, checkpoint):
        self.calls.append(("load_model", hashlib.sha256(checkpoint.getvalue()).hexdigest()))
        return "synthetic-module"

    def evaluate(self, inputs, twin, module, cfg, norm, pop, calib, rule, trace):
        self.calls.append(("evaluate", [ps.pid for ps in inputs], twin, module, trace))
        if self.evaluate_error:
            raise self.evaluate_error
        return {"synthetic": True}, None

    def decide(self, result, trace, inputs, cfg, rule, manifest, attempt_id):
        self.calls.append(("decide", result, manifest, attempt_id))
        return {"attempt_id": attempt_id, "status": "COMPLETE", "synthetic_result": True}

    def stages(self):
        return rs.Stages(self.load_cohort, self.make_twin, self.load_model, self.evaluate, self.decide)


# --------------------------------------------------------------------------- the valid path


def test_valid_test_fixture_passes_the_gate_and_scores_only_the_sealed_bytes(world):
    before = world.state()
    rec = Recorder()
    result = world.run(rec.stages())
    sealed = world.sealed
    ids = json.loads((sealed / "cohort_ids.json").read_text())
    assert [c[0] for c in rec.calls] == ["load_cohort", "make_twin", "load_model", "evaluate", "decide"]
    _, data_dir, loaded_ids, meal = rec.calls[0]
    assert data_dir == str(sealed) and loaded_ids == sorted(ids)
    assert meal == (sealed / "scientific_meal_log.npz").read_bytes()
    assert rec.calls[2][1] == run_inventory()[rs.CHECKPOINT]
    assert rec.calls[3][1] == sorted(ids) and rec.calls[3][4] is True
    assert rec.calls[4][2] == {"decision_rule": rs.DECISION_RULE}

    b = result["bindings"]
    assert b["trust"] == rs.TEST_FIXTURE != rs.PRODUCTION
    assert b["sealed_cohort_digest"] == world.sealed_digest and b["run_authorization_digest"] == world.run_digest
    assert b["cohort_artifact_sha256"] == world.seal_record["cohort"]["cohort_artifact_sha256"]
    assert b["sealed_dir"] == str(sealed) and b["execution_commit"] == HEAD
    attempt = world.reg.scientific_attempt
    assert stat.S_IMODE(attempt.stat().st_mode) == 0o444
    marker = json.loads(attempt.read_text())
    assert marker["trust"] == rs.TEST_FIXTURE and b["attempt_digest"] == hashlib.sha256(attempt.read_bytes()).hexdigest()
    out = world.output
    assert sorted(os.listdir(out)) == ["attempt_ledger.json", "attempt_outcome.json", "scientific_results.json"]
    assert json.loads((out / "attempt_outcome.json").read_text())["status"] == "COMPLETE"
    assert json.loads((out / "scientific_results.json").read_text()) == result

    after = world.state()
    for name in ("sealed", "gen", "prep", "out"):
        assert after[name] == before[name]
    added = {k: v for k, v in after["registry"].items() if before["registry"].get(k) != v}
    assert list(added) == ["EW01-R1/scientific_attempt.json"]

    # The single attempt is never repeated: an existing output blocks first, then the reservation does.
    assert_blocked(world, "already exists")
    world.authorize_run(output_dir=str(world.fa.tmp / "results" / "second"))
    assert_blocked(world, "attempt is already reserved")


def test_failure_after_reservation_spends_the_attempt_and_records_invalid(world):
    rec = Recorder(evaluate_error=RuntimeError("synthetic evaluator failure"))
    with pytest.raises(rs.AttemptFailed, match="spent and INVALID: synthetic evaluator failure"):
        world.run(rec.stages())
    assert world.reg.scientific_attempt.exists()
    assert sorted(os.listdir(world.output)) == ["attempt_ledger.json", "attempt_outcome.json"]
    assert json.loads((world.output / "attempt_outcome.json").read_text())["status"].startswith("INVALID")


def test_sealed_cohort_changed_while_loading_blocks_before_evaluation(world):
    target = world.sealed / "patients_ehr.csv"

    def tamper():
        world.sealed.chmod(0o755)
        target.chmod(0o644)
        target.write_bytes(target.read_bytes().replace(b"Type 2", b"Type 3"))
        target.chmod(0o444)
        world.sealed.chmod(0o555)

    rec = Recorder(during_load=tamper)
    with pytest.raises(rs.AttemptFailed, match="sealed cohort changed after verification"):
        world.run(rec.stages())
    assert [c[0] for c in rec.calls] == ["load_cohort"]
    assert not (world.output / "scientific_results.json").exists()


# --------------------------------------------------------------------------- test fixture vs production


def test_fixture_key_is_never_the_production_trust_anchor(world, tmp_path):
    assert not os.path.lexists(tr.PRODUCTION_REGISTRY_ROOT), "test assumes no production registry on this host"
    before = world.state()
    cases = [
        (dict(registry_root=world.fa.root, stages=NEVER), "only the designated registry"),
        (dict(registry_root=world.fa.root), "only the designated registry"),
        (dict(registry_root=world.fa.root, test_fixture=True), "supply test stages"),
        (dict(registry_root=world.fa.root, test_fixture=True, stages=rs.production_stages()), "supply test stages"),
        (dict(registry_root=tr.PRODUCTION_REGISTRY_ROOT, test_fixture=True, stages=NEVER),
         "never opens the production registry"),
        (dict(stages=NEVER), "production evaluation stages only"),
        (dict(), "designated authority registry is not provisioned"),
    ]
    alias = tmp_path / "alias-to-production"
    alias.symlink_to(tr.PRODUCTION_REGISTRY_ROOT)
    cases.append((dict(registry_root=alias, test_fixture=True, stages=NEVER), "never opens the production registry"))
    for kw, msg in cases:
        with pytest.raises(Blocked, match=msg):
            rs.run(**kw)
    assert world.state() == before
    assert not os.path.lexists(tr.PRODUCTION_REGISTRY_ROOT) and not os.path.lexists(world.reg.scientific_attempt)


# --------------------------------------------------------------------------- missing trust material


def test_missing_registry_blocks_and_creates_nothing(tmp_path):
    for root in [tmp_path / "absent" / "EW-01", tmp_path / "file"]:
        if root.name == "file":
            root.write_text("not a registry")
        listing = sorted(p.name for p in tmp_path.iterdir())
        with pytest.raises(Blocked, match="designated authority registry is not provisioned"):
            rs.run(registry_root=root, test_fixture=True, stages=NEVER)
        assert sorted(p.name for p in tmp_path.iterdir()) == listing
    assert not (tmp_path / "absent").exists()


def test_missing_trust_anchor_blocks_without_ledger_or_output(world):
    (world.fa.root / tr.TRUST_ANCHOR_NAME).unlink()
    assert_blocked(world, "trust anchor is absent")
    assert not world.output.parent.exists()


@pytest.mark.parametrize("record", ["run_authorization", "sealed_cohort", "authorization"])
def test_missing_signed_record_blocks(world, record):
    getattr(world.reg, record).unlink()
    assert_blocked(world, "record is absent")


# --------------------------------------------------------------------------- signatures


def _tampered(world, path, field, value):
    rec = json.loads(path.read_text())
    rec["payload"][field] = value
    path.write_text(json.dumps(rec))


@pytest.mark.parametrize("record", ["run_authorization", "sealed_cohort"])
@pytest.mark.parametrize("attack,msg", [
    ("tampered", "invalid authority signature"),
    ("wrong_key", "invalid authority signature"),
    ("garbage_signature", "invalid authority signature"),
    ("missing_signature", "not a signed authority record"),
    ("unsigned_payload", "not a signed authority record"),
    ("wrong_type", "expected EW01_"),
])
def test_invalid_missing_tampered_or_wrong_key_signatures_block(world, record, attack, msg):
    path = getattr(world.reg, record)
    payload = json.loads(path.read_text())["payload"]
    if attack == "tampered":
        field = "output_dir" if record == "run_authorization" else "sealed_dir"
        _tampered(world, path, field, str(world.fa.tmp / "elsewhere"))
    elif attack == "wrong_key":
        world.fa.sign(path, payload, key=ed25519.Ed25519PrivateKey.generate())
    elif attack == "garbage_signature":
        path.write_text(json.dumps({"payload": payload, "signature": "!!not-base64!!"}))
    elif attack == "missing_signature":
        path.write_text(json.dumps({"payload": payload}))
    elif attack == "unsigned_payload":
        path.write_text(json.dumps(payload))
    else:
        other = world.reg.sealed_cohort if record == "run_authorization" else world.reg.run_authorization
        path.write_bytes(other.read_bytes())
    assert_blocked(world, msg)


def test_construction_authorization_signed_by_another_key_blocks(world):
    world.fa.sign(world.reg.authorization, world.fa.authorization_payload(), key=ed25519.Ed25519PrivateKey.generate())
    assert_blocked(world, "invalid authority signature on EW01_CONSTRUCTION_AUTHORIZATION")


# --------------------------------------------------------------------------- ledgers and legacy manifests


def test_unsigned_legacy_manifest_or_local_ledger_is_never_authorization(world):
    legacy = {"status": "AUTHORIZED", "authorized_execution_commit": HEAD,
              "protocol_amendment_sha256": run_inventory()[
                  "experiments/protocol_amendments/EW01_AMENDMENT_002_BOOLEAN_PREDICATE.md"],
              "cohort": {"cohort_artifact_sha256": world.seal_record["cohort"]["cohort_artifact_sha256"]},
              "model_artifacts": {}, "decision_rule": rs.DECISION_RULE}
    world.reg.run_authorization.write_text(json.dumps(legacy))
    assert_blocked(world, "non-integer or non-finite JSON number")  # the old manifest's float thresholds
    del legacy["decision_rule"]
    world.reg.run_authorization.write_text(json.dumps(legacy))
    assert_blocked(world, "not a signed authority record")
    world.authorize_run()
    # A ledger written by a previous (or forged) attempt is never read as permission: it only blocks.
    for content in [b'{"status": "STARTED"}', b'{"status": "COMPLETE", "scientific_evaluation": true}', b"garbage"]:
        world.reg.scientific_attempt.write_bytes(content)
        assert_blocked(world, "attempt is already reserved")
        assert world.reg.scientific_attempt.read_bytes() == content
        world.reg.scientific_attempt.unlink()
    world.reg.scientific_attempt.symlink_to(world.fa.tmp / "nowhere.json")
    assert_blocked(world, "attempt is already reserved")
    assert not (world.fa.tmp / "nowhere.json").exists()
    world.reg.scientific_attempt.unlink()
    world.output.mkdir(parents=True)
    (world.output / "attempt_ledger.json").write_text(json.dumps({"status": "AUTHORIZED"}))
    assert_blocked(world, "already exists")
    assert not os.path.lexists(world.reg.scientific_attempt)


def test_cli_and_main_fail_closed_against_the_pinned_registry(tmp_path, monkeypatch):
    assert not os.path.lexists(tr.PRODUCTION_REGISTRY_ROOT), "test assumes no production registry on this host"
    script = str(EW01_DIR / "run_scientific.py")
    base = {"HOME": os.environ.get("HOME", "/"), "PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"}
    for argv, env, msg in [
        ([], {}, "FATAL: SCIENTIFIC_EVALUATION=true is required."),
        ([], {"SCIENTIFIC_EVALUATION": "true"}, "BLOCKED: designated authority registry is not provisioned"),
        (["EW01_PRE_RUN_MANIFEST.json", "out"], {"SCIENTIFIC_EVALUATION": "true"}, "takes no arguments"),
        (["--registry", str(tmp_path)], {"SCIENTIFIC_EVALUATION": "true"}, "takes no arguments"),
    ]:
        res = subprocess.run([sys.executable, script, *argv], capture_output=True, text=True, cwd=tmp_path,
                             env={**base, **env})
        assert res.returncode == 1 and msg in res.stderr, res.stderr
    assert list(tmp_path.iterdir()) == [] and not os.path.lexists(tr.PRODUCTION_REGISTRY_ROOT)
    assert not os.path.lexists(tr.PRODUCTION_REGISTRY_ROOT.parent)

    # In process, with every real model-facing stage replaced by a stub that fails the test if reached.
    for name in ("load_cohort_explicit_canonical", "load_model", "evaluate_locked_core", "evaluate_scientific_rules"):
        monkeypatch.setattr(rs, name, _never)
    monkeypatch.setattr(rs.T, "make_twin", _never)
    monkeypatch.setenv("SCIENTIFIC_EVALUATION", "true")
    assert rs.main([]) == 1
    assert rs.main(["manifest.json", str(tmp_path / "out")]) == 1
    assert list(tmp_path.iterdir()) == [] and not os.path.lexists(tr.PRODUCTION_REGISTRY_ROOT)


def test_runner_import_has_no_side_effects(tmp_path):
    """Importing the runner (as test_runner_remediation does) neither exits nor evaluates nor writes."""
    code = f"import sys; sys.path.insert(0, {str(EW01_DIR)!r}); import run_scientific; print('imported')"
    res = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=tmp_path,
                         env={"HOME": os.environ.get("HOME", "/"), "PATH": "/usr/bin:/bin",
                              "PYTHONDONTWRITEBYTECODE": "1"})
    assert res.returncode == 0 and res.stdout == "imported\n", res.stderr
    assert list(tmp_path.iterdir()) == [] and not os.path.lexists(tr.PRODUCTION_REGISTRY_ROOT)


# --------------------------------------------------------------------------- the sealed input


def test_repository_local_or_unsealed_cohort_paths_are_rejected(world):
    world.reseal(sealed_dir=str(EW01_DIR / "scientific_cohort"))
    assert_blocked(world, "sealed cohort directory must be outside the repository")
    for r in tr.REPLICAS:
        for d in (world.fa.prep[r], world.fa.raw[r]):
            world.reseal(sealed_dir=str(d))
            assert_blocked(world, "overlaps")
    world.reseal(sealed_dir=str(world.fa.root / "sealed"))
    assert_blocked(world, "overlaps")
    writable = world.fa.tmp / "writable_copy"
    shutil.copytree(world.sealed, writable)
    writable.chmod(0o755)
    world.reseal(sealed_dir=str(writable))
    assert_blocked(world, "not a read-only real directory")
    writable.chmod(0o555)
    (writable / "cohort_ids.json").chmod(0o644)
    assert_blocked(world, "not a read-only, singly linked regular file")


def _rewrite_sealed(world, name, data):
    world.sealed.chmod(0o755)
    path = world.sealed / name
    if path.is_symlink():
        path.unlink()
    elif path.exists():
        path.chmod(0o644)
        path.unlink()
    if data is not None:
        path.write_bytes(data)
        path.chmod(0o444)
    world.sealed.chmod(0o555)


def test_sealed_inventory_mismatch_blocks_before_evaluation(world):
    original = (world.sealed / "patient_cgm_telemetry.csv").read_bytes()
    _rewrite_sealed(world, "patient_cgm_telemetry.csv", original.replace(b",0\n", b",1\n", 1))
    assert_blocked(world, "sealed cohort bytes vs the authority-signed seal inventory")
    _rewrite_sealed(world, "patient_cgm_telemetry.csv", original)
    _rewrite_sealed(world, "extra.json", b"{}")
    assert_blocked(world, "must contain exactly")
    _rewrite_sealed(world, "extra.json", None)
    meal = (world.sealed / "scientific_meal_log.npz").read_bytes()
    _rewrite_sealed(world, "scientific_meal_log.npz", None)
    assert_blocked(world, "must contain exactly")
    _rewrite_sealed(world, "scientific_meal_log.npz", meal)

    # A signed seal whose inventory is not what the construction attested.
    inv = json.loads(json.dumps(world.seal_record["cohort"]["inventory"]))
    inv["files"][0]["sha256"] = "0" * 64
    world.reseal(cohort={"inventory": inv, "cohort_artifact_sha256": world.seal_record["cohort"]["cohort_artifact_sha256"]})
    assert_blocked(world, "sealed cohort artifact digest")
    world.reseal(cohort={"inventory": inv, "cohort_artifact_sha256": tr.cohort_artifact_digest(inv)})
    assert_blocked(world, "attested preparation")


def test_symlink_traversal_and_path_substitution_are_rejected(world, tmp_path):
    t = world.fa.tmp
    for sealed_dir, msg in [(str(t / "x" / ".." / "sealed"), "absolute normalized"),
                            ("sealed", "absolute normalized"),
                            (str(t / "sealed") + "/", "absolute normalized")]:
        world.reseal(sealed_dir=sealed_dir)
        assert_blocked(world, msg)
    link = t / "sealed_link"
    link.symlink_to(world.sealed)
    world.reseal(sealed_dir=str(link))
    assert_blocked(world, "traverses a symlink")
    alias = tmp_path.parent / (tmp_path.name + "-alias")
    alias.symlink_to(t)
    try:
        world.reseal(sealed_dir=str(alias / "sealed"))
        assert_blocked(world, "traverses a symlink")
    finally:
        alias.unlink()
    world.reseal()
    # A sealed file substituted by a symlink to an identical, writable copy.
    copy = t / "prep" / "A" / "cohort_ids.json"
    _rewrite_sealed(world, "cohort_ids.json", None)
    world.sealed.chmod(0o755)
    (world.sealed / "cohort_ids.json").symlink_to(copy)
    world.sealed.chmod(0o555)
    assert_blocked(world, "not a regular file")
    _rewrite_sealed(world, "cohort_ids.json", copy.read_bytes())

    for output, msg in [(t / "sealed" / "results", "overlaps"), (world.fa.root / "results", "overlaps"),
                        (t / "prep" / "A" / "results", "overlaps"), (link / "results", "symlinked ancestor"),
                        (tr.REPO_ROOT / "runs" / "ew01_results", "protected location"),
                        (t / "results" / "data_manifest.json", "protected manifest"),
                        (t / "results" / ".." / "results2", "absolute normalized")]:
        world.authorize_run(output_dir=str(output))
        assert_blocked(world, msg)
    assert not (tr.REPO_ROOT / "runs" / "ew01_results").exists()


# --------------------------------------------------------------------------- bindings


def test_environment_source_and_evidence_bindings_block(world, tmp_path):
    drifted = tmp_path / "requirements.txt"
    drifted.write_bytes(tr.LOCK_PATH.read_bytes() + b"\n")
    assert_blocked(world, "environment lock drift", lock_path=drifted)
    world.authorize_run(execution_commit="0" * 40)
    assert_blocked(world, "repository HEAD vs authorized execution commit")
    inv = run_inventory()
    inv[rs.CHECKPOINT] = "0" * 64
    world.authorize_run(run_source_inventory=inv)
    assert_blocked(world, "checkpoints/stage2_observed")
    inv = run_inventory()
    del inv[rs.CONFIG]
    world.authorize_run(run_source_inventory=inv)
    assert_blocked(world, "authorized run source inventory is missing")
    world.authorize_run(environment={**tr.environment_identity(), "lock_sha256": "1" * 64})
    assert_blocked(world, "environment lock drift")
    world.authorize_run(sealed_cohort_digest="2" * 64)
    assert_blocked(world, "run authorization vs sealed cohort record")
    world.authorize_run()

    # Construction evidence replaced after sealing no longer matches the signed seal.
    world.fa.witness("A", witness={"method": "INDEPENDENT_REEXECUTION"})
    assert_blocked(world, r"sealed cohort generation_receipts\[A\]")
    world.fa.witness("A")
    (world.reg.slots / "C").mkdir()
    assert_blocked(world, "a third or duplicate construction is never accepted")
    (world.reg.slots / "C").rmdir()
    world.reseal(registry_root=str(tmp_path))
    assert_blocked(world, "sealed cohort registry_root")
    world.reseal()

    # A re-issued construction authorization invalidates the run authorization and the seal.
    world.fa.authorize(contract_digest="d" * 64)
    assert_blocked(world, "run authorization vs construction authorization")

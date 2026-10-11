"""EW-01 construction trust boundary: the designated authority, its registry and the records it signs.

Nothing here creates a trust root. The authority's Ed25519 public key and every record it signs live in
a repository-independent registry; when the key, the registry or a required record is absent, every
entry point fails closed. Workers (generation, preparation) write only the slot start marker and
unsigned, deterministic claims. Every binding that preparation or sealing relies on comes from an
authority-signed record, never from local provenance JSON.

Registry layout (all signed records are {"payload": {...}, "signature": base64}):

    <root>/trusted_pubkey.pem                        Ed25519 public key of the designated authority
    <root>/EW01-R1/authorization.json                EW01_CONSTRUCTION_AUTHORIZATION (reserves A and B)
    <root>/EW01-R1/seed_reservation.json             EW01_SEED_RESERVATION
    <root>/EW01-R1/freshness_reference_catalog.json  EW01_FRESHNESS_REFERENCE_CATALOG
    <root>/EW01-R1/comparison_attestation.json       EW01_REPLICA_COMPARISON
    <root>/EW01-R1/slots/<A|B>/started.json          EW01_SLOT_START (unsigned, created exclusively)
    <root>/EW01-R1/slots/<A|B>/generation_receipt.json       EW01_GENERATION_RECEIPT
    <root>/EW01-R1/slots/<A|B>/preparation_attestation.json  EW01_PREPARATION_ATTESTATION
    <root>/EW01-R1/sealed_cohort.json                EW01_SEALED_COHORT (the authority's signature over
                                                     the seal record seal_cohort.py writes)
    <root>/EW01-R1/scientific_run_authorization.json EW01_SCIENTIFIC_RUN_AUTHORIZATION
    <root>/EW01-R1/scientific_attempt.json           EW01_SCIENTIFIC_ATTEMPT (unsigned, created exclusively)
"""
from __future__ import annotations

import base64
import hashlib
import importlib.metadata as md
import json
import os
import platform
import re
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

EW01_DIR = Path(__file__).resolve().parent
REPO_ROOT = EW01_DIR.parents[1]
LOCK_PATH = EW01_DIR / "requirements.txt"

PRODUCTION_REGISTRY_ROOT = Path("/home/akshaya/t2d-execution-registry/EW-01")
TRUST_ANCHOR_NAME = "trusted_pubkey.pem"

EXPERIMENT = "EW-01"
CONSTRUCTION = "EW01-R1"
REPLICAS = ("A", "B")
SELECTED_REPLICA = "A"  # fixed prospectively, before either construction runs
MEAL_LOG_SEED = 20260930  # preparation (meal-log corruption) seed; never the generation seed

GENERATOR_PATH = "backend/generate_health_data_v2.py"
GENERATOR_COMMIT = "1ab28f31fcc0954cf417bb10aafd4c785364e280"
GENERATOR_SOURCE_SHA256 = "830fd86ba1a327ff81749730fe2f97d44f637a87da33ed34f3cff5db75021f7a"
GENERATION_PATIENTS = 300
GENERATION_DAYS = 14
GENERATION_WRITE_TRUTH = True

RAW_SCIENTIFIC = ("patient_cgm_telemetry.csv", "patient_cgm_truth.csv", "patients_ehr.csv")
PREPARED_SCIENTIFIC = ("cohort_exclusions.json", "cohort_ids.json", "id_mapping.json", "patient_cgm_telemetry.csv",
                       "patient_cgm_truth.csv", "patients_ehr.csv", "scientific_meal_log.npz")
PREPARED_METADATA = ("cohort_provenance.json", "freshness_validation_report.json")
PREPARED_ALL = tuple(sorted(PREPARED_SCIENTIFIC + PREPARED_METADATA))

# Code whose identity the authorization approves, as repository-relative paths.
CONSTRUCTION_SOURCES = (
    "backend/input_contract.py",
    "backend/provenance.py",
    "backend/train_pr_tft.py",
    "experiments/early_warning_ew01/EW01_FRESHNESS_2_SCHEMA.json",
    "experiments/early_warning_ew01/ew01_construct.py",
    "experiments/early_warning_ew01/ew01_trust.py",
    "experiments/early_warning_ew01/freshness2.py",
    "experiments/early_warning_ew01/prepare_cohort.py",
    "experiments/early_warning_ew01/provenance_pipeline.py",
    "experiments/early_warning_ew01/requirements.txt",
    "experiments/early_warning_ew01/seal_cohort.py",
)

SIGNING_CONTEXT = b"EW01-AUTHORITY-RECORD/2\n"
AUTHORIZATION = "EW01_CONSTRUCTION_AUTHORIZATION"
SEED_RESERVATION = "EW01_SEED_RESERVATION"
SLOT_START = "EW01_SLOT_START"
GENERATION_RECEIPT = "EW01_GENERATION_RECEIPT"
PREPARATION_CLAIM = "EW01_PREPARATION_CLAIM"
PREPARATION_ATTESTATION = "EW01_PREPARATION_ATTESTATION"
REPLICA_COMPARISON = "EW01_REPLICA_COMPARISON"
REFERENCE_CATALOG = "EW01_FRESHNESS_REFERENCE_CATALOG"
SEALED_COHORT = "EW01_SEALED_COHORT"
SCIENTIFIC_RUN_AUTHORIZATION = "EW01_SCIENTIFIC_RUN_AUTHORIZATION"
SCIENTIFIC_ATTEMPT = "EW01_SCIENTIFIC_ATTEMPT"

GENERATION_WITNESS_METHODS = ("WITNESSED_EXECUTION", "INDEPENDENT_REEXECUTION")
PREPARATION_VERIFICATION_METHODS = ("INDEPENDENT_REPRODUCTION",)

PROTECTED_MANIFEST_NAMES = frozenset({"data_manifest.json", "run_manifest.json", "cohort_manifest.json",
                                      "EW01_PRE_RUN_MANIFEST.json"})
PROTECTED_PATH_COMPONENTS = frozenset({"backend", "runs", "t2d-sealed", ".git"})

HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX40 = re.compile(r"^[0-9a-f]{40}$")


class Blocked(ValueError):
    """A required trust, evidence or safety condition is not met; nothing was written."""


# --------------------------------------------------------------------------- canonical bytes


def canonical_json(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def digest_of(obj: Any) -> str:
    return sha256_bytes(canonical_json(obj))


def _no_duplicate_keys(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise Blocked(f"BLOCKED: duplicate JSON key {k!r}")
        out[k] = v
    return out


def _reject(token):
    raise Blocked(f"BLOCKED: non-integer or non-finite JSON number {token!r}")


def strict_json(data: bytes, what: str) -> Any:
    """Parse JSON that may contain only strings, integers, booleans, null, lists and objects."""
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=_no_duplicate_keys, parse_float=_reject,
                          parse_constant=_reject)
    except Blocked:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise Blocked(f"BLOCKED: {what} is not valid JSON: {e}") from None


def read_regular_file(path: Path, what: str) -> bytes:
    """Read a regular file without following a symlink at the final component."""
    path = Path(path)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        raise Blocked(f"BLOCKED: {what} is absent: {path}") from None
    except OSError as e:
        raise Blocked(f"BLOCKED: {what} cannot be opened safely ({e.strerror}): {path}") from None
    with os.fdopen(fd, "rb") as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            raise Blocked(f"BLOCKED: {what} is not a regular file: {path}")
        return f.read()


# --------------------------------------------------------------------------- authority and registry


def load_trust_anchor(path: Path) -> ed25519.Ed25519PublicKey:
    """The designated authority's Ed25519 key: PEM SubjectPublicKeyInfo or the raw 32-byte key."""
    data = read_regular_file(path, "designated-authority trust anchor")
    try:
        if data.lstrip().startswith(b"-----BEGIN"):
            key = serialization.load_pem_public_key(data)
        else:
            key = ed25519.Ed25519PublicKey.from_public_bytes(data)
    except Exception as e:
        raise Blocked(f"BLOCKED: trust anchor is not a valid Ed25519 key: {e}") from None
    if not isinstance(key, ed25519.Ed25519PublicKey):
        raise Blocked(f"BLOCKED: trust anchor is not an Ed25519 key: {type(key).__name__}")
    return key


@dataclass(frozen=True)
class SignedRecord:
    payload: dict
    digest: str  # sha256 of the exact record file bytes
    path: Path


@dataclass(frozen=True)
class Registry:
    root: Path

    @property
    def construction(self) -> Path:
        return self.root / CONSTRUCTION

    @property
    def authorization(self) -> Path:
        return self.construction / "authorization.json"

    @property
    def seed_reservation(self) -> Path:
        return self.construction / "seed_reservation.json"

    @property
    def catalog(self) -> Path:
        return self.construction / "freshness_reference_catalog.json"

    @property
    def comparison(self) -> Path:
        return self.construction / "comparison_attestation.json"

    @property
    def slots(self) -> Path:
        return self.construction / "slots"

    def slot(self, replica: str) -> Path:
        return self.slots / replica

    def start(self, replica: str) -> Path:
        return self.slot(replica) / "started.json"

    def receipt(self, replica: str) -> Path:
        return self.slot(replica) / "generation_receipt.json"

    def attestation(self, replica: str) -> Path:
        return self.slot(replica) / "preparation_attestation.json"

    @property
    def sealed_cohort(self) -> Path:
        return self.construction / "sealed_cohort.json"

    @property
    def run_authorization(self) -> Path:
        return self.construction / "scientific_run_authorization.json"

    @property
    def scientific_attempt(self) -> Path:
        return self.construction / "scientific_attempt.json"


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


@dataclass(frozen=True)
class Authority:
    registry: Registry
    public_key: ed25519.Ed25519PublicKey
    anchor_sha256: str

    def verify(self, path: Path, record_type: str) -> SignedRecord:
        """Authenticate a signed registry record of the given type, or block."""
        data = read_regular_file(path, f"{record_type} record")
        obj = strict_json(data, f"{record_type} record")
        if not isinstance(obj, dict) or set(obj) != {"payload", "signature"}:
            raise Blocked(f"BLOCKED: {record_type} record is not a signed authority record: {path}")
        payload, sig = obj["payload"], obj["signature"]
        if not isinstance(payload, dict) or not isinstance(sig, str):
            raise Blocked(f"BLOCKED: malformed {record_type} record: {path}")
        try:
            sig_bytes = base64.b64decode(sig, validate=True)
            self.public_key.verify(sig_bytes, SIGNING_CONTEXT + canonical_json(payload))
        except (InvalidSignature, ValueError):
            raise Blocked(f"BLOCKED: invalid authority signature on {record_type} record: {path}") from None
        if payload.get("record_type") != record_type:
            raise Blocked(f"BLOCKED: {path} holds {payload.get('record_type')!r}, expected {record_type}")
        return SignedRecord(payload, sha256_bytes(data), Path(path))


def open_authority(registry_root: Path) -> Authority:
    """The designated authority, from a registry outside the repository; blocks if not provisioned."""
    root = Path(registry_root)
    if not root.is_absolute():
        raise Blocked(f"BLOCKED: registry root must be absolute: {root}")
    if root.is_symlink() or not root.is_dir():
        raise Blocked(f"BLOCKED: designated authority registry is not provisioned: {root}")
    if _inside(root.resolve(), REPO_ROOT.resolve()):
        raise Blocked(f"BLOCKED: registry {root} is inside the repository; it must be repository-independent")
    anchor = root / TRUST_ANCHOR_NAME
    key = load_trust_anchor(anchor)
    return Authority(Registry(root), key, sha256_bytes(read_regular_file(anchor, "trust anchor")))


def require_keys(obj: Any, keys: set[str] | frozenset[str], what: str) -> dict:
    if not isinstance(obj, dict):
        raise Blocked(f"BLOCKED: {what} is not an object")
    missing, extra = sorted(set(keys) - set(obj)), sorted(set(obj) - set(keys))
    if missing:
        raise Blocked(f"BLOCKED: {what} is missing {missing}")
    if extra:
        raise Blocked(f"BLOCKED: {what} has unexpected fields {extra}")
    return obj


def require_equal(actual: Any, expected: Any, what: str) -> None:
    if actual != expected:
        raise Blocked(f"BLOCKED: {what} mismatch: got {actual!r}, expected {expected!r}")


def require_hex(value: Any, pattern: re.Pattern, what: str) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise Blocked(f"BLOCKED: {what} is not a lowercase hex digest: {value!r}")
    return value


def require_int(value: Any, what: str) -> int:
    if type(value) is not int:
        raise Blocked(f"BLOCKED: {what} must be an integer, got {value!r}")
    return value


# --------------------------------------------------------------------------- environment


def normalize_dist(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_lock(path: Path = LOCK_PATH) -> dict[str, str]:
    """{normalized name: version} of a fully hash-pinned lock; any unpinned or unhashed line blocks."""
    pins: dict[str, str] = {}
    text = read_regular_file(path, "environment lock").decode("utf-8")
    for block in text.replace("\\\n", " ").splitlines():
        if not block.strip() or block.lstrip().startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._\-]*)(?:\[[^\]]*\])?==(\S+)\s", block + " ")
        if not m or not re.findall(r"--hash=sha256:[0-9a-f]{64}", block):
            raise Blocked(f"BLOCKED: lock line is not an exact hash-pinned requirement: {block[:80]}")
        name = normalize_dist(m[1])
        if name in pins:
            raise Blocked(f"BLOCKED: duplicate lock pin {name}")
        pins[name] = m[2]
    return pins


def runtime_identity() -> dict:
    libc, libc_version = platform.libc_ver()
    return {
        "implementation": platform.python_implementation(),
        "python_version": platform.python_version(),
        "system": platform.system(),
        "machine": platform.machine(),
        "libc": f"{libc}-{libc_version}",
        "virtualenv": sys.prefix != sys.base_prefix,
    }


def installed_distributions() -> dict[str, str]:
    found: dict[str, set[str]] = {}
    for d in md.distributions():
        name = d.metadata["Name"]
        if name:
            found.setdefault(normalize_dist(name), set()).add(d.version)
    multi = {k: sorted(v) for k, v in found.items() if len(v) > 1}
    if multi:
        raise Blocked(f"BLOCKED: several versions of one distribution are importable: {multi}")
    return {k: next(iter(v)) for k, v in found.items()}


def environment_identity(lock_path: Path = LOCK_PATH) -> dict:
    return {"lock_sha256": sha256_bytes(read_regular_file(lock_path, "environment lock")),
            "runtime": runtime_identity()}


def verify_environment(expected: dict, lock_path: Path = LOCK_PATH) -> dict:
    """The running interpreter must be the approved one, built from exactly the approved lock."""
    require_keys(expected, {"lock_sha256", "runtime"}, "authorized environment")
    actual = environment_identity(lock_path)
    if actual["lock_sha256"] != expected["lock_sha256"]:
        raise Blocked(f"BLOCKED: environment lock drift: {lock_path} is {actual['lock_sha256']}, "
                      f"authorized {expected['lock_sha256']}")
    if actual["runtime"] != expected["runtime"]:
        raise Blocked(f"BLOCKED: runtime environment mismatch: {actual['runtime']} != {expected['runtime']}")
    pins, installed = parse_lock(lock_path), installed_distributions()
    missing = sorted(set(pins) - set(installed))
    extra = sorted(set(installed) - set(pins))
    wrong = sorted(f"{k} {installed[k]} != {pins[k]}" for k in set(pins) & set(installed) if installed[k] != pins[k])
    if missing or extra or wrong:
        raise Blocked(f"BLOCKED: installed distributions do not match the lock: missing={missing[:5]} "
                      f"extra={extra[:5]} version={wrong[:5]}")
    return actual


# --------------------------------------------------------------------------- source identity


def _git(*args: str) -> bytes:
    res = subprocess.run(["git", "-C", str(REPO_ROOT), *args], capture_output=True)
    if res.returncode != 0:
        raise Blocked(f"BLOCKED: git {' '.join(args)} failed: {res.stderr.decode(errors='replace').strip()}")
    return res.stdout


def read_sources(paths: tuple[str, ...] = CONSTRUCTION_SOURCES) -> dict[str, bytes]:
    return {p: read_regular_file(REPO_ROOT / p, f"source {p}") for p in paths}


def source_inventory(paths: tuple[str, ...] = CONSTRUCTION_SOURCES) -> dict[str, str]:
    return {p: sha256_bytes(b) for p, b in read_sources(paths).items()}


def verify_sources(expected: dict, commit: str, paths: tuple[str, ...] = CONSTRUCTION_SOURCES,
                   what: str = "preparation commit") -> dict[str, bytes]:
    """Code on disk, the authorized commit and HEAD must all be the approved source inventory.
    Returns the verified bytes, so callers use exactly what was checked."""
    require_keys(expected, set(paths), "authorized source inventory")
    require_hex(commit, HEX40, f"authorized {what}")
    head = _git("rev-parse", "HEAD").decode().strip()
    require_equal(head, commit, f"repository HEAD vs authorized {what}")
    actual = read_sources(paths)
    for p in paths:
        require_equal(sha256_bytes(actual[p]), expected[p], f"source {p} on disk")
        digest, size = committed_content(commit, p)
        require_equal(digest, expected[p], f"source {p} at {commit}")
        if size is not None:
            require_equal(len(actual[p]), size, f"source {p} size vs its Git LFS pointer")
    return actual


LFS_POINTER = re.compile(rb"version https://git-lfs\.github\.com/spec/v1\noid sha256:([0-9a-f]{64})\nsize ([0-9]+)\n")


def committed_content(commit: str, path: str) -> tuple[str, int | None]:
    """sha256 of the content a commit records for path. A Git LFS pointer records its object by sha256
    and size, so for a pointer blob those are returned; any other blob is hashed as it is."""
    blob = _git("cat-file", "blob", f"{commit}:{path}")
    m = LFS_POINTER.fullmatch(blob)
    return (m[1].decode(), int(m[2])) if m else (sha256_bytes(blob), None)


def require_clean_tree() -> None:
    status = _git("status", "--porcelain").decode()
    if status.strip():
        raise Blocked(f"BLOCKED: the working tree is not clean: {status.splitlines()[:5]}")


# --------------------------------------------------------------------------- inventories and snapshots


def snapshot_directory(path: Path, names: tuple[str, ...], what: str) -> dict[str, bytes]:
    """Read a directory that must hold exactly `names` as regular files, as one stable snapshot.

    Every check and every byte written downstream uses these in-memory bytes, so a concurrent writer
    cannot change what was verified; a directory that changes while it is read blocks."""
    path = Path(path)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        raise Blocked(f"BLOCKED: {what} directory is absent: {path}") from None
    if not stat.S_ISDIR(st.st_mode):
        raise Blocked(f"BLOCKED: {what} is not a real directory: {path}")
    entries = sorted(os.listdir(path))
    if entries != sorted(names):
        raise Blocked(f"BLOCKED: {what} must contain exactly {sorted(names)}; found {entries}")
    out, before = {}, {}
    for n in names:
        fst = os.lstat(path / n)
        if not stat.S_ISREG(fst.st_mode):
            raise Blocked(f"BLOCKED: {what}/{n} is not a regular file")
        before[n] = (fst.st_ino, fst.st_size, fst.st_mtime_ns)
        out[n] = read_regular_file(path / n, f"{what}/{n}")
    if sorted(os.listdir(path)) != entries or any(
            (s.st_ino, s.st_size, s.st_mtime_ns) != before[n] or len(out[n]) != s.st_size
            for n in names for s in [os.lstat(path / n)]):
        raise Blocked(f"BLOCKED: {what} changed while it was being read; no stable snapshot")
    return out


def inventory(snapshot: dict[str, bytes], names: tuple[str, ...] | None = None) -> dict:
    names = tuple(sorted(snapshot)) if names is None else tuple(sorted(names))
    return {"files": [{"path": n, "size": len(snapshot[n]), "sha256": sha256_bytes(snapshot[n])} for n in names]}


def inventory_entry(inv: dict, name: str) -> dict:
    hits = [f for f in inv["files"] if f["path"] == name]
    if len(hits) != 1:
        raise Blocked(f"BLOCKED: inventory does not list {name} exactly once")
    return hits[0]


def validate_inventory(inv: Any, names: tuple[str, ...], what: str) -> dict:
    require_keys(inv, {"files"}, what)
    files = inv["files"]
    if not isinstance(files, list) or [f.get("path") if isinstance(f, dict) else None for f in files] != sorted(names):
        raise Blocked(f"BLOCKED: {what} must list exactly {sorted(names)} in path order")
    for f in files:
        require_keys(f, {"path", "size", "sha256"}, f"{what} entry")
        require_int(f["size"], f"{what} size")
        require_hex(f["sha256"], HEX64, f"{what} sha256")
    return inv


def sub_inventory(inv: dict, names: tuple[str, ...]) -> dict:
    return {"files": [f for f in inv["files"] if f["path"] in names]}


# --------------------------------------------------------------------------- output-path safety


def check_output_path(path: Path | str, what: str, forbidden: tuple[Path, ...] = ()) -> Path:
    """An output path that does not exist, has no symlinked ancestor, and is not a protected location."""
    p = Path(os.path.abspath(path))
    if os.path.lexists(p):
        raise Blocked(f"BLOCKED: {what} already exists and is never overwritten: {p}")
    for anc in p.parents:
        if os.path.lexists(anc) and anc.is_symlink():
            raise Blocked(f"BLOCKED: {what} has a symlinked ancestor {anc}")
    resolved = p.parent.resolve() / p.name
    if p.name in PROTECTED_MANIFEST_NAMES:
        raise Blocked(f"BLOCKED: {what} may not be named like a protected manifest: {p.name}")
    if PROTECTED_PATH_COMPONENTS & set(resolved.parts):
        raise Blocked(f"BLOCKED: {what} is inside a protected location: {resolved}")
    for root in forbidden:
        r = Path(os.path.abspath(root))
        if _inside(resolved, r) or _inside(r, resolved):
            raise Blocked(f"BLOCKED: {what} overlaps a construction input or the registry: {r}")
    return p


def require_outside_repository(path: Path | str, what: str) -> None:
    p = Path(os.path.abspath(path))
    resolved = p.parent.resolve() / p.name
    if _inside(resolved, REPO_ROOT.resolve()) or _inside(p, REPO_ROOT):
        raise Blocked(f"BLOCKED: {what} must be outside the repository: {p}")


def create_exclusive(path: Path, data: bytes, mode: int = 0o444) -> None:
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(path, mode)


# --------------------------------------------------------------------------- authorization


SEALED_COHORT_KEYS = frozenset({"record_type", "experiment", "construction", "selected_replica", "sealed_dir", "cohort",
                                "authorization_digest", "seed_reservation_digest", "generation_seed",
                                "trust_anchor_sha256", "registry_root", "slot_starts", "generation_receipts",
                                "preparation_attestations", "comparison_attestation_digest", "preparation_commit",
                                "environment", "freshness"})


def cohort_artifact_digest(inv: dict) -> str:
    """sha256 over "name:sha256\\n" lines of an inventory, in name order (the seal manifest's cohort digest)."""
    h = hashlib.sha256()
    for f in sorted(inv["files"], key=lambda f: f["path"]):
        h.update(f["path"].encode() + b":" + f["sha256"].encode() + b"\n")
    return h.hexdigest()


def expected_preparation_config() -> dict:
    return {
        "id_scheme": "EW01-R1-{raw_patient_id}",
        "eligibility": "diabetes_status != 'Type 1'",
        "exclusions": "type_1",
        "meal_log_seed": MEAL_LOG_SEED,
        "log_corruption": True,
        "twin_mode": "s3",
    }


def _check_output_dirs(dirs: Any, what: str) -> dict:
    require_keys(dirs, set(REPLICAS), what)
    paths = []
    for r in REPLICAS:
        d = dirs[r]
        if not isinstance(d, str) or not os.path.isabs(d) or os.path.normpath(d) != d:
            raise Blocked(f"BLOCKED: {what}[{r}] must be an absolute normalized path: {d!r}")
        paths.append(Path(d))
    if paths[0] == paths[1] or _inside(paths[0], paths[1]) or _inside(paths[1], paths[0]):
        raise Blocked(f"BLOCKED: {what} must be distinct, non-nested locations per replica")
    return dirs


AUTHORIZATION_KEYS = frozenset({"record_type", "experiment", "construction", "replicas", "selected_replica",
                                "contract_digest", "seed_reservation_digest", "generation", "preparation",
                                "source_inventory", "environment", "freshness"})
GENERATION_KEYS = frozenset({"generator_path", "generator_commit", "generator_source_sha256", "generation_seed",
                             "patients", "days", "write_truth", "output_dirs"})


def validate_authorization(p: dict, schema_digest: str) -> dict:
    require_keys(p, AUTHORIZATION_KEYS, "authorization")
    require_equal(p["experiment"], EXPERIMENT, "authorization experiment")
    require_equal(p["construction"], CONSTRUCTION, "authorization construction")
    require_equal(p["replicas"], list(REPLICAS), "authorized replicas (exactly two constructions)")
    require_equal(p["selected_replica"], SELECTED_REPLICA, "prospectively selected replica")
    require_hex(p["contract_digest"], HEX64, "adopted contract digest")
    require_hex(p["seed_reservation_digest"], HEX64, "seed reservation digest")
    g = require_keys(p["generation"], GENERATION_KEYS, "authorized generation")
    require_equal(g["generator_path"], GENERATOR_PATH, "generator path")
    require_equal(g["generator_commit"], GENERATOR_COMMIT, "generator commit")
    require_equal(g["generator_source_sha256"], GENERATOR_SOURCE_SHA256, "generator source sha256")
    require_int(g["generation_seed"], "generation seed")
    if g["generation_seed"] == MEAL_LOG_SEED:
        raise Blocked("BLOCKED: the generation seed must be separate from the meal-log preparation seed")
    require_equal(g["patients"], GENERATION_PATIENTS, "authorized patients")
    require_equal(g["days"], GENERATION_DAYS, "authorized days")
    require_equal(g["write_truth"], GENERATION_WRITE_TRUTH, "authorized write_truth")
    _check_output_dirs(g["output_dirs"], "generation output_dirs")
    prep = require_keys(p["preparation"], {"preparation_commit", "config", "output_dirs"}, "authorized preparation")
    require_hex(prep["preparation_commit"], HEX40, "preparation commit")
    require_equal(prep["config"], expected_preparation_config(), "authorized preparation config")
    _check_output_dirs(prep["output_dirs"], "preparation output_dirs")
    for r in REPLICAS:
        raw, out = Path(g["output_dirs"][r]), Path(prep["output_dirs"][r])
        for other in [Path(g["output_dirs"][x]) for x in REPLICAS] + [Path(prep["output_dirs"][x]) for x in REPLICAS]:
            if other != out and (_inside(out, other) or _inside(other, out)):
                raise Blocked(f"BLOCKED: preparation output {out} overlaps {other}")
        if raw == out:
            raise Blocked("BLOCKED: preparation output may not be the raw generation output")
    require_keys(p["source_inventory"], set(CONSTRUCTION_SOURCES), "authorized source inventory")
    for v in p["source_inventory"].values():
        require_hex(v, HEX64, "authorized source digest")
    env = require_keys(p["environment"], {"lock_sha256", "runtime"}, "authorized environment")
    require_hex(env["lock_sha256"], HEX64, "authorized lock sha256")
    f = require_keys(p["freshness"], {"schema_id", "schema_digest", "reference_catalog_sha256"}, "authorized freshness")
    require_equal(f["schema_id"], "EW01-FRESHNESS-2", "authorized freshness schema")
    require_equal(f["schema_digest"], schema_digest, "authorized freshness schema digest")
    if f["reference_catalog_sha256"] is None:
        raise Blocked("UNKNOWN: the custodian has not supplied a protected-reference catalog; freshness is unresolved")
    require_hex(f["reference_catalog_sha256"], HEX64, "authorized reference catalog sha256")
    return p


@dataclass(frozen=True)
class Context:
    authority: Authority
    authorization: SignedRecord
    seed_reservation: SignedRecord
    environment: dict
    lock_path: Path

    @property
    def auth(self) -> dict:
        return self.authorization.payload

    @property
    def generation_seed(self) -> int:
        return self.auth["generation"]["generation_seed"]

    def raw_dir(self, replica: str) -> Path:
        return Path(self.auth["generation"]["output_dirs"][replica])

    def prepared_dir(self, replica: str) -> Path:
        return Path(self.auth["preparation"]["output_dirs"][replica])


def load_context(authority: Authority, schema_digest: str, lock_path: Path = LOCK_PATH) -> Context:
    """Authorization, seed reservation, environment and source identity: all verified, or block."""
    reg = authority.registry
    authz = authority.verify(reg.authorization, AUTHORIZATION)
    validate_authorization(authz.payload, schema_digest)
    seed = authority.verify(reg.seed_reservation, SEED_RESERVATION)
    require_keys(seed.payload, {"record_type", "experiment", "construction", "generation_seed"}, "seed reservation")
    require_equal(seed.payload["experiment"], EXPERIMENT, "seed reservation experiment")
    require_equal(seed.payload["construction"], CONSTRUCTION, "seed reservation construction")
    require_equal(seed.digest, authz.payload["seed_reservation_digest"], "seed reservation digest")
    require_equal(seed.payload["generation_seed"], authz.payload["generation"]["generation_seed"],
                  "reserved generation seed vs authorization")
    env = verify_environment(authz.payload["environment"], lock_path)
    verify_sources(authz.payload["source_inventory"], authz.payload["preparation"]["preparation_commit"])
    return Context(authority, authz, seed, env, Path(lock_path))


# --------------------------------------------------------------------------- slots and generation


def canonical_generation_argv(ctx: Context, replica: str) -> list[str]:
    """The only generator invocation a slot may run: every value comes from the authorization."""
    g = ctx.auth["generation"]
    return [GENERATOR_PATH, "--patients", str(g["patients"]), "--days", str(g["days"]),
            "--seed", str(g["generation_seed"]), "--out-dir", g["output_dirs"][replica], "--write-truth"]


def expected_effective_config(ctx: Context, replica: str) -> dict:
    g = ctx.auth["generation"]
    return {"patients": g["patients"], "days": g["days"], "seed": g["generation_seed"],
            "out_dir": g["output_dirs"][replica], "write_truth": g["write_truth"]}


def require_replica(ctx: Context, replica: str) -> str:
    if replica not in ctx.auth["replicas"]:
        raise Blocked(f"BLOCKED: {replica!r} is not a reserved construction slot; only {ctx.auth['replicas']} "
                      "exist and no further construction is authorized")
    return replica


def verify_registry_layout(reg: Registry, *, sealing: bool) -> None:
    """No slot beyond the reserved two, and nothing in a slot beyond its one start, receipt and attestation."""
    if not reg.slots.is_dir() or reg.slots.is_symlink():
        raise Blocked(f"BLOCKED: registry slots are not provisioned: {reg.slots}")
    slots = sorted(os.listdir(reg.slots))
    if slots != sorted(REPLICAS):
        raise Blocked(f"BLOCKED: registry slots must be exactly {list(REPLICAS)}; found {slots} "
                      "(a third or duplicate construction is never accepted)")
    allowed = {"started.json", "generation_receipt.json", "preparation_attestation.json"}
    for r in REPLICAS:
        entries = set(os.listdir(reg.slot(r)))
        if entries - allowed:
            raise Blocked(f"BLOCKED: slot {r} holds unexpected records {sorted(entries - allowed)}")
        if sealing and entries != allowed:
            raise Blocked(f"BLOCKED: slot {r} lacks {sorted(allowed - entries)}; both constructions need full evidence")


def verify_start(ctx: Context, replica: str) -> tuple[dict, str]:
    data = read_regular_file(ctx.authority.registry.start(replica), f"slot {replica} start marker")
    rec = strict_json(data, "slot start marker")
    require_keys(rec, {"record_type", "experiment", "construction", "replica", "authorization_digest",
                       "seed_reservation_digest", "nonce"}, f"slot {replica} start marker")
    require_equal(rec["record_type"], SLOT_START, "slot start record type")
    require_equal(rec["experiment"], EXPERIMENT, "slot start experiment")
    require_equal(rec["construction"], CONSTRUCTION, "slot start construction")
    require_equal(rec["replica"], replica, "slot start replica")
    require_equal(rec["authorization_digest"], ctx.authorization.digest, "slot start authorization")
    require_equal(rec["seed_reservation_digest"], ctx.seed_reservation.digest, "slot start seed reservation")
    require_hex(rec["nonce"], HEX64, "slot start nonce")
    return rec, sha256_bytes(data)


RECEIPT_KEYS = frozenset({"record_type", "experiment", "construction", "replica", "authorization_digest",
                          "slot_start_digest", "contract_digest", "generation_seed", "seed_reservation_digest",
                          "generator_path", "generator_commit", "generator_source_sha256", "environment", "argv",
                          "effective_config", "output_dir", "raw_inventory", "raw_inventory_digest", "witness"})


def verify_generation_receipt(ctx: Context, replica: str) -> SignedRecord:
    """The authority-signed record of one witnessed generation for this slot, checked binding by binding."""
    require_replica(ctx, replica)
    _, start_digest = verify_start(ctx, replica)
    rec = ctx.authority.verify(ctx.authority.registry.receipt(replica), GENERATION_RECEIPT)
    p = require_keys(rec.payload, RECEIPT_KEYS, f"generation receipt {replica}")
    g = ctx.auth["generation"]
    require_equal(p["experiment"], EXPERIMENT, "receipt experiment")
    require_equal(p["construction"], CONSTRUCTION, "receipt construction")
    require_equal(p["replica"], replica, "receipt replica")
    require_equal(p["authorization_digest"], ctx.authorization.digest, "receipt authorization")
    require_equal(p["slot_start_digest"], start_digest, "receipt slot start marker")
    require_equal(p["contract_digest"], ctx.auth["contract_digest"], "receipt contract digest")
    require_equal(p["generation_seed"], g["generation_seed"], "receipt generation seed")
    require_equal(p["seed_reservation_digest"], ctx.seed_reservation.digest, "receipt seed reservation")
    require_equal(p["generator_path"], g["generator_path"], "receipt generator path")
    require_equal(p["generator_commit"], g["generator_commit"], "receipt generator commit")
    require_equal(p["generator_source_sha256"], g["generator_source_sha256"], "receipt generator source")
    require_equal(p["environment"], ctx.auth["environment"], "receipt environment identity")
    require_equal(p["argv"], canonical_generation_argv(ctx, replica), "receipt normalized argument vector")
    require_equal(p["effective_config"], expected_effective_config(ctx, replica), "receipt effective configuration")
    require_equal(p["output_dir"], g["output_dirs"][replica], "receipt replica output location")
    validate_inventory(p["raw_inventory"], RAW_SCIENTIFIC, "receipt raw inventory")
    require_equal(p["raw_inventory_digest"], digest_of(p["raw_inventory"]), "receipt raw inventory digest")
    w = p["witness"]
    if not isinstance(w, dict) or w.get("method") not in GENERATION_WITNESS_METHODS:
        raise Blocked(f"BLOCKED: receipt lacks an authority witness method in {GENERATION_WITNESS_METHODS}")
    return rec

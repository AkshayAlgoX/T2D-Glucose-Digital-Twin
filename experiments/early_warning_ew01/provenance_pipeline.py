"""EW-01 replacement-cohort preparation and sealing under the designated authority.

Workers prepare a reserved slot from its authenticated generation output; the authority independently
reproduces each preparation and compares the two constructions; the sealer accepts only when every
binding is authenticated and recomputed. Functions that return an unsigned payload for the authority
(`verify_preparation_independently`, `compare_replicas`) never sign anything: the authority's private
key is not part of this repository.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ew01_trust import (CONSTRUCTION, EXPERIMENT, LOCK_PATH, MEAL_LOG_SEED, PREPARATION_ATTESTATION,
                        PREPARATION_CLAIM, PREPARATION_VERIFICATION_METHODS, PREPARED_ALL, PREPARED_SCIENTIFIC,
                        RAW_SCIENTIFIC, REPLICA_COMPARISON, REPLICAS, REPO_ROOT, SELECTED_REPLICA, Blocked, Context,
                        SignedRecord, canonical_json, check_output_path, create_exclusive, digest_of, inventory,
                        inventory_entry, load_context, open_authority, require_equal, require_keys, require_replica,
                        sha256_bytes, snapshot_directory, strict_json, sub_inventory, validate_inventory,
                        verify_generation_receipt, verify_registry_layout)
from freshness2 import (EHR_COLUMNS, SCHEMA_DIGEST, SCHEMA_ID, TELEMETRY_COLUMNS, TRUTH_COLUMNS, Catalog,
                        check_freshness, read_csv_bytes, verify_reference_catalog)

sys.path.insert(0, str(REPO_ROOT / "backend"))
import train_pr_tft as T  # noqa: E402


def _context(registry_root: Path, lock_path: Path) -> Context:
    return load_context(open_authority(registry_root), SCHEMA_DIGEST, lock_path)


def _catalog(ctx: Context) -> Catalog:
    return verify_reference_catalog(ctx.authority, ctx.authority.registry.catalog,
                                    ctx.auth["freshness"]["reference_catalog_sha256"], SCHEMA_DIGEST)


# --------------------------------------------------------------------------- deterministic preparation


def remap_csv(data: bytes, mapping: dict[str, str], name: str) -> bytes:
    """Replace the leading patient_id field of every row; every other byte is preserved."""
    lines = data.split(b"\n")
    if lines[-1] != b"" or not lines[0].startswith(b"patient_id,"):
        raise Blocked(f"BLOCKED: {name} is not a generator CSV with a leading patient_id column")
    out = [lines[0]]
    for line in lines[1:-1]:
        pid, sep, rest = line.partition(b",")
        new = mapping.get(pid.decode("ascii", errors="replace"))
        if not sep or new is None:
            raise Blocked(f"BLOCKED: {name} row has an unmapped patient id {pid[:16]!r}")
        out.append(new.encode("ascii") + b"," + rest)
    return b"\n".join(out) + b"\n"


def meal_log_bytes(files: dict[str, bytes], cohort_ids: list[str]) -> bytes:
    """The contract's observed (corrupted) meal log for each eligible mapped id, seed 20260930."""
    with tempfile.TemporaryDirectory(prefix="ew01-meal-") as tmp:
        for name in RAW_SCIENTIFIC:
            Path(tmp, name).write_bytes(files[name])
        cfg = T.TrainConfig(data_dir=tmp, twin_mode="s3", seed=MEAL_LOG_SEED, log_corruption=True)
        series = T.load_data(cfg)
    if sorted(series) != cohort_ids:
        raise Blocked("BLOCKED: meal-log loader cohort differs from the eligibility artifact")
    arrays = {}
    for pid in cohort_ids:
        arrays[f"{pid}_min"] = np.asarray(series[pid].meal_min, dtype=np.float64)
        arrays[f"{pid}_carbs"] = np.asarray(series[pid].meal_carbs, dtype=np.float64)
    buf = io.BytesIO()
    np.savez(buf, **arrays)
    return buf.getvalue()


def build_prepared(ctx: Context, replica: str, receipt: SignedRecord, raw: dict[str, bytes],
                   catalog: Catalog) -> dict[str, bytes]:
    """Every prepared file's bytes, a pure function of authenticated inputs (no clock, no paths)."""
    ehr = read_csv_bytes(raw["patients_ehr.csv"], EHR_COLUMNS, "raw patients_ehr.csv")
    tele = read_csv_bytes(raw["patient_cgm_telemetry.csv"], TELEMETRY_COLUMNS, "raw patient_cgm_telemetry.csv")
    truth = read_csv_bytes(raw["patient_cgm_truth.csv"], TRUTH_COLUMNS, "raw patient_cgm_truth.csv")
    pids = ehr["patient_id"].tolist()
    if set(tele["patient_id"]) != set(pids) or set(truth["patient_id"]) != set(pids):
        raise Blocked("BLOCKED: EHR, telemetry and truth do not cover the same patients")
    report = check_freshness(ehr, tele, catalog, SCHEMA_DIGEST)

    mapping = {pid: f"{CONSTRUCTION}-{pid}" for pid in sorted(pids)}
    if len(set(mapping.values())) != len(mapping):
        raise Blocked("BLOCKED: ID mapping is not bijective")
    status = dict(zip(ehr["patient_id"], ehr["diabetes_status"]))
    files = {name: remap_csv(raw[name], mapping, name) for name in RAW_SCIENTIFIC}
    cohort_ids = sorted(mapping[p] for p in pids if status[p] != "Type 1")
    files["id_mapping.json"] = canonical_json(mapping)
    files["cohort_ids.json"] = canonical_json(cohort_ids)
    files["cohort_exclusions.json"] = canonical_json({"other": [], "type_1": sorted(mapping[p] for p in pids
                                                                                   if status[p] == "Type 1")})
    files["scientific_meal_log.npz"] = meal_log_bytes(files, cohort_ids)
    files["freshness_validation_report.json"] = canonical_json(report)

    a, r = ctx.auth, receipt.payload
    claim = {
        "record_type": PREPARATION_CLAIM,
        "experiment": EXPERIMENT,
        "construction": CONSTRUCTION,
        "replica": replica,
        "authorization_digest": ctx.authorization.digest,
        "contract_digest": a["contract_digest"],
        "generation_receipt_digest": receipt.digest,
        "slot_start_digest": r["slot_start_digest"],
        "raw_inventory_digest": r["raw_inventory_digest"],
        "generation_seed": r["generation_seed"],
        "seed_reservation_digest": r["seed_reservation_digest"],
        "preparation_commit": a["preparation"]["preparation_commit"],
        "source_inventory": a["source_inventory"],
        "environment": ctx.environment,
        "preparation_config": a["preparation"]["config"],
        "id_mapping_sha256": sha256_bytes(files["id_mapping.json"]),
        "cohort_ids_sha256": sha256_bytes(files["cohort_ids.json"]),
        "cohort_exclusions_sha256": sha256_bytes(files["cohort_exclusions.json"]),
        "prepared_scientific_inventory": inventory(files, PREPARED_SCIENTIFIC),
        "freshness": {
            "schema_id": SCHEMA_ID,
            "schema_digest": SCHEMA_DIGEST,
            "reference_catalog_sha256": catalog.digest,
            "reference_coverage": catalog.coverage,
            "validation_report_sha256": sha256_bytes(files["freshness_validation_report.json"]),
        },
    }
    files["cohort_provenance.json"] = canonical_json(claim)
    return files


def _authenticated_raw(ctx: Context, replica: str, receipt: SignedRecord) -> dict[str, bytes]:
    raw = snapshot_directory(ctx.raw_dir(replica), RAW_SCIENTIFIC, f"raw output of slot {replica}")
    require_equal(inventory(raw), receipt.payload["raw_inventory"], f"slot {replica} raw inventory vs signed receipt")
    return raw


def prepare_replica(replica: str, *, registry_root: Path, assert_seed: int | None = None,
                    lock_path: Path = LOCK_PATH) -> dict:
    """Prepare one reserved slot. Every check runs before the output directory is created; once it is
    created the slot's single preparation is spent, whatever happens next."""
    ctx = _context(registry_root, lock_path)
    reg = ctx.authority.registry
    require_replica(ctx, replica)
    verify_registry_layout(reg, sealing=False)
    if assert_seed is not None and assert_seed != ctx.generation_seed:
        raise Blocked(f"BLOCKED: asserted generation seed {assert_seed} is not the authorized seed")
    if os.path.lexists(reg.attestation(replica)):
        raise Blocked(f"BLOCKED: slot {replica} already has a preparation attestation; one preparation per slot")
    receipt = verify_generation_receipt(ctx, replica)
    inputs = tuple(ctx.raw_dir(r) for r in REPLICAS) + (reg.root,)
    out_dir = check_output_path(ctx.prepared_dir(replica), f"slot {replica} preparation output", inputs)
    raw = _authenticated_raw(ctx, replica, receipt)
    files = build_prepared(ctx, replica, receipt, raw, _catalog(ctx))
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    os.mkdir(out_dir, 0o755)
    for name in PREPARED_ALL:
        create_exclusive(out_dir / name, files[name], 0o644)
    return inventory(files)


# --------------------------------------------------------------------------- authority-side tools


def verify_preparation_independently(replica: str, *, registry_root: Path, lock_path: Path = LOCK_PATH) -> dict:
    """For the authority: reproduce the slot's preparation from authenticated raw bytes and compare every
    worker file byte for byte. Returns the unsigned attestation payload only if all match."""
    ctx = _context(registry_root, lock_path)
    reg = ctx.authority.registry
    require_replica(ctx, replica)
    verify_registry_layout(reg, sealing=False)
    if os.path.lexists(reg.attestation(replica)):
        raise Blocked(f"BLOCKED: slot {replica} is already attested")
    receipt = verify_generation_receipt(ctx, replica)
    reproduced = build_prepared(ctx, replica, receipt, _authenticated_raw(ctx, replica, receipt), _catalog(ctx))
    worker = snapshot_directory(ctx.prepared_dir(replica), PREPARED_ALL, f"slot {replica} prepared output")
    differing = [n for n in PREPARED_ALL if worker[n] != reproduced[n]]
    if differing:
        raise Blocked(f"BLOCKED: slot {replica} worker output differs from independent reproduction: {differing}")
    claim = strict_json(worker["cohort_provenance.json"], "preparation claim")
    payload = {k: v for k, v in claim.items() if k != "record_type"}
    payload.update({
        "record_type": PREPARATION_ATTESTATION,
        "prepared_inventory": inventory(worker),
        "provenance_sha256": sha256_bytes(worker["cohort_provenance.json"]),
        "verification": {"method": "INDEPENDENT_REPRODUCTION",
                         "reproduced_prepared_inventory_digest": digest_of(inventory(reproduced))},
    })
    return payload


ATTESTATION_KEYS = frozenset({"record_type", "experiment", "construction", "replica", "authorization_digest",
                              "contract_digest", "generation_receipt_digest", "slot_start_digest",
                              "raw_inventory_digest", "generation_seed", "seed_reservation_digest",
                              "preparation_commit", "source_inventory", "environment", "preparation_config",
                              "id_mapping_sha256", "cohort_ids_sha256", "cohort_exclusions_sha256",
                              "prepared_scientific_inventory", "freshness", "prepared_inventory",
                              "provenance_sha256", "verification"})


def verify_preparation_attestation(ctx: Context, replica: str, receipt: SignedRecord) -> SignedRecord:
    """Authenticate the slot's preparation attestation; every expected value comes from the
    authorization or the authenticated receipt, never from local provenance JSON."""
    rec = ctx.authority.verify(ctx.authority.registry.attestation(replica), PREPARATION_ATTESTATION)
    p = require_keys(rec.payload, ATTESTATION_KEYS, f"preparation attestation {replica}")
    a, r = ctx.auth, receipt.payload
    for key, expected in [("experiment", EXPERIMENT), ("construction", CONSTRUCTION), ("replica", replica),
                          ("authorization_digest", ctx.authorization.digest),
                          ("contract_digest", a["contract_digest"]), ("generation_receipt_digest", receipt.digest),
                          ("slot_start_digest", r["slot_start_digest"]),
                          ("raw_inventory_digest", r["raw_inventory_digest"]),
                          ("generation_seed", a["generation"]["generation_seed"]),
                          ("seed_reservation_digest", ctx.seed_reservation.digest),
                          ("preparation_commit", a["preparation"]["preparation_commit"]),
                          ("source_inventory", a["source_inventory"]), ("environment", a["environment"]),
                          ("preparation_config", a["preparation"]["config"])]:
        require_equal(p[key], expected, f"attestation {replica} {key}")
    inv = validate_inventory(p["prepared_inventory"], PREPARED_ALL, f"attestation {replica} prepared inventory")
    require_equal(p["prepared_scientific_inventory"], sub_inventory(inv, PREPARED_SCIENTIFIC),
                  f"attestation {replica} scientific inventory")
    for key, name in [("id_mapping_sha256", "id_mapping.json"), ("cohort_ids_sha256", "cohort_ids.json"),
                      ("cohort_exclusions_sha256", "cohort_exclusions.json"),
                      ("provenance_sha256", "cohort_provenance.json")]:
        require_equal(p[key], inventory_entry(inv, name)["sha256"], f"attestation {replica} {key}")
    f = require_keys(p["freshness"], {"schema_id", "schema_digest", "reference_catalog_sha256", "reference_coverage",
                                      "validation_report_sha256"}, f"attestation {replica} freshness")
    require_equal(f["schema_id"], a["freshness"]["schema_id"], "attested freshness schema")
    require_equal(f["schema_digest"], a["freshness"]["schema_digest"], "attested freshness schema digest")
    require_equal(f["reference_catalog_sha256"], a["freshness"]["reference_catalog_sha256"], "attested catalog")
    require_equal(f["validation_report_sha256"], inventory_entry(inv, "freshness_validation_report.json")["sha256"],
                  "attested validation report")
    v = require_keys(p["verification"], {"method", "reproduced_prepared_inventory_digest"},
                     f"attestation {replica} verification")
    if v["method"] not in PREPARATION_VERIFICATION_METHODS:
        raise Blocked(f"BLOCKED: attestation {replica} does not record independent verification")
    require_equal(v["reproduced_prepared_inventory_digest"], digest_of(inv), f"attestation {replica} reproduction")
    return rec


@dataclass
class Evidence:
    receipt: SignedRecord
    attestation: SignedRecord
    raw_inventory: dict
    prepared_scientific_inventory: dict
    prepared: dict[str, bytes] | None
    identities: tuple


def _dir_identity(path: Path) -> tuple:
    st = os.lstat(path)
    return st.st_dev, st.st_ino


def replica_evidence(ctx: Context, replica: str, keep_prepared: bool) -> Evidence:
    """Authenticate and recompute everything for one construction from stable snapshots."""
    receipt = verify_generation_receipt(ctx, replica)
    att = verify_preparation_attestation(ctx, replica, receipt)
    raw_inv = inventory(_authenticated_raw(ctx, replica, receipt))
    prepared = snapshot_directory(ctx.prepared_dir(replica), PREPARED_ALL, f"slot {replica} prepared output")
    require_equal(inventory(prepared), att.payload["prepared_inventory"],
                  f"slot {replica} prepared inventory vs signed attestation")
    report = strict_json(prepared["freshness_validation_report.json"], "freshness validation report")
    if not isinstance(report, dict) or report.get("disposition") != "PASS" or \
            report.get("schema_digest") != ctx.auth["freshness"]["schema_digest"] or \
            report.get("reference_catalog_sha256") != ctx.auth["freshness"]["reference_catalog_sha256"]:
        raise Blocked(f"BLOCKED: slot {replica} freshness validation report is not an authorized PASS")
    return Evidence(receipt, att, raw_inv, inventory(prepared, PREPARED_SCIENTIFIC),
                    prepared if keep_prepared else None,
                    (_dir_identity(ctx.raw_dir(replica)), _dir_identity(ctx.prepared_dir(replica))))


def _require_distinct(ev: dict[str, Evidence]) -> None:
    a, b = (ev[r] for r in REPLICAS)
    if (a.receipt.digest == b.receipt.digest or a.attestation.digest == b.attestation.digest
            or a.receipt.payload["slot_start_digest"] == b.receipt.payload["slot_start_digest"]
            or set(a.identities) & set(b.identities)):
        raise Blocked("BLOCKED: duplicate replica: the two constructions share evidence or directories")


def _require_replicas_match(ev: dict[str, Evidence]) -> None:
    a, b = (ev[r] for r in REPLICAS)
    if a.raw_inventory != b.raw_inventory:
        raise Blocked("BLOCKED: raw scientific inventories of the two constructions differ")
    if a.prepared_scientific_inventory != b.prepared_scientific_inventory:
        raise Blocked("BLOCKED: prepared scientific inventories of the two constructions differ")


def compare_replicas(*, registry_root: Path, lock_path: Path = LOCK_PATH) -> dict:
    """For the authority: the unsigned comparison payload, produced only if both constructions are fully
    evidenced, distinct, and identical in raw and prepared scientific payload."""
    ctx = _context(registry_root, lock_path)
    reg = ctx.authority.registry
    verify_registry_layout(reg, sealing=True)
    if os.path.lexists(reg.comparison):
        raise Blocked("BLOCKED: a comparison attestation already exists")
    ev = {r: replica_evidence(ctx, r, keep_prepared=False) for r in REPLICAS}
    _require_distinct(ev)
    _require_replicas_match(ev)
    return _comparison_payload(ctx, ev)


def _comparison_payload(ctx: Context, ev: dict[str, Evidence]) -> dict:
    return {
        "record_type": REPLICA_COMPARISON,
        "experiment": EXPERIMENT,
        "construction": CONSTRUCTION,
        "authorization_digest": ctx.authorization.digest,
        "selected_replica": ctx.auth["selected_replica"],
        "replicas": {r: {"generation_receipt_digest": ev[r].receipt.digest,
                         "preparation_attestation_digest": ev[r].attestation.digest,
                         "slot_start_digest": ev[r].receipt.payload["slot_start_digest"]} for r in REPLICAS},
        "raw_scientific_inventory": ev[REPLICAS[0]].raw_inventory,
        "prepared_scientific_inventory": ev[REPLICAS[0]].prepared_scientific_inventory,
        "result": "MATCH",
    }


# --------------------------------------------------------------------------- sealing


def cohort_artifact_sha256(files: dict[str, bytes]) -> str:
    """The digest run_scientific.py recomputes over the sealed directory."""
    import hashlib
    h = hashlib.sha256()
    for name in sorted(files):
        h.update(name.encode() + b":" + sha256_bytes(files[name]).encode() + b"\n")
    return h.hexdigest()


def seal_construction(*, registry_root: Path, sealed_dir: Path, manifest_path: Path,
                      lock_path: Path = LOCK_PATH) -> dict:
    """Seal the prospectively selected replica into a new read-only directory plus a new manifest.

    Inputs are never modified or made read-only: the sealed copy is written from the same in-memory
    snapshot that was verified, so nothing can change between verification and sealing."""
    ctx = _context(registry_root, lock_path)
    reg = ctx.authority.registry
    inputs = tuple(ctx.raw_dir(r) for r in REPLICAS) + tuple(ctx.prepared_dir(r) for r in REPLICAS) + (reg.root,)
    sealed = check_output_path(sealed_dir, "sealed cohort directory", inputs)
    manifest = check_output_path(manifest_path, "seal manifest", inputs + (sealed,))
    verify_registry_layout(reg, sealing=True)
    selected = ctx.auth["selected_replica"]
    require_equal(selected, SELECTED_REPLICA, "selected replica")
    if not os.path.lexists(reg.comparison):
        raise Blocked("BLOCKED: signed comparison attestation is absent")
    _catalog(ctx)
    ev = {r: replica_evidence(ctx, r, keep_prepared=(r == selected)) for r in REPLICAS}
    _require_distinct(ev)
    _require_replicas_match(ev)
    comparison = ctx.authority.verify(reg.comparison, REPLICA_COMPARISON)
    require_equal(comparison.payload, _comparison_payload(ctx, ev), "signed comparison attestation")

    snapshot = ev[selected].prepared
    sealed.parent.mkdir(parents=True, exist_ok=True)
    os.mkdir(sealed, 0o700)
    created = []
    try:
        for name in PREPARED_ALL:
            create_exclusive(sealed / name, snapshot[name], 0o444)
            created.append(name)
        os.chmod(sealed, 0o555)
        written = snapshot_directory(sealed, PREPARED_ALL, "sealed cohort")
        require_equal(inventory(written), inventory(snapshot), "sealed copy vs verified snapshot")
        record = {
            "experiment": EXPERIMENT,
            "construction": CONSTRUCTION,
            "selected_replica": selected,
            "cohort": {"cohort_artifact_sha256": cohort_artifact_sha256(written), "inventory": inventory(written)},
            "authorization_digest": ctx.authorization.digest,
            "seed_reservation_digest": ctx.seed_reservation.digest,
            "generation_seed": ctx.generation_seed,
            "trust_anchor_sha256": ctx.authority.anchor_sha256,
            "registry_root": str(reg.root),
            "slot_starts": {r: ev[r].receipt.payload["slot_start_digest"] for r in REPLICAS},
            "generation_receipts": {r: ev[r].receipt.digest for r in REPLICAS},
            "preparation_attestations": {r: ev[r].attestation.digest for r in REPLICAS},
            "comparison_attestation_digest": comparison.digest,
            "preparation_commit": ctx.auth["preparation"]["preparation_commit"],
            "environment": ctx.environment,
            "freshness": ctx.auth["freshness"],
        }
        manifest.parent.mkdir(parents=True, exist_ok=True)
        create_exclusive(manifest, json.dumps(record, indent=2, sort_keys=True).encode() + b"\n", 0o444)
    except BaseException:
        os.chmod(sealed, 0o700)
        for name in created:
            os.unlink(sealed / name)
        os.rmdir(sealed)
        raise
    return record

"""EW-01 construction controls against the designated registry (production registry pinned).

    python ew01_construct.py start --replica A        mark a reserved slot started (once, never replenished)
    python ew01_construct.py generate --replica A     run the authorized generator invocation once
    python ew01_construct.py verify-preparation --replica A   authority: reproduce and print attestation payload
    python ew01_construct.py compare                  authority: print comparison payload

Payloads are printed unsigned; the designated authority signs them with its own key outside this
repository. Nothing here retries a failed step or creates registry structure.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import sys
from pathlib import Path

from ew01_trust import (CONSTRUCTION, EXPERIMENT, GENERATOR_PATH, LOCK_PATH, PRODUCTION_REGISTRY_ROOT,
                        RAW_SCIENTIFIC, REPLICAS, REPO_ROOT, SLOT_START, Blocked, canonical_json,
                        canonical_generation_argv, check_output_path, create_exclusive, digest_of,
                        expected_effective_config, inventory, load_context, open_authority, read_regular_file,
                        require_equal, require_replica, sha256_bytes, snapshot_directory, verify_registry_layout,
                        verify_start)
from freshness2 import SCHEMA_DIGEST


def start_slot(replica: str, *, registry_root: Path, lock_path: Path = LOCK_PATH) -> dict:
    """Create the slot's start marker exclusively. A started slot stays spent even if generation fails."""
    ctx = load_context(open_authority(registry_root), SCHEMA_DIGEST, lock_path)
    reg = ctx.authority.registry
    require_replica(ctx, replica)
    verify_registry_layout(reg, sealing=False)
    if os.path.lexists(reg.receipt(replica)) or os.path.lexists(reg.attestation(replica)):
        raise Blocked(f"BLOCKED: slot {replica} already holds construction evidence")
    if os.path.lexists(ctx.raw_dir(replica)):
        raise Blocked(f"BLOCKED: slot {replica} output location already exists: {ctx.raw_dir(replica)}")
    record = {"record_type": SLOT_START, "experiment": EXPERIMENT, "construction": CONSTRUCTION, "replica": replica,
              "authorization_digest": ctx.authorization.digest,
              "seed_reservation_digest": ctx.seed_reservation.digest, "nonce": secrets.token_hex(32)}
    try:
        create_exclusive(reg.start(replica), canonical_json(record), 0o444)
    except FileExistsError:
        raise Blocked(f"BLOCKED: slot {replica} was already started; slots are never replenished") from None
    return record


def run_generation(replica: str, *, registry_root: Path, lock_path: Path = LOCK_PATH, runner=subprocess.run) -> dict:
    """Run the one authorized generator invocation for a started slot and return the unsigned claim the
    authority witnesses. A failure consumes the slot; there is no retry."""
    ctx = load_context(open_authority(registry_root), SCHEMA_DIGEST, lock_path)
    reg = ctx.authority.registry
    require_replica(ctx, replica)
    verify_registry_layout(reg, sealing=False)
    _, start_digest = verify_start(ctx, replica)
    if os.path.lexists(reg.receipt(replica)):
        raise Blocked(f"BLOCKED: slot {replica} already has a generation receipt")
    inputs = tuple(ctx.prepared_dir(r) for r in REPLICAS) + (reg.root,)
    check_output_path(ctx.raw_dir(replica), f"slot {replica} generation output", inputs)
    source = read_regular_file(REPO_ROOT / GENERATOR_PATH, "generator source")
    require_equal(sha256_bytes(source), ctx.auth["generation"]["generator_source_sha256"], "generator source sha256")
    argv = canonical_generation_argv(ctx, replica)
    res = runner([sys.executable, *argv], cwd=str(REPO_ROOT))
    if res.returncode != 0:
        raise Blocked(f"BLOCKED: generation for slot {replica} exited {res.returncode}; the slot is spent")
    raw = snapshot_directory(ctx.raw_dir(replica), RAW_SCIENTIFIC, f"slot {replica} generation output")
    raw_inv = inventory(raw)
    g = ctx.auth["generation"]
    return {"record_type": "EW01_GENERATION_CLAIM", "experiment": EXPERIMENT, "construction": CONSTRUCTION,
            "replica": replica, "authorization_digest": ctx.authorization.digest, "slot_start_digest": start_digest,
            "contract_digest": ctx.auth["contract_digest"], "generation_seed": g["generation_seed"],
            "seed_reservation_digest": ctx.seed_reservation.digest, "generator_path": g["generator_path"],
            "generator_commit": g["generator_commit"], "generator_source_sha256": g["generator_source_sha256"],
            "environment": ctx.environment, "argv": argv, "effective_config": expected_effective_config(ctx, replica),
            "output_dir": g["output_dirs"][replica], "raw_inventory": raw_inv,
            "raw_inventory_digest": digest_of(raw_inv)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="EW-01 construction controls (production registry pinned)")
    sub = ap.add_subparsers(dest="command", required=True)
    for name in ("start", "generate", "verify-preparation"):
        sub.add_parser(name).add_argument("--replica", required=True)
    sub.add_parser("compare")
    args = ap.parse_args(argv)
    from provenance_pipeline import compare_replicas, verify_preparation_independently
    root = PRODUCTION_REGISTRY_ROOT
    try:
        if args.command == "start":
            out = start_slot(args.replica, registry_root=root)
        elif args.command == "generate":
            out = run_generation(args.replica, registry_root=root)
        elif args.command == "verify-preparation":
            out = verify_preparation_independently(args.replica, registry_root=root)
        else:
            out = compare_replicas(registry_root=root)
    except Blocked as e:
        print(e, file=sys.stderr)
        return 1
    print(json.dumps(out, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())

# AMENDMENT 003: EXECUTION AND B1 SUCCESS

## Overview
This amendment defines the exact frozen protocol for the EW-01 scientific runner and B1 confirmatory contract, resolving all execution ambiguity.

**Revision note (2026-10-11, documentation only).** Sections 3 and 4 originally described an unsigned local manifest, an attempt ledger whose registry directory the runner created itself, and a sealer that made the cohort read-only in place. They now describe the authenticated runner gate (commit `68bcb278`, evidence `8ef50baa`) and the attempt-reservation design. Sections 1, 2 and 5 are unchanged: the B1 contract, the success predicate, the thresholds and the bootstrap seed. This file is one of the runner's bound `RUN_SOURCES`, so its sha256 in any future run authorization must be this revision's.

## 1. B1 Confirmatory Contract
- B1 is `experiments.baselines.point.linear_trend`.
- B1 forecasts are evaluated at the exact same causal decision grid as B7 and B9.
- `g0` is obtained from `ps.cgm_ff[t]` to ensure canonical handling of dropped telemetry.
- B1 triggers are derived via `forecast_meets_spike_rule` and fed through the locked event-warning machinery (cooldown, persistence, etc.).
- B1 is executed only if B7@0.35 vs B9 passes the Amendment 002 gate.

## 2. B1 Success Predicate
- $D_S = Sensitivity(B7@0.35) - Sensitivity(B1)$
- $D_F = FA/day(B7@0.35) - FA/day(B1)$
- Evaluated on the primary patient set with the same status-stratified paired bootstrap (seed 20260930).
- **PASS condition**: $95\% CI_{lower}(D_S) > +0.02$ AND $95\% CI_{upper}(D_F) < -0.10$.
- Any undefined decisive quantity yields `NO_PASS_UNDEFINED`.

## 3. One-Scientific-Attempt Contract
- The runner (`run_scientific.py`) takes no arguments and opens only the designated registry `/home/akshaya/t2d-execution-registry/EW-01/`. No alternate path, CLI argument, environment variable, legacy manifest or local ledger can redirect it or stand in for authorization.
- The registry, its trust anchor (`trusted_pubkey.pem`) and its records are provisioned by the designated authority. The runner never creates the registry or any of its directories. If any of them is absent, it returns BLOCKED before it opens scientific inputs or writes anything.
- The attempt is reserved only after the complete authorization gate (Section 4) has passed. The runner creates `EW01-R1/scientific_attempt.json` exclusively in the existing registry. The marker is unsigned, so its integrity relies on the registry being append-only. It binds the run-authorization and sealed-cohort digests and a random nonce.
- The first reservation irrevocably consumes the entitlement. If the marker already exists, whatever its content, the run blocks. Any failure after reservation spends the attempt; once the output directory exists, the outcome is recorded as INVALID. Nothing is retried.
- A ledger in the output directory (`attempt_ledger.json`, `attempt_outcome.json`) is a record only. It is never read as permission, and an output directory that already exists blocks the run.

## 4. Cohort Sealing and Root of Trust
- The sealer (`seal_cohort.py`) never modifies or chmods its inputs. It authenticates both replica constructions and their signed comparison, then writes the selected replica from the verified in-memory snapshot into a *new* read-only directory outside the repository. It also writes a seal manifest, the unsigned `EW01_SEALED_COHORT` payload.
- The root of trust is the designated authority's Ed25519 key. The runner accepts only these authority-signed records:
  - `EW01_SEALED_COHORT`, the authority's signature over the verified seal manifest;
  - `EW01_SCIENTIFIC_RUN_AUTHORIZATION`, which binds the sealed-cohort record, the execution commit, the sha256 of every run source and model artifact (`RUN_SOURCES`: code, checkpoint, normalization, calibration, habit, config and these amendments), the locked environment and the output directory.
- An unsigned or locally edited manifest is never authorization.
- Before inference the runner re-verifies every construction record the seal relied on. It requires a clean working tree whose HEAD is the authorized commit, the locked environment, and on-disk and committed bytes equal to the signed digests. A Git LFS pointer is checked by its oid and size.
- The runner reads the cohort only from the signed sealed directory. That directory must be absolute and normalized; outside the repository, the registry and every construction directory; free of symlinks; read-only and singly linked. Its bytes must equal the signed inventory before loading and again after.
- The gate reads `patient_cgm_truth.csv` only to hash it for this integrity check; truth is never passed to the loader or evaluator (Section 5).
- `VERIFICATION PATH == ACTUAL LOADED PATH`; model artifacts are used from the exact bytes that were verified. There is no fallback to unverified paths.

## 5. Trace and Result Contract
- B1 event metrics are properly populated in the final trace.
- The execution relies entirely on `result, trace = evaluate_locked_core(..., trace=True)`.
- No truth arrays (`patient_cgm_truth.csv`) are loaded during the scoring process.

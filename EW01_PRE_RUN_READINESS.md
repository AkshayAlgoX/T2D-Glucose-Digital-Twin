# EW01 PRE-RUN READINESS

## 1. Exact Decision Rule
- The exact decision rule has been explicitly frozen in `experiments/protocol_amendments/EW01_AMENDMENT_002_BOOLEAN_PREDICATE.md`.
- **PASS_B7_VS_B9** = (B7_sens_lb > 0.02) AND (B7_fa_ub < -0.10).
- B1 evaluation is strictly conditional on the B7 vs B9 pass.
- B7@0.60 is descriptive only.
- **NO post-hoc changes allowed.**

## 2. Exact Metric Contract
- **Co-Primary Metrics**: Event Sensitivity, False Alerts per patient-day.
- **Secondary/Descriptive Metrics**: Alert precision, Alerts per patient-day, Full lead-time distribution (median lead time), At-risk fraction, Calibrated ECE, Undefined-draw count.

## 3. Cohort Choice
**FRESH COHORT = PREFERRED AND MANDATED.**
A fresh, EW-specific cohort generated from frozen code, sealed before scoring, hashed, explicitly excluded from training decisions.
- Specification: 300 patients, 14 days, `--write-truth`, generator `backend/generate_health_data_v2.py` at commit `1ab28f31`, built as exactly two replica constructions (EW01-R1/A and EW01-R1/B, with A selected prospectively).
- Generation seed: **conditional**. It is the integer in the authority-signed `EW01_SEED_RESERVATION` record in the designated registry, and nothing else. 20261016 is proposed but not reserved. The earlier proposal 20261014 is withdrawn. The meal-log preparation seed 20260930 is separate and never the generation seed.

## 4. Q0-03 Status (Parity)
**PASSED.**
- Engineering parity has been fully proven and signed off by T3.
- The `evaluate_locked_core` mathematically reproduces the locked evaluator's functionality to 1e-6 precision, verified with strict negative controls on the original VAL dataset.

## 5. Provenance Requirements
There is no locally editable "approved manifest". The scientific runner `experiments/early_warning_ew01/run_scientific.py` (gate implemented at commit `68bcb278`; evidence at `8ef50baa`) accepts only records that the designated authority has signed with Ed25519 into the registry at `/home/akshaya/t2d-execution-registry/EW-01/`:
- `EW01-R1/sealed_cohort.json` (`EW01_SEALED_COHORT`): the authority's signature over the seal record that `seal_cohort.py` writes. It binds the sealed directory, its inventory, and every construction record the seal relied on.
- `EW01-R1/scientific_run_authorization.json` (`EW01_SCIENTIFIC_RUN_AUTHORIZATION`): binds the sealed-cohort record, the execution commit, and the sha256 of every run source and model artifact (`RUN_SOURCES`, including this protocol's amendments). It also binds the locked environment and the output directory.

Before it creates anything, the runner verifies:
- every signature, and every binding;
- a clean working tree whose HEAD is the authorized commit;
- the locked environment;
- the sealed directory: it must be outside the repository, contain no symlinks, be read-only, and match the signed bytes.

It then reserves the single attempt by creating `EW01-R1/scientific_attempt.json` exclusively. It never creates the registry or any of its directories. `SCIENTIFIC_EVALUATION=true` is an additional opt-in, not a substitute for any of these checks.

## 6. Safety and Kill Conditions
The one-shot scientific runner guarantees:
- No automatic retry or resume.
- No output overwrite.
- Immutable inputs: the runner scores only the verified, read-only sealed copy. Sealing writes that copy anew and never modifies or chmods the construction outputs.
- Reject on any integrity failure.

## 7. Execution Sequence (reference only; nothing here may be run before Section 8 is cleared)
The legacy commands are withdrawn. They wrote into `experiments/early_warning_ew01/scientific_cohort` with seed 20261014 and used a locally finalized `EW01_PRE_RUN_MANIFEST.json`. Every current entry point pins the designated registry, and blocks if the registry, the trust anchor or any required signed record is absent.
1. `python experiments/early_warning_ew01/ew01_construct.py start --replica A` (then `B`): marks a reserved slot started. A slot is never replenished.
2. `python experiments/early_warning_ew01/ew01_construct.py generate --replica A` (then `B`): runs the one authorized generator invocation. The authority witnesses it and signs `EW01_GENERATION_RECEIPT`.
3. `python experiments/early_warning_ew01/prepare_cohort.py --replica A` (then `B`; `--assert-seed N` only asserts the reserved seed). The authority independently reproduces the preparation and signs `EW01_PREPARATION_ATTESTATION`.
4. The authority compares both constructions (`ew01_construct.py compare`) and signs `EW01_REPLICA_COMPARISON`.
5. `python experiments/early_warning_ew01/seal_cohort.py --sealed-dir <new directory outside the repository> --manifest <new path>`. The authority verifies the seal and signs its manifest payload as `EW01_SEALED_COHORT`.
6. The authority signs `EW01_SCIENTIFIC_RUN_AUTHORIZATION`.
7. `SCIENTIFIC_EVALUATION=true python experiments/early_warning_ew01/run_scientific.py`. It takes no arguments, and runs from a clean checkout at the authorized commit in the locked environment.

## 8. What Remains Blocked
The one-shot scientific score remains **BLOCKED** on external, owner-controlled prerequisites:
- the genuine designated authority, its registry and `trusted_pubkey.pem`;
- the signed construction authorization and the approved seed reservation;
- the custodian-supplied EW01-FRESHNESS-2 reference catalog;
- witnessed generation receipts, independent preparation attestations and the signed replica comparison;
- the signed `EW01_SEALED_COHORT` and `EW01_SCIENTIFIC_RUN_AUTHORIZATION`;
- an append-only guarantee for the registry.

## FINAL STATUS
**OPERATIONALLY BLOCKED.** The runner-gate code remediation (`68bcb278`) awaits independent T3 adversarial re-audit. No cohort has been generated, sealed or scored.

# EW-01 Scientific Runner Design

## Objective
Provide an immutable, one-shot scientific execution entrypoint (`experiments/early_warning_ew01/run_scientific.py`) for the final BL-01 EW-01 evaluation. The runner must cryptographically verify inputs, apply the owner-approved Boolean superiority predicate, and output the final scientific results without generating data, retraining, or modifying inputs.

## Components
1. **Manifest Validation**: Consumes `EW01_PRE_RUN_MANIFEST_TEMPLATE.json` and verifies that the execution commit, protocol amendment, checkpoint, and cohort hashes match the authorized values.
2. **Exclusivity and One-Shot Safety**: Reserves an attempt ID via `attempt_ledger.json` in an exclusive output directory. Overwrites are forbidden.
3. **Boolean Predicate**: Implements exactly the pre-registered Boolean rule from `EW01_AMENDMENT_002_BOOLEAN_PREDICATE.md`.
    - `pass_b7_vs_b9 = (B7_sens_LB > 0.02) AND (B7_FA_UB < -0.10)`
    - B1 evaluated conditionally.
4. **Cohort Sealing**: `experiments/early_warning_ew01/seal_cohort.py` guarantees ID uniqueness, training set disjointness, read-only permissions, and computes a composite hash for the manifest.

## Trust Chain
Owner Approved Pre-Run Commit -> Protocol Clarification -> Authorized Manifest -> Exact Artifact Hashes -> Runner.

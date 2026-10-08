# EW-01 Q0-03 Canonical Parity Audit

## 1. Prior Status Override
**CRITICAL:** The prior 0.0 Q0-03 PASS reported at commit `84478c5c` is **INVALID EVIDENCE**. That execution used a copied evaluator instead of direct locked-function oracles.
**CRITICAL:** The prior PASS claim at `e1ed31b1` is also **INVALID EVIDENCE**. That execution relied on uncommitted dirty working-tree files (`harness.py` and `loader.py`) and did not establish parity for the committed repository state.
**CRITICAL:** An intermediate run also failed because the parity script was verifying the trace against its own mutated output rather than an independent oracle.

## 2. Engineering Parity Scope
This canonical Q0-03 test is strictly for **engineering parity only**.
- B1 trend baseline is explicitly outside the Q0-03 parity scope.
- The scientific EW-01 Selection Rule logic is also outside this strict function-level Q0-03 check.
- **NO H1/scientific cohort was accessed, generated, or scored.**

## 3. Stagewise Conformance
A full independent reference loop using original `E` and `T` modules was constructed to verify intermediate candidate traces. Every boundary was asserted against independent oracles using identical verified inputs.
- Final Commit SHA: `cba780f5` (verified from a clean `git worktree` checkout)
- Maximum absolute difference: exactly `0.0`
- Tolerance used: `<= 1e-6`
- Exact NaN, inf, and None masks match precisely.

## 4. Input Path and Zero Regeneration
The candidate `experiments/early_warning_ew01/loader.py` rigorously enforces explicitly loading `canonical_meal_log.npz` and `canonical_population_habit.npz` with zero runtime regeneration and no training-data access for habit priors. Input identity is strictly bounded to the 44 VAL patients.

## 5. Module Integrity
`experiments/early_warning_ew01/test_q03_parity.py` validates object identity for `train_pr_tft` and `evaluate_run` directly against candidate module scopes to guarantee no monkeypatching occurred.

## 6. Negative Controls (Candidate-Only)
The immutable reference was checked against temporary activating candidate fixtures.
- **Permuted patient order**: Detected
- **Cooldown modification**: Detected
- **Threshold offset modification**: Detected
- **Missing patient**: Detected
- **Duplicate patient**: Detected
- **NaN-mask corruption**: Detected
- **Off-by-one target mapping**: Detected
- **Aggregation macro-average**: Detected
Parity correctly failed in all 8 mutation cases.

## 7. PASS/FAIL
**PASSED.** Complete stagewise engineering conformance verified. Execution log has been hashed and stored at `experiments/early_warning_ew01/Q03_PASS.log`.

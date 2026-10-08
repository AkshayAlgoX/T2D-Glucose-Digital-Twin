# EW-01 Q0-03 Canonical Parity Audit

## 1. Prior Status Override
**CRITICAL:** The prior 0.0 Q0-03 PASS reported at commit `84478c5c` is **INVALID EVIDENCE**. That execution used a copied evaluator instead of direct locked-function oracles and did not independently check intermediate candidate arguments, wiring, or undefined behavior correctly. Any claims from that run must be discarded.

## 2. Engineering Parity Scope
This canonical Q0-03 test is strictly for **engineering parity only**.
- B1 trend baseline is explicitly outside the Q0-03 parity scope (as there was no original B1 trace locked).
- The scientific EW-01 Selection Rule logic is also outside this strict function-level Q0-03 check.
- **NO H1/scientific cohort was accessed, generated, or scored.**

## 3. Stagewise Conformance
A full independent reference loop using original `E` and `T` modules was constructed to verify intermediate candidate traces. Every boundary (prediction, statistics, calibration, alerts, counts, bootstraps, summarizations) was asserted with raw outputs.

- Maximum absolute difference: exactly `0.0`
- Tolerance used: `<= 1e-6`
- Exact NaN, inf, and None masks match precisely.

## 4. Input Path and Zero Regeneration
The candidate `experiments/early_warning_ew01/loader.py` was replaced. It now rigorously enforces explicitly loading `canonical_meal_log.npz` and `canonical_population_habit.npz` with zero runtime regeneration and no training-data access for habit priors. Input identity is strictly bounded to the 44 VAL patients.

## 5. Module Integrity
`experiments/early_warning_ew01/test_q03_parity.py` validates object identity for `train_pr_tft` and `evaluate_run` directly against candidate module scopes to guarantee no monkeypatching or duplicated evaluator modules occurred.

## 6. Negative Controls (Candidate-Only)
The immutable reference was checked against temporary activating candidate fixtures.
- **Permuted patient order**: Detected (Parity broke as expected)
- **Cooldown modification**: Detected (Parity broke as expected)
- **Threshold offset modification**: Detected (Parity broke as expected)

## 7. PASS/FAIL
**PASSED.** Complete stagewise engineering conformance verified.

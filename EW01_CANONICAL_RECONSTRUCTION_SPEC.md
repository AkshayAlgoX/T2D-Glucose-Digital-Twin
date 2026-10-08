# EW01 Canonical Reconstruction Specification

This specification strictly follows the Astra 6 Q0-03 Canonical Design.

## 1. Input Integrity and Zero Regeneration
- **No Stochastic Corruption:** `loader.py` sets `log_corruption=False`.
- **No Missing Fallbacks:** If a VAL patient lacks canonical meals in `canonical_meal_log.npz`, execution halts.
- **Pre-computed Habit Priors:** The loader bypasses training-set loops and consumes the locked `canonical_population_habit.npz` directly.

## 2. Stagewise Conformance
The candidate `harness.py` execution is traced and rigorously verified against independent `E` and `T` oracles at every significant data boundary:
- Causality decisions and eligible anchors
- Prediction tensors and probabilities
- Calibrated quantiles and statistical aggregates
- Raised alert arrays and event counts
- Final bootstrap aggregations

## 3. Separation of Concerns
- **Q0-03 Engineering Parity:** Strict mathematical conformance to locked WIF-02 artifacts, constrained purely to B0, B7, and B9.
- **Scientific Cohort:** B1 baseline execution and the EW-01 Scientific Selection Rule exist in the execution layer but are tested via separate functional paradigms outside the Q0-03 specification.

## 4. Validating Q0-03 Status
The previous 0.0 PASS claim from `84478c5c` has been explicitly invalidated because it did not adhere to the stage-by-stage oracle pattern. Q0-03 is now considered PASSED only because it mathematically satisfies the strict, independent, stage-wise canonical trace checking and activating candidate-only mutation checks.

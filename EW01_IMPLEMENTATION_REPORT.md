# EW-01 Implementation Report

## 1. Exact Source Functions Reused
The EW-01 execution layer strictly reuses the following frozen functions from `backend/evaluate_run.py` and `backend/train_pr_tft.py`:
- `T.load_data()`
- `E.causal_decision_mask()`
- `E._predict()`
- `T.eligible_anchors()`
- `E.patient_stats()`
- `E.raise_alerts()`
- `E.forecast_meets_spike_rule()`
- `E.event_counts()`
- `E.bootstrap_weights()`
- `E.metric_draws()`
- `E.summarize()`
- `E._beats()` and `E._not_worse()`
- `T.hazard_discrimination()`
- `T.clarke_at()`
- `linear_trend()` from `experiments/baselines/point.py` for B1.

## 2. Newly Implemented Functions
- `experiments.early_warning_ew01.loader.load_cohort`: A strict minimal wrapper around `T.load_data()` that asserts the list ordering requested by the cohort generation and correctly injects the frozen canonical meal log artifact (`canonical_meal_log.npz`).
- `experiments.early_warning_ew01.harness.evaluate_ew01`: Orchestrates the locked evaluator internal functions to compute event metrics exactly. It also implements the exact beats/not-worse/tie logic specified by `model_selection_rule.json` focusing exclusively on the authorized EW-01 B7@0.35 vs B9 scientific decision rule, adding B1 as a subsequent baseline.

## 3. Q0-03 Definition
Q0-03 is direct in-process parity of the locked functions on legitimate VAL inputs. It proves the reconstructed wrapper agrees with the locked evaluator's individual split-agnostic metric and bootstrapping functions.

## 4. Q0-03 Test Result
See `EW01_Q03_PARITY_AUDIT.md`.

## 5. Exact Max Absolute Parity Error
See `EW01_Q03_PARITY_AUDIT.md`.

## 6. Test Results
The Q0-03 parity integration script (`experiments/early_warning_ew01/test_q03_parity.py`) natively exercises the full VAL split. Additionally, it executes multiple deterministic engineering negative controls:
- **Patient Order Permutation**: PASS (Detects ordering errors).
- **Cooldown modification**: PASS (Detects cooldown errors).
- **Threshold operator modification**: PASS (Detects inequality errors).

## 7. Leakage Audit
- **Causal Decisions**: Handled strictly via the frozen `E.causal_decision_mask()` which limits visibility of the time series strictly to `t` and enforces sufficient historical coverage.
- **Twin Meal Awareness**: Canonical meal logs explicitly capture early meal logging dynamics in a causally sound manner.

## 8. Protocol Conformity
The implemented wrapper enforces the protocol mandated by `experiments/protocol_amendments/EW01_AMENDMENT_001.md`:
- **Populations**: Stratifies correctly into `Prediabetes + Type 2`.
- **Exclusions**: Type 1 diabetes patients are excluded.
- **Models/Baselines**: Explicitly runs B7@0.35, B7@0.6, B9, B1, B0.
- **Decision Rule**: Extracted exactly from `model_selection_rule.json`. Tests B7@0.35 vs B9 first for co-primary metrics (sensitivity, false alerts/day).
- **Bootstrap**: Configured to 2000 replicates, patient-level, stratified resamples with seed 20260930.

## 9. Provenance Contract
Before executing a one-shot scientific run, the following hashes must be computed and injected into `EW01_PRE_RUN_MANIFEST_TEMPLATE.json`:
- `cohort_manifest.json` SHA256
- `patient_cgm_telemetry.csv` SHA256
- `patients_ehr.csv` SHA256
- The Q0-03 parity artifact execution log.

## 10. Files Changed
- `experiments/early_warning_ew01/loader.py`
- `experiments/early_warning_ew01/harness.py`
- `experiments/early_warning_ew01/test_q03_parity.py`
- `EW01_CANONICAL_RECONSTRUCTION_SPEC.md`
- `EW01_IMPLEMENTATION_REPORT.md`
- `EW01_Q03_PARITY_AUDIT.md`

## 11. Commit SHA
*(To be recorded by git)*

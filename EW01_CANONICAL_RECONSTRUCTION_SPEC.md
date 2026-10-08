# EW-01 CANONICAL RECONSTRUCTION SPECIFICATION

## 1. Authoritative Sources
This specification strictly derives from the actual verified files in the repository:
- `backend/evaluate_run.py` (Causal masks, alerting, bootstrap, aggregation)
- `backend/train_pr_tft.py` (Constants, data loading, meal log corruption, onset rules)
- `backend/model_selection_rule.json` (Locked comparison rule, tie tolerances)
- `experiments/protocol_amendments/EW01_AMENDMENT_001.md` (EW-01 protocol restrictions)
- *Legacy agent reports are explicitly excluded as sources of authority.*

## 2. Function-Level Execution Contract
An EW-01 execution harness must compose the following locked functions without altering their internal mathematics:

*   **A. Loading cohort data:** `train_pr_tft.load_data(cfg, patient_ids)`
*   **B. Causal decision masks:** `evaluate_run.causal_decision_mask(ps, cfg)`. Strictly limits decisions to `t >= 287` with sufficient past coverage.
*   **C. Event/onset labels:** `train_pr_tft.detect_spike_onsets(cgm)`. Defines the target.
*   **D. Predictions (B7):** `train_pr_tft.predict(...)` yielding `p_cum` which is mapped through the calibrator to probabilities.
*   **E. B9 (Twin-Only):** `evaluate_run.forecast_meets_spike_rule(history, twin_forecast)`.
*   **F. B1 (Linear Trend):** The existing trend forecast function.
*   **G. B0 (Persistence):** Last observed CGM value carried forward.
*   **H. Alert matching:** `evaluate_run.raise_alerts(trigger, at_risk, cooldown=24)`. Enforces the 120-min refractory rule.
*   **I-M. Event Metrics (Sensitivity, Precision, Lead Time, Alerts/Day):** `evaluate_run.event_counts(...)`. Outputs `monitored_onsets`, `detected_onsets`, `alerts_raised`, `true_alerts`, `false_alerts`, `lead_times_min`, `patient_days`.
*   **N. Bootstrap:** `evaluate_run.bootstrap_weights(groups, n_boot=2000, seed=20260930)` and `evaluate_run.metric_draws(stats, w)`.
*   **O. Stratification:** Populations defined by mapping the patient's EHR status (e.g., Prediabetes, Type 2).
*   **P. Decision Rule:** Adopted from `evaluate_run.apply_selection_rule()` mechanics, mapped to EW-01's required comparisons.
*   **Q. Output:** A JSON artifact containing estimates, CIs, undefined-draw counts, and hashes.

## 3. Q0-03 Exact Definition
The phrase *"reproduces locked functions to 1e-6 on VAL"* is an **engineering parity gate**.
Q0-03 is direct in-process parity of the locked functions on legitimate VAL inputs.
- The whole `evaluate_run.evaluate()` entrypoint is NOT the parity target.
- No mock/patch of integrity checks is permitted.
- Locked functions must be imported and called directly.
- VAL inputs are treated as legitimate unsealed engineering data.
- Q0-03 is strictly an engineering parity gate, not scientific evidence.
- The comparison focuses on B0, B7, B9, locked persistence, and locked metrics. B1 is separated from the Q0-03 locked parity claim.
## 4. Metric Contract
*   **Co-Primary:** Event Sensitivity (Tolerance: 0.02), False Alerts per patient-day (Tolerance: 0.1).
*   **Secondary:** Alert precision, lead time median, ECE, undefined draws.
*   *No post-hoc additions permitted.*

## 5. Data Contract
**FROZEN MODEL INPUTS:**
- `runs/pr_tft_ablation_arm_d/checkpoints/*.ckpt`
- `config.json`, `calibration.json`, `normalization.json`, `canonical_population_habit.npz`
- `model_selection_rule.json`

**COHORT INPUTS:**
- `patient_cgm_telemetry.csv`, `patients_ehr.csv`, `cohort_manifest.json`
- *(Truth arrays are not required beyond the telemetry CGM itself, as the target is measured CGM).*

## 6. Leakage Contract
*   **Causal Decisions:** Information at time $t$ uses exclusively CGM $<= t$.
*   **Early Meal Logging:** The generator (`corrupt_meal_log`) randomly shifts ~10% of meals earlier by 5-15 minutes. This implies the twin has advance knowledge of a meal because the patient explicitly logged it in advance. **This is fully causal with respect to the app's timeline.** It is NOT mathematical leakage, but it is a behavioral assumption that must be disclosed, as it directly aids B7/B9 detection.

## 7. Decision-Rule Contract
Extracted exactly from `model_selection_rule.json`:
*   **Beats:** The whole 95% CI of the paired difference (A - B) must lie beyond the metric's tie tolerance on A's favorable side.
*   **Not Worse:** The 95% CI stays within the tie tolerance on B's favorable side.
*   **Tie:** Anything else.
*   **Order:** B7@0.35 must beat B9 first. Only then is B1 compared.

## 8. Bootstrap Contract
*   **Unit:** Patient-level paired difference.
*   **Replacement:** Yes.
*   **Strata:** Diabetes status (EHR group).
*   **Replicates:** 2000.
*   **Seed:** 20260930.
*   **CI Method:** 95% percentile (`np.nanpercentile`).
*   **Undefined Draws:** Excluded from percentile computation; explicit count of NaNs reported.

## 9. Provenance Contract / One-Shot Execution
Before a scientific score can run, the manifest (`EW01_PRE_RUN_MANIFEST_TEMPLATE.json`) must be fully populated with SHA256 hashes of:
- The Q0-03 parity success log.
- The generated cohort artifacts.
- The frozen model inputs.
- The `EW01_AMENDMENT_001.md`.
The script must **fail closed** if any hash does not match at execution time. Exactly ONE scientific run is permitted.

## 10. Exact Unresolved Items
- A fresh, EW-specific unsealed cohort needs to be generated and hashed.
- The Q0-03 parity synthetic script needs to be written and executed against `VAL`.

## 11. What T2 Is Allowed To Implement
T2 is allowed to write `harness.py`, `loader.py`, and the Q0-03 parity script strictly as glue code that imports the locked functions from `backend/evaluate_run.py` and `backend/train_pr_tft.py`.

## 12. What T2 Is NOT Allowed To Invent
T2 must NOT rewrite event definitions, rewrite bootstrapping, invent new alert semantics, create new random number streams, generate cohorts silently, or introduce post-hoc superiority rules.

---
**FINAL STATUS: SPEC READY**

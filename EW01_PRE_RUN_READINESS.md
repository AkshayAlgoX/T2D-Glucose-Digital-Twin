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
- Proposed specification: 300 patients, 14 days, seed 20261014.

## 4. Q0-03 Status (Parity)
**PASSED.**
- Engineering parity has been fully proven and signed off by T3.
- The `evaluate_locked_core` mathematically reproduces the locked evaluator's functionality to 1e-6 precision, verified with strict negative controls on the original VAL dataset.

## 5. Provenance Requirements
The exact hashes of all code, checkpoints, parameters, and cohort data will be populated into the final approved manifest. The scientific runner `experiments/early_warning_ew01/run_scientific.py` enforces all hashes, requires `SCIENTIFIC_EVALUATION=true`, creates an exclusive attempt ledger, and refuses to run on a dirty working tree or mismatched execution commit.

## 6. Safety and Kill Conditions
The one-shot scientific runner guarantees:
- No automatic retry or resume.
- No output overwrite.
- Immutable inputs.
- Reject on any integrity failure.

## 7. Exact Commands for the Future
- **Generate**: `python backend/generate_health_data_v2.py --seed 20261014 --patients 300 --days 14 --out experiments/early_warning_ew01/scientific_cohort`
- **Seal**: `python experiments/early_warning_ew01/seal_cohort.py experiments/early_warning_ew01/scientific_cohort runs/pr_tft_ablation_arm_d/split.json EW01_PRE_RUN_MANIFEST_TEMPLATE.json`
- **Manifest-Finalize**: Copy template to `EW01_PRE_RUN_MANIFEST.json`, insert final execution commit, and set status to AUTHORIZED.
- **One-Shot-Score**: `SCIENTIFIC_EVALUATION=true python experiments/early_warning_ew01/run_scientific.py EW01_PRE_RUN_MANIFEST.json runs/scientific_results`

## 8. What Remains Blocked
The one-shot scientific score remains **BLOCKED** on:
- Generation and sealing of the FRESH COHORT.
- Final owner approval and authorization of the manifest.

## FINAL STATUS
**REMEDIATED — READY FOR T3 RE-AUDIT**

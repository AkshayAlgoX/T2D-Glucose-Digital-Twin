# EW01 PRE-RUN READINESS

## 1. Exact Decision Rule
- A beats B on a metric when the whole 95% CI of the paired difference (A - B) lies beyond the metric's tie tolerance on A's favourable side. A is not worse than B when the CI stays within the tie tolerance on B's favourable side. Anything else is a tie.
- Tie tolerance for Event Sensitivity: 0.02
- Tie tolerance for False Alerts per patient-day: 0.1
- **NO post-hoc changes allowed.**

## 2. Exact Metric Contract
- **Co-Primary Metrics**: Event Sensitivity, False Alerts per patient-day.
- **Secondary/Descriptive Metrics**: Alert precision, Alerts per patient-day, Full lead-time distribution (median lead time), At-risk fraction, Calibrated ECE (if correctly available), Undefined-draw count.
- **Target**: Spike onset within `(t, t + 24]` steps (120 minutes).

## 3. Cohort Choice
**FRESH COHORT = PREFERRED.**
A fresh, EW-specific cohort generated from frozen code, sealed before scoring, hashed, explicitly excluded from training/development decisions, and independently reproducible is strongly preferred.
**DEVGEN = FALLBACK DIAGNOSTIC ONLY.**
DEVGEN is unsealed and reused for other work; its results must NOT be called independent scientific validation. If fresh cohort machinery is unready, DEVGEN acts purely as a non-scientific dry-run diagnostic.

## 4. Q0-03 Status (Parity)
**BLOCKED.**
The Q0-03 requirement mandates that `harness.py` mathematically reproduces the locked evaluator's (`evaluate_run.py`) persistence, twin-only, and PR-TFT statistics to 1e-6 precision on the VAL dataset.
- *What Parity Means*: The exact same event definitions, masks, and calculations yield bit-identical arrays.
- *Required Artifacts*: A test script establishing identical outputs between both implementations on the identical VAL subset.
- *Current State*: This synthetic parity script does not yet exist or hasn't been run and verified.
- *Is Real Data Needed?*: No. Q0-03 must be completed completely on synthetic/VAL data before the actual scientific score is run.

## 5. Provenance Requirements
The exact hashes of all code, checkpoints, parameters, and cohort data must be populated into the `EW01_PRE_RUN_MANIFEST_TEMPLATE.json`. The harness strictly fails closed unless the provided manifest contains the correct schema (`ew01_approved_inputs/v1`), an explicitly approved status, and identically matches all file hashes dynamically before loading any scientific patient data.

## 6. Kill Conditions
These are explicitly frozen BEFORE scoring. A run is killed/invalid if:
- B7 is worse than B9 on either co-primary metric.
- B9 or B1 is not worse than B7 on both co-primary metrics.
- The primary alert threshold (0.35) is unreachable.
- Any guard bypass is detected.
- Any hash mismatch occurs.
- Protocol drift is found.
- The run is executed more than once (any rerun after seeing results is immediately invalid).
*(Note: Excessive concurrent detection or weak lead profile is not a kill condition unless explicitly adopted as a descriptive limitation.)*
**Do not introduce extra post-hoc kill conditions.**

## 7. Exact Command for One-Shot Score
Once unblocked, the one-shot run command will be:
`python experiments/early_warning_ew01/harness.py --score --manifest EW01_PRE_RUN_MANIFEST.json`

## 8. What Remains Blocked
The one-shot scientific score remains **BLOCKED** on:
- Generation and sealing of the FRESH COHORT.
- Satisfying the Q0-03 numerical parity test on VAL.
- Populating the final manifest hashes.
- Authorizing the score by flipping `ALLOW_REAL_SCORING = True`.

## FINAL STATUS
**BLOCKED (Pending Q0-03 Parity and Fresh Cohort Generation)**

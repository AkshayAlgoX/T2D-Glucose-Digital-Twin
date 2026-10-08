# EW01_AMENDMENT_001

## A. PRIMARY POPULATION
Prediabetes + Type 2

## B. EXCLUSIONS
Type 1 patients are excluded.
Cohort IDs must be prefixed (e.g., `EW-`). No duplicate IDs with training/validation splits.

## C. EVENT DEFINITION
The exact locked causal event definition from `backend/evaluate_run.py`:
- Spike onset defined by `detect_spike_onsets`: >= 180 mg/dL, rise >= 50 mg/dL over preceding 60 min, >= 180 for 15 min, refractory until < 160 for 30 min.

## D. DECISION TIMES
Decision mask rules exactly as in `causal_decision_mask`:
- `t >= 287`
- Past coverage >= `cfg.min_past_coverage`
- Current CGM value is finite.

## E. TARGET
Spike onset within `(t, t + 24]` steps (120 minutes).

## F. MODELS/BASELINES
- **B7 @ 0.35** (primary alerting threshold)
- **B7 @ 0.60** (secondary/descriptive threshold)
- **B9** (UKF twin-only spike rule)
- **B1** (linear trend)
- **B0** (non-alerting persistence baseline)

## G. COMPARISON ORDER
1. B7@0.35 vs B9 first.
2. B7@0.35 vs B1 only if the first comparison passes.

## H. PRIMARY METRICS
- **Event Sensitivity** (higher is better, tie tolerance 0.02)
- **False Alerts per patient-day** (lower is better, tie tolerance 0.1)

## I. SECONDARY/DESCRIPTIVE METRICS
- Alert precision
- Alerts per patient-day
- Full lead-time distribution (median lead time)
- At-risk fraction
- Calibrated ECE (if correctly available)
- Undefined-draw count
*Note: Paired median-lead difference is NOT used as a superiority test.*

## J. DECISION RULE
A beats B on a metric when the whole 95% CI of the paired difference (A - B) lies beyond the metric's tie tolerance on A's favourable side. A is not worse than B when the CI stays within the tie tolerance on B's favourable side. Anything else is a tie.
**NO post-hoc changes allowed.**

## K. BOOTSTRAP
2,000 patient-level, status-stratified paired resamples.
Seed: 20260930.
Same weights across candidate comparisons.
95% percentile CI.
Undefined-value handling: NaN excluded from CI calculation, undefined draws reported.

## L. RE-RUN RULE
Exactly ONE scientific run.
Any hash mismatch / guard failure / invalid artifact = INVALID RUN. This is not a reason to patch and rerun.

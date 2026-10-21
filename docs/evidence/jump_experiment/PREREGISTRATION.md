# Pre-registration: isolated one-step jumps in the forecast median (2026-10-21)

Written and committed **before** any outcome below was computed. Synthetic development data only; no sealed test-split data; no model, threshold or evaluator change. Gate 3 remains FAILED.

## Question
`docs/evidence/model_audit/MODEL_AUDIT_20261020.md` found an isolated one-step departure > 20 mg/dL in 19.8% of 880 factual validation forecasts (> 40 mg/dL in 11.6%); the physiology twin has none. Are these departures wrong against the observed CGM, where are they, and does a fixed, parameter-free repair remove them without degrading accuracy?

## Data
- **Development (in-sample for the network):** training split, 40 patients drawn with seed 1, 20 eligible anchors each (seed 1).
- **Validation (used for checkpoint selection and calibration, so not independent):** all 44 validation patients, 20 anchors each, seed 0 — the same 880 forecasts as the audit.
- Truth: observed CGM at anchor + 5k min, k = 1..24 (`ps.cgm[t + k]`); missing truth is excluded per step.
- Sealed test split: not read.

## Diagnostics (descriptive)
1. Horizon index and size of the largest isolated departure per forecast.
2. At that step: |median − truth| versus |mean of the two neighbouring medians − truth|.

## Repair (fixed in advance; no parameters tuned)
R3: replace the learned residual r_k = median_k − twin_k by the 3-point running median of r (k = 2..23; end points unchanged), and shift every quantile at step k by the same amount. The twin is unchanged.

## Outcomes
Per split, for original vs R3, plus physiology twin alone and persistence: RMSE at +30, +60, +120 min; share of forecasts with an isolated step > 20 and > 40 mg/dL; empirical P10–P90 coverage (all steps).

## Decision rule
R3 is recorded as a candidate for a future, separately validated model change only if, on **both** splits: the > 20 mg/dL jump share falls by at least half; RMSE at each of +30/+60/+120 does not rise by more than 0.10 mg/dL; P10–P90 coverage changes by no more than 1.0 percentage point.
**Whatever the outcome, R3 is not substituted into the served model in this release:** the published evidence (evaluation report, run manifest, calibration) was produced for the unrepaired network, and no independent test exists to confirm a change.

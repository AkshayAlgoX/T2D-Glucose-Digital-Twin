# Model selection rule (version 2)

**Locked 2026-10-01, before any final-model training and before any test-set evaluation.**
`model_selection_rule.json` is the machine-readable rule; this file explains it. The sha256
of both files is pinned in `final_config.json`. `train_pr_tft.py` refuses to train and
`evaluate_run.py` refuses to evaluate if either file changed, and the evaluator also requires
the hashes recorded when the run was trained. The rule is applied by code, not by hand:
`twin_mode_selection.py` picks the twin mode, and `evaluate_run.py` picks the final model.

## Populations

- **Primary:** Prediabetes + Type 2. Every selection decision uses this population.
- **Secondary:** Healthy. Reported, never decisive.
- **Excluded:** Type 1. There is no bolus-insulin log, and they are outside the target use case.

## Candidates

| Candidate | What it is | Alerting |
|---|---|---|
| `persistence` | Last CGM value carried forward | none; forecast baseline only |
| `twin_only` | Realistic UKF twin in the selected mode, habit-scenario forecast | alert when the forecast meets the spike rule |
| `pr_tft` | Realistic PR-TFT + UKF twin in the selected mode | alert on calibrated P(onset within 120 min) |
| `oracle` | Simulator-latent inputs (21 static features, oracle UKF) | reference only, never selectable |

## Step 1: twin mode (S2 vs S3), validation patients only

- **Data:** the validation split of `split_293.json`, with exactly the training pipeline's
  inputs (same per-patient meal-log corruption, ceil meal timing, first-day resting HR).
- **Metric:** 60-min UKF forecast RMSE (mg/dL). Lower is better.
- **Tie:** a difference of 0.1 mg/dL or less is a tie. The mode whose mean NIS is closer to 1
  then wins; if that is also tied, S2 wins.
- **Disclosure:** S2/S3 validation numbers were first computed on 2026-09-30, before this
  clause was written down. The clause formalizes the comparison used then. Test patients are
  never used to choose the twin mode.

## Step 2: final model, test patients, after training

**Alerts.** At every 5-min decision time from step 287, an alert is raised when the patient is
at risk (causal flag) and the trigger holds. At most one alert is raised per 120 min.

**Operating points.** The primary threshold is calibrated P ≥ 0.35. The secondary threshold,
0.60, is reported when it is reachable. A threshold above the maximum calibrated probability
is **unreachable**. It is reported as unreachable with no metrics and is never replaced by
another threshold. If 0.35 is unreachable, PR-TFT has no operating point and `twin_only` is
selected.

**Metrics.**

| Metric | Direction | Tie tolerance | Role |
|---|---|---|---|
| Event sensitivity (detected / monitored onsets) | higher | 0.02 | decisive |
| False alerts per patient-day | lower | 0.10 | decisive |
| RMSE 60 / 120 min (mg/dL) | lower | 0.5 | decisive (superiority only) |
| Alert precision (alerts followed by an onset within 120 min / alerts) | higher | 0.02 | reported |
| Alerts per patient-day, lead time, MAE 60/120, ECE | as named | | reported |
| Conformal 80% interval coverage | target 0.80 | window [0.75, 0.85] | eligibility |

**Uncertainty.** Paired, patient-level bootstrap, stratified by diabetes status, with 2000
resamples, a 95% percentile CI and seed 20260930.

**Comparison.** A *beats* B on a metric when the whole CI of the paired difference (A − B)
lies beyond the tie tolerance on A's favourable side. A is *not worse* than B when the CI stays
within the tie tolerance on B's favourable side. Anything else is a tie.

**Decision**, applied in order:

1. If the primary threshold is unreachable for PR-TFT, select `twin_only`.
2. If PR-TFT conformal 80% coverage on the primary population is outside [0.75, 0.85],
   PR-TFT is downgraded and `twin_only` is selected.
3. PR-TFT must be not worse than `twin_only` on event sensitivity **and** on false alerts per
   patient-day at the primary threshold. Otherwise select `twin_only`.
4. PR-TFT is selected only if it also beats `twin_only` on at least one of event sensitivity,
   false alerts per patient-day, RMSE 60 or RMSE 120. If everything ties, the simpler model,
   `twin_only`, is selected.
5. Persistence is not an alerting candidate. The report states whether the selected forecast
   beats persistence on RMSE 60 and RMSE 120.

This rule must not be changed after test results are seen. Any change produces new hashes,
which the trainer and evaluator reject for existing runs.

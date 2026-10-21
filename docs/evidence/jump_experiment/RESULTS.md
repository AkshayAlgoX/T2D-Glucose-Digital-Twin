# Results: isolated one-step jumps (pre-registered in PREREGISTRATION.md)

Run: `python docs/evidence/jump_experiment/jump_experiment.py docs/evidence/jump_experiment/results.json` (58 s on CPU). Checkpoint `runs/pr_tft_ablation_arm_d`. Train sample: 40 patients × 20 anchors (seed 1). Validation: 44 × 20 (seed 0), the audit's 880 forecasts. The sealed test split was not read (the script asserts it). These are sampled anchors, not the full evaluation in `evaluation_report.json`.

## Diagnosis
| | Train sample | Validation |
|---|---|---|
| Forecasts with an isolated step > 20 mg/dL | 173 / 800 (22.0%) | 174 / 880 (19.8%, reproduces the audit) |
| Where the step falls | +70 to +115 min (95% of cases) | +75 to +115 min (93%) |
| Direction | 97.7% upward | 95.4% upward |
| Mean abs. error at the step | 48.2 mg/dL | 52.3 mg/dL |
| … if the step is replaced by its neighbours' mean | 26.1 mg/dL | 26.2 mg/dL |
| Step is worse than its neighbours' mean | 76.3% | 81.0% |

The steps are late-horizon, almost always upward, and wrong against the observed CGM: they are an artefact of the learned residual (which is penalised for size but not smoothness in training), not a signal.

## Fixed repair R3 vs current checkpoint and baselines
| | RMSE +30 | RMSE +60 | RMSE +120 | Step > 20 | Step > 40 | P10–P90 coverage |
|---|---|---|---|---|---|---|
| **Validation** — current checkpoint | 11.798 | 19.160 | 24.417 | 19.8% | 11.6% | 80.54% |
| R3 | 11.802 | 18.990 | 24.417 | 2.3% | 0.1% | 80.49% |
| Physiology twin alone | 14.014 | 22.559 | 27.257 | — | — | — |
| Persistence | 21.724 | 36.989 | 47.758 | — | — | — |
| **Train sample** — current checkpoint | 12.159 | 19.431 | 23.184 | 22.0% | 12.8% | 81.66% |
| R3 | 12.163 | 19.215 | 23.184 | 3.6% | 0.0% | 81.57% |
| Physiology twin alone | 13.871 | 21.792 | 27.233 | — | — | — |
| Persistence | 20.998 | 34.425 | 46.028 | — | — | — |

## Decision (as pre-registered)
R3 meets every criterion on both splits (jump share down by > 80%; RMSE change ≤ +0.004 mg/dL at +30, −0.17 to −0.22 at +60, 0 at +120; coverage change ≤ 0.09 points). It is **recorded as a candidate for a future model change**, to be evaluated on the full validation evaluation and on the sealed test split only after a new evaluation is pre-registered.

It is **not** applied to the served model in this release. The published metrics, calibration and run manifest describe the unrepaired network; validation was already used for checkpoint selection and calibration, so this comparison is development evidence, not an independent test. The product instead flags isolated steps where they occur (forecast chart and What-If) and links this result.

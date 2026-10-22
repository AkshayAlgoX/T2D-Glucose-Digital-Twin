# External check on Hall et al. 2018: results

Single run of `hall_evaluate.py` after the freeze commit `d1a2d887` (protocol: [PREREGISTRATION.md](PREREGISTRATION.md); raw output: [`results.json`](results.json)). Hall file sha256 matched the preregistered value. No parameter was changed after the data were read.

**Cohort:** 57 participants; 73,576 decisions; 1,104 patient-days; **64** qualifying spike onsets. Spikes are far rarer than in the development cohorts: 64 onsets in Hall, against 198 in 12 validation patients.

## Primary endpoint: not confirmed

| Policy (frozen) | Sens. ≥30 min [95% CI] | Sens. any lead | False alerts/day [95% CI] | Precision | Median lead | Per-patient false alerts/day |
|---|---|---|---|---|---|---|
| P0 baseline, global threshold (comparator) | 0.0% [0.0–0.0] | 14.1% | 0.013 [0.005–0.036] | 39.1% | 10 min | 0 – 0.43 |
| **P2 routine + own-rate, floor 0.25 (selected)** | **7.8%** [0.0–13.2] | 26.6% | 0.029 [0.013–0.083] | 34.7% | 15 min | 0 – 0.98 |
| P1 routine, global threshold (secondary) | 7.8% [0.0–13.2] | 26.6% | 0.030 [0.013–0.087] | 34.0% | 15 min | 0 – 0.98 |
| P3 routine, global + 3 alerts/24 h cap (secondary) | 10.9% [2.2–17.9] | 35.9% | 0.056 [0.028–0.153] | 27.1% | 20 min | 0 – 1.17 |
| **Reference: linear trend, alert when the 30-min trend projects ≥ 200 mg/dL at +60 min** (threshold fixed in advance as the strictest; not selected on Hall) | **32.8%** | **78.1%** | 0.38 | — | — | — |

- **Paired difference in sensitivity ≥30 min, selected minus comparator:** +7.8 points, 95% CI **[0.0, +13.2]**. The preregistered success rule needed a lower bound above 0, so it is **not met**. The false-alert condition (≤ 1.0/day) is met.
- **Direction:** the routine model catches more spikes than the baseline at every lead requirement under all three routine policies, with the same direction as in development.
- **Why it is small:** every policy used about 1–6% of the false-alert budget. On this mostly normoglycaemic cohort the calibrated risk stays low. The selected policy's 0.25 floor binds, so its per-patient rate control could not raise alerting, and P2 behaved almost exactly like P1. Calibration does not transfer across populations: on the development validation patients the same threshold over-alerted (1.55/day), and here it under-alerts.

## Secondary: 60-min forecast RMSE (mg/dL)

| Persistence | Linear trend (30 min) | Reduced twin prior | LightGBM |
|---|---|---|---|
| 19.60 | 39.23 | 20.55 | **19.00** |

The same linear-trend rule has the worst RMSE yet the best early warning on this cohort ([`results.json`](results.json)).

## Reading

- This is the project's first evaluation on a cohort never used in development.
- **A simple linear-trend rule beat both learned policies here.** It caught 32.8% of spikes ≥30 min ahead and 78.1% at any lead, at 0.38 false alerts/patient-day, within budget. On the development cohorts the same rule overshot the budget (1.90/day on validation, operating_point §1). On a low-spike population, a slope rule keeps its sensitivity while the calibrated learned models fall almost silent.
- The daily-routine model's advantage keeps its direction on an external population, but this check does not confirm it statistically. A cohort with few spikes and a near-silent comparator leave little room.
- **What it does show:** the learned models' calibrated probability is the weak point across populations. A fixed probability threshold over-alerts on one population and under-alerts on another, while a physical slope rule is more stable on the sensitivity side. Any future preregistered policy must include the linear-trend rule as a comparator, and should test a combination such as trend OR learned risk under a per-patient budget.
- **What would fix it:** an operating policy that adapts to each patient's own spike rate without a population floor. That needs its own preregistered test on a further unused cohort.
- None of this changes the locked real-data results.

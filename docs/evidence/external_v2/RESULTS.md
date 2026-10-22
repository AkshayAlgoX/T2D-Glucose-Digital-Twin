# External check 2: results (AZT1D primary, Broll secondary)

Protocol: [PREREGISTRATION.md](PREREGISTRATION.md). The freeze commit is `3f1d7350`. Amendment 1 (`b81afcf5`) was made after a loading error and before any outcome existed: it excludes the one AZT1D file without a separable CGM column. Input sha256 values matched the preregistered ones. There was one evaluation run, and no parameter was changed after it. Raw output: [`results.json`](results.json).

## Primary: AZT1D — not met

24 adults with type 1 diabetes on automated insulin delivery; 988.6 patient-days; 273,119 decisions; **2,814** spike onsets.

| Policy (frozen) | Sens. ≥30 min [95% CI] | Sens. any lead | False alerts/day [95% CI] | Precision | Median lead | Per-patient false alerts/day (min–median–max) |
|---|---|---|---|---|---|---|
| **P0 learned baseline (selected)** | **12.5%** [10.0–15.0] | 32.2% | 0.89 [0.73–1.05] | 50.7% | 20 min | 0.22 – 0.86 – 1.93 |
| T trend alone (comparator) | 15.0% [13.3–16.8] | 33.0% | 0.73 [0.65–0.82] | 56.2% | 25 min | 0.29 – 0.70 – 1.12 |
| C1 trend OR risk (comparator) | 15.2% [14.0–16.4] | 31.0% | 0.83 [0.77–0.89] | 51.5% | 25 min | 0.46 – 0.84 – 1.24 |
| P1 routine (secondary) | 21.0% [18.3–23.4] | 39.4% | 1.38 [1.26–1.50] | 44.8% | 30 min | 0.84 – 1.41 – 1.87 |
| C2 risk-gated trend (secondary) | 26.4% [24.3–28.5] | 62.1% | 1.26 [1.15–1.37] | 58.4% | 20 min | 0.69 – 1.24 – 1.98 |

- **P0 − T:** −2.5 points [−6.4, +1.4]. **P0 − C1:** −2.7 points [−5.7, +0.5]. The success rule needed both lower bounds above 0. **Not met:** the selected learned policy did not beat the trend rule or the combined policy, and was numerically below both.
- **P0 false alerts:** 0.89/day, within budget.

**RMSE (mg/dL)**

| Horizon | Persistence | Linear trend | Reduced twin | LightGBM |
|---|---|---|---|---|
| 30 min | **23.78** | 30.87 | 26.18 | 24.18 |
| 60 min | 37.87 | 59.62 | 39.51 | **36.87** |
| 120 min | 54.12 | 117.04 | 51.56 | **46.37** |

## Secondary: Broll, type 2 diabetes (5 people, 51.2 patient-days, 104 onsets; descriptive, underpowered)

| Policy | Sens. ≥30 min [95% CI] | Sens. any lead | False alerts/day | Precision | Median lead |
|---|---|---|---|---|---|
| P0 learned baseline | 11.5% [4.0–20.6] | 35.6% | 0.61 | 54.4% | 15 min |
| T trend alone | 11.5% [5.0–22.1] | 30.8% | 0.45 | 58.2% | 25 min |
| C1 trend OR risk | 16.3% [11.3–22.3] | 31.7% | 0.63 | 50.8% | 30 min |
| P1 routine | 17.3% [4.4–23.6] | 37.5% | 0.76 | 50.0% | 20 min |
| C2 risk-gated trend | 11.5% [7.1–17.2] | 46.2% | 0.63 | 60.0% | 15 min |

RMSE: persistence was best at every horizon (20.49 / 33.52 / 49.26 mg/dL at 30 / 60 / 120 min); LightGBM scored 24.60 / 39.14 / 52.25.

## Reading, across both external checks (Hall and this one)

- **On unused cohorts, the learned risk does not beat a physical trend rule at ≥30-min warning.** On Hall the trend rule led clearly. On AZT1D, trend and trend + risk were numerically ahead of the learned model.
- **Ranking and operating point are different problems.** The risk-gated trend policy (C2) roughly doubles ≥30-min sensitivity: 26.4% vs 12.5% on AZT1D, and 29.3% vs 22.7% on development validation. It does this consistently at about 1.2–1.3 false alerts/day, which is over the preregistered budget of 1.0. Its training threshold does not hold the budget on new patients.
- **Forecast accuracy transfers modestly at best.** LightGBM beats persistence at 60 and 120 min on AZT1D, but not at 30 min, and not on the small type 2 cohort.
- **This does not justify changing the shipped model or policy.** No candidate passed a preregistered external criterion.
- The type 1 / closed-loop physiology and the absence of EHR in both cohorts limit what transfers. None of this changes the locked real-data results.

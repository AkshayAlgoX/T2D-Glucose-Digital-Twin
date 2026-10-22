# Early-warning root-cause study (exploratory)

**Status: EXPLORATORY.** It uses training and validation patients only, and the test records are never loaded. The validation patients already informed model selection and calibration in the locked real-data run, so these validation numbers are not independent. Nothing here changes or re-evaluates the locked results in [`../real_data/RESULTS.md`](../real_data/RESULTS.md).

## Question

The locked hybrid caught 6.0% of spikes at least 30 min ahead, with a 10-min median lead, at 0.11 false alerts per patient-day. The budget was 1.0. Four candidate causes were tested: the two below, an explicit ≥30-min target, and missing daily routine (section 3).

1. **Operating point.** The policy alerts at a fixed calibrated risk of 0.35 and never uses the false-alert budget.
2. **No meal information.** The preregistration set meal carbohydrate to zero for every model.

## Method (shared)

- Hazard model: LightGBM with the `develop.py` decision features and hazard parameters, 300 rounds, seed `20260930`.
- Calibration: isotonic, fitted on patient-grouped 5-fold out-of-fold (OOF) predictions from training patients.
- Threshold: the one with the highest training-OOF sensitivity ≥30 min ahead at ≤ 1.0 false alerts per patient-day.
- Scoring uses `develop.evaluate_event_alerts`: 120-min cooldown, 1-to-1 alert-to-onset matching, warnings 5–120 min ahead. Confidence intervals come from 2,000 patient-bootstrap resamples.

## Results

**1. Operating point** (`budget_operating_point.py` → `results.json`). CGMacros + BIG IDEAs; 34 training and 12 validation patients; 198 validation onsets.

| Validation | Sens. ≥30 min [95% CI] | Sens. any lead | False alerts/day [95% CI] | Median lead |
|---|---|---|---|---|
| Fixed 0.35 | 19.2% [8.8–26.7] | 53.5% | 0.79 [0.38–1.26] | 15 min |
| Budget threshold 0.27 (set on training) | 22.7% [9.6–32.3] | 58.1% | 0.99 [0.45–1.55] | 15 min |

The 30-min linear-trend score has no threshold that meets the budget on training. At its strictest threshold (1.0) it scores 23.2% ≥30 min at 1.90 false alerts/day on validation.

**2. Meal information** (`meal_information_arm.py` → `meal_arm_results.json`). CGMacros only; 25 training and 9 validation patients; 181 validation onsets; 884 and 325 logged meals. The meal arm adds causal features: carbohydrate logged in the past 30, 60 and 120 min, and time since the last meal.

| Validation, budget threshold | Sens. ≥30 min [95% CI] | False alerts/day [95% CI] | Precision | Median lead [IQR] |
|---|---|---|---|---|
| CGM only (threshold 0.26) | 25.4% [14.0–34.1] | 1.49 [0.88–2.20] | 51.9% | 15 [5–55] min |
| CGM + logged meals (threshold 0.32) | 27.6% [13.1–38.9] | 1.06 [0.57–1.63] | 58.7% | 25 [10–55] min |

**3. Explicit ≥30-min target and the patient's own daily routine** (`routine_target_arms.py` → `routine_target_results.json`, `routine_iso_fa.py` → `routine_iso_fa_results.json`). CGMacros + BIG IDEAs, the same 34 training and 12 validation patients.

- **H1, target:** train on onset 30–120 min ahead instead of 5–120 min.
- **H2, routine:** for d = 1, 2, 3 days back, the patient's own CGM over the same upcoming clock window (t−288d+6 … t−288d+24 steps). Features are the window's mean maximum, its rise over CGM at t−288d, the fraction of days with a new excursion above 180 mg/dL, and the number of days with data. Everything is before t. Gaps stay missing, never imputed. Coverage: 99.8% of decisions.
- **Decision rule, fixed before running:** pick the arm with the highest training-OOF sensitivity ≥30 min at ≤1.0 false alert/patient-day. Only that arm and the baseline were then scored on validation.

| Training OOF, budget threshold | Sens. ≥30 min | Sens. any lead | False alerts/day | Median lead |
|---|---|---|---|---|
| Baseline | 21.5% | 52.6% | 0.72 | 15 min |
| ≥30-min target | 18.5% | 24.4% | 0.97 | 50 min |
| **Routine** (selected) | **26.9%** | 63.1% | 1.00 | 20 min |
| Routine + ≥30-min target | 25.4% | 35.6% | 0.89 | 55 min |

At matched false-alert rates (each arm's threshold swept on the same predictions), routine is ahead at every level:

| ≤ false alerts/day | Training OOF ≥30 min: baseline → routine | Validation ≥30 min: baseline → routine | Validation median lead |
|---|---|---|---|
| 0.5 | 11.0% → 20.0% | 12.1% → 24.2% | 10 → 37.5 min |
| 1.0 | 21.5% → 26.9% | 22.7% → 30.8% | 15 → 30 min |
| 1.5 | 27.2% → 30.8% | 26.8% → 38.4% | 20 → 35 min |

In the validation rows the threshold is swept on validation, so they describe the trade-off curve and are not an operating point. Paired patient bootstrap of the training-OOF difference at the budget threshold: **+5.4 points [95% CI +0.7, +10.1]**, 34 patients, 2,000 resamples. At its training-chosen threshold, the routine arm on validation reached 38.4% [24.3–49.1] ≥30 min but used **1.55** false alerts/day, so the training threshold does not hold the budget on new patients.

The explicit ≥30-min target lengthens lead but loses more spikes than it gains, so H1 is rejected.

## Conclusion

- **Routine is the best-supported candidate.** The patient's own previous days are the one input tested here that raises ≥30-min sensitivity at a matched false-alert rate on training OOF (CI excludes zero), with the same direction and larger size on validation. It is exploratory. Adopting it needs a new preregistration and an evaluation on patients not yet used, because the locked test partition cannot be reused. The threshold must also be re-set per deployment or per patient, since it does not transfer.
- **The operating point and logged meals do not explain the gap on their own.** A budget-matched threshold raises sensitivity a little, and its intervals overlap the fixed threshold's. Logged meals raise precision and median lead and keep false alerts nearer the budget. Their ≥30-min sensitivity gain is inside the confidence intervals, and on training OOF the meal arm is no better (23.7% vs 25.3%).
- **Transfer is weak.** The CGM-only threshold chosen on training overshoots the budget on validation (1.49/day), so a fixed false-alert budget does not carry across patients reliably.
- **What this means.** Recent CGM alone gives warnings mostly 5–25 min ahead. The patient's own daily pattern is what moves warnings past 30 min on these datasets. Retrospective meal logs added little here; prospectively time-stamped meals remain untested. A confirmatory test needs new patients; the locked test partition must not be reused for it.

## Reproduce

```
python budget_operating_point.py --data-dir <repo>/data/real
python meal_information_arm.py   --data-dir <repo>/data/real
python routine_target_arms.py    --data-dir <repo>/data/real
python routine_iso_fa.py         --data-dir <repo>/data/real
```

Data: CGMacros and BIG IDEAs raw files as described in [`../real_data/DATA_CARD.md`](../real_data/DATA_CARD.md). Both are under their own licences and are not redistributed here.

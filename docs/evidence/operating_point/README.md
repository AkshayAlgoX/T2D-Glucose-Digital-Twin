# Early-warning root-cause study (exploratory)

**Status: EXPLORATORY.** It uses training and validation patients only, and the test records are never loaded. The validation patients already informed model selection and calibration in the locked real-data run, so these validation numbers are not independent. Nothing here changes or re-evaluates the locked results in [`../real_data/RESULTS.md`](../real_data/RESULTS.md).

## Question

The locked hybrid caught 6.0% of spikes at least 30 min ahead, with a 10-min median lead, at 0.11 false alerts per patient-day. The budget was 1.0. Two candidate causes were tested:

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

## Conclusion

- **Neither cause explains the gap on its own.** A budget-matched threshold raises sensitivity a little, and its intervals overlap the fixed threshold's. Logged meals raise precision and median lead and keep false alerts nearer the budget. Their ≥30-min sensitivity gain is inside the confidence intervals, and on training OOF the meal arm is no better (23.7% vs 25.3%).
- **Transfer is weak.** The CGM-only threshold chosen on training overshoots the budget on validation (1.49/day), so a fixed false-alert budget does not carry across patients reliably.
- **What this means.** With CGM history alone, warnings 30 min or more before a spike that starts in range are rare on these datasets. Prospectively logged meals are the most plausible source of earlier warnings, but this retrospective study does not establish it. A confirmatory test needs new patients and prospective, time-stamped meal logs. The locked test partition must not be reused for it.

## Reproduce

```
python budget_operating_point.py --data-dir <repo>/data/real
python meal_information_arm.py   --data-dir <repo>/data/real
```

Data: CGMacros and BIG IDEAs raw files as described in [`../real_data/DATA_CARD.md`](../real_data/DATA_CARD.md). Both are under their own licences and are not redistributed here.

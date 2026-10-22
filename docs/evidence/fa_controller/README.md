# Early warning within budget: feedback controller and robust operating-point selection

**Status: EXPLORATORY (training-only selection; validation scored once per family and used in earlier work).** No external confirmation: no unused, openly licensed type 2 cohort large enough was found (see below). The locked test evaluation, Hall, AZT1D and Broll were not used.

## Hypotheses
The risk-gated trend policy C2, `(trend ≥ tf AND risk ≥ tg) OR risk ≥ tr`, ranked best in development and on AZT1D but ran over the false-alert budget. Two fixes were tested, every parameter chosen on training patient-grouped OOF:

1. **Feedback controller.** Each patient's thresholds move with their own resolved false alerts: offset = η·(false alerts − target·days), clipped to [−0.1, 0.5].
2. **Robust selection.** Parameters must keep the *worst* of the five patient-group folds at ≤ 1.0 false alert/patient-day, not just the pooled rate. This is a training-only proxy for new patients.

## Results (`develop_controller.py` → `results.json`; `paired_validation.py` → `paired_validation.json`; seed 20260930)

| Family (worst-fold selection) | Parameters | Training-OOF sens. ≥30 min | Worst-fold false alerts/day | Validation sens. ≥30 min [95% CI] | Any lead | Validation false alerts/day [95% CI] | Precision |
|---|---|---|---|---|---|---|---|
| P0 learned baseline | t 0.40 | 7.4% | 0.37 | 3.5% [0.8–5.8] | 22.7% | 0.25 [0.07–0.46] | 65.2% |
| **C2 static** | tf 240, tg 0.20, tr 0.476 | 22.3% | 0.94 | **27.3%** [15.8–36.4] | 69.7% | **0.87** [0.63–1.09] | 62.2% |
| C2 + controller | tf 220, tg 0.15, tr 0.424, η 0.03, target 0.75 | 21.5% | 0.98 | 25.8% [17.6–33.3] | 71.7% | 1.09 [0.92–1.22] | 57.5% |

- **Paired against the strongest training-chosen baseline** (P0 at its pooled budget threshold 0.2715: 22.7% at 0.98/day), 12 validation patients:
  - C2 static: **+4.5 points [−2.5, +12.8]** at ≥30 min;
  - **+11.6 points [−4.1, +34.3]** at any lead;
  - fewer false alerts (0.87 vs 0.98/day).
- **The controller is a null result.** It narrows the per-patient spread, but over-alerts on validation (1.09/day).
- **Worst-fold selection is what lets C2 hold the budget on new patients** (0.87/day, against 1.19 under pooled selection earlier). It does not help the learned baseline, which collapses to 3.5%.

## Reading
- C2 with worst-fold selection is the first policy in this project that both stays within the false-alert budget on new patients and points to more early warnings than the learned baseline.
- The gain is not statistically established on 12 validation patients, and validation has been used before. It is a candidate, not a result.

## Frozen candidate for any future confirmation
For use unchanged on a genuinely unused type 2 cohort:
- **Policy C2:** tf 240 mg/dL (30-min trend projection at +60 min), tg 0.20, tr 0.476, no cap.
- **Risk model:** routine-feature LightGBM hazard with training-OOF isotonic calibration, as in `develop_controller.py`.
- **Comparator:** P0 at 0.2715.
- **Primary endpoint:** paired patient-bootstrap difference in sensitivity ≥30 min, success if the lower bound > 0 and C2 false alerts ≤ 1.0/patient-day.

## Confirmation cohort search (2026-10-22)
- **Openly licensed type 2 CGM data:** Broll (5 people, already used), Hall (already used) and Colás (17 people with type 2 diabetes, about 2 days each, too short). Source: the Awesome-CGM and GlucoBench indexes.
- **Controlled-access only:** AI-READI (FAIRhub) and OMIX002493 (60 Shanghai patients).
- **Already used:** CGMacros, BIG IDEAs and ShanghaiT2DM test partitions are locked.
- **The most direct route to confirmation is approved AI-READI access.**

## Reproduce
`python develop_controller.py --data-dir <repo>/data/real` then `python paired_validation.py --data-dir <repo>/data/real`.

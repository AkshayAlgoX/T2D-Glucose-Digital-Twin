# Event-level early warning on the validation patients

Reproduce (repo root, ~21 min CPU):

    python backend/evaluate_events_validation.py --out docs/evidence/event_eval/validation_event_report.json \
        --decisions docs/evidence/event_eval/validation_decisions.npz

Recompute every number from the saved per-decision triggers, without the model (seconds):

    python backend/evaluate_events_validation.py --from-decisions docs/evidence/event_eval/validation_decisions.npz --out /tmp/check.json

`backend/tests/test_event_validation.py` asserts that the recomputation equals the committed report.

## What was scored
- **Patients:** the 44 validation patients; the table is the primary population (19 Prediabetes + 10 Type 2, 374.7 patient-days, 617 monitored spike onsets). The test split is never loaded.
- **Decisions:** every 5-min step with a current CGM value and enough past data; nothing after the decision time is used.
- **Policy, locked before this evaluation** (`backend/model_selection_rule.json`, unchanged): alert when the patient is at risk and the trigger holds, at most one per 120 min; thresholds 0.35 and 0.60; a spike counts as caught when an alert comes 5–120 min before onset; 95% CI from a 2000-resample patient bootstrap stratified by diabetes status (seed 20260930).
- **Deterministic 1-to-1 matching enforced:** Each raised alert can match at most one eligible spike onset, and each monitored spike onset can be detected by at most one alert. Matching proceeds chronologically by monitored onset (earliest onset first), assigning the earliest available (unmatched) eligible alert in `[onset - 120 min, onset - 5 min]`. Unmatched alerts count as false alerts; unmatched onsets count as missed. Under our locked 120-min alert cooldown and physiological refractory separation, every alert and onset on this validation cohort was already strictly disjoint, so 1-to-1 matching preserves every metric exactly while eliminating any potential for multi-event over-crediting in overlapping windows.
- **Calibration leak removed:** the hybrid's thresholds are applied to a hazard whose isotonic map was refitted on the *other* half of the patients (2 folds, stratified, seed 20261021). The served calibration reproduces from the validation predictions (max map difference 0.00009), and cross-fitted results are close to the served ones (at 0.35: 90.0% vs 90.6% of spikes caught, 1.77 vs 1.68 false alerts per patient-day).

## Results (primary population, 95% patient-bootstrap CI)

| Trigger | Spikes caught | Missed | False alerts / patient-day | Median warning | Caught ≥ 30 min ahead | Alerts that were right |
|---|---|---|---|---|---|---|
| Hybrid onset risk ≥ 0.35 (cross-fitted) | 90.0% (87.4–92.2) | 62 / 617 | 1.77 (1.58–1.94) | 70 min (70–80) | 83% | 45.6% (40.6–50.2) |
| Hybrid onset risk ≥ 0.60 (cross-fitted) | 70.8% (66.1–75.4) | 180 / 617 | 0.56 (0.44–0.68) | 65 min (55–70) | 87% | 67.6% (61.5–73.1) |
| Hybrid median forecast crosses the spike rule | 99.0% (98.1–99.7) | 6 / 617 | 1.02 (0.90–1.13) | 50 min (45–55) | 75% | 61.5% (56.7–66.0) |
| Physiology twin alone crosses the spike rule | 83.8% (79.7–87.6) | 100 / 617 | 0.42 (0.35–0.50) | 35 min (35–40) | 64% | 76.5% (71.8–81.0) |
| Straight-line CGM trend, last 30 min (baseline) | 99.4% (98.4–100) | 4 / 617 | 1.52 (1.29–1.74) | 20 min (20–20) | 29% | 51.9% (44.7–59.3) |

## Reading it
- **What the hybrid adds is warning time.** A straight-line extrapolation of CGM catches almost every spike, but with a median of 20 minutes' notice; the hybrid's onset risk at 0.35 gives a median of 70 minutes at a similar false-alert rate (difference +0.25 per patient-day, CI −0.01 to +0.53).
- **It is not better on every axis.** The physiology twin alone raises a quarter of the false alerts with shorter warning; the hybrid's own forecast, run through the spike rule, catches more spikes with fewer false alerts than its onset-risk head at 0.35, at 50 rather than 70 minutes' notice. The trade-off is reported, not resolved here.
- **1.8 false alerts per patient-day at 0.35 is high** for a real alarm. 0.60 cuts it to 0.56 and loses 29% of spikes. Neither threshold is tuned on these results; the operating curve in the report is descriptive only.

## Limits
Synthetic data (Gate 3 failed: the generator is distinguishable from an independent mock-real generator). The validation patients chose the checkpoint (early stopping on validation loss), so this is development evidence, not an independent test. The sealed test split, which `backend/evaluate_run.py` scores under the same policy, has not been opened. No open real-world dataset was used: the model needs heart rate, HRV, steps, sleep and logged carbohydrate at 5-min resolution, which the open T2D CGM datasets do not provide together, and inventing them would not validate anything.

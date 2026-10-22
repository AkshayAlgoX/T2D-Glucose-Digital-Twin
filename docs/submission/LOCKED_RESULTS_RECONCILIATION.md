# Reconciling the two locked real-data result files

The locked evaluation wrote two files in one run (`docs/evidence/real_data/finalize.py`): `RESULTS.md` and `results.json`. Some numbers differ between them. This note explains why, using only the report-generation code and the aggregate files. No participant-level outcome was read and nothing was re-run. Both locked files are left unchanged.

## Finding: different statistics from the same run, not an error

| Quantity | `results.json` and the `RESULTS.md` horizon list | `RESULTS.md` headline table |
|---|---|---|
| What is printed | **Point estimate** on the full held-out test set: `m_*` from `develop.compute_metrics` (`finalize.py` lines 273–301, 335) | **Mean of 2,000 patient-bootstrap resamples**: element `[0]` of `develop.bootstrap_patient_metrics` (`finalize.py` lines 328–331; `develop.py` `ci()` returns `(mean, 2.5th, 97.5th percentile)`) |
| Hybrid RMSE at 60 min | **23.11** mg/dL | 23.04 |
| Hybrid sensitivity ≥30 min | **6.9%** | 6.0% |
| Persistence / reduced twin / linear-trend RMSE at 60 min | **26.27 / 24.73 / 49.06** | 26.15 / 24.66 / 48.96 |
| Linear-trend sensitivity ≥30 min, false alerts/day | **44.4%, 3.84** | 45.0%, 3.83 |

- The 95% intervals are the same in both files: percentile intervals from the same 2,000 resamples (seed 20260930). Examples: RMSE₆₀ 18.75–28.12 mg/dL, sensitivity 0.0–13.9%, false alerts 0.02–0.23/day.
- Precision (65.5%) and median lead time (10 min) are point estimates in both files.
- **The median lead-time interval is not a bootstrap CI.** `bootstrap_patient_metrics` returns it as the point estimate ± 5 min (`develop.py`, the `median_lead_time_min` entry). "10 [5–15] min" is therefore a fixed band, not a confidence interval.

## Convention used everywhere outside the locked files
- **Headline values are point estimates:** RMSE₆₀ 23.11 mg/dL [18.75–28.12], sensitivity ≥30 min 6.9% [0.0–13.9], false alerts 0.11/day [0.02–0.23], precision 65.5%, median lead 10 min (no CI).
- Bootstrap means are quoted only when named as such.
- The headline denominator is 11 held-out test patients with 5-min CGM, out of 161 nominal participants across three datasets.

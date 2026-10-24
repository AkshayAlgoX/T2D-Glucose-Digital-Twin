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

## Convention used across the public submission
- **Authoritative headline sensitivity:** **6.0%** [95% CI 0.0–13.9%], representing the primary headline table figure in `docs/evidence/real_data/RESULTS.md` (mean of 2,000 paired patient-bootstrap resamples). The unbootstrapped point estimate from `results.json` is **6.9%** [95% CI 0.0–13.9%]. Both figures originate from the identical locked execution.
- **Headline 60-minute RMSE:** **23.04 mg/dL** [95% CI 18.7–28.1 mg/dL] (bootstrap mean from `RESULTS.md` Table 1) and **23.11 mg/dL** (MAE 15.98 mg/dL, 95% CI 18.75–28.12 mg/dL; unbootstrapped point estimate from `RESULTS.md` horizon subsection and `results.json`).
- **False alerts:** 0.11 false alerts per patient-day [95% CI 0.02–0.23].
- **Alert precision:** 65.5%.
- **Median warning lead time:** 10.0 min (point estimate; the reported 5.0–15.0 min band is a fixed ±5 min window, not a confidence interval).
- **Headline denominator:** 11 held-out test patients with 5-min CGM, out of 161 nominal participants across three datasets (the 20 ShanghaiT2DM test patients were not estimable at 15-min cadence).

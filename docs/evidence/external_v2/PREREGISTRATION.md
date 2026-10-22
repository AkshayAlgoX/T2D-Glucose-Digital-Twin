# External check 2: combined trend + routine-risk policies on AZT1D and Broll (preregistration)

**Committed before either cohort is read by analysis code.** The commit containing this file, `select_combined.py`, `frozen_policy.json` and `external_evaluate.py` is the freeze point. Results come from one run of `external_evaluate.py` after it.

## Development (done; training + validation only)
- Signals: calibrated routine-model risk, the baseline-model risk, and the 30-min linear-trend projection to +60 min.
- Policies: P0 baseline risk; P1 routine risk; T trend alone; C1 trend OR risk; C2 risk-gated trend OR high risk.
- All policies share the at-risk rule, the 120-min cooldown and 1-to-1 matching, plus a per-patient cap of K alerts per 24 h.
- Parameters were chosen on training patient-grouped OOF (sensitivity ≥30 min at ≤ 1.0 false alert/patient-day).

Validation results:

| Policy | Validation sens. ≥30 min | Any lead | False alerts/day |
|---|---|---|---|
| P0 baseline (t 0.2715, no cap) | **22.7%** | 58.1% | 0.98 |
| P1 routine (t 0.2348, cap 4) | 27.8% | 54.0% | 1.19 ✗ |
| T trend ≥ 220 mg/dL… (tf 210, cap 2) | 10.1% | 40.9% | 0.74 |
| C1 trend OR risk (tf 220, tr 0.399, cap 2) | 19.2% | 37.9% | 0.80 |
| C2 gated (tf 220, tg 0.15, tr 0.476, no cap) | 29.3% | 75.8% | 1.19 ✗ |

**Development finding:** no combined policy beats the baseline model within the false-alert budget. C2 and P1 rank better but overshoot the budget.

**Selection amendment (before any external data were read):** the first rule excluded P0 and would have chosen C1, which already scored below P0. The rule now selects the best validation policy within budget among all of them. **Selected: P0. Comparators: T (trend alone) and C1 (best within-budget combined policy).**

## External cohorts (unused in all development; Hall and the locked test partition are not used)
- **Primary: AZT1D.** Khamesian et al. 2025, Mendeley Data doi:10.17632/gk9m674wcx.1, CC BY 4.0. 25 adults with type 1 diabetes on automated insulin delivery; Dexcom G6, 5-min, 6–8 weeks. Zip sha256 `2c6b4183fdc729c708c1b3230ab1988d2c9006dd35729537f2de07f649f0d113`. Only the CGM column is used.
- **Secondary (descriptive): Broll.** iglu R package `example_data_5_subject`, GPL-2. 5 adults with type 2 diabetes, not on insulin, HbA1c ≥ 6.5%; Dexcom G4, 5-min, about 7 days.
  - `.rda` sha256 `1eeb7e14883faa78745ee141592f6b06d63613614c7ba29e947f4055535742de`.
  - Converted to CSV with `pyreadr` (columns id, time, gl); CSV sha256 `4f632b6d70cece144c9f30bc363f4a7dcf5ca0e291972fe940db5bdb1ffa5d20`.
- **Inspected before freezing:** file layout, column names, sampling cadence and participant counts only.
- No EHR fields: they enter as missing, as for any patient. Non-numeric or empty CGM stays missing. Data are not redistributed.

## Endpoints
- **Primary (AZT1D):** paired patient-bootstrap difference in sensitivity ≥30 min, P0 minus T and P0 minus C1 (2,000 resamples, seed 20260930).
  - **Success** requires both lower 95% bounds > 0 **and** P0 false alerts ≤ 1.0/patient-day.
- **Secondary, both cohorts:**
  - every policy's sensitivity (≥30 min and any lead), false alerts/patient-day with CI, precision, lead-time quartiles, per-patient false-alert range and per-patient sensitivity;
  - RMSE at 30/60/120 min for persistence, linear trend, the reduced twin and LightGBM.
- Broll is underpowered (5 people) and descriptive only.

## Limits stated in advance
- AZT1D is type 1 diabetes under closed-loop insulin, a different physiology from the type 2 development cohorts. The check tests transfer, not type 2 performance.
- Neither cohort has EHR fields.
- The locked multi-model hybrid ensemble is not re-trained here. P0 is its LightGBM hazard component.

## Amendment 1 (before any outcome was computed)
The first run of `external_evaluate.py` stopped while loading AZT1D, before any decision, prediction or metric existed. One of the 25 CSV files has no `CGM` column. It has only `Readings (CGM / BGM)`, which mixes fingerstick readings, so its CGM cannot be isolated. That participant is excluded and listed in `results.json` (`azt1d_excluded_amendment_1`). The other 24 files use `CGM` as preregistered. Nothing else changed.

Correction to the development table above: the T row is "trend projection ≥ 210 mg/dL at +60 min, cap 2". "220" was a typo; `frozen_policy.json` holds the true value, 210.

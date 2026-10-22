# External check on Hall et al. 2018: preregistration

**Written and committed before the Hall data are read by any analysis code.** The commit containing this file, `select_policy.py`, `hall_evaluate.py` and `frozen_policy.json` is the freeze point. Results come from one run of `hall_evaluate.py` after that commit.

## Why
On our own data, the patient's daily CGM routine improves how well risk is ranked. The open question is whether an alert policy chosen without the test data keeps the gain within the false-alert budget on new patients. The locked real-data test partition cannot be reused. Hall 2018 is an unused, openly licensed cohort.

## Data
- Hall KM, Di Giacomo M, Snyder MP et al. *Glucotypes reveal new patterns of glucose dysregulation.* PLoS Biol 2018;16(7):e2005143. S1 Data (`pbio.2005143.s010`), CC BY 4.0. Gzip sha256 `47e837a8622dd5763106de943a7849e265ce9f9ab3d0ac1970b5d4166a85f484`.
- 57 participants, mostly normoglycaemic or prediabetic, with a Dexcom 5-min CGM for about a week.
- It was not used in any development step. Before freezing, only its file format, participant count and readings per participant were inspected, along with how many participants had any reading above 180 mg/dL (32).
- The file has no EHR fields. Age, BMI, weight, HbA1c and sex enter as missing: training medians plus missing flags, as in `develop.py`.
- Non-numeric CGM entries stay missing.
- The data are not redistributed in this repository.

## Frozen pipeline
- Decision grid, spike definition, at-risk rule, 120-min cooldown, 5–120-min warning window and 1-to-1 matching all come from `docs/evidence/real_data/develop.py`, unchanged.
- Models and policies come from `frozen_policy.json`, written by `select_policy.py`:
  - parameters chosen on training-patient OOF;
  - the policy among P1–P3 selected on validation (development data).
- **Selected:** P2, the routine model with a per-patient own-rate threshold (95th percentile of the patient's own past 3 days of at-risk scores) and a floor of 0.25.
- **Comparator:** P0, the baseline model with a global threshold of 0.2715.
- P1 and P3 are reported as secondary.

## Endpoints
- **Primary:** the difference in sensitivity ≥30 min ahead between the selected policy and P0, with a patient-bootstrap 95% CI (2,000 resamples, seed 20260930).
- **Success** requires the lower CI bound > 0 **and** selected-policy false alerts ≤ 1.0 per patient-day (point estimate). Anything else is reported as not confirmed.
- **Secondary:**
  - each policy's sensitivity (≥30 min and any lead), false alerts per patient-day with CI, precision, lead-time quartiles and the per-patient false-alert range;
  - the linear-trend reference;
  - 60-min RMSE for persistence, linear trend, the reduced twin and LightGBM.

## Limits stated in advance
- Hall differs from the development cohorts. It has fewer people with diabetes, so spikes are rarer, and it has no EHR.
- A null result would not show that the routine features are useless for type 2 diabetes. A positive result would show transfer to an external cohort, not clinical benefit.

# Confirmation of the C2 early-warning candidate on AI-READI (preregistration)

**Frozen before any AI-READI data have been obtained.** On 2026-10-22 this project has no approved AI-READI access, and no AI-READI data exist on the development machine. This file and `aireadi_evaluate.py` are frozen in the commit that adds them. Results come from one run of `aireadi_evaluate.py` after approved access, with no changes. If a change proves necessary (for example a loader fix after a format error), it is recorded as a dated amendment, committed before any outcome is computed.

## Why
The risk-gated trend policy C2, chosen on training data only with worst-fold false-alert selection, is the only policy in this project that stayed within the false-alert budget on new patients while pointing to more early warnings. On development validation it scored 27.3% ≥30 min at 0.87 false alerts/day, against 22.7% at 0.98 for the learned baseline: paired +4.5 points [−2.5, +12.8] (`docs/evidence/fa_controller/`). That is exploratory, and validation has been used before. Three external checks have been spent (Hall, AZT1D, Broll), and no openly licensed, unused type 2 cohort remains. AI-READI has about 944 participants with type 2 diabetes (Oral or Insulin study groups) wearing a Dexcom G6 for about 10 days.

## Access (to be completed by a team member)
- AI-READI on FAIRhub requires an approved data-access request:
  - CILogon sign-in;
  - a statement that the research relates to type 2 diabetes;
  - evidence of research-ethics training;
  - agreement to the dataset licence.
- The CGM data are in the public tier.
- The data are not redistributed in this repository.

## Cohort
- `participants.tsv` rows with `study_group` in {Oral, Insulin} **and** `recommended_split` = test.
- Restricting to AI-READI's own test split leaves the train and validation participants free for any later development (`docs/evidence/real_data_v2` plans AI-READI development) without contaminating this check.
- CGM from `wearable_blood_glucose/manifest.tsv`.
- Eligibility: ≥ 7 days of wear (2,016 unique 5-min epochs) and ≥ 70% active wear over the wear span.
- Readings outside 40–400 mg/dL stay missing. No EHR fields are used: they enter as missing, as in the other external checks.

## Frozen pipeline
- Decisions, spike definition, at-risk rule, 120-min cooldown, 5–120-min warning window and 1-to-1 matching: `docs/evidence/real_data/develop.py`, unchanged.
- Risk models: fitted on the same training patients with training-OOF isotonic calibration (`develop_controller.py`), seed 20260930.
- **Policy C2:** (30-min trend projection at +60 min ≥ 240 mg/dL AND routine risk ≥ 0.20) OR routine risk ≥ 0.476.
- **Comparator P0:** learned baseline risk ≥ 0.2715.

## Endpoints
- **Primary:** paired patient-bootstrap difference in sensitivity ≥30 min, C2 minus P0, 2,000 resamples, seed 20260930.
- **Success:** lower 95% bound > 0 **and** C2 false alerts ≤ 1.0/patient-day.
- **Secondary:** each policy's sensitivity (≥30 min and any lead), false alerts/day with CI and precision, and the same endpoints within the Oral and Insulin groups.
- Only a met primary endpoint may be described as independent confirmation.

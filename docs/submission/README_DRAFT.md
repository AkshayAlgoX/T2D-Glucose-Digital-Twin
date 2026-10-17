# T2D Glucose Digital Twin

**A research prototype combining patient context, wearable history and a physiological model to forecast glucose and estimate near-term spike risk.**

`DRAFT — team details, release verification and submission links remain incomplete.`

| Submission item | Value |
|---|---|
| Team / institution | `[TEAM_NAME] / [COLLEGE_OR_INCUBATOR]` |
| Members and roles | `[VERIFIED_MEMBER_NAMES_AND_ROLES]` |
| Public repository / release | `[VERIFIED_PUBLIC_URL] / [REVIEWED_RELEASE_COMMIT]` |
| Demo video (>=20 minutes) | `[PUBLIC_OR_UNLISTED_VIDEO_URL]` |
| Architecture PDF/PPT | `[ARCHITECTURE_EXPORT_LINK]` |
| Presentation PDF/PPT | `[PRESENTATION_LINK]` |
| License | `[OWNER_CONFIRMED_LICENSE_AND_NOTICES]` — package metadata says ISC; final rights review pending |

## The problem

A glucose reading describes the present. A useful monitoring interface should also show a possible trajectory, uncertainty and the information behind a warning. We explore that workflow for prediabetes and Type 2 diabetes using synthetic patient records and wearable-like time series.

The intended benefit is helping a clinician inspect changing glucose risk in context. Reduced complications, improved HbA1c, reduced workload and treatment benefit have **not** been demonstrated. This is **research only, not for clinical decisions**.

## What is implemented

- **EHR–wearable fusion:** static age, BMI, HbA1c, eGFR, disease/medication context enters the model with CGM, HR, HRV, steps, sleep and logged-meal features. S3 uses an observable-input contract rather than the privileged oracle mode. [C01–C02]
- **Hybrid forecasting:** an Unscented Kalman Filter physiological prior feeds a Physics-Residual Temporal Fusion Transformer. The network adds learned residual quantiles and predicts discrete-time spike hazard. [C03]
- **Forecast and risk outputs:** 24 five-minute forecast points cover the next 120 minutes. The API exposes seven quantiles and a calibrated 120-minute onset probability. Implementation is verified; prospective accuracy is not established here. [C04–C05]
- **Clinician-facing concept:** cohort selection, patient chart, risk panel, model-contribution display, data-quality information and replay controls exist in the frontend. The streaming service replays synthetic data; it is not a connected medical-device deployment. [C06–C07]
- **Scenario API:** meal/activity/skip-meal handlers alter twin inputs and re-run prediction. The dashboard's Scenario Editor is currently disabled. Medication scenarios are rejected. Scenario magnitudes are not validated human treatment effects. [C08]

The inspected configuration selects **Arm D: PR-TFT + UKF S3**. EXP-FINAL and the research raw-physics-delta composer are not represented as integrated serving components in this draft.

## How the prototype works

Existing synthetic EHR and telemetry → observable-input contract and preprocessing → UKF prior plus historical/habit features → PR-TFT residual forecasts and hazard → calibration and service alert policy → validated API responses → dashboard.

The model uses patient-specific EHR context and filter states. This is not evidence of separately trained, clinically fitted models for every patient. TwinCard calibration is labelled `ehr_prior`; nightly MAP fitting is not implemented in the inspected serving path.

See [architecture](ARCHITECTURE_CONTENT.md), [diagram source](architecture.mmd) and [claim ledger](CLAIM_EVIDENCE_LEDGER.md).

## Reading the display responsibly

The forecast band represents model uncertainty; an 80% nominal interval is not a universal coverage guarantee. The risk value concerns an onset **within** 120 minutes, not a guaranteed two-hour warning. Contributions explain arithmetic within the model, not causal drivers in a person.

The service has insufficient-input, degraded-input and twin-only fallback paths. Their existence does not certify clinical safety. Its streaming alert policy has hysteresis and suppression and is distinct from the scientific evaluator's comparison rules.

## Evidence status

**VERIFIED:** implementation paths and configuration described above exist in the inspected source.

**SUPPORTED:** a saved infrastructure-test log records 112 passing tests at commit `68bcb278`; this is engineering evidence, not clinical validation or prospective accuracy.

**Historical only:** Arm D's manifest contains validation forecasting and anchor-level discrimination figures. The same validation cohort was involved in model selection/calibration, and the manifest records a dirty source tree. These numbers are not presented as independent evaluation results.

**Not established:** useful alert-level advance warning beyond fair baselines, human counterfactual validity, clinical effectiveness, real-world generalization or superiority over competing entries. EW-01 remains governance-blocked in the inspected record; no successful EW-01 result is claimed.

## Reviewer walkthrough and reproducibility

**Live verification is pending.** This draft does not provide an untested one-command installation promise.

1. Obtain `[REVIEWED_RELEASE_AND_ARTIFACT_DOWNLOAD_INSTRUCTIONS]` and verify `[PUBLISHED_SOURCE_AND_ASSET_DIGESTS]`.
2. Use `[VERIFIED_BACKEND_ENVIRONMENT]` and `[VERIFIED_NODE_PACKAGE_MANAGER_LOCK]`. Do not build from the dirty EW-01 lock in the inspected working tree.
3. Configure server-side `BACKEND_URL`; use `PR_TFT_SERVICE_TOKEN` consistently if authentication is enabled. Never place credentials in the video or client bundle.
4. Follow `[AUTHORIZED_EXISTING_SYNTHETIC_DEMO_STARTUP_INSTRUCTIONS]`. Service configuration and checkpoint must match the selected run; no cohort generation is needed for the proposed replay demonstration.
5. Open `/cohort`, then its patient link. Confirm synthetic/replay identity, time, chart, risk and data quality against the actual response.

Do not invoke `/v1/subjects/{id}/twin` for this non-scoring walkthrough: it computes cohort RMSE. `/evidence` is not presently a verified populated results page. Pinned-time navigation, scenario requests and failure-state demonstrations require separate rehearsal; use no protected or quarantined dataset.

Frontend build scripts regenerate contract files; a build is not a read-only operation. Final startup/build instructions must be tested in a separately authorized clean release workspace.

## Limits and next steps

The synthetic generator and twin share physiological assumptions, so simulation evidence alone can be circular. Real-data evaluation and scientifically controlled scenario validation remain separate research tasks. No sensor vendor integration, medication dosing, automatic treatment, clinical trial, or demonstrated reduction in healthcare events is claimed.

Priorities are a reliable end-to-end replay demonstration, a complete evidence-linked submission and, only after all approvals, the frozen EW-01 evaluation. No new cohort or scientific score was produced while preparing this README.

Draft provenance: source inspection at `4a743311c2492a919a84e8857f3c7ca8e985d8af`, 2026-10-12. Links here are relative to `submission_draft/`; review paths before adopting this as a root README. Existing root README is unchanged.

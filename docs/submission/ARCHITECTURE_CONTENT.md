# Architecture content for the submission export

Snapshot: `4a743311c2492a919a84e8857f3c7ca8e985d8af`, 2026-10-12. **VERIFIED** below means source/configuration inspection, not a successful runtime demonstration. Diagram: [architecture.mmd](architecture.mmd).

## 1. Scope and system boundary

The served prototype replays existing synthetic EHR/telemetry and forecasts glucose. It is not a live wearable integration or a clinically validated decision system. Scientific EW-01 evaluation is a separate gated research path; this document does not authorize it or supply its results.

Inspected run: `runs/pr_tft_ablation_arm_d/config.json` selects `twin=ukf`, `twin_mode=s3`, `twin_base=habit`. Do not substitute research challengers for the deployed configuration in the diagram.

## 2. Components and data flow

| Component | Responsibility | Source |
|---|---|---|
| Synthetic data origin | Generator defines EHR, behavior, physiology and sensor simulation. Existing telemetry contains CGM, HR, HRV, sleep, steps and meal fields. Generator was read, not run. | `backend/generate_health_data_v2.py` |
| Observable-input boundary | S3 reads permitted EHR; privileged simulator latents belong to oracle mode. Logged meals become available on the first grid point at/after logging. | `backend/input_contract.py`, `train_pr_tft.py` |
| Preprocessing | Patient series, missingness handling, static normalization, past features, logged-meal effects and train-derived population habit. Resting-HR warm-up and eligibility logic constrain usable anchors. | `train_pr_tft.py`, `ServiceContext` |
| UKF S3 | Physiological state estimation and rollouts; EHR-derived parameters, glucose/insulin/gut dynamics, wearable inputs and sensor-state handling. | `backend/ukf_twin.py` |
| PR-TFT | Static variable selection/context; past/future variable selection; LSTM encoder/decoder; gated enrichment and causal attention; residual quantile, hazard and peak heads. | `train_pr_tft.py::PRTFT` |
| Calibration | Interval adjustment from saved conformal parameters; isotonic calibration of cumulative onset probability. | `Calibrators`, `ServiceContext.run_model`, `calibrated_hazard` |
| Serving policy | Quality assessment, network exception fallback, risk tiers, one-off alerts and separate stateful streaming policy. | `backend/serve_pr_tft.py` |
| API | `/v1/health`, `/v1/subjects`, `/v1/forecasts`, subject stream and twin-card endpoints. Pydantic response models. | `create_app` |
| Frontend integration | Next.js server routes proxy to `BACKEND_URL`; token forwarding, response validation and SSE processing. | `src/app/api/`, `src/lib/schema-validator.ts` |
| Dashboard | Cohort selection, patient view, chart/risk strip, contribution panel, time controls, quality/error rendering. | `src/app/cohort`, `src/app/patients`, `src/components/digital-twin` |

Model output is the selected twin prior plus learned residual quantiles. Forecast interval: 24 steps of five minutes; quantiles: p05, p10, p25, p50, p75, p90, p95. Risk is derived from per-step hazards and calibrated at the 120-minute horizon. Do not interpret horizon length as achieved warning lead time.

## 3. Artifact loading and provenance

Service startup reads config, split, normalization, calibration and checkpoint from the run directory, checks recorded hashes and data compatibility, and constructs patient caches. Canonical meal and UKF-state artifacts are supported. `T.load_data` is called before canonical meal replacement; therefore this service must not be described as the EW-01 no-regeneration execution path.

The inspected split lists 205 train, 44 validation and 44 test IDs; counts are verified metadata, not a new data audit. The run manifest records historical source commit `bf34aca4772d51d748c95edd7e83c8e47444c5ad` with a dirty tree. Current runtime provenance and historical training provenance must remain distinct.

Checkpoint and canonical artifacts exist locally and were not LFS pointer text in the inspected file prefixes. Their full bytes were not rehashed here. Clean-machine downloadability and service startup remain UNKNOWN.

## 4. Clinician-facing workflow

1. Select a synthetic replay subject.
2. Inspect timestamp/current CGM and forecast uncertainty.
3. Inspect onset probability, alert state and data quality.
4. Inspect available twin-state/contribution information as model context.
5. Investigate missing or degraded information; no medication recommendation or autonomous treatment follows.

The UI contains an EHR sidebar, but the default SSE include list omits `ehr_context` and the proxy does not forward an include request. Sidebar population is therefore not a demonstrated end-to-end capability. The backend forecast API supports explicit EHR-context inclusion.

The time scrubber exists, but pinned-time behavior requires rehearsal: its client waits for an SSE response to finish. It is not presented as verified interactive history navigation.

## 5. What-If capability: current implementation boundary

`serve_pr_tft.py::scenarios` supports meal input, immediate activity-uptake approximation and skipping a habitual meal. It changes twin inputs and re-runs PR-TFT, returning scenario quantiles, peak change and probability change. Medication input returns `SCENARIO_UNSUPPORTED`. Activity omits a delayed sensitivity effect and includes an approximation warning.

`src/app/api/forecast/route.ts` supplies a scenario proxy and transforms the first scenario response. However, `ScenarioEditor.tsx` explicitly disables its controls: the dashboard scenario interaction is not wired. Do not use a fixture's What-If curve as proof of that integration.

This serving path is not the research raw-UKF-delta composer. Directional, magnitude, out-of-distribution and human counterfactual validity are not established by source availability. Retain What-If as a bounded prototype/API capability, not treatment-effect prediction.

## 6. Uncertainty and failure handling

- Learned quantiles are ordered by construction; served calibrated quantiles are checked, with exceptions entering a twin-only fallback.
- Fallback uses saved interval adjustments; they are not independently validated uncertainty for the fallback model. Do not assert universal monotonic/safe fallback behavior.
- Insufficient history/coverage or unavailable forward-filled current CGM can suppress forecast/risk output. Staleness and other warnings are recorded, but a stale reason alone is not equivalent to unconditional suppression.
- Stream policy uses watch/warning thresholds, hysteresis and a 120-minute suppression period. The evaluator uses its own frozen alert-comparison definitions; UI behavior is not scientific alert-performance evidence.
- Contribution bars are arithmetic within the forecast. The displayed unannounced-meal indication is heuristic. Neither establishes human causality.
- Zod/Pydantic validation and error handling exist; no claim of complete security, fault tolerance or regulatory compliance is made.

## 7. Scientific evidence path and limits

The separate EW-01 harness and runner are intended for frozen model comparisons under adopted scientific definitions. Current A004 decisions/migrations remain incomplete; no fresh result is supplied here. Saved 112-test evidence concerns implementation behavior only.

The `/evidence` page expects a specific manifest/report shape. Arm D lacks the expected report, and its manifest uses different keys. Do not fabricate an export to make the page look evaluated.

The TwinCard endpoint is outside the planned non-scoring demo: `twin_card` computes a forecast RMSE over cohort anchors. It reports `ehr_prior` and degenerate parameter intervals, not completed nightly fitting.

Other limits: synthetic realism is incomplete; shared simulator assumptions can inflate apparent validity; training-era validation was reused for selection/calibration; real-world predictive generalization and clinical benefit remain UNKNOWN. Historical plasma-truth and fairness concerns from prior reports require their own evidence audit and must not be quietly reused.

## 8. Export guidance

Use the Mermaid diagram as the main system figure. Solid links denote source-implemented paths, not successful runtime verification. Dashed links denote optional/disconnected or future integration. Put the scientific evaluation branch beside the serving path, never as an already completed result feeding the UI.

Add a visible footer: **Synthetic research prototype; clinical utility and live deployment not validated.** Do not label the dashboard scenario editor operational. Export to `[ARCHITECTURE_PDF_OR_PPT]` after checking text legibility and consistency with the ledger.

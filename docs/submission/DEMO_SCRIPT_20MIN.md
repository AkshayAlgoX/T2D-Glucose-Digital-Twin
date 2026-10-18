# 22-minute demonstration script — draft, not execution authorization

Target recording: **22:00**, with final delivered duration at least 20:00. No recording, model inference or scientific evaluation was performed in this sprint. Rehearse only after separate authorization for ordinary inference on explicitly approved existing synthetic data. Do not use fresh EW-01 data, protected data, quarantined data or scientific evaluators.

## Recording preconditions

- Fill `[DEMO_RELEASE]`, `[APPROVED_DEMO_DATA_ID]`, `[SUBJECT_UUID]`, `[REPLAY_TIME]`, `[STARTUP_RECIPE]` and all public links. A demonstrator may choose an illustrative existing replay, but must not call it a representative accuracy sample.
- Capture screen and narration clearly; mask tokens and personal contact details. Identify every fixture screen visibly as **UI FIXTURE — NOT MODEL OUTPUT**.
- Establish API/UI connectivity without collecting cohort performance metrics. Do not call the TwinCard endpoint: its handler computes RMSE.
- No scenario UI click-through is promised: `ScenarioEditor.tsx` disables its controls. API demonstration is optional and remains unverified until separately rehearsed.
- Do not navigate to `/design-review` and imply its hand-built outputs are inference. Do not show fixture screenshots as validation.
- Telemetry stream provides observable EHR context (`ehr_context=True` by default); explain how static clinical covariates condition the residual model.
- A failed live step must be disclosed. A source walkthrough can explain implementation but cannot replace evidence that the prototype runs. Do not silently splice in fixtures.

## Timed plan

| Time | Screen/action | Narration and evidence | Status / fallback |
|---|---|---|---|
| 00:00–01:00 | Title, team, research-only statement | “We combine synthetic patient context and wearable history to inspect near-term glucose risk.” No outcome-improvement claim. | Team placeholders must be completed. |
| 01:00–02:30 | One clinician workflow diagram | Review context → inspect trend/band → inspect risk/quality → decide whether more information is needed. No treatment recommendation. | Conceptual workflow; ARCHITECTURE_CONTENT.md. |
| 02:30–04:00 | Architecture diagram and selected source snippets | Explain observable static inputs and time-series features; distinguish oracle mode and S3. | VERIFIED `input_contract.py`, feature declarations; no data files opened for this segment. |
| 04:00–05:30 | Existing `/cohort` and a patient link | Show the subject returned by the actual service, synthetic identity and replay timestamp. | Implemented, runtime pending. Do not claim device connection. |
| 05:30–08:00 | Patient chart updates from actual SSE responses | Explain current CGM, p50 and quantile band, five-minute steps and 120-minute horizon. Show corresponding response metadata/network event. | `PatientWorkspace`, `ForecastCanvas`, stream route. Successful end-to-end output is required for the final prototype claim. |
| 08:00–10:00 | Risk panel and alert fields | Explain onset probability within 120 minutes. If alert is absent, say so. Distinguish watch/warning presentation from evaluator sensitivity and false-alert metrics. | `RiskPanel`, `alert_for`, `StreamPolicy`. Never force a favorable event or claim two-hour achieved lead time. |
| 10:00–11:30 | API payload or code and twin-state display where populated | Show EHR fields used, physiological prior and patient-specific state. A direct `ehr_context` request may be shown only after authorized rehearsal. | Source exists; default UI EHR sidebar may be absent. No TwinCard request. |
| 11:30–13:00 | “How this forecast is built” panel | Explain the model's arithmetic contributions. Describe unannounced-meal indication as heuristic. | `drivers` and RiskPanel; no causal attribution or verified meal detection claim. |
| 13:00–14:30 | Data-quality display; then clearly labelled fixture if necessary | Describe absent forecasts for insufficient input and explicit fallback flags. A fixture demonstrates rendering only. | Existing `/design-review` states may illustrate UI, but are never performance evidence. |
| 14:30–16:00 | Scenario architecture and disabled editor | State: API handlers exist, dashboard interaction is not connected. Optional separately rehearsed API request may show baseline/scenario arrays; otherwise show source only. | `scenarios`, forecast proxy, disabled ScenarioEditor. Magnitude/causal validity unknown; medication unsupported. No claim that raw-delta research composer is deployed. |
| 16:00–18:00 | Evidence ledger and saved test log | Separate source verification, historical VAL metrics, engineering tests and unrun scientific evaluation. Show 112-test log as saved evidence with its commit. | No evaluator executed. Do not imply `/evidence` currently renders those results. |
| 18:00–19:30 | Limitations slide | Synthetic-only demonstration; simulator similarity; validation reuse; undefined clinical benefit; served/evaluator alert differences; lead-time limitation. | Ledger C05/C08/C10/C12/C13/C16. |
| 19:30–21:00 | Reproducibility and final artifact links | Show reviewed release identity, artifact requirements and completed installation notes once available. No live installation that could mutate frozen work. | Final clean-machine evidence is a remaining task. |
| 21:00–22:00 | Closing scope and next steps | Summarize demonstrated inference and uncertainty display. Present real-world validation, UI What-If integration and clinical utility study as future work. | No rank guarantee; no governance-dependent result stated as completed. |

## Minimum actual live proof

Within the recording, demonstrate an approved existing synthetic subject, at least two successive real service forecast updates, matching API/UI subject and time, forecast quantiles, risk and quality fields. Record the release/model identity. This establishes prototype execution only.

If permitted and rehearsed, add one direct scenario request to prove the API path; otherwise label it source-verified but not live-demonstrated. Scenario UI integration is future work. Do not call twin-card fit metrics, scientific runners, generators, preparation or sealing tools.

## Stop conditions and capture checklist

- Stop the live segment if it would access an unauthorized cohort or require a scientific metric computation.
- If inference cannot run, record the blocker and fix it through separately authorized engineering work before claiming a working live prototype. The 22-minute script alone does not meet that claim.
- Preserve `[VIDEO_URL]`, `[VIDEO_DURATION]`, `[DEMO_RELEASE]`, `[MODEL_ARTIFACT_IDENTIFIERS]`, `[APPROVED_REPLAY_SELECTION]`, and `[REVIEWER_SIGNOFF]`.
- Runtime/latency may be described only after actual measurements with hardware and conditions; no estimate is inserted here.

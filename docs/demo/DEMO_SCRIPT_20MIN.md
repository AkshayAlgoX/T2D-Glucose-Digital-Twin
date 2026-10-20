# 20-Minute Demonstration Script — Verified Submission Draft

> [!CAUTION]
> **SUBMISSION RELEASE BLOCKER**: A written script alone is insufficient. An actual demonstration video of at least 20 minutes must be recorded, verified for legibility and privacy, and published to a permanent public/unlisted URL. As of this release candidate, the video asset is **MISSING** and remains an active release blocker.

Target recording duration: **20:00** (minimum 20:00 required by challenge rules).  
This script provides the step-by-step walkthrough for demonstrating the prototype using the approved synthetic replay cohort (`19dba1b5-d8b3-5634-a184-aeb831ea6d36`). Do not use protected cohorts, quarantined data, or unapproved evaluators during rehearsal or recording.

---

## Recording Preconditions & Constraints

1. **Placeholders**: Prior to recording, team lead must confirm `[DEMO_RELEASE]`, `[APPROVED_DEMO_DATA_ID]`, `[SUBJECT_UUID]`, `[REPLAY_TIME]`, and public repository URLs.
2. **Credential Sanitization**: Ensure browser screen capture, terminal output, and network inspector mask all bearer tokens (`PR_TFT_SERVICE_TOKEN`), API keys, and local home filesystem paths (`/home/akshaya/...`).
3. **Fixture Labelling**: If any design review or edge-case screen is demonstrated (`/design-review`), clearly narrate and visually caption it as **"UI FIXTURE — ILLUSTRATIVE DESIGN ONLY, NOT REAL MODEL INFERENCE"**.
4. **Boundary Disclosures**:
   - Telemetry stream includes observable static EHR context by default (`ehr_context=True`); explain how static clinical covariates condition the residual model.
   - Scenario Editor controls in `ScenarioEditor.tsx` are disabled; explain that the scenario API exists in backend routes, but interactive editing is not yet wired to live serving.
   - Do NOT invoke `/v1/subjects/{id}/twin` on camera: its handler triggers cohort RMSE computations over anchor records.
   - Explain that model contribution bars describe internal arithmetic decomposition, not causal patient drivers.

---

## Timed Walkthrough (Exact 20:00 Timeline)

| Time | Duration | Screen / Action | Narration & Evidence Focus | Technical Reference |
|---|---|---|---|---|
| **00:00–01:00** | 1:00 | Title slide, team details, research disclaimer | Introduce project title, participating team and institution, and the explicit boundary: *"A synthetic research prototype for predictive metabolic monitoring; not validated for clinical diagnosis or treatment."* | README, Slide 1 |
| **01:00–02:30** | 1:30 | Clinician workflow diagram | Conceptual clinical journey: Patient context → Continuous trajectory → Risk horizon → Data quality review → Decision context. | `docs/architecture/architecture.pdf`, Slide 2 |
| **02:30–04:00** | 1:30 | System architecture & code tour | Explain observable static inputs vs. dynamic telemetry; show UKF S3 physiological prior feeding PR-TFT deep residual model. | `backend/input_contract.py`, `backend/ukf_twin.py`, Slide 4 |
| **04:00–05:30** | 1:30 | Cohort directory (`/cohort`) | Navigate to `/cohort`. Filter by group (`Prediabetes`), inspect synthetic subject identities (`P0001` / `19dba1b5-d8b3-5634-a184-aeb831ea6d36`). | `src/app/cohort/page.tsx` |
| **05:30–08:00** | 2:30 | Patient workspace (`/patients/[id]`) | Demonstrate live SSE stream connection (`"Synthetic stream connected"`). Show current glucose (114 mg/dL), 24-step forecast ribbon (p05–p95), and 120-minute horizon. Inspect incoming SSE packets via browser network tab (`forecast.updated`). | `PatientWorkspace.tsx`, `ForecastCanvas.tsx` |
| **08:00–10:00** | 2:00 | Risk panel & adverse event monitoring | Inspect `RiskPanel`: spike onset probability within 120 minutes, risk tier badge (`High`), alert status (`Warning`). Emphasize that risk represents onset *within* 120 min, not guaranteed 2-hour lead time. | `RiskPanel.tsx`, `serve_pr_tft.py` |
| **10:00–11:30** | 1:30 | Twin physiological state & EHR context | Show twin state parameters (`insulin_sensitivity_rel`, unannounced meal indication). Disclose that unannounced meal probability is a physiological filter heuristic. | `twin_state`, `ServiceContext` |
| **11:30–13:00** | 1:30 | "How this forecast is built" panel | Inspect arithmetic contribution bars (learned residual, habitual meal, baseline return). Explicitly state: *"These bars explain model arithmetic, not causal patient biology."* | `drivers`, `RiskPanel.tsx` |
| **13:00–14:30** | 1:30 | Data quality, fallbacks & edge cases | Show data quality indicator (`status: ok`, `cgm_coverage: 100%`). Discuss fallback handling (insufficient input, sensor gaps, twin-only fallback). | `data_quality`, `useRealtimeTelemetry.ts` |
| **14:30–16:00** | 1:30 | Scenario exploration & boundary | Show scenario architecture. Explain that backend API routes (`/api/forecast`, `/v1/forecasts`) support meal and activity simulation, but `ScenarioEditor.tsx` UI is currently disabled pending causal clinical validation. Medication scenarios return `SCENARIO_UNSUPPORTED`. | `ScenarioEditor.tsx`, `serve_pr_tft.py` |
| **16:00–18:30** | **2:30** | Evidence ledger, test logs & limitations | Walk through the Claim–Evidence Ledger: separate verified implementation from historical validation metrics and unexecuted experiments. Show verified test log (37 passing Jest suites with 346 passing tests, and 111 passing Pytest backend tests). Disclose synthetic realism Gate 3 failure (AUROC 0.9320 historical / 0.9290 corrected vs 0.65 threshold) and unexecuted EW-01 status. | `CLAIM_EVIDENCE_LEDGER.md`, `validation_report.json` |
| **18:30–19:30** | 1:00 | Reproducibility & setup walkthrough | Walk through verified installation: Node 22, Next.js dev server with Webpack, Python 3.12 venv, FastAPI backend on 8001. Show deterministic test commands. | `README.md`, setup instructions |
| **19:30–20:00** | 0:30 | Conclusion, research scope & Q&A | Summarize demonstrated capabilities: reliable chunk-invariant SSE streaming, calibrated uncertainty visualization, bounded fail-closed error handling. Outline future clinical trial requirements. | Slide 12 |

---

## Exact Segment Check

- **Segment 16:00–18:30**: Exactly **2 minutes and 30 seconds** (150 seconds).  
  *Calculation*: $18:30 - 16:00 = 2:30$. (Corrected from draft that erroneously wrote 2:50 or 2:00).
- **Total Duration**: Exactly **20 minutes and 00 seconds** (1,200 seconds).

---

## Minimum Live Proof Checklist on Camera

- [ ] Synthetic patient `P0001` loaded from permitted local backend (`http://127.0.0.1:8001`).
- [ ] At least two successive SSE stream events (`000143-forecast`, `000144-forecast`) rendered live without page refresh.
- [ ] Companion event (`000143-alert`) observed without wiping or resetting forecast canvas.
- [ ] Forecast quantile ribbon (p05, p10, p25, p50, p75, p90, p95) visibly rendered.
- [ ] Risk probability curve (0–120m) displayed in `RiskPanel`.
- [ ] Zero unhandled JavaScript exceptions in browser console.

# T2D Glucose Digital Twin — Clinical Workstation & Replay Engine

**A research prototype combining observable patient context, wearable history, and mechanistic physiological modeling to forecast glucose trajectories and estimate adverse spike risk.**

[![Frontend Tests](https://img.shields.io/badge/frontend%20tests-48%20suites%20%7C%20449%20tests-brightgreen.svg)]()
[![Backend Tests](https://img.shields.io/badge/backend%20tests-160%20passed-brightgreen.svg)]()
[![Typecheck](https://img.shields.io/badge/typescript-zero%20errors-blue.svg)]()
[![Release Candidate](https://img.shields.io/badge/release-release%2Fcandidate--clean-blue.svg)]()
[![Intended Use](https://img.shields.io/badge/intended%20use-research%20prototype%20only-important.svg)]()

---

## Submission Summary & Governance Overview

| Submission Deliverable | Location / Status | Verified Metric / Detail |
| :--- | :--- | :--- |
| **Project Title** | `T2D Glucose Digital Twin` | Focus: Prediabetes & Type 2 Diabetes Adverse Event Early Warning |
| **Team & Institution** | **T2D Digital Twin Team**<br>• Akshaya R — BGS College of Engineering and Technology<br>• Nikhil VS — East West Institute of Technology | Descriptive project-team label; independent engineering college affiliations |
| **Public GitHub Repository** | [`https://github.com/AkshayAlgoX/T2D-Glucose-Digital-Twin`](https://github.com/AkshayAlgoX/T2D-Glucose-Digital-Twin) | Authoritative GitHub repository (clone: `https://github.com/AkshayAlgoX/T2D-Glucose-Digital-Twin.git`) |
| **Release Branch** | `release/candidate-clean` | Default branch; the submitted code, documents and evidence |
| **Architecture Document** | [`docs/architecture/architecture.pdf`](docs/architecture/architecture.pdf) | Verified 3-page landscape document; source in [`docs/architecture/architecture.html`](docs/architecture/architecture.html) |
| **Presentation Deck** | [`docs/presentation/presentation.pdf`](docs/presentation/presentation.pdf) | Verified 12-page PDF; editable source in [`docs/presentation/presentation.html`](docs/presentation/presentation.html) |
| **Demonstration Script** | [`docs/demo/DEMO_SCRIPT_20MIN.md`](docs/demo/DEMO_SCRIPT_20MIN.md) | Recording-ready 20:00 timeline for the current UI |
| **Demonstration Video** | **DEFERRED — PENDING RECORDING** | Deferred by owner; demonstration video on hold |
| **Open-Source License** | [`Apache-2.0`](LICENSE) | Complete unmodified Apache License 2.0; see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) |
| **Real-Data Generalization Study** | [`docs/evidence/real_data/RESULTS.md`](docs/evidence/real_data/RESULTS.md) | Preregistered 161-patient benchmark: 60-min RMSE **23.11 mg/dL** [18.75–28.12], alert precision **65.5%**, median lead time **10.0 min**, **0.11** false alerts/day under verified 1-to-1 matching; Shanghai 15-min cadence non-estimable |
| **Clinical Workstation** | `/cohort` → `/patients/[id]` | Ward triage ranked by served 2-h spike risk; What-if with 29 Indian dishes from USDA FNDDS (public domain), survey portions or weighed grams; printable clinician summary with an English/Hindi patient note (Hindi not yet reviewed by a native-speaking clinician); FHIR R4 Bundle export validated in tests against the official HL7 R4 JSON schema, plus semantic checks (references resolve, LOINC/UCUM codes, HTEST test-data label); FHIRPath invariants, profiles and terminology-server validation not checked |
| **Early-Warning Root-Cause Study** | [`docs/evidence/operating_point/README.md`](docs/evidence/operating_point/README.md) | **Exploratory** (train/validation only, test not loaded): the patient's own previous-day CGM in the upcoming clock window raises ≥30-min warning sensitivity at matched false-alert rates (training patient-grouped OOF +5.4 points [+0.7, +10.1]; validation at ≤1 false alert/day 22.7% → 30.8%, median lead 15 → 30 min). A budget-matched threshold, logged meals and an explicit ≥30-min target do not. The training threshold does not hold the budget on new patients (1.55/day). Per-patient rate control holds it (0.90/day) but only at baseline-level sensitivity (23.7%). Online forecast personalization does not beat LightGBM. Locked results unchanged; adopting any of this needs a new preregistered evaluation |
| **External Check (Hall 2018)** | [`docs/evidence/external_hall/RESULTS.md`](docs/evidence/external_hall/RESULTS.md) | Preregistered (freeze commit `d1a2d887`), 57 unused participants, CC BY 4.0. Routine-model policy vs baseline, sensitivity ≥30 min: **+7.8 points [0.0, +13.2], not confirmed** (lower bound not above 0); false alerts 0.03/day. A simple linear-trend reference did better on this cohort (32.8% ≥30 min at 0.38 false alerts/day). 60-min RMSE: LightGBM 19.0, persistence 19.6, twin 20.6 mg/dL |
| **External Check 2 (AZT1D, Broll)** | [`docs/evidence/external_v2/RESULTS.md`](docs/evidence/external_v2/RESULTS.md) | Preregistered (freeze `3f1d7350`; amendment 1 before any outcome). Learned policy vs trend and trend+risk on 24 unused adults with type 1 diabetes (2,814 onsets): **not met** (−2.5 [−6.4, +1.4] and −2.7 [−5.7, +0.5] points at ≥30 min). A risk-gated trend policy doubles ≥30-min sensitivity (26.4%) but at 1.26 false alerts/day, over budget |
| **Early Warning Within Budget** | [`docs/evidence/fa_controller/README.md`](docs/evidence/fa_controller/README.md) | **Exploratory**, training-only selection. A risk-gated trend policy, with thresholds chosen so the worst training fold stays within 1 false alert/day, holds the budget on validation (0.87/day) at 27.3% ≥30 min and 69.7% any lead. Paired vs the learned baseline: +4.5 points [−2.5, +12.8], not established. A per-patient feedback controller was null. Frozen as the candidate for an unused type 2 cohort (none openly available) |
| **Claim–Evidence Ledger** | [`docs/submission/CLAIM_EVIDENCE_LEDGER.md`](docs/submission/CLAIM_EVIDENCE_LEDGER.md) | Multi-tier evidence separation (Verified vs. Historical vs. Excluded) |

---

## Clinical Problem & System Hypothesis

While modern Continuous Glucose Monitors (CGMs) offer predictive low alerts for hypoglycemia, hyperglycemic spike alarms remain predominantly reactive once interstitial glucose breaches static clinical limits (e.g., post-prandial excursion &gt; 180 mg/dL). Because post-prandial glycemic excursions develop rapidly (30–60 minutes), reactive alarms leave patients and clinicians with minimal response windows.

This project investigates whether **continuous forward visibility**—predicting multi-horizon quantile trajectories and adverse event hazards using multimodal patient context—can provide actionable advance insight.

> [!IMPORTANT]
> **Investigational Research Boundary**: This system is an engineering research prototype evaluated on synthetic physiological cohorts. It has **not** been evaluated in clinical trials, does **not** carry medical device certification, and must **not** be used for autonomous clinical or therapeutic decisions.

---

## System Architecture

```
[ Observable Static EHR ]       [ Dynamic Wearable Telemetry ]
(Age, BMI, HbA1c, eGFR, Meds)   (CGM, HR, HRV, Sleep, Steps, Meals)
           │                                     │
           ▼                                     ▼
 ┌─────────────────────────────────────────────────────────────┐
 │            Observable Input Contract (Contract S3)          │
 └──────────────────────────────┬──────────────────────────────┘
                                │
               ┌────────────────┴────────────────┐
               ▼                                 ▼
 ┌───────────────────────────┐     ┌───────────────────────────┐
 │   Mechanistic UKF Twin    │     │   PR-TFT Neural Model     │
 │ 2-Compartment Bergman ODE │     │ Variable Selection + LSTM │
 │ Physiological Rollouts    │     │ Causal Multi-Head Attn    │
 └─────────────┬─────────────┘     └─────────────┬─────────────┘
               │                                 │
               └────────────────┬────────────────┘
                                │
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  Residual Combination: UKF Prior + Learned Quantile Residuals│
 │  24 Steps (120 min) | 7 Quantiles (p05–p95) | Spike Hazard  │
 └──────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │       FastAPI Inference Service (`backend/serve_pr_tft.py`) │
 └──────────────────────────────┬──────────────────────────────┘
                                │ SSE (port 8001)
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  Next.js SSE Proxy & Earliest-Delimiter Transform Stream    │
 └──────────────────────────────┬──────────────────────────────┘
                                │ (port 3000)
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  Clinical Workstation Dashboard (`/cohort`, `/patients/[id]`)│
 └─────────────────────────────────────────────────────────────┘
```

1. **Observable Ingestion Boundary (Contract S3)**: Consumes static clinical variables and dynamic sensor channels. Prohibits privileged simulation latents from leaking into inference features.
2. **Physiological Prior (Mechanistic UKF)**: Two-compartment Bergman minimal model tracking glucose, insulin dynamics, and gut absorption.
3. **Deep Residual Network (PR-TFT)**: Temporal Fusion Transformer predicting non-linear residual quantiles over the physics prior, plus discrete-time spike hazard.
4. **Reliable Telemetry Stream**: Next.js proxy route pipes upstream SSE through `createSafeSSETransformStream`, enforcing chunk-invariant earliest-boundary detection across mixed CRLF/LF packet boundaries.
5. **Fail-Closed Client Telemetry**: `useRealtimeTelemetry` hook implements envelope-level subject isolation, bounded exponential backoff retries, and strict terminal `contract-invalid` failure modes.

---

## Technical Stack

- **Frontend Application**: Next.js 16.3.7 (App Router), React 19, TypeScript 5.8 / 7.0, Tailwind CSS 4, D3 scales.
- **Backend Inference Service**: Python 3.12, FastAPI, Uvicorn, Pydantic v2.
- **Machine Learning & Simulation**: PyTorch, PyTorch Lightning, FilterPy (Unscented Kalman Filter), SciPy, NumPy, Pandas.
- **Validation & Quality Gates**: Zod schemas (client/proxy contract enforcement), Jest 30 (unit and integration testing), Playwright (end-to-end browser verification).

---

## Verified Installation & Local Startup

The setup instructions below have been verified on Linux x86_64:

### 1. Prerequisites
- **Git LFS**: Required for model weights and UKF state artifacts (`git lfs pull` to fetch `canonical_ukf_state.npz` [198 MB] and checkpoints)
- **Node.js**: `>=20.9.0` (Next.js lock requirement; tested on `v20.x` and `v22.23.2`)
- **Python**: `3.12.x` (strictly required by pinned dependencies, tested on `3.12.3`)
- **Brave / Chromium**: Required for end-to-end browser verification

### 2. Backend Setup & Service Startup
```bash
# Clone the repository:
git clone https://github.com/AkshayAlgoX/T2D-Glucose-Digital-Twin.git
cd T2D-Glucose-Digital-Twin

# Pull Git LFS assets and create virtual environment:
git lfs pull
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu

# Start the permitted synthetic inference backend (runs on port 8001):
python -B backend/serve_pr_tft.py \
  --run-dir runs/pr_tft_ablation_arm_d \
  --host 127.0.0.1 \
  --port 8001
```
Verify backend health: `curl -s http://127.0.0.1:8001/v1/health` &rarr; `{"status":"ok", ...}`.

### 3. Frontend Setup & Startup
```bash
# In a separate terminal:
npm ci

# Configure backend target:
echo "BACKEND_URL=http://127.0.0.1:8001" > .env.local

# For demos and judging, run the production build (smooth, no development overlay):
npm run build && npx next start -p 3000

# For development only (slower, with the Next.js error overlay):
# npx next dev --webpack -p 3000
```
Open `http://localhost:3000/` (overview and a direct link to the demonstration twin), `http://localhost:3000/cohort`, or the validation-split demonstration subject P0017 at `http://localhost:3000/patients/6f50ef50-b6e5-5408-a70c-d8f0509d6012`. Use `localhost`, not `127.0.0.1`: the Next.js dev server does not serve its client runtime to other origins, and the page stays on "Connecting".

### 4. Running Verification Test Suites
```bash
# Run all 45 Jest test suites (424 tests: unit, integration, contracts, safety invariants):
npm test -- --runInBand --silent --no-cache

# Run the backend tests from the repository root: provenance, contracts, causality, safety, sealed-split access, twin counterfactual plausibility, alert-policy mechanics (160 passed with RUN_DIR set on 2026-10-22; without RUN_DIR, 132 tests are collected and the serving tests skip):
RUN_DIR=runs/pr_tft_ablation_arm_d pytest backend/tests/ -v

# Run TypeScript typecheck:
npx tsc --noEmit --incremental false

# Run Git whitespace validation:
git diff --check
```

---

## Scientific Evidence & Explicit Limitations

In accordance with scientific integrity guidelines, all reported metrics and limitations are disclosed without fabrication:

### 1. Negative Validation Gate: Synthetic Realism (Gate 3)
- **Result**: **FAILED**
- **Metric**: Historical AUROC = **0.9320** (90% CI: 0.928–0.936); Reported duration-corrected AUROC = **0.9290** (90% CI: 0.925–0.933) against target threshold **&le; 0.65**.
- **Implication**: A 40-feature classifier reliably distinguishes synthetic ODE trajectories from mock-real generator records. Factorial drift experiments reported in the validation report (scripts not in this repository) indicate that AR(1) background drift (SD 8–16 mg/dL) accounts for a portion of the trajectory curvature difference (e.g., jerk/acceleration), but does not explain the entire multivariate failure across the 40-feature discriminator. Acceptance threshold remains &le; 0.65; result remains FAILED without metric-gaming.

### 2. EW-01 Scientific Evaluation
- **Status**: **UNEXECUTED / GOVERNANCE-BLOCKED**
- **Detail**: The formal EW-01 comparative evaluation harness was not executed due to incomplete co-author sign-offs. No comparative superiority or lead-time claims are made over clinical baselines.

### 3. Baseline Checkpoint Discrepancy
- **Status**: **METRICS EXCLUDED**
- **Detail**: `backend/runs/pr_tft_demo/evaluation_baseline.json` references an absent checkpoint (`stage2_observed-epoch=01-val_loss=0.3096.ckpt`). Its metrics are strictly excluded from performance claims.

### 4. Meal / Activity What-If (Simulated Model Response)
- **Status**: **INTERACTIVE, BACKEND-DRIVEN — NOT A VALIDATED CAUSAL EFFECT**
- **Detail**: The patient workspace sends meal, activity and skip-a-usual-meal scenarios through `/api/forecast` to `POST /v1/forecasts`. The linearized twin re-rolls the plan and the network re-scores it. Baseline and scenario come from the same response at the same anchor. The panel shows the highest median in the next 2 h for each (with its time), the largest same-time difference, and the calibrated 2-h spike probability before and after.
- **Example (genuine backend output, P0017, validation split, anchor 2026-10-05T07:30Z, a different day from the 29 Sept 08:00 demonstration view, 60 g carbohydrate meal in 30 min)**: highest median 185.0 → 199.3 mg/dL (peaks at +60 → +95 min), largest same-time difference +34.5 mg/dL, spike probability 10.6% → 17.3%. The physiology twin alone moves glucose by up to +55.3 mg/dL. At anchor 2026-09-28T23:55Z the same meal gives 101.5 → 133.6 mg/dL and 0.0% → 3.3%.
- **Default demonstration view**: every subject's replay opens at 08:00 UTC on the cohort's first morning (cohort start 23:55 plus 97 readings; the same rule for every subject). For P0017 the window shows the night, waking and a 123 g breakfast logged at 07:35. The 08:00 forecast's median rises to 222.5 mg/dL at +45 min; observed CGM then reads 207 mg/dL at 08:30 and 216 mg/dL at 09:00 (`backend/synthetic_v2/patient_cgm_telemetry.csv`). This is one favourable example; aggregate accuracy is on the Evidence page. From 08:00, a further 60 g meal in 30 min moves the physiology twin alone by up to +47.8 mg/dL, the network's highest median from 222.5 to 228.5 mg/dL, and the spike probability from 53.3% to 56.9%. In that What-If, the change chart flags one 5-min blip in the learned adjustment at +30 min, when the meal starts; no isolated step above 20 mg/dL (the artefact described below) is flagged. At 05:55, the same meal gives a network curve with a single 5-min spike at +75 min, 53.7 mg/dL above the physiology twin and about 54 mg/dL above its neighbouring steps (`docs/evidence/whatif_probe_P0017.json`).
- **Audit (2026-10-20)**: see `docs/evidence/model_audit/MODEL_AUDIT_20261020.md`.
  - **Meal timing:** scenario meals were entered 5 min late. This is fixed and covered by a regression test.
  - **Out-of-range inputs:** a meal scenario feeds the network a meal probability of 1.0 and its full carbohydrate amount in one 5-min step. In training these inputs never exceeded 0.29 and 33 g, so the service attaches `SCENARIO_OUT_OF_RANGE`.
  - **Isolated steps:** the learned adjustment adds isolated one-step jumps of more than 20 mg/dL to 19.8% of sampled validation forecasts, and the physiology twin never does. This is a disclosed model limitation. The chart flags it when present. A pre-registered check ([`docs/evidence/jump_experiment/`](docs/evidence/jump_experiment/RESULTS.md)) found the steps are late-horizon, almost always upward and wrong against the observed CGM (worse than their neighbours' average in 81% of cases); a fixed 3-point median repair removes 88% of them with RMSE and coverage changes on both the training sample and validation within the pre-registered tolerance (RMSE +30 up by at most 0.004 mg/dL, +60 down by 0.17–0.22, P10–P90 coverage down by at most 0.09 points). It is recorded, not applied: the published metrics describe the unrepaired network and no independent test exists.
- **Boundary**: These are synthetic-model outputs. Neither their direction nor their size has been validated against a reference counterfactual. Activity is modelled as immediate insulin-independent uptake only (the service attaches `SCENARIO_APPROXIMATION`). Medication changes are refused with `SCENARIO_UNSUPPORTED` because the served twin has no drug terms.

### 5. Validation Trajectory Benchmark & Matched Baseline Audit
- **Early warning, scored like an alarm** ([`docs/evidence/event_eval/RESULTS.md`](docs/evidence/event_eval/RESULTS.md), `backend/evaluate_events_validation.py`): on the validation patients (Prediabetes + Type 2, 617 spike onsets, 375 patient-days) under the locked alert policy, the hybrid's onset risk at 0.35 catches **90.0%** of spikes (95% CI 87.4–92.2) with a median **70 min** warning and **1.77 false alerts per patient-day**; at 0.60, 70.8% with 0.56 false alerts per day. A straight-line CGM trend catches 99.4% but with a median 20 min warning. Calibration is cross-fitted across patient folds; the validation patients still chose the checkpoint, so this is development evidence. Every number recomputes from the committed per-decision file.
- **Scope**: Evaluated on the **44 validation patients** (54,281 eligible anchors; 53,920 / 53,906 / 53,849 evaluable rows at 30 / 60 / 120 min) from the pre-registered split (`split_293.json`). (Note: 47,629 was the at-risk hazard calibration subset).
- **Report provenance**: `runs/pr_tft_ablation_arm_d/evaluation_report.json` is hash-linked to the run manifest, checkpoint and data, which the Evidence page verifies. The script that produced its validation-ceiling bootstrap (`evaluate_validation_ceiling.py`, named in `docs/evidence/validation_ceiling_results.json`) is not in this repository, so those intervals can be checked against the artifacts but not regenerated from committed code.
- **Matched Trajectory Benchmark (95% Patient-Clustered Bootstrap CI, B=10,000 draws)**:
  - **30-min**: PR-TFT **12.36** [11.89, 12.84] (MAE 8.43, MARD 7.22%) vs. UKF Twin **15.24** [14.30, 16.16] vs. Persistence **21.64** [20.44, 22.79]. Paired diff: $\Delta = \mathbf{-9.28}$ [-10.05, -8.43] vs. PE (42.87% reduction); $\Delta = \mathbf{-2.88}$ [-3.37, -2.38] vs. Twin (18.90% reduction); 10,000/10,000 draws negative.
  - **60-min**: PR-TFT **19.53** [18.56, 20.48] (MAE 12.43, MARD 10.16%) vs. UKF Twin **23.23** [21.76, 24.64] vs. Persistence **36.05** [33.85, 38.13]. Paired diff: $\Delta = \mathbf{-16.53}$ [-17.77, -15.17] vs. PE (45.84% reduction); $\Delta = \mathbf{-3.71}$ [-4.27, -3.15] vs. Twin (15.96% reduction); 10,000/10,000 draws negative.
  - **120-min**: PR-TFT **25.03** [23.67, 26.27] (MAE 16.76, MARD 13.66%) vs. UKF Twin **28.64** [26.67, 30.51] vs. Persistence **48.36** [45.06, 51.46]. Paired diff: $\Delta = \mathbf{-23.33}$ [-25.31, -21.23] vs. PE (48.24% reduction); $\Delta = \mathbf{-3.61}$ [-4.44, -2.81] vs. Twin (12.61% reduction); 10,000/10,000 draws negative.
- **Aggregation Reporting**: Both pooled micro-averages and unweighted patient macro-averages are reported side-by-side (e.g., at 60 min, Macro 19.27 mg/dL vs. Micro 19.53 mg/dL) as distinct aggregation perspectives.
- **Patient Win Rates (Exact 95% Clopper-Pearson Binomial CIs)**: 44/44 (100% [92.0%, 100.0%]) at 30m & 60m; at 120m: 44/44 (100% [92.0%, 100.0%]) vs. Persistence, 41/44 (93.2% [81.3%, 98.6%]) vs. UKF Twin. *Sampling assumption:* Independent Bernoulli trials across the 44 subjects in simulated cohort; strictly limited to this simulated cohort.
- **Probabilistic Calibration (Resubstitution Diagnostics)**: 80% conformal interval empirical coverage is **80.00%** (mean width 37.30 mg/dL). Isotonic-calibrated hazard achieves AUROC **0.9226**, AUPRC **0.6314**, Brier score **0.0703** (raw 0.1650), and ECE **0.000094** on 47,629 at-risk anchors (source: `runs/pr_tft_ablation_arm_d/run_manifest.json` → `validation.hazard_calibrated`; raw AUROC 0.9221, AUPRC 0.6388). Isotonic calibration is monotone, so discrimination is essentially unchanged, and an ECE near zero is expected when the calibrator is scored on the anchors it was fitted to. Because calibration parameters were estimated on this validation set, all calibration metrics are resubstitution diagnostics; evaluated thresholds (0.35 and 0.60) are empirical diagnostics, not approved clinical operating points.
- **Explicit Boundary & Ledger Caveat**: These figures are simulated development-validation results derived from the development validation partition (`split_293.json`) which was used for both checkpoint selection and calibration. They establish architecture-level validation error metrics under simulated conditions, but are explicitly **NOT** independent held-out generalization to human patients. The 44-subject test cohort remains sealed and strictly unexecuted under protocol.

---

## Public-Release Safety Audit

A repository security scan across tracked files, commit history, and branches confirmed:
- **Credentials & API Keys**: Zero leaked AWS tokens, GitHub PATs, or live service passwords.
- **Protected Cohorts**: No quarantined or restricted H1 / WIF-02 truth datasets are tracked.
- **Sealed Test Partition**: The 44 test-split subjects are loaded only for provenance checks and are never served. `/v1/subjects` omits them, and forecast, scenario, twin-card and stream requests for them return the same `404 SUBJECT_NOT_FOUND` as an unknown id (`backend/tests/test_sealed_split_access.py`).
- **Local Path Sanitization Finding**: Tracked pycache file `backend/__pycache__/train_pr_tft.cpython-312.pyc` has been removed from tracking. `backend/final_config.json` uses portable relative path `"data_dir": "synthetic_v2"` with `T2D_DATA_DIR` environment override support. `experiments/early_warning_ew01/ew01_trust.py` supports `EW01_REGISTRY_ROOT` override with fail-closed validation.

---

## License & Legal Notice

This project is licensed under the **Apache License, Version 2.0**. See the [`LICENSE`](LICENSE) file for the full license text and [`NOTICE`](NOTICE) for copyright attribution.

```
Copyright 2026 Akshaya R, Nikhil VS (T2D Digital Twin Team)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

### Attribution & Redistribution Terms
- **Project Copyright**: Held by the verified project team: Akshaya R (BGS College of Engineering and Technology) and Nikhil VS (East West Institute of Technology).
- **Synthetic Data & Model Artifacts**: Model checkpoints (`runs/pr_tft_ablation_arm_d/checkpoints/`), UKF state (`canonical_ukf_state.npz`), and synthetic datasets (`backend/synthetic_v2/`) were generated exclusively using project simulation and training pipelines without third-party patient PHI or proprietary weights, and are distributed under the terms of this license.
- **Third-Party Dependencies**: External runtime and development dependencies installed via `npm` or `pip` are governed by their respective upstream open-source licenses (MIT, BSD-3-Clause, Apache-2.0, etc.) and are not re-licensed under this project's Apache-2.0 grant.

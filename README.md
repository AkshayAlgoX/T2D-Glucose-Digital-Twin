# T2D Glucose Digital Twin — Clinical Workstation & Replay Engine

**A research prototype combining observable patient context, wearable history, and mechanistic physiological modeling to forecast glucose trajectories and estimate adverse spike risk.**

[![Frontend Tests](https://img.shields.io/badge/frontend%20tests-36%20passed%20%7C%20307%20tests-brightgreen.svg)]()
[![Backend Tests](https://img.shields.io/badge/backend%20tests-107%20passed-brightgreen.svg)]()
[![Typecheck](https://img.shields.io/badge/typescript-zero%20errors-blue.svg)]()
[![Release Candidate](https://img.shields.io/badge/candidate-release%2Fcandidate--20261017-blue.svg)]()
[![Intended Use](https://img.shields.io/badge/intended%20use-research%20prototype%20only-important.svg)]()

---

## Submission Summary & Governance Overview

| Submission Deliverable | Location / Status | Verified Metric / Detail |
| :--- | :--- | :--- |
| **Project Title** | `T2D Glucose Digital Twin` | Focus: Prediabetes & Type 2 Diabetes Adverse Event Early Warning |
| **Team & Institution** | **T2D Digital Twin Team**<br>• Akshaya R — BGS College of Engineering and Technology<br>• Nikhil VS — East West Institute of Technology | Descriptive project-team label; independent engineering college affiliations |
| **Release Candidate** | `release/candidate-20261017` | Verified release candidate branch based on commit `67431af9` |
| **Architecture Document** | [`docs/architecture/architecture.pdf`](docs/architecture/architecture.pdf) | Verified 2-page landscape document; source in [`docs/architecture/architecture.mmd`](docs/architecture/architecture.mmd) |
| **Presentation Deck** | [`docs/presentation/presentation.pdf`](docs/presentation/presentation.pdf) | Verified 12-page PDF; editable source in [`docs/presentation/presentation.html`](docs/presentation/presentation.html) |
| **Demonstration Script** | [`docs/demo/DEMO_SCRIPT_20MIN.md`](docs/demo/DEMO_SCRIPT_20MIN.md) | Verified 20:00 exact timeline (segment 16:00–18:30 is exactly 2:30) |
| **Demonstration Video** | **DEFERRED — PENDING RECORDING** | Deferred by owner; demonstration video on hold |
| **Open-Source License** | [`Apache-2.0`](LICENSE) | Complete unmodified Apache License 2.0; see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) |
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
# From repository root:
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

# Launch Next.js dev server with Webpack bundler (port 3000):
npx next dev --webpack -p 3000
```
Open `http://localhost:3000/cohort` or `http://localhost:3000/patients/19dba1b5-d8b3-5634-a184-aeb831ea6d36` in your browser.

### 4. Running Verification Test Suites
```bash
# Run all 36 Jest test suites (307 tests: unit, integration, contracts, safety invariants):
npm test -- --runInBand --silent --no-cache

# Run all 107 backend tests (provenance, contracts, causality, safety):
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
- **Metric**: Discriminator AUROC = **0.9320** (90% CI: 0.928–0.936) against target threshold **&le; 0.65**.
- **Implication**: A classifier can reliably distinguish synthetic patient series from mock-real records (top tell: `jerk_sd`). Purely simulation-based evaluations carry risks of circularity.

### 2. EW-01 Scientific Evaluation
- **Status**: **UNEXECUTED / GOVERNANCE-BLOCKED**
- **Detail**: The formal EW-01 comparative evaluation harness was not executed due to incomplete co-author sign-offs. No comparative superiority or lead-time claims are made over clinical baselines.

### 3. Baseline Checkpoint Discrepancy
- **Status**: **METRICS EXCLUDED**
- **Detail**: `backend/runs/pr_tft_demo/evaluation_baseline.json` references an absent checkpoint (`stage2_observed-epoch=01-val_loss=0.3096.ckpt`). Its metrics are strictly excluded from performance claims.

### 4. Disabled Scenario UI
- **Status**: **API-ONLY PROTOTYPE**
- **Detail**: While backend routes support meal/activity simulation, `ScenarioEditor.tsx` in the dashboard is explicitly disabled. Pharmacological scenarios are rejected (`SCENARIO_UNSUPPORTED`). Scenario outputs do not represent human causal treatment effects.

---

## Public-Release Safety Audit

A repository security scan across tracked files, commit history, and branches confirmed:
- **Credentials & API Keys**: Zero leaked AWS tokens, GitHub PATs, or live service passwords.
- **Protected Cohorts**: No quarantined or restricted H1 / WIF-02 truth datasets are tracked.
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

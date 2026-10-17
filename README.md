# T2D Glucose Digital Twin — Clinical Workstation & Replay Engine

**A research prototype combining observable patient context, wearable history, and mechanistic physiological modeling to forecast glucose trajectories and estimate adverse spike risk.**

[![Build Status](https://img.shields.io/badge/tests-35%20passed%20%7C%20292%20tests-brightgreen.svg)]()
[![Typecheck](https://img.shields.io/badge/typescript-zero%20errors-blue.svg)]()
[![Code Freeze](https://img.shields.io/badge/status-code%20frozen%20%40%2068f8cce8-success.svg)]()
[![Intended Use](https://img.shields.io/badge/intended%20use-research%20prototype%20only-important.svg)]()

---

## Submission Summary & Governance Overview

| Submission Deliverable | Location / Status | Verified Metric / Detail |
| :--- | :--- | :--- |
| **Project Title** | `T2D Glucose Digital Twin` | Focus: Prediabetes & Type 2 Diabetes Adverse Event Early Warning |
| **Team & Institution** | `[OWNER DECISION REQUIRED]` | Placeholder awaiting verified participant names and college/institution |
| **Release Commit** | `68f8cce84dee8a584982a8bb23113ed22bb3d01c` | Merge commit of PR #3 on `handoff/frontend-polish-20261015` |
| **Architecture Document** | [`docs/architecture/architecture.pdf`](docs/architecture/architecture.pdf) | Verified 2-page landscape document; source in [`docs/architecture/architecture.mmd`](docs/architecture/architecture.mmd) |
| **Presentation Deck** | [`docs/presentation/presentation.pdf`](docs/presentation/presentation.pdf) | Verified 12-page PDF; editable source in [`docs/presentation/presentation.html`](docs/presentation/presentation.html) |
| **Demonstration Script** | [`docs/demo/DEMO_SCRIPT_20MIN.md`](docs/demo/DEMO_SCRIPT_20MIN.md) | Verified 20:00 exact timeline (segment 16:00–18:30 is exactly 2:30) |
| **Demonstration Video** | **BLOCKED — MISSING ASSET** | Requires real recorded 20-minute video (.mp4) at public/unlisted URL |
| **Open-Source License** | **OWNER DECISION REQUIRED** | No root `LICENSE` file; `package.json` declares `ISC`; Apache 2.0 / MIT recommended |
| **Claim–Evidence Ledger** | [`docs/submission/CLAIM_EVIDENCE_LEDGER.md`](docs/submission/CLAIM_EVIDENCE_LEDGER.md) | Multi-tier evidence separation (Verified vs. Historical vs. Excluded) |

---

## Clinical Problem & System Hypothesis

Continuous Glucose Monitors (CGMs) currently trigger alarms reactively once interstitial glucose breaches static clinical limits (e.g., hyperglycemic spike &gt; 180 mg/dL). Because post-prandial glycemic excursions develop rapidly (30–60 minutes), reactive alarms leave patients and clinicians with minimal response windows.

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
- **Node.js**: `v20.x` or `v22.x` (tested on `v22.23.2`)
- **Python**: `3.10`, `3.11`, or `3.12` (tested on `3.12.3`)
- **Brave / Chromium**: Required for end-to-end browser verification

### 2. Backend Setup & Service Startup
```bash
# From repository root:
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

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
npm install

# Configure backend target:
echo "BACKEND_URL=http://127.0.0.1:8001" > .env.local

# Launch Next.js dev server with Webpack bundler (port 3000):
npx next dev --webpack -p 3000
```
Open `http://localhost:3000/cohort` or `http://localhost:3000/patients/19dba1b5-d8b3-5634-a184-aeb831ea6d36` in your browser.

### 4. Running Verification Test Suites
```bash
# Run all 35 Jest test suites (unit, integration, contracts, safety invariants):
npm test -- --runInBand --silent --no-cache

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
- **Local Path Sanitization Finding**: Historical logs (`experiments/early_warning_ew01/*.log`) and `backend/final_config.json` contain local paths (`/home/akshaya/...`). Tracked pycache file `backend/__pycache__/train_pr_tft.cpython-312.pyc` contains local paths and should be pruned before public distribution.

---

## License & Legal Notice

- **Current Repository State**: Private repository, no root `LICENSE` file.
- **Owner Decision Required**: The repository owner must confirm the intended open-source license (e.g., Apache 2.0 or MIT) before toggling the repository public.

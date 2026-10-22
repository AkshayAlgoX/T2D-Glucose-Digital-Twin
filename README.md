<div align="center">

# Glucose Twin

### A physiology-informed digital twin that forecasts type 2 diabetes glucose spikes,<br>and states exactly what its evidence does and does not prove.

[![Frontend tests](https://img.shields.io/badge/frontend%20tests-48%20suites%20%7C%20450%20passed-0f6e74)](#tests-and-verification)
[![Backend tests](https://img.shields.io/badge/backend%20tests-162%20passed-0f6e74)](#tests-and-verification)
[![License](https://img.shields.io/badge/license-Apache--2.0-1f3a5f)](LICENSE)
[![Intended use](https://img.shields.io/badge/intended%20use-research%20only-8f5e0b)](#limitations-and-intended-use)

[What it does](#what-it-does) · [Architecture](#architecture) · [Evidence](#evidence) · [Quick start](#quick-start) · [Datasets](#datasets-and-licences) · [Limitations](#limitations-and-intended-use)

<img src="docs/assets/readme/screens/patient-forecast.png" alt="Patient workspace: observed CGM, the physiology twin, the learned adjustment and the 2-hour forecast with bands and spike-onset risk" width="100%">

<sub>The patient workspace, captured from the production build on this branch with a synthetic validation subject. Dots: observed CGM. Dashed: physiology twin. Hatched: learned adjustment. Bands: forecast quantiles.</sub>

</div>

> [!IMPORTANT]
> **Research prototype. Not for clinical decisions.** The application replays a synthetic cohort. It has no medical-device status and no clinical validation. Every metric below names its data, its denominator and its evidence tier.

## In 30 seconds

- **The problem.** After-meal glucose spikes above 180 mg/dL drive long-term harm in type 2 diabetes, and CGM alarms usually fire only once the spike has started.
- **What we built.** A clinical workstation around a hybrid twin. A physiological model (UKF-tracked) gives the baseline; a learned residual and a calibrated hazard head give a 2-hour forecast and a spike-onset risk. Around it: ward triage, What-if meal and activity scenarios, a printable clinician summary and a FHIR R4 export.
- **What we proved, and what we did not.** On a locked, preregistered real-patient evaluation, the hybrid forecasts better than persistence at 60 minutes. It warns of only **6% of spikes ≥30 min ahead**. Two later preregistered checks on unused cohorts did **not** confirm an early-warning improvement over simple trend rules. A new candidate policy is exploratory, and its confirmation protocol is frozen but not yet run.

| Evidence tier | Status | Where |
|---|---|---|
| Locked real-patient evaluation | ✅ run once, immutable | [`docs/evidence/real_data/RESULTS.md`](docs/evidence/real_data/RESULTS.md) |
| External check 1: Hall 2018 | ❌ not confirmed | [`docs/evidence/external_hall/RESULTS.md`](docs/evidence/external_hall/RESULTS.md) |
| External check 2: AZT1D + Broll | ❌ not met | [`docs/evidence/external_v2/RESULTS.md`](docs/evidence/external_v2/RESULTS.md) |
| Candidate C2 (risk-gated trend) | 🧪 exploratory, CI includes 0 | [`docs/evidence/fa_controller/README.md`](docs/evidence/fa_controller/README.md) |
| AI-READI confirmation | ⏳ protocol frozen, awaiting data access | [`docs/evidence/aireadi_confirmation/PREREGISTRATION.md`](docs/evidence/aireadi_confirmation/PREREGISTRATION.md) |

## What it does

| | |
|---|---|
| <img src="docs/assets/readme/screens/ward-triage.png" alt="Ward triage table ranking validation patients by 2-hour spike risk" width="420"> | **Ward triage.** Ranks every validation patient by the backend's calibrated 2-hour spike-onset risk at the replay hold. Shows current glucose, alert tier, and when and how high the forecast median crosses 180 mg/dL. Patients the service declines to forecast are listed by name, never silently ranked. |
| <img src="docs/assets/readme/screens/whatif-result.png" alt="What-if comparison of baseline and scenario forecasts with twin and learned-adjustment contributions" width="420"> | **What-if, on the same time axis.** Add a meal, activity, or a skipped usual meal. The backend re-runs the twin and the network from the forecast moment. The result separates the twin's response from the learned adjustment and flags inputs outside the training range. Medication changes are refused rather than guessed. |
| <img src="docs/assets/readme/screens/whatif-meal-builder.png" alt="Indian meal plate builder with USDA FNDDS dishes and carbohydrate totals" width="420"> | **Indian meals with provenance.** Build a plate from 29 dishes of Indian origin in USDA FNDDS (public domain), by survey portion or weighed grams. Every dish keeps its FDC id. Only carbohydrate grams reach the model, and the interface says so. |
| <img src="docs/assets/readme/screens/clinician-summary.png" alt="Printable one-page clinician summary" width="420"> | **Clinician summary and FHIR R4.** A one-page printable summary covers measured versus forecast glucose, risk, data quality and the last scenario. It includes a patient note in English or Hindi; the Hindi is marked as not yet reviewed by a native-speaking clinician. The FHIR R4 Bundle export validates against the official HL7 R4 JSON schema in tests, with semantic checks on references, LOINC and UCUM codes, and a test-data label. |
| <img src="docs/assets/readme/screens/evidence-claim-tiers.png" alt="Evidence page tiers: proven, exploratory, independently confirmed (none yet)" width="420"> | **Evidence inside the product.** The Evidence page separates proven capabilities, exploratory candidates and independently confirmed results (currently none). It shows the failed external checks with their numbers. A test keeps every figure in sync with the committed result files. |

## Architecture

The product and the real-patient research pipeline are separate systems. The **workstation** serves a synthetic cohort through the hybrid twin. The **research pipeline** produced the locked real-patient evaluation and the external checks; it is not served.

```mermaid
flowchart LR
  subgraph Served["Clinical workstation (synthetic cohort replay)"]
    direction LR
    EHR["Synthetic EHR context<br/>age · BMI · HbA1c · medications"] --> Contract
    CGM["CGM + wearables<br/>5-min replay stream"] --> Contract
    Contract["Observable-input contract<br/>causal, no future data"] --> UKF["Physiology twin<br/>UKF state + 2-h rollout"]
    Contract --> TFT["PR-TFT network<br/>residual quantiles + hazard"]
    UKF --> TFT
    TFT --> Cal["Calibration<br/>conformal bands · isotonic risk"]
    Cal --> Policy["Data quality + alert policy"]
    Policy --> API["FastAPI /v1<br/>forecasts · scenarios · SSE"]
    API --> BFF["Next.js BFF<br/>Zod contract checks"]
    BFF --> UI["Ward · Workspace · What-if<br/>Clinician summary · FHIR · Evidence"]
  end
  subgraph Research["Real-patient research pipeline (offline)"]
    direction LR
    Real["CGMacros · BIG IDEAs · ShanghaiT2DM"] --> Split["Patient-level split<br/>SHA-256, 60/20/20"]
    Split --> Feat["Causal 5-min decisions<br/>meals masked to zero"]
    Feat --> Models["Reduced UKF twin prior +<br/>LightGBM / neural residual"]
    Models --> Locked["Locked test run<br/>RESULTS.md"]
  end
```

<details>
<summary><b>Prediction and early-warning pipeline</b></summary>

```mermaid
flowchart TB
  A["Last 24 h of CGM<br/>coverage ≥ 70%"] --> B["Causal features<br/>lags · slopes · variability · time of day"]
  A --> R["Daily routine<br/>same clock window, 1–3 days earlier"]
  B --> F["Forecast<br/>twin prior + learned residual<br/>30 / 60 / 120 min"]
  B --> H["Spike-onset hazard<br/>calibrated on patient-grouped OOF"]
  R --> H
  A --> T["30-min trend projection"]
  H --> P{"Alert policy"}
  T --> P
  P --> O["Alert<br/>120-min cooldown · at-risk only<br/>1-to-1 matching to onsets"]
  O --> M["Scored: sensitivity ≥30 min · any lead ·<br/>false alerts per patient-day · lead time"]
```

**Research pipeline:** a spike onset is the start of a run of at least 15 min at or above 180 mg/dL. **Served application:** it also requires a rise of at least 50 mg/dL within the previous 60 min. In both, warnings count only 5–120 min before an onset, alerts are raised only while glucose is below 180 mg/dL, and each alert can claim at most one onset.
</details>

<details>
<summary><b>Evaluation design: isolation, selection, freezing</b></summary>

```mermaid
flowchart LR
  D["Development patients<br/>train / validation"] --> O["Patient-grouped 5-fold<br/>OOF predictions"]
  O --> S["Calibration, thresholds,<br/>policy selection"]
  S --> Z["Freeze: protocol + code<br/>committed to git"]
  Z --> L["Locked V1 test<br/>(11 held-out patients, 5-min)"]
  Z --> E1["Hall 2018<br/>(freeze d1a2d887)"]
  Z --> E2["AZT1D + Broll<br/>(freeze 3f1d7350)"]
  Z --> E3["AI-READI<br/>(frozen, not run)"]
  L --> X["Results published,<br/>including failures"]
  E1 --> X
  E2 --> X
```

Test records are loaded only by the single authorized run. External cohorts are read once, after the freeze commit. A later amendment is allowed only for a loading error and must be committed before any outcome exists (one occurred, in AZT1D, and is documented).
</details>

## Evidence

### Locked real-patient evaluation

Preregistered ([`PREREGISTRATION.md`](docs/evidence/real_data/PREREGISTRATION.md), [`AMENDMENT_001.md`](docs/evidence/real_data/AMENDMENT_001.md)) and run once. It is **immutable**: none of the exploratory work below changes it. The cohort has 161 nominal participants across three datasets. The 5-min headline metrics come from **11 held-out test patients**. The 20 ShanghaiT2DM test patients are not estimable at 15-min cadence.

<img src="docs/assets/readme/charts/locked_rmse60.svg" alt="Locked evaluation 60-minute RMSE: hybrid 23.11 mg/dL with 95% CI 18.75 to 28.12, reduced twin 24.73, persistence 26.27, linear trend 49.06" width="100%">

| Metric (held-out test) | Value | 95% CI |
|---|---|---|
| RMSE at 30 / 60 / 120 min | 16.77 / **23.11** / 26.44 mg/dL | 60 min: 18.75–28.12 |
| Spike onsets warned ≥30 min ahead | **6.0%** | 0.0–13.9 |
| Alert precision | 65.5% | — |
| False alerts per patient-day | 0.11 | 0.02–0.23 |
| Median warning lead time | 10 min | 5–15 |
| Leave-one-dataset-out RMSE at 60 min | CGMacros 23.97 · BIG IDEAs 22.14 mg/dL | — |

<details>
<summary>Consistency note on the locked record</summary>

The locked files differ slightly in places:
- `results.json` records RMSE₆₀ 23.11 [18.75–28.12], sensitivity ≥30 min 6.9% and baselines 26.27 / 24.73 / 49.06 mg/dL.
- The headline table in `RESULTS.md` prints 23.04 [18.7–28.1], 6.0% and 26.15 / 24.66 / 48.96 mg/dL. Its horizon list gives 23.11.

The files are locked, so we report both rather than edit either. The chart above is generated from `results.json`.
</details>

### External checks (preregistered, on cohorts unused in development)

<img src="docs/assets/readme/charts/external_hall_sens30.svg" alt="Hall 2018: routine model 7.8 percent, learned baseline 0 percent, linear-trend reference 32.8 percent of spike onsets warned at least 30 minutes ahead" width="100%">

**Hall 2018: not confirmed.** The routine model beat the learned baseline by +7.8 points [0.0, +13.2], but the preregistered rule needed the lower bound above zero. A simple linear-trend reference did better than both learned policies on this mostly normoglycaemic cohort.

<img src="docs/assets/readme/charts/external_azt1d_sens30.svg" alt="AZT1D: learned baseline 12.5 percent, trend 15.0, trend or risk 15.2, routine 21.0 over budget, risk-gated trend 26.4 over budget" width="100%">

**AZT1D (type 1 diabetes, closed-loop insulin): not met.** The learned policy scored −2.5 points [−6.4, +1.4] against the trend rule and −2.7 [−5.7, +0.5] against trend-or-risk. Broll (5 adults with type 2 diabetes) is descriptive only: persistence had the lowest RMSE at every horizon.

### Exploratory candidate and pending confirmation

<img src="docs/assets/readme/charts/candidate_c2_validation.svg" alt="Candidate C2 on validation: 27.3 percent at 0.87 false alerts per day versus 22.7 percent at 0.98 for the learned baseline; paired difference +4.5 points, CI -2.5 to +12.8" width="100%">

- **Candidate C2** is a risk-gated trend policy, with thresholds chosen on training data so that the *worst* patient fold stays within 1 false alert/day. It is the first policy here to stay within budget on new patients. The gain is not established: +4.5 points, with a CI from −2.5 to +12.8, on 12 validation patients used in earlier work.
- **AI-READI confirmation** covers type 2 participants in AI-READI's test split and is frozen in [`aireadi_evaluate.py`](docs/evidence/aireadi_confirmation/aireadi_evaluate.py), tested on a synthetic release. **It has not been run**: data access is not yet approved.

<details>
<summary><b>Every exploratory experiment, including the null results</b></summary>

All of these use training and validation patients only. None touches the locked test partition.

| Question | Result | Report |
|---|---|---|
| Does a budget-matched threshold help? | Small gain inside the CI | [`operating_point/README.md` §1](docs/evidence/operating_point/README.md) |
| Do logged meals help? | Precision and lead up; ≥30-min sensitivity inside the CI | §2 |
| An explicit ≥30-min target? | Rejected (worse) | §3 |
| The patient's daily routine? | Ranking improves: training OOF +5.4 points [+0.7, +10.1] | §3 |
| Does the routine threshold transfer? | No (1.55 false alerts/day); per-patient rate control holds the budget but loses the gain | §4 |
| Online per-patient forecast personalization? | Does not beat LightGBM | §5 |
| False-alert feedback controller? | Null (1.09/day) | [`fa_controller/README.md`](docs/evidence/fa_controller/README.md) |
</details>

Every claim, with its artifact and promotion rule, is in the [claim–evidence ledger](docs/submission/CLAIM_EVIDENCE_LEDGER.md).

## Quick start

**Requirements:** Node.js ≥ 20.9, Python 3.12, Git LFS (model weights and twin state).

```bash
git clone https://github.com/AkshayAlgoX/T2D-Glucose-Digital-Twin.git
cd T2D-Glucose-Digital-Twin && git lfs pull

# Backend: synthetic-cohort inference service
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
python -B backend/serve_pr_tft.py --run-dir runs/pr_tft_ablation_arm_d --host 127.0.0.1 --port 8001

# Frontend (second terminal)
npm ci
echo "BACKEND_URL=http://127.0.0.1:8001" > .env.local
npm run build && npx next start -p 3000
```

Open `http://localhost:3000/cohort` and choose a patient from the ward. Use `localhost`, not `127.0.0.1`.

<details>
<summary><b>API entry points</b></summary>

| Layer | Endpoint | Purpose |
|---|---|---|
| Backend | `GET /v1/health` | Liveness |
| Backend | `GET /v1/subjects` | Served subjects (the sealed test split is never listed) |
| Backend | `POST /v1/forecasts` | Forecast, spike risk and optional scenarios at a pinned moment |
| Backend | `GET /v1/subjects/{id}/twin` | Twin card |
| Backend | `GET /v1/subjects/{id}/stream` | Server-sent replay stream |
| Frontend BFF | `/api/subjects`, `/api/forecast`, `/api/ward`, `/api/patients/[id]/stream`, `/api/patients/[id]/twin` | Proxies with contract validation |

Contracts live in `backend/contracts/v1/*.json` and are compiled into `src/types` by `npm run prebuild`. `npm run build` fails if they drift.
</details>

<details>
<summary><b>Reproducing the evidence</b></summary>

```bash
python docs/assets/readme/make_charts.py      # regenerates every README chart from committed results

# Research scripts need the licensed raw datasets under data/real (not redistributed):
python docs/evidence/operating_point/routine_target_arms.py --data-dir data/real
python docs/evidence/fa_controller/develop_controller.py   --data-dir data/real
```

Seeds are fixed at `20260930`. External-check inputs are verified by the sha256 values recorded in their preregistrations.
</details>

## Tests and verification

```bash
npm test -- --runInBand --silent                     # 48 suites, 450 tests
RUN_DIR=runs/pr_tft_ablation_arm_d pytest backend/tests/ -q   # 162 passed (134 collected without RUN_DIR)
npx tsc --noEmit && npm run build                     # types, contract-drift check, production build
```

- **Frontend:** contracts, safety invariants, stream recovery, accessibility (jest-axe), FHIR schema and semantics, and evidence-number drift.
- **Backend:** causality, sealed-split access, twin counterfactual plausibility, alert-policy mechanics, and the AI-READI harness on synthetic data.
- **Browser:** the ward → patient → What-if → summary → FHIR flow is checked on desktop and at 390 px.

## Datasets and licences

| Dataset | Role | Licence |
|---|---|---|
| Synthetic cohort (`backend/synthetic_v2`) | Served application | Project, Apache-2.0 |
| CGMacros (PhysioNet 1.0.0) | Real-patient development and locked test | CC BY-NC-SA 4.0 (not redistributed) |
| BIG IDEAs (PhysioNet 1.1.3) | Real-patient development and locked test | ODC-By 1.0 (not redistributed) |
| ShanghaiT2DM | Real-patient development; test not estimable | CC BY 4.0 (not redistributed) |
| Hall et al. 2018, *PLoS Biol* | External check 1 | CC BY 4.0 (not redistributed) |
| AZT1D (Mendeley Data) · Broll (iglu) | External check 2 | CC BY 4.0 · GPL-2 (not redistributed) |
| USDA FoodData Central FNDDS 2021–2023 | Meal catalogue | Public domain (CC0) |
| HL7 FHIR R4 JSON schema | Test fixture | HL7 FHIR licence (CC0) |

## Limitations and intended use

- **Research only.** Not a medical device. Not for diagnosis, dosing or treatment decisions.
- **The served application replays a synthetic cohort.** Its realism check (Gate 3) failed. Real-patient results come from the separate research pipeline.
- **Early warning is the weak point.** It was 6% at ≥30 min in the locked evaluation, and no improvement over simple trend rules has been shown on unused data.
- **What-if results are model responses, not validated causal effects.** Meal inputs are outside the network's training range, and only carbohydrate grams are modelled.
- **Hindi text is unreviewed** by a native-speaking clinician.
- **FHIR checks are partial.** Invariants, profiles and terminology bindings are not checked.

## Submission

| Item | Location |
|---|---|
| Team | **T2D Digital Twin Team**: Akshaya R (BGS College of Engineering and Technology) · Nikhil VS (East West Institute of Technology) |
| Repository | [github.com/AkshayAlgoX/T2D-Glucose-Digital-Twin](https://github.com/AkshayAlgoX/T2D-Glucose-Digital-Twin) |
| Architecture document | [`docs/architecture/architecture.pdf`](docs/architecture/architecture.pdf) (submission snapshot; the diagrams above reflect this branch) |
| Presentation | [`docs/presentation/presentation.pdf`](docs/presentation/presentation.pdf) (submission snapshot) |
| Demo script | [`docs/demo/DEMO_SCRIPT_20MIN.md`](docs/demo/DEMO_SCRIPT_20MIN.md) |
| Demonstration video | Pending: link to be added by the team |
| Claim–evidence ledger | [`docs/submission/CLAIM_EVIDENCE_LEDGER.md`](docs/submission/CLAIM_EVIDENCE_LEDGER.md) |
<!-- TODO(owner): replace "Pending: link to be added by the team" in the Demonstration video row with the recorded video URL. No public deployment is linked because none has been verified. -->

## License

Apache License 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Copyright 2026 Akshaya R and Nikhil VS (T2D Digital Twin Team). Third-party datasets keep their own licences (above) and are not redistributed. npm and pip dependencies keep their upstream licences.

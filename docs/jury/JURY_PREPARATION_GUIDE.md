# T2D Glucose Digital Twin — Jury Preparation & Project Explainer Guide

**A comprehensive, evidence-first internal master guide for the Happiest Health Digital Twin Challenge expert jury defense.**

* **Presenters:** Akshaya R (BGS College of Engineering and Technology) & Nikhil VS (East West Institute of Technology)
* **Project Repository:** [`https://github.com/AkshayAlgoX/T2D-Glucose-Digital-Twin`](https://github.com/AkshayAlgoX/T2D-Glucose-Digital-Twin)
* **Default Branch:** `release/candidate-clean` (Verified Base Commit: `1c6e51b462f609fbe6d021f7017cd55cbb6e1f63`)
* **Verified Live Application:** [`https://t2d-glucose-digital-twin.akshay.blitz.cloud/`](https://t2d-glucose-digital-twin.akshay.blitz.cloud/)
* **Published Submission Video:** [`https://youtu.be/arTnv1yWy1E`](https://youtu.be/arTnv1yWy1E) (Runtime: 19:41)
* **Intended Use Scope:** Research Prototype Only — Not for Clinical Diagnosis, Treatment, or Real-Time Medical Decision Making.

---

## Table of Contents

1. [The Project in 60 Seconds](#1-the-project-in-60-seconds)
2. [The Healthcare Problem](#2-the-healthcare-problem)
3. [What a Digital Twin Means in This Project](#3-what-a-digital-twin-means-in-this-project)
4. [Exactly How Our System Works](#4-exactly-how-our-system-works)
5. [What Judges See in the Product](#5-what-judges-see-in-the-product)
6. [Model and Technical Architecture](#6-model-and-technical-architecture)
7. [Dataset and Partition Story](#7-dataset-and-partition-story)
8. [Results: What We Know](#8-results-what-we-know)
9. [Negative Results, Failed Gates, and Known Artefacts](#9-negative-results-failed-gates-and-known-artefacts)
10. [Privacy, Partition Protection, and Safety Governance](#10-privacy-partition-protection-and-safety-governance)
11. [What We Would Do Next (Research Roadmap)](#11-what-we-would-do-next-research-roadmap)
12. [Glossary of Key Technical and Clinical Terms](#12-glossary-of-key-technical-and-clinical-terms)
13. [One-Page Quick Reference & Primary Source Locators](#13-one-page-quick-reference--primary-source-locators)

---

## 1. The Project in 60 Seconds

### What it is
The **T2D Glucose Digital Twin** is an open-source, evidence-first clinical software prototype designed to forecast continuous glucose monitor (CGM) trajectories two hours ahead and estimate the advance risk of postprandial glucose spikes (>180 mg/dL) for adults with type 2 diabetes and prediabetes.

### Whose problem it is intended to address
It addresses the clinical monitoring dilemma faced by individuals living with type 2 diabetes and their attending clinicians:
* Commercial CGM devices beep or alert **after** blood glucose has already crossed 180 mg/dL (reactive threshold alarms).
* By the time an alert sounds, the patient's glucose is already high, carbohydrate absorption is in full progress, and the physiological window for an easy behavioral intervention (such as a 15-minute post-meal walk) has passed.
* Patients and clinicians lack a forward-looking, contextual forecast that explains **how** the prediction was computed, **how confident** the model is, and what might happen if daily behaviors change.

### What we built
We built a fully integrated software workstation consisting of:
1. **A hybrid forecasting engine:** Combines a mechanistic physiological prior (a modified Bergman Minimal Model solved via an Unscented Kalman Filter) with a deep neural network (Physiological-Residual Temporal Fusion Transformer, PR-TFT) that learns only the residual errors the physics cannot capture.
2. **Uncertainty and spike-hazard outputs:** Produces 24 discrete 5-minute forecasts (120-minute horizon) across 7 quantiles ($P_{05}$ to $P_{95}$) with conformal interval coverage adjustment, alongside a separate calibrated spike-onset probability.
3. **An interactive clinical workstation:** A Next.js frontend featuring cohort triage, real-time telemetry replay, timeline anchor pinning, interactive "What-If" meal and exercise exploration, bilingual patient notes (English and Hindi), and official HL7 FHIR R4 JSON bundle export.
4. **An unredacted Evidence and Validation page:** Directly embedded into the running product, disclosing all development metrics, locked real-patient test results, external validation checks, failed gates, and known model artefacts without concealment.

### What the prototype can currently demonstrate
* Connected streaming replay across a 249-subject served synthetic cohort (205 training, 44 validation).
* Live 120-minute forecast generation with explicit additive decomposition: $\text{Physiology Twin} + \text{Learned Adjustment} = \text{Final Forecast}$.
* Instant scenario re-simulation for added carbohydrates and physical activity.
* Strict refusal of unmodelled interventions (medication changes return `SCENARIO_UNSUPPORTED`).
* Transparent data-quality flagging and fallback to pure physiological rollouts when inputs are degraded.

### What it does NOT prove
* **It does not prove clinical efficacy:** It has never been tested in a prospective human trial; no reduction in HbA1c, hypoglycaemia, or hyperglycaemia has been demonstrated.
* **It is not an automated medical device:** It cannot prescribe insulin, adjust medications, or diagnose diabetes.
* **Its What-If scenarios are not validated causal treatments:** They are simulated model responses under linearised physiological assumptions, not guaranteed medical outcomes.
* **Its early-warning sensitivity on real patients is modest:** In our single locked real-patient evaluation, it detected only 6.9% of spikes $\ge 30$ minutes in advance within a strict false-alert budget.

---

## 2. The Healthcare Problem

### Continuous Glucose Monitoring (CGM)
A continuous glucose monitor uses a tiny enzymatic sensor wire inserted under the skin into subcutaneous tissue. It measures the glucose concentration in **interstitial fluid** (not capillary or venous blood) at regular intervals (typically every 5 minutes, yielding 288 readings per day). Interstitial glucose lags blood glucose by 5 to 15 minutes due to physiological diffusion time.

### What an "adverse glucose spike" means in this project
In clinical guidelines (e.g., American Diabetes Association / International Consensus on Time in Range), postprandial glucose should ideally remain below 180 mg/dL ($10.0\text{ mmol/L}$).
In our project's rigorous pre-registered evaluation protocol:
* An **adverse spike onset** is defined as interstitial glucose crossing from below 180 mg/dL to $\ge 180\text{ mg/dL}$, preceded by a sustained rise of at least 50 mg/dL within the previous 60 minutes, and remaining above 180 mg/dL for at least 3 consecutive 5-minute readings (15-minute persistence).
* This persistence criterion filters out single-sample sensor noise and transient sensor compression artefacts.

### Why predicting future glucose could be useful
Unlike type 1 diabetes—where immediate subcutaneous insulin boluses dominate glycemic management—type 2 diabetes management heavily emphasizes behavioral timing, carbohydrate moderation, and post-meal muscle glucose uptake:
* Physical exercise (e.g., a brisk 20–30 minute walk) activates non-insulin-dependent glucose transporter type 4 (GLUT4) translocation directly into skeletal muscle, lowering postprandial glucose excursion.
* However, exercise works best **before** or **during** the initial glycemic upslope.
* If a patient or clinician receives a dependable warning 30 to 60 minutes before a spike occurs, there is an actionable window to take a walk, drink water, or alter impending meal timing.

### Why a prediction is NOT a clinical recommendation
A predictive statistical model outputs a conditional distribution: $P(G_{t+h} \mid \text{history})$.
Even if this mathematical distribution is well-calibrated, converting a prediction into an action recommendation introduces causal and clinical safety risks:
1. **Uncertainty under counterfactuals:** A neural network trained on observational data cannot guarantee how a person's body will react if they take an action outside their normal training distribution.
2. **False alarms and alert fatigue:** If an alarm sounds 4 times a day when no spike occurs, the patient will silence or ignore the monitor.
3. **Safety critical bounds:** In diabetes care, an unverified recommendation to take medication or perform strenuous exercise could trigger acute hypoglycaemia (<70 mg/dL), which is acutely life-threatening. Therefore, our system strictly decouples **prediction** from **treatment**, explicitly labeling all outputs as research-only estimates.

---

## 3. What a Digital Twin Means in This Project

In engineering and medicine, the phrase "digital twin" is frequently overused. In this project, we give it a concrete, mathematically bounded definition.

### The Patient's Twin State
A digital twin here is a computational state representation of a specific individual, initialized from their Electronic Health Record (EHR) priors and continuously synchronized with streaming wearable observations:
* **Static Context (EHR Priors):** Age, sex, body mass index (BMI), baseline glycated hemoglobin ($\text{HbA}_{1c}$), estimated glomerular filtration rate (eGFR), diabetes diagnosis duration, and prescribed medication classes.
* **Dynamic Observations:** Streaming 5-minute CGM readings, heart rate (HR), heart rate variability (HRV / RMSSD), pedometer steps, sleep stage indicators, and logged carbohydrate intake.
* **Internal Physiological State Vector:** Estimated via an Unscented Kalman Filter tracking plasma glucose $G(t)$, remote insulin action $X(t)$, plasma insulin proxy $I(t)$, and gut glucose absorption compartments $Q_1(t)$ and $Q_2(t)$.

### Simulated vs. Prospective Clinical System
* **Current Prototype Cohort:** Operates on a fully synthetic cohort of 293 subjects generated by an ODE-based virtual patient simulator (`generate_health_data_v2`). The deployed live workstation serves 249 of these subjects (205 training, 44 validation).
* **Research Evidence Cohort:** Retrospective, offline research evaluations were executed against 161 real-world patients across three open clinical datasets (CGMacros, BIG IDEAs, ShanghaiT2DM).
* **Prospective Reality:** This prototype is **not** connected to live human hospital feeds or consumer Bluetooth hardware in production. It is a replayed demonstration workstation illustrating how such a clinical architecture operates when fed standardized observation streams.

---

## 4. Exactly How Our System Works

The computational pipeline follows a strict, causal six-stage data path:

```
[1. Patient Inputs]      Static EHR (Age, BMI, HbA1c, eGFR) + Wearables (CGM, HR, Steps, Sleep, Meals)
         │
         ▼
[2. Data Quality Gate]   Check 5-min cadence, missingness (<30% gap), sensor range (40–400 mg/dL)
         │
         ▼
[3. UKF Physiology Twin] Nonlinear state estimation: updates glucose, insulin action, gut compartments
         │               Outputs: Mechanistic rollout baseline over 24 steps (120 minutes)
         │
         ├───────────────────────────────┐
         ▼                               ▼
[4. PR-TFT Neural Network]      [Residual Combination]
   Learns residual correction:     Final Median = Twin Baseline + Learned Residual
   ΔG at 7 quantiles (P05–P95)     Bands = Conformal interval adjustments
   Discrete-time hazard head       Hazard = Isotonic probability calibration
         │                               │
         └───────────────────────────────┘
                         │
                         ▼
[5. Alert Policy & Safety]      Triggers at risk ≥ 0.35 with 120-min cooldown
                         │      Fallback: If neural network fails, serve twin-only rollout
                         ▼
[6. Workstation UI & FHIR]      Next.js charts, What-If simulation, FHIR R4 JSON bundle export
```

### 1. The Physiology Twin (Modified Bergman Minimal Model + UKF)
Traditional machine learning often treats glucose forecasting as a black-box time-series problem. When sensor noise or missing meals occur, pure neural networks produce unphysical oscillations.
To prevent this, we employ a physiological foundation:
* **Bergman Minimal Model equations:** Model how plasma insulin accelerates glucose clearance from the blood and how carbohydrates entering the gut are absorbed into plasma over time.
* **Unscented Kalman Filter (UKF):** A recursive nonlinear filter that tracks hidden physiological states. As each new 5-minute CGM reading arrives, the UKF updates its internal estimates of the patient's current insulin sensitivity and gut glucose.
* **Twin Rollout:** The UKF projects forward 120 minutes assuming no unannounced future food intake. This produces a smooth, biologically plausible baseline trajectory.

### 2. The Learned Adjustment (PR-TFT Neural Network)
The physiology model is intentionally simple; it does not capture circadian cortisol rhythms, dawn phenomenon, physical exertion dynamics, stress, or individual behavioral nuances.
* **Temporal Fusion Transformer (TFT):** A state-of-the-art deep architecture featuring multi-head self-attention and gating mechanisms that process static EHR variables, historical time series (past 24 hours), and known future inputs (time-of-day clock features).
* **Physiological Residual (PR):** Instead of predicting absolute glucose, the network is trained strictly to predict the **residual error** ($\Delta G = G_{\text{actual}} - G_{\text{twin}}$). This guarantees that the machine learning acts as an empirical correction layer on top of a biological foundation rather than hallucinating arbitrary trajectories.

### 3. Forecast Horizon and Quantiles
* **Horizon:** 24 discrete steps of 5 minutes each, covering exactly 120 minutes ahead.
* **Quantiles:** The network outputs seven quantiles simultaneously: $P_{05}, P_{10}, P_{25}, P_{50}, P_{75}, P_{90}, P_{95}$.
* **Conformal Adjustment:** To ensure the uncertainty intervals are meaningful, empirical non-conformity scores calculated on validation data adjust the width of the $P_{10}–P_{90}$ band to achieve valid 80% coverage.

### 4. Calibrated Spike-Onset Risk
A dedicated discrete-time hazard classification head evaluates the likelihood that a new adverse spike onset will occur within the 120-minute window. Raw probabilities from neural networks are often overconfident; our pipeline passes this output through an isotonic regression calibrator fitted on held-out validation data.

### 5. Fallback Behavior Under Failure
* **Network or Service Disconnection:** If the PR-TFT model crashes or fails validation, the backend automatically falls back to serving the pure UKF physiological rollout. The API response explicitly sets `model.fallback_used = true`, and the UI notifies the clinician.
* **Degraded Sensor Data:** If CGM coverage drops below 70% in the preceding 24 hours, the service suppresses forecasting entirely, setting the forecast to `null` and populating `data_quality.reasons` with explanatory codes (e.g., `INSUFFICIENT_HISTORY`, `EXCESSIVE_STALENESS`).

---

## 5. What Judges See in the Product

The live application running at [`https://t2d-glucose-digital-twin.akshay.blitz.cloud/`](https://t2d-glucose-digital-twin.akshay.blitz.cloud/) contains five primary interfaces, each verified against the running backend:

### 1. The Landing Page (`/`)
* **Live Hero Forecast:** Displays patient `P0017` (a 53-year-old male with type 2 diabetes from the validation split) at the designated demonstration moment: 08:00 UTC on 29 September 2026.
* **Additive Decomposition Strip:** Directly displays:
  $$\text{Physiology Twin } (232.5\text{ mg/dL}) + \text{Learned Adjustment } (-15.4\text{ mg/dL}) = \text{Forecast } (217.1\text{ mg/dL at }+60\text{ min})$$
* **Wearable Input Streams:** Aligned bar and area charts displaying the logged breakfast (123g carbs at 07:35 UTC), steps, heart rate (71 bpm), HRV (26 ms), and sleep state.
* **Model Disagreement Notice:** Prominently highlights when the trajectory quantile bands and the discrete spike classifier offer differing perspectives (e.g., trajectory lower bound crosses 180 mg/dL, while the calibrated hazard head estimates 53.3% risk of a *new* spike starting), explaining why in clear clinical prose.
* **Technical Proof:** Demonstrates full-stack integration between FastAPI and Next.js, real-time math execution, and transparent decomposition.
* **Clinical Caveat:** Proves nothing about real-human efficacy; it is a simulated demonstration.

### 2. Patient Cohort Directory (`/cohort`)
* **Ward Triage View:** Ranks validation patients at 08:00 UTC by their calibrated 2-hour spike risk (e.g., P0100 at 75% [WARNING], P0283 at 61% [WARNING], P0036 at 60% [WATCH], P0017 at 53% [WATCH]).
* **Full Subject Directory:** Enumerates exactly **249 served subjects** (88 Healthy, 107 Prediabetes, 54 Type 2; 205 training, 44 validation).
* **Partition Firewall:** The 44 sealed test-split subjects are completely blocked by the backend API and never appear in the list or search.

### 3. Patient Workspace (`/patients/[id]`)
* **Trajectory Chart:** Observed CGM (black dots), forecast median (solid blue line), 50%, 80%, and 90% confidence bands (shaded blue ribbons), physiological baseline (dashed rust line), and learned adjustment (hatched teal wedge).
* **Interactive Time Scrubber & Anchor Pinning:** Allows the user to pause replay, jump back in time, pin a specific historical moment, and inspect historical model performance without lookahead leakage.
* **Clinical Context Rail:** Shows complete EHR parameters (Age, BMI, $\text{HbA}_{1c}$, eGFR, diabetes duration, medication classes) and estimated physiological states (relative insulin sensitivity, active gut carbs on board).

### 4. What-If Scenario Exploration
* **Pre-Set Scenarios:**
  1. *Add 60g carbohydrate meal in 30 minutes:* The twin simulates gut absorption; the neural network adds learned corrections; the chart plots the counterfactual trajectory alongside the baseline.
  2. *Add 30 minutes of moderate exercise:* Exercises GLUT4 uptake via an elevated metabolic clearance rate ($\Delta\text{HR} = 30\text{ bpm}$); glucose curves depress realistically.
  3. *Skip usual habitual meal:* Removes expected circadian meal intake.
  4. *Medication Change:* The user clicks medication adjustment; the backend immediately returns `SCENARIO_UNSUPPORTED` with an explanatory notice: *"The physiological twin has no validated drug action terms; the system refuses to guess."*
* **Indian Dish Selector:** Allows building scenarios from 29 authentic Indian dishes with source-backed carbohydrate data from USDA FNDDS (e.g., Masala Dosa, Chana Masala, Roti).
* **Artefact Warning:** If the neural network produces a single-step 5-minute jump (>20 mg/dL), the chart automatically highlights it with a circled warning flag rather than smoothing it out.

### 5. Clinician Summary & FHIR Export Modal
* **Bilingual Patient Note:** Generates a plain-language summary of current glucose and forecast risk in both English and Hindi. The UI explicitly discloses that the Hindi translation uses fixed clinical template strings and has not undergone formal clinical review.
* **Official HL7 FHIR R4 JSON Export:** Exports a structured FHIR Bundle conforming to the official HL7 R4 schema (`Observation` resources for CGM history and forecast, tagged with LOINC code `99504-3` and UCUM units `mg/dL`).

### 6. Evidence and Validation Page (`/evidence`)
* Direct public display of all project metrics, bootstrap confidence intervals, LODO generalization, failed gates, and external evaluations.

---

## 6. Model and Technical Architecture

### Complete System Stack
* **Frontend:** Next.js 15 (React 19, TypeScript, Tailwind CSS, Lucide Icons). Served as a standalone Node.js production server.
* **Backend:** FastAPI (Python 3.12, PyTorch 2.x, NumPy, SciPy, Pydantic v2).
* **Physiological Simulator / Filter:** Custom Python implementation of Bergman Minimal Model + Unscented Kalman Filter (`backend/ukf_twin.py`).
* **Deep Learning Engine:** PyTorch Lightning implementation of Temporal Fusion Transformer (`backend/train_pr_tft.py`).
* **Inter-Process Communication:** Local reverse proxy (`BACKEND_URL=http://127.0.0.1:8001`) with Server-Sent Events (SSE) for streaming CGM telemetry.
* **Containerization:** Single unified Docker container running both FastAPI and Next.js via `deploy/entrypoint.sh` under a non-root user (`appuser`, UID 10001), exposed on port 7860.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Next.js 15 Frontend (:7860)                     │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ Landing Page │  │ Cohort Triage │  │  Workspace   │  │ Evidence  │  │
│  └──────┬───────┘  └───────┬───────┘  └──────┬───────┘  └─────┬─────┘  │
│         │                  │                 │                │        │
│         ▼                  ▼                 ▼                ▼        │
│  Next.js API Route Handlers: /api/forecast, /api/subjects, /api/stream  │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ HTTP (localhost:8001)
┌────────────────────────────────────▼───────────────────────────────────┐
│                        FastAPI Backend (:8001)                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Endpoints: /v1/forecasts, /v1/subjects, /v1/health, /v1/twin     │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
│                                     │                                  │
│         ┌───────────────────────────┴────────────────────────────┐     │
│         ▼                                                        ▼     │
│  ┌────────────────────────┐                            ┌─────────────┐ │
│  │ UKF Physiological Twin │                            │   PR-TFT    │ │
│  │ Minimal Bergman ODEs   │                            │   PyTorch   │ │
│  └──────────┬─────────────┘                            └──────┬──────┘ │
│             │ Mechanistic Rollout                             │        │
│             └───────────────────────┬─────────────────────────┘        │
│                                     ▼                                  │
│                  Additive Residual & Uncertainty Engine                │
│                  - Conformal 80% Interval Adjustment                   │
│                  - Isotonic Hazard Calibration                         │
│                  - Sealed Partition Guard (blocks test subjects)       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Dataset and Partition Story

To understand the evidence, one must understand the exact patient counts and denominators across our development and evaluation phases.

### Phase A: Synthetic Development Cohort (`generate_health_data_v2`)
* **Total Generated:** 293 synthetic subjects (`runs/pr_tft_ablation_arm_d/split.json`).
* **Training Partition:** 205 subjects (used for model fitting and parameter learning).
* **Validation Partition:** 44 subjects (15 Healthy, 19 Prediabetes, 10 Type 2; used for early stopping, hyperparameter checkpoint selection, and calibration).
* **Sealed Test Partition:** 44 subjects (strictly quarantined; never exposed to training, tuning, or inference).
* **Served Cohort in Application:** Exactly **249 subjects** ($205\text{ train} + 44\text{ val}$). The 44 test subjects are hardcoded into `SEALED_SPLITS = frozenset({"test"})` in `backend/serve_pr_tft.py` and raise HTTP 404 if queried.

### Phase B: Retrospective Real-Patient Benchmark (`docs/evidence/real_data/`)
Preregistered protocol evaluating generalizability across three open clinical repositories:
* **Nominal Cohort:** 161 real patients.
  * **CGMacros (PhysioNet):** 27 train, 9 validation, 9 test (5-minute CGM).
  * **BIG IDEAs Glycemic Wearable (PhysioNet):** 9 train, 3 validation, 4 test (5-minute CGM).
  * **ShanghaiT2DM (Figshare):** 60 train, 20 validation, 20 test.
* **The ShanghaiT2DM Reality:** Shanghai continuous glucose monitoring was recorded at native 15-minute intervals. On our pre-registered 5-minute causal grid, 15-minute data achieves at most 33.3% coverage, violating the mandatory $\ge 70\%$ 24-hour observation eligibility rule. Furthermore, 15-minute data cannot evaluate the 3-sample (15-minute) spike persistence rule without fabricated interpolation. In accordance with strict scientific integrity, **ShanghaiT2DM test endpoints were declared NOT ESTIMABLE (N/E)**.
* **Final Held-Out Real Test Denominator:** Exactly **11 real patients** with native 5-minute CGM (9 from CGMacros, 2 evaluable from BIG IDEAs).

### Phase C: Unused External Cohorts
* **Hall et al. 2018:** 57 participants, 1,104 patient-days, mostly normoglycaemic or prediabetic, only 64 qualifying spike onsets.
* **AZT1D:** 24 adults with type 1 diabetes on automated insulin delivery, 988.6 patient-days, 2,814 spike onsets.
* **Broll et al.:** 5 participants with type 2 diabetes, 51.2 patient-days, 104 onsets (descriptive).
* **AI-READI (Pending):** ~944 type 2 diabetes participants on FAIRhub. Preregistered protocol frozen; data access pending ethics approval.

---

## 8. Results: What We Know

Every statistic below is traced to its committed artifact in the repository.

### Table 1: Synthetic Development Validation (44 Patients, Arm D Manifest)
*Source: `runs/pr_tft_ablation_arm_d/run_manifest.json` and `docs/evidence/validation_ceiling_results.json`*

| Metric | Horizon | Hybrid Model (PR-TFT) [95% CI] | Physics Twin Alone | Persistence Baseline | Relative Improvement vs Twin |
|---|---|---|---|---|---|
| **RMSE (mg/dL)** | +30 min | **12.36** [11.89–12.84] | 15.24 | 21.64 | −18.9% |
| **RMSE (mg/dL)** | +60 min | **19.53** [18.56–20.48] | 23.23 | 36.05 | **−16.0%** (−45.8% vs persist.) |
| **RMSE (mg/dL)** | +120 min | **25.03** [23.67–26.27] | 28.64 | 48.36 | −12.6% |
| **80% Band Coverage** | — | **80.00%** (width: 37.3 mg/dL) | — | — | Exact conformal calibration |
| **Hazard AUROC** | — | **0.922** (Brier: 0.0703) | — | — | In-sample diagnostic |

*Alarm-scored early warning on 29 synthetic validation patients with prediabetes/T2D (375 patient-days, 617 spikes):*
* At risk threshold 0.35: Caught **90% of spikes** (555/617), 62 missed, median lead time **70 minutes**, 1.77 false alerts/day, 46% precision.
* At risk threshold 0.60: Caught **71% of spikes** (437/617), 180 missed, median lead time **65 minutes**, 0.56 false alerts/day, 68% precision.

---

### Table 2: Locked Real-Patient Test Evaluation (11 Held-Out Test Patients)
*Source: `docs/evidence/real_data/results.json` (Point Estimates) and `RESULTS.md` (Bootstrap Means)*
*Evaluated under pre-registered protocol v1: threshold 0.35, 120-min refractory cooldown, 5–120 min valid warning window, 1-to-1 deterministic alert matching.*

| Model | 60-min RMSE (mg/dL) [95% CI] | Sensitivity $\ge 30$ min [95% CI] | Alert Precision | False Alerts / Patient-Day [95% CI] | Median Lead Time [Band] |
|---|---|---|---|---|---|
| **Persistence Baseline** | 26.27 [20.85–32.22] | 0.0% [—] | — | 0.00 [—] | 0.0 min |
| **Linear Trend (30 min)** | 49.06 [42.10–57.40] | **44.4%** [36.8–56.1] | 16.4% | **3.84** [3.16–4.40] (Over budget) | 25.0 min |
| **Reduced Twin (UKF Prior)** | 24.73 [20.43–29.68] | 0.0% [0.0–0.0] | 30.8% | 0.10 [0.00–0.31] | 5.0 min |
| **Masked Hybrid (Ours, Point Est.)** | **23.11** [18.75–28.12] | **6.9%** [0.0–13.9] | **65.5%** | **0.11** [0.02–0.23] | **10.0 min** [5.0–15.0]* |
| *Masked Hybrid (Bootstrap Mean)* | *23.04 [18.7–28.1]* | *6.0% [0.0–13.9]* | *65.5%* | *0.11 [0.02–0.23]* | *10.0 min [5.0–15.0]* |

*\*Note on Lead Time Interval:* As documented in `docs/submission/LOCKED_RESULTS_RECONCILIATION.md`, the median lead-time interval `[5.0–15.0]` is a fixed $\pm 5$-minute reporting band, **not** a bootstrap confidence interval.
*Leave-One-Dataset-Out (LODO) Generalization:* CGMacros held-out RMSE60 = 23.97 mg/dL; BIG IDEAs held-out RMSE60 = 22.14 mg/dL.

---

### Understanding the Key Metrics in Plain English
* **RMSE (Root Mean Squared Error):** Measures trajectory distance in mg/dL. Lower is better. If real glucose is 180 and we forecast 203, error is 23 mg/dL.
* **Sensitivity $\ge 30$ minutes:** Out of all verified spikes that occurred, what fraction triggered an alarm at least 30 minutes before crossing 180 mg/dL? On real patients, our hybrid achieved 6.9%.
* **False Alerts per Patient-Day:** How many times per 24 hours did the alarm sound when no spike occurred within 2 hours? Our hybrid scored **0.11 false alerts/day** (about one false alarm every 9 days), well inside the clinical budget of $\le 1.0/\text{day}$.
* **Alert Precision:** When the alarm sounds, how often is a spike genuinely on the way? Our hybrid scored **65.5%**.
* **Linear Trend Baseline Comparison:** The simple 30-minute linear trend caught 44.4% of spikes $\ge 30$ minutes ahead, but it fired **3.84 false alarms per day** (almost 4 false alarms daily), creating unbearable clinical alert fatigue and an abysmal 16.4% precision.

---

## 9. Negative Results, Failed Gates, and Known Artefacts

A hallmark of genuine science is reporting what did not work. Our repository openly documents five major negative findings:

### 1. Gate 3 Synthetic Realism Failure (`FAIL: AUROC = 0.932`)
* **What was tested:** We built a 40-feature random forest discriminator to determine whether our synthetic CGM generator could be distinguished from an independent, literature-standard mock-real generator.
* **The Gate Rule:** Acceptance required AUROC $\le 0.65$ (indistinguishable from chance).
* **The Outcome:** The discriminator achieved **AUROC = 0.932** ($90\%\text{ CI: } 0.928–0.936$).
* **Why it failed:** The top distinguishing feature was `jerk_sd` (the standard deviation of the third derivative of glucose). Our synthetic ODE trajectories were smoother and lacked the jagged sensor noise characteristic of real CGMs.
* **Our Response:** We declared Gate 3 FAILED, preserved the result in our governance ledger, and displayed it prominently on the home page and Evidence page.

### 2. Low Early-Warning Sensitivity on Held-Out Real Patients (`6.9%`)
* In the locked real-patient test evaluation, the hybrid model caught only **6.9%** of spikes $\ge 30$ minutes in advance (6.0% bootstrap mean).
* **Why:** In real patients without contemporaneous meal logs (carbohydrate was masked to 0 because retrospective logs lacked timing verification), postprandial glucose rises unexpectedly. The calibrated probability threshold ($0.35$) remained conservative to prevent false alarms, keeping the model silent until the rise was already underway.

### 3. External Validation Checks Did Not Confirm Improvement
* **Hall et al. 2018 External Check:** Evaluated on 57 external participants. The routine model improved sensitivity $\ge 30$ min by $+7.8$ points ($95\%\text{ CI: } 0.0\text{ to }+13.2$). Because the pre-registered success rule required the lower confidence bound to strictly exceed 0, the primary endpoint was declared **NOT CONFIRMED**. On this low-spike cohort, a simple linear-trend rule outperformed both learned models (32.8% sensitivity).
* **AZT1D External Check:** Evaluated on 24 adults with type 1 diabetes on automated insulin delivery. The learned baseline scored $12.5\%$ sensitivity $\ge 30$ min, falling below the simple trend rule ($15.0\%$) and the combined rule ($15.2\%$). Difference: $-2.5$ points ($95\%\text{ CI: } -6.4\text{ to }+1.4$). Declared **NOT MET**.
* **Key Lesson:** Calibrated probability thresholds do not generalize across distinct patient populations without local recalibration. Physical slope rules are more robust across cohorts than raw neural network probabilities.

### 4. Known Model Artefact: Single-Step Median Jumps
* In approximately 19.8% of synthetic validation forecasts, the PR-TFT median trajectory jumped by $>20\text{ mg/dL}$ in a single 5-minute step.
* This is an unphysical neural network artefact (the physics twin never jumps).
* We pre-registered an empirical repair (a 3-point running median filter) that cuts the jump occurrence to 2.3% without degrading RMSE. However, because our published evaluation describes the raw model, **we refused to silently patch the model weights**. Instead, the live UI flags these 5-minute blips with a visible on-chart warning indicator.

### 5. Unexecuted Protocols
* **EW-01 Early Warning Protocol:** A planned real-data prospective trial protocol remains unexecuted and is marked as such.
* **AI-READI Confirmation:** Preregistered protocol for candidate C2 is frozen in Git, but has **NOT BEEN RUN** because institutional data access on FAIRhub is awaiting research ethics approval.

---

## 10. Privacy, Partition Protection, and Safety Governance

### Data Isolation & What the Application Serves
* **Served Data:** Synthetic data only. The live application serves only the 205 training and 44 validation synthetic subjects from the Arm D run.
* **Protected Quarantined Data:** The 44 synthetic test subjects are strictly partitioned. The backend `serve_pr_tft.py` maintains a `SEALED_SPLITS = frozenset({"test"})` firewall. Any attempt to query a test subject returns `404 SUBJECT_NOT_FOUND`.
* **Zero Real Patient Data Served:** Real patient data from PhysioNet and Figshare are stored exclusively in offline research directories (`data/real/`), never bundled into the Docker container or served over public APIs.

### Clinical Disclaimers and Safeguards
* **Research-Only Scope:** The application header, footer, clinician export, and API metadata declare: `"research_only_not_for_clinical_decisions"`.
* **Medication Refusal:** What-If requests attempting to simulate drug changes return `422 Unprocessable Entity` with `SCENARIO_UNSUPPORTED`.
* **FHIR Conformance:** Exported FHIR JSON bundles include security labels marking the record as `HTEST` (Healthcare Test Data) to prevent accidental ingestion into clinical electronic health records.

---

## 11. What We Would Do Next (Research Roadmap)

If granted research support and additional development time, our next steps follow an evidence-justified sequence:

1. **Execute AI-READI Confirmation:** Upon receiving approved access to the AI-READI cohort on FAIRhub (~944 type 2 diabetes participants wearing Dexcom G6 CGMs), run the frozen `aireadi_evaluate.py` script to test the C2 risk-gated policy on a large, untouched type 2 population.
2. **Dynamic Operating-Point Recalibration:** Implement a self-tuning threshold controller where each patient's alert threshold adapts to their historical baseline spike frequency, overcoming cross-cohort calibration collapse.
3. **Incorporate Continuous Meal Estimation:** Develop a deconvolution filter to estimate unannounced carbohydrate intake directly from the early trajectory inflection, bypassing the need for manual patient meal logs.
4. **Physiological Smoothness Loss:** Retrain the PR-TFT network with an explicit derivative penalty loss ($\mathcal{L}_{\text{smooth}} = \|\nabla^2 \Delta G\|^2$) to permanently eliminate single-step 20 mg/dL jumps without post-hoc heuristic filtering.
5. **Prospective Observational Feasibility Study:** Partner with a clinical diabetes center to observe whether providing advance trajectory forecasts to attending clinicians influences behavioral coaching without inducing patient anxiety.

---

## 12. Glossary of Key Technical and Clinical Terms

* **CGM (Continuous Glucose Monitor):** A wearable biosensor measuring glucose in subcutaneous interstitial fluid every 5 minutes.
* **Interstitial Fluid:** Extracellular fluid bathing tissue cells; glucose levels lag venous blood by 5–15 minutes.
* **Adverse Glucose Spike:** A rise of $\ge 50\text{ mg/dL}$ within 60 minutes crossing $180\text{ mg/dL}$ and persisting for $\ge 15$ minutes.
* **Digital Twin:** A patient-specific computational model joining static EHR priors and streaming physiological inputs to simulate current state and future trajectory.
* **Bergman Minimal Model:** A classic two-compartment ordinary differential equation model describing glucose clearance as a function of remote insulin action.
* **Unscented Kalman Filter (UKF):** A nonlinear recursive estimator using sigma points to track unobserved physiological states and parameter distributions.
* **PR-TFT (Physiological-Residual Temporal Fusion Transformer):** A specialized deep attention architecture trained strictly to predict the difference between the actual glucose and the UKF physiological prior.
* **Conformal Prediction:** A statistical technique that generates distribution-free, guaranteed finite-sample coverage intervals based on empirical calibration errors.
* **Isotonic Calibration:** Non-parametric monotonic regression that maps raw model scores into true empirical probabilities.
* **1-to-1 Alert Matching:** An evaluation rule where an advance alert can credit at most one subsequent spike event, preventing a single alert from falsely claiming multiple spikes.
* **Refractory Cooldown:** A mandatory 120-minute period following an alert during which new alerts are suppressed to prevent spamming the user.
* **Lead Time:** The time duration between an advance warning alert and the actual moment glucose crosses the 180 mg/dL threshold.
* **HL7 FHIR R4:** Fast Healthcare Interoperability Resources version 4, the international standard JSON schema for electronic health data exchange.

---

## 13. One-Page Quick Reference & Primary Source Locators

### Critical Numbers at a Glance
| Claim / Metric | Exact Value | Denominator & Context | Primary Artifact Locator |
|---|---|---|---|
| Synthetic Validation 60m RMSE | **19.53 mg/dL** | 44 synthetic validation patients | `runs/pr_tft_ablation_arm_d/run_manifest.json` |
| Synthetic Val Relative Gain | **−16.0%** | vs. UKF Twin alone (23.23 mg/dL) | `docs/evidence/validation_ceiling_results.json` |
| Real Held-Out Test 60m RMSE | **23.11 mg/dL** | 11 held-out real test patients | `docs/evidence/real_data/results.json` |
| Real Held-Out Early Sensitivity | **6.9%** (pt) / **6.0%** (boot) | Spikes caught $\ge 30$m ahead | `docs/evidence/real_data/RESULTS.md` |
| Real Held-Out False Alerts | **0.11 / day** | False alarms per 24 hours | `docs/evidence/real_data/results.json` |
| Real Held-Out Lead Time | **10.0 min** | Fixed reporting band [5–15 min] | `docs/submission/LOCKED_RESULTS_RECONCILIATION.md` |
| Gate 3 Realism Check | **FAIL (AUROC 0.932)** | Target was $\le 0.65$ | `backend/synthetic_v2/validation/validation_report.json` |
| ShanghaiT2DM Status | **NOT ESTIMABLE** | 15-min cadence violates 70% rule | `docs/evidence/real_data/PREREGISTRATION.md` |
| Hall External Check | **NOT CONFIRMED** | +7.8% [0.0, +13.2], lower bound $\le 0$ | `docs/evidence/external_hall/RESULTS.md` |
| AZT1D External Check | **NOT MET** | Learned model −2.5% vs linear trend | `docs/evidence/external_v2/RESULTS.md` |
| C2 Exploratory Candidate | **27.3% sens, 0.87 FA** | Validation-selected worst-fold | `docs/evidence/fa_controller/README.md` |
| Deployed Synthetic Cohort | **249 subjects** | 205 train, 44 val (44 test blocked) | `backend/serve_pr_tft.py` |

### Key Source Code Anchors
* **Backend Serving & Sealed Split Guard:** `backend/serve_pr_tft.py` (lines 78–82, 558, 575)
* **Physiological Model & UKF Implementation:** `backend/ukf_twin.py`
* **PR-TFT Neural Architecture:** `backend/train_pr_tft.py`
* **Locked Real-Patient Evaluation:** `docs/evidence/real_data/` (`PREREGISTRATION.md`, `RESULTS.md`, `results.json`)
* **Evidence Page Implementation:** `src/app/evidence/page.tsx`
* **FHIR R4 Exporter:** `src/lib/fhir.ts`
* **Indian Dish Nutritional Database:** `src/data/indian-meals.json` (USDA FNDDS CC0)

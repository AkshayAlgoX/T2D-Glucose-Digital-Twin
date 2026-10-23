# T2D Glucose Digital Twin — Jury Speaker Script & Presentation Timing Guide

**Presenters:** Akshaya R (BGSIT) & Nikhil VS (EWIT)
**Deck Reference:** `docs/jury/JURY_PRESENTATION.pptx` (and `docs/jury/JURY_PRESENTATION.pdf`)
**Live Application:** [`https://t2d-glucose-digital-twin.akshay.blitz.cloud/`](https://t2d-glucose-digital-twin.akshay.blitz.cloud/)

---

## 1. Quick-Answer Synthesis (The 6 Questions Every Judge Asks)

Before memorizing slide scripts, both speakers must have these 6 direct answers on the tip of their tongue:

1. **What did we build?**
   > *"We built an open-source clinical software workstation that forecasts 2-hour glucose trajectories and gives advance warning before post-meal glucose spikes happen in adults with type 2 diabetes and prediabetes. It combines a biophysical model with a neural network, provides interactive What-If simulation, and discloses all its evidence transparently."*

2. **What is genuinely different about it?**
   > *"Two things. First, unlike black-box AI models that can hallucinate impossible curves during sensor dropouts, our forecast is explicitly anchored on an Unscented Kalman Filter tracking biophysical ODEs—the neural network learns only the residual the physics misses. Second, we report what failed: our synthetic realism test failed, and we publish that right on our home page."*

3. **What works today?**
   > *"The live application is running. It serves a 249-subject synthetic cohort with streaming 5-minute replay, interactive 120-minute trajectory forecasts across 7 quantiles, What-If meal and activity simulations, bilingual patient summaries in English and Hindi, and validated HL7 FHIR R4 JSON bundle exports."*

4. **What does the evidence prove?**
   > *"On our synthetic validation cohort, the hybrid model reduces 60-minute RMSE by 16% over the physics twin alone. In our single locked real-patient test evaluation on 11 held-out test patients, it achieved an RMSE of 23.11 mg/dL, beating persistence, and maintained a false-alert rate of 0.11 alerts per day with 65.5% precision."*

5. **What failed?**
   > *"Our synthetic data realism audit failed with an AUROC of 0.932 because our ODEs were smoother than real CGMs. In our locked real-patient test, advance warning sensitivity was only 6.9% because retrospective meal logs were masked. And on external cohorts (Hall and AZT1D), our learned models did not statistically outperform simple linear trend rules."*

6. **What needs to happen before any real clinical use?**
   > *"Three things: First, independent confirmation on large, untouched type 2 cohorts like AI-READI. Second, dynamic operating points that adapt to each patient's personal spike rate. Third, a prospective observational clinical pilot to verify that forward forecasts genuinely help clinicians and patients without causing anxiety or alert fatigue."*

---

## 2. Timing Structures Overview

The exact jury presentation rules are not yet announced. Prepare for three flexible pitch durations plus a modular live demo:

| Track | Core Deck Run | Live Demo Run | Q&A Buffer | Total Time | Strategy & Cut Points |
|---|---|---|---|---|---|
| **5-Minute Flash Pitch** | 3.5 min | 1.5 min | 5–10 min | ~10–15 min | Core slides 1, 2, 4, 7, 8, 10 only. Skip slides 3, 5, 6, 9. 90-sec live demo showing P0017 and What-If. |
| **8-Minute Standard Pitch** | 5.5 min | 2.5 min | 5–10 min | ~15–20 min | Full 10-slide core deck (approx. 30–35 sec per slide). 2.5-min live demo showing cohort triage, P0017 forecast, What-If meal blip, and evidence page. |
| **12-Minute Deep Dive** | 8.0 min | 4.0 min | 10–15 min | ~25 min | Full 10-slide deck with deep dive on architecture, conformal calibration, and real-patient denominators, plus 4-min comprehensive workstation walkthrough. |

---

## 3. Slide-by-Slide Speaker Script (10-Slide Core Presentation)

### Slide 1: Title & One-Sentence Scope (Akshaya & Nikhil)
* **Visual:** Dark teal cover slide with project title, team affiliations, and research-only scope tag.
* **Speaker:** Akshaya opens, handoff to Nikhil.
* **Spoken Script:**
  > **[Akshaya]**: *"Good morning, esteemed members of the jury. I am Akshaya R from BGS Institute of Technology, and with me is Nikhil VS from East West Institute of Technology. We are presenting the T2D Glucose Digital Twin.*
  >
  > **[Nikhil]**: *"Our project is an open-source, evidence-first digital twin designed to forecast continuous glucose trajectories two hours into the future for adults with type 2 diabetes. We built a working software workstation that explains how every prediction is computed, and we state with complete transparency what our evidence proves, what it does not prove, and where it failed."*
* **Time:** 30 seconds.

---

### Slide 2: The Healthcare Problem: Reactive Alarms vs. Actionable Windows (Akshaya)
* **Visual:** Side-by-side comparison cards: Reactive Threshold Alarms vs. Actionable 30–60 Minute Advance Forecast.
* **Speaker:** Akshaya.
* **Spoken Script:**
  > **[Akshaya]**: *"Let us start with the clinical reality of continuous glucose monitors. A CGM sensor measures interstitial fluid under the skin every 5 minutes. In clinical care, post-meal glucose should ideally stay below 180 mg/dL.*
  >
  > *Today, commercial monitors sound an alarm only AFTER glucose crosses 180 mg/dL. That is a reactive alarm. By the time it sounds, carbohydrate absorption is in full swing, and the window for an easy behavioral intervention has passed.*
  >
  > *In type 2 diabetes, light exercise—such as a 15- to 20-minute post-meal walk—stimulates GLUT4 glucose uptake directly into muscle cells, blunting the spike. But this works best BEFORE the peak occurs. We set out to give patients a 30- to 60-minute early warning while keeping false alarms below one per day. But we emphasize: a predictive estimate is not a medical prescription, and our prototype does not diagnose or treat diabetes."*
* **Time:** 40 seconds.

---

### Slide 3: Our Solution: A Physiology-Informed Digital Twin Workstation (Nikhil)
* **Visual:** 3 vertical cards: 1. Physiology Twin, 2. Learned PR-TFT, 3. Clinical Workstation.
* **Speaker:** Nikhil.
* **Spoken Script:**
  > **[Nikhil]**: *"To solve this, we did not build a generic black-box neural network. Pure deep learning models can hallucinate impossible curves during sensor dropouts. Instead, we built a three-part hybrid digital twin.*
  >
  > *First, a biophysical physiology twin based on the classic Bergman Minimal Model, solved recursively with an Unscented Kalman Filter. It tracks insulin action and gut glucose absorption, providing a stable, biologically plausible baseline.*
  >
  > *Second, a deep Temporal Fusion Transformer that learns strictly the residual error the physics cannot capture—such as circadian cortisol rhythms and exertion recovery.*
  >
  > *And third, an interactive clinical workstation where attending clinicians can triage patients, navigate through time, run What-If scenarios, and export official HL7 FHIR R4 records."*
* **Time:** 35 seconds.

---

### Slide 4: How It Works: Causal Architecture & Data Flow (Nikhil)
* **Visual:** Diagram of the mathematical pipeline and additive decomposition: $\text{Twin Baseline} + \text{Learned Residual} = \text{Final Forecast}$.
* **Speaker:** Nikhil.
* **Spoken Script:**
  > **[Nikhil]**: *"Here is our exact computational data path. We ingest static EHR context—age, BMI, HbA1c, and eGFR—alongside streaming wearable data: CGM, heart rate, steps, and sleep.*
  >
  > *The Unscented Kalman Filter updates the patient's internal metabolic states and projects a 2-hour physics rollout. Simultaneously, our PR-TFT network evaluates the past 24 hours of wearables and outputs residual corrections across 7 quantiles.*
  >
  > *The final forecast is an explicit sum: Twin Rollout plus Learned Residual. On screen, every prediction is broken down into these exact numbers in mg/dL. If the neural network ever crashes or encounters corrupted inputs, the backend automatically falls back to serving the biophysical twin alone. Nothing runs in the dark."*
* **Time:** 40 seconds.

---

### Slide 5: Live Workstation: Verified Prototype on Synthetic Cohort (Akshaya)
* **Visual:** High-resolution screenshot of patient P0017 at 08:00 UTC with decomposition strip and Ward Triage view.
* **Speaker:** Akshaya.
* **Spoken Script:**
  > **[Akshaya]**: *"This is our live running application. On screen is patient P0017, a 53-year-old male with type 2 diabetes from our validation cohort, replayed at 08:00 UTC on his first morning.*
  >
  > *Notice the decomposition strip right below the heading: at plus 60 minutes, the physics twin projects 232.5 mg/dL. The neural network subtracts 15.4 mg/dL, giving a final forecast of 217.1 mg/dL with an 80% conformal confidence interval.*
  >
  > *Our cohort directory serves 249 synthetic subjects across healthy, prediabetes, and type 2 categories. Crucially, our 44 held-out test subjects are quarantined behind a strict server firewall; querying them returns HTTP 404. We never leak test data."*
* **Time:** 35 seconds.

---

### Slide 6: Uncertainty & What-If Counterfactual Simulation (Nikhil)
* **Visual:** Screenshot of What-If scenario (60g carb meal) with Figure 2, Figure 3, and circled 5-minute blip indicator.
* **Speaker:** Nikhil.
* **Spoken Script:**
  > **[Nikhil]**: *"A true digital twin should support interactive clinical inquiry. In our What-If panel, a clinician can test adding a 60-gram carbohydrate meal or 30 minutes of moderate activity.*
  >
  > *The backend re-runs the biophysical equations and neural network to show the counterfactual trajectory. But notice our ethical guardrails: if you click 'Medication change', the system refuses with SCENARIO_UNSUPPORTED because the twin has no validated drug models. We refuse to guess.*
  >
  > *And look at Figure 3: when the neural network produces a single-step 5-minute blip, we do not smooth it out. We circle it and warn the user. Honest software flags its artefacts rather than hiding them."*
* **Time:** 40 seconds.

---

### Slide 7: Evidence: Locked Evaluation on 161 Real Patients (Akshaya)
* **Visual:** Real-patient test results table, LODO generalization metrics, and baseline comparisons.
* **Speaker:** Akshaya.
* **Spoken Script:**
  > **[Akshaya]**: *"Let us turn to our real-world evidence. We executed a single, preregistered locked evaluation across 161 real patients from three open clinical datasets: CGMacros, BIG IDEAs, and ShanghaiT2DM.*
  >
  > *On the 11 held-out test patients with native 5-minute CGM, our hybrid model achieved a 60-minute RMSE of 23.11 mg/dL, outperforming persistence at 26.27 and the physics twin at 24.73. It maintained a false-alert rate of 0.11 alarms per day—one alarm every nine days—with 65.5% precision.*
  >
  > *Now look at the linear trend baseline: it caught 44.4% of spikes, but it fired 3.84 false alarms per day. That is almost four false alarms every single day, which destroys patient trust. Finally, ShanghaiT2DM was declared Not Estimable because 15-minute readings cannot test 5-minute persistence rules without interpolation."*
* **Time:** 45 seconds.

---

### Slide 8: What Failed and What We Learned: Honest Science (Nikhil)
* **Visual:** Evidence page screenshot highlighting Gate 3 FAILED, low sensitivity, and external validation tables.
* **Speaker:** Nikhil.
* **Spoken Script:**
  > **[Nikhil]**: *"A presentation without negative results is not scientific. We openly report where our prototype failed.*
  >
  > *First, our synthetic realism audit failed. A 40-feature classifier distinguished our synthetic data from an independent mock-real generator with an AUROC of 0.932 against a 0.65 threshold, because our ODEs were too smooth.*
  >
  > *Second, in our locked real-patient test, advance warning sensitivity was only 6.9%. Because retrospective meal logs lacked verifiable timestamps, meal inputs were masked to zero, and the model stayed conservative to protect the false-alert budget.*
  >
  > *Third, on two external cohorts—Hall and AZT1D—our learned model did not beat simple trend rules. We learned that calibrated probability thresholds do not generalize across distinct populations without adaptive recalibration."*
* **Time:** 45 seconds.

---

### Slide 9: Engineering Rigor, Safety Governance & Interoperability (Akshaya)
* **Visual:** Clinician summary modal showing FHIR R4 JSON export, bilingual patient note, and test badges.
* **Speaker:** Akshaya.
* **Spoken Script:**
  > **[Akshaya]**: *"From an engineering perspective, this system is built for real healthcare workflows.*
  >
  > *Our clinician export generates an official HL7 FHIR R4 JSON bundle conforming to the official schema, utilizing LOINC code 99504-3 and HTEST test-data labels. We provide bilingual patient summaries in English and Hindi.*
  >
  > *Our backend enforces strict non-root Docker security, automated health checks, and Git commit tracking. Every single number presented today is tied to a hashed, committed artifact in our public repository. We do not invent numbers, and we do not invent benchmark results."*
* **Time:** 35 seconds.

---

### Slide 10: Conclusion & Next Steps: The Path to Clinical Translation (Akshaya & Nikhil)
* **Visual:** Summary cards: What We Have Proven vs. Next Steps Before Clinical Use.
* **Speaker:** Akshaya summarizes proven capabilities; Nikhil delivers roadmap and closing.
* **Spoken Script:**
  > **[Akshaya]**: *"In summary, we have built a working, reproducible digital twin that proves biophysical priors improve neural forecasting stability, cutting RMSE by 16% on validation data while strictly controlling false alarms.*
  >
  > **[Nikhil]**: *"Before this can ever be considered for clinical care, three steps are necessary: First, independent confirmation on the AI-READI cohort of 944 type 2 patients, which is currently preregistered awaiting ethics data access. Second, self-tuning threshold controllers that adapt to personal baseline spike rates. And third, prospective clinical trials. Thank you, and we welcome your questions."*
* **Time:** 40 seconds.

---

## 4. Live Demo Walkthrough (Modular 2.5- to 4-Minute Runbook)

When the jury asks to see the working software, switch to the browser at [`https://t2d-glucose-digital-twin.akshay.blitz.cloud/`](https://t2d-glucose-digital-twin.akshay.blitz.cloud/) and execute this exact 4-step sequence:

### Step 1: Landing Page & P0017 Hero (45 seconds)
* **Action:** Open `https://t2d-glucose-digital-twin.akshay.blitz.cloud/`.
* **Speak:** *"Judges, this is our live deployed application. On the home page, you see patient P0017 from our validation split at 08:00 UTC. Notice the decomposition strip: 232.5 mg/dL from the physiology twin plus −15.4 mg/dL from the learned adjustment equals 217.1 mg/dL at plus 60 minutes. Underneath are the wearable inputs: breakfast of 123 grams at 07:35, heart rate 71 bpm, and sleep status. And look at the rail: the two models disagree on risk, and our interface explains why in plain clinical terms."*
* **Click:** Click **Open the demo twin · P0017 &rarr;** to navigate to the workspace.

### Step 2: Workspace Navigation & Time Scrubber (45 seconds)
* **Action:** Show the patient workspace for P0017.
* **Speak:** *"Here in the workspace, we have 2 hours of observed CGM dots, the forecast median in solid blue, and the 50, 80, and 90% confidence ribbons. The dashed rust line is our biophysical twin. Notice the Replay is paused at 08:00 UTC. If I click 'Resume replay', new 5-minute readings arrive in real time via Server-Sent Events. Or I can scrub back in time and pin a historical moment to review past predictions without lookahead leakage."*

### Step 3: What-If Simulation & Artefact Flagging (60 seconds)
* **Action:** Scroll down to the What-If simulation panel.
* **Click:** Click **60 g carb meal in 30 min**.
* **Speak:** *"Now let us ask What-If. We simulate adding a 60-gram carbohydrate meal in 30 minutes. The backend re-runs the Bergman ODEs and PR-TFT. The chart immediately displays the counterfactual curve in blue alongside the unchanged plan in grey. Notice the circled flag in Figure 3: our neural network produced a 5-minute blip of 53 mg/dL. We explicitly detect and flag this artefact rather than smoothing it away.*
* **Click:** Click **Medication change**.
* **Speak:** *"And if a user tries to alter medication, the system refuses with SCENARIO_UNSUPPORTED. We refuse to model pharmacological interventions without validated drug kinetics."*

### Step 4: Clinician Summary & Evidence Page (45 seconds)
* **Action:** Click **Clinician summary** button in the header, then navigate to `/evidence`.
* **Speak:** *"Finally, clinicians can export an official HL7 FHIR R4 JSON bundle or generate a bilingual patient note in English and Hindi. And on our Evidence page, we disclose everything: our locked real-patient metrics, our external checks on Hall and AZT1D, and the prominent red box confirming that our Gate 3 synthetic realism audit failed with AUROC 0.932. This is open, reproducible, evidence-first software."*

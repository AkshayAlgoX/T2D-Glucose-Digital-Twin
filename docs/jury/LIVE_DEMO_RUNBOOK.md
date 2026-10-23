# T2D Glucose Digital Twin — Live Demonstration Runbook

**A step-by-step operational protocol for demonstrating the working workstation during jury evaluation.**

* **Primary Live Production URL:** [`https://t2d-glucose-digital-twin.akshay.blitz.cloud/`](https://t2d-glucose-digital-twin.akshay.blitz.cloud/)
* **Local Fallback URL:** `http://localhost:3000/` (FastAPI at `http://127.0.0.1:8001/`)
* **Designated Primary Subject:** `P0017` (Validation split, Type 2 diabetes, 53yo male)
* **Secondary / Alternative Subject:** `P0001` (Training split, Prediabetes, 43yo female)
* **Strict Privacy Rule:** Never attempt to search or open sealed test subjects (`P0004`, `P0013`, etc.) — querying them returns HTTP 404.

---

## 1. Pre-Flight Health Check (Run 15 Minutes Before the Event)

Execute these checks from a terminal before your presentation session starts:

```bash
# 1. Check live cloud health endpoint
curl -s -i https://t2d-glucose-digital-twin.akshay.blitz.cloud/v1/health

# Expected response:
# HTTP/2 200
# {"status":"ok","model_version":"0.1.0 (...)","simulator_version":"generate_health_data_v2","contract_version":"1.0.0","subjects":249}

# 2. Check subject API response
curl -s https://t2d-glucose-digital-twin.akshay.blitz.cloud/api/subjects | head -c 200

# 3. Check live forecast for P0017
curl -s -X POST https://t2d-glucose-digital-twin.akshay.blitz.cloud/v1/forecasts \
  -H "Content-Type: application/json" \
  -d '{"subject_id": "00000000-0000-0000-0000-000000000000"}' | head -c 200
```

### If Cloud Status Returns 503 or "Unwell":
Free-tier serverless cloud containers sleep during periods of idle inactivity or take 30–60 seconds to cycle after heavy loads.
1. Send an initial `GET /v1/health` request to trigger the container wake-up.
2. Wait 10 seconds and reload.
3. If the cloud container remains unresponsive, immediately initiate the **Local Emergency Fallback** (Section 5 below).

---

## 2. Master Demonstration Click Sequence (4 Minutes)

### Step 1: The Landing Page (`/`) — 45 Seconds
1. **Navigate to:** `https://t2d-glucose-digital-twin.akshay.blitz.cloud/`.
2. **Visual Anchor:** The hero chart loads patient `P0017` replayed at 08:00 UTC on 29 September 2026.
3. **What to Say:**
   > *"Judges, this is our live running application. We start on the home page, which immediately displays patient P0017 from our validation cohort. Look directly at the decomposition strip above the chart."*
4. **Values to Read Directly from the Screen (Do Not Memorize):**
   * Point to marker ①: **Physiology Twin:** `232.5 mg/dL`
   * Point to marker ②: **Learned Adjustment:** `-15.4 mg/dL`
   * Point to marker ③: **Final Forecast:** `217.1 mg/dL` at +60 minutes
   * Read the right rail: Current glucose `148 mg/dL`, New-spike onset risk `53.3%`.
5. **What to Say on Model Disagreement:**
   > *"Notice the note in the right rail: the trajectory lower bound is above 180 mg/dL, but the classifier says 53.3% spike risk. The interface explains why: the trajectory asks if glucose will be elevated, while the classifier asks if a *new spike onset* will initiate. Our software discloses model differences in plain English."*
6. **Action:** Click the large button: **Open the demo twin · P0017 &rarr;**.

---

### Step 2: Patient Workspace & Replay Navigation — 45 Seconds
1. **Visual Anchor:** The full workspace loads (`/patients/P0017`).
2. **What to Say:**
   > *"Here in the workspace, we have two hours of observed CGM readings as black dots, the solid blue forecast median, and shaded ribbons representing the 50, 80, and 90% confidence bands. The dashed rust line is the biophysical twin, and the hatched teal wedge is the learned adjustment.*
   >
   > *Notice that the replay opens in a paused state at 08:00 UTC—the exact moment shown on the home page. In this subject, breakfast of 123 grams of carbohydrates was logged at 07:35 UTC. The model predicts a peak median of 222.5 mg/dL at +45 minutes."*
3. **Action:** Click **Resume replay**.
4. **What to Say:**
   > *"When I click 'Resume replay', incoming 5-minute CGM readings stream in real-time via Server-Sent Events. The observed CGM actually climbs to 207 mg/dL at 08:30 and 216 mg/dL at 09:00. This is a favorable example; aggregate performance across all subjects is reported on our Evidence page."*
5. **Action:** Click the time scrubber or pin an anchor.
   > *"Clinicians can pause and pin any historical anchor to review past forecasts without lookahead bias."*

---

### Step 3: What-If Counterfactual Scenario — 60 Seconds
1. **Visual Anchor:** Scroll down to the **What-if simulation** panel.
2. **What to Say:**
   > *"Now let us test clinical counterfactuals. Directly above the controls, our system states: 'Simulated model response — not a validated causal treatment effect.' We never claim these simulations are guaranteed medical outcomes."*
3. **Action:** Click the button **60 g carb meal in 30 min**.
4. **Visual Outcome:** The chart recalculates. Figure 2 shows the unchanged plan in grey and the modified plan in blue.
5. **Values to Read Directly from the Screen:**
   * Biggest gap between forecast curves: read the value (e.g., `+27.7 mg/dL` or `+96.9 mg/dL` depending on anchor).
   * Peak twin difference: read the mechanistic rollout value.
   * New-spike onset risk shift: read the percentage change (e.g., `53.3% &rarr; 56.9%`).
6. **Point Out Known Artefact (Crucial for Honesty):**
   > *"Look at Figure 3: there is a circled 5-minute blip where the learned adjustment spikes briefly. This is a known neural network artefact. We pre-registered an empirical smoothing filter, but because our published metrics describe the unrepaired model, our software detects and circles the blip with a warning flag rather than hiding it."*
7. **Action (The Safeguard Test):** Click **Medication change**.
8. **Visual Outcome:** The system displays `SCENARIO_UNSUPPORTED`.
9. **What to Say:**
   > *"And when a user clicks 'Medication change', the backend explicitly refuses. The biophysical twin has no validated pharmacological models, and the system refuses to guess."*

---

### Step 4: Clinician Summary & FHIR Export — 30 Seconds
1. **Action:** Scroll to the top and click **Clinician summary** in the header rail.
2. **Visual Outcome:** A clean modal opens with print-ready summary tables.
3. **What to Say:**
   > *"Attending clinicians can export an official HL7 FHIR R4 JSON bundle conforming to international schemas, tagged with LOINC 99504-3 and HTEST test-data labels.*
   >
   > *Underneath is a plain-language summary for the patient. Notice the language toggle: we provide summaries in both English and Hindi. The UI explicitly discloses that the Hindi translation uses fixed clinical templates and has not undergone formal clinical review."*
4. **Action:** Click the `&times; Close` button.

---

### Step 5: The Evidence & Governance Page (`/evidence`) — 45 Seconds
1. **Action:** Click **Evidence** in the top navigation bar.
2. **Visual Anchor:** The `/evidence` page loads.
3. **What to Say:**
   > *"Finally, we take judges to our Evidence page, which is accessible directly inside the product. We begin with the Read-First box: we disclose that Gate 3, our synthetic realism audit, FAILED with an AUROC of 0.932 because our ODEs were too smooth.*
   >
   > *Below are our locked real-patient metrics on 11 held-out test patients: 60-minute RMSE of 23.11 mg/dL, false-alert rate of 0.11 per day, precision of 65.5%, and advance sensitivity of 6.9%. And we publish our external checks on Hall and AZT1D, showing where simple linear trend baselines outperformed the learned model.*
   >
   > *Every number here is backed by hashed artifacts committed in Git. This is how trustworthy clinical software must be built."*

---

## 3. Values to Read Directly from the Screen (Never Guess)

During high-pressure jury questioning, **do not recite numbers from memory** if they are visible on screen. Point to the screen and read them:

| Screen Element | Location | Values to Read Aloud |
|---|---|---|
| **Decomposition Strip** | Top of Landing Hero & Workspace | Physiology Twin value, Learned Adjustment value, Final Forecast value, Horizon (+60 min). |
| **Current Vitals Rail** | Right rail of Workspace | Current glucose in mg/dL, Trend arrow, New-spike onset risk %. |
| **What-If Delta Box** | Bottom of What-If Panel | Biggest gap (mg/dL) at +X min, Mechanistic twin gap (mg/dL), Calibrated risk shift (X% &rarr; Y%). |
| **Ward Triage Table** | `/cohort` top section | Rank, Patient ID, Glucose Now, 2-h Spike Risk %, Alert State (WATCH / WARNING). |
| **Evidence Cards** | `/evidence` top section | 60-min RMSE (19.53 mg/dL synthetic, 23.11 mg/dL real), Gate 3 status (FAILED), False alerts/day (0.11). |

---

## 4. What NOT to Click or Display (Blacklist)

To ensure presentation safety and ethical compliance, **never perform the following actions**:
1. **Never attempt to search or open sealed test-split subjects:** IDs `P0004`, `P0013`, `P0021`, `P0038`, `P0043`, `P0060`, `P0066`, `P0085`, `P0091`, `P0097`, etc. Querying them returns HTTP 404.
2. **Never inspect or show internal `.env` files, secrets, or cloud tokens.**
3. **Never navigate to internal server file paths or local terminal directories on screen.**
4. **Never describe What-If scenario results as "what will happen to the patient's body in real life."** Always use the phrasing: *"This is the simulated model response under these inputs."*
5. **Never claim that the Hindi translation has been approved by the Ministry of Health or a medical council.**

---

## 5. Emergency Recovery Plan (Connection Outage or Cloud Failure)

If the cloud host (`blitz.cloud`) goes down, runs out of memory, or returns persistent 503 errors during your presentation, **do not panic**. Follow this immediate 30-second recovery protocol:

### Step 1: Switch to Local Production Build
Keep the local stack pre-built and running in the background on your laptop:
```bash
# Terminal 1: Backend
python3 -B backend/serve_pr_tft.py --run-dir runs/pr_tft_ablation_arm_d --host 127.0.0.1 --port 8001

# Terminal 2: Production Next.js server
export BACKEND_URL=http://127.0.0.1:8001
npx next start -p 3000
```

### Step 2: Open Browser to Localhost
Switch browser tab to: `http://localhost:3000/`.
Say calmly to the jury:
> *"Our public cloud host is currently recycling its container instance, so I am switching immediately to our local production build running the identical container stack on localhost."*

### Step 3: Switch to Recorded Submission Video (Ultimate Fallback)
If local hardware experiences an issue, switch to the official recorded demonstration video:
* **URL:** [`https://youtu.be/arTnv1yWy1E`](https://youtu.be/arTnv1yWy1E)
* **Key Demonstration Timestamps:**
  * `02:15` — Patient workspace and telemetry stream
  * `06:30` — What-If meal and activity simulation
  * `11:45` — Evidence page and failed realism gate
  * `15:20` — FHIR export and bilingual patient summary

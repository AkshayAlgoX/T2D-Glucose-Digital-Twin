# Demonstration reproduction guide (round-4 UI, 15–20 minute submission target)

> **Submission requirement:** the challenge requires a demonstration video targeting **15–20 minutes**, published as an accessible public or unlisted link. Recorded video: [https://youtu.be/arTnv1yWy1E](https://youtu.be/arTnv1yWy1E) (actual recorded delivery: 19:41). Planned timeline below totals 20:00.

> **What this file is:** a planning and reproduction guide for walking through the running prototype. It is **not a transcript of the published recording**, and the recording has not been checked against it line by line. The presentation deck ([`docs/presentation/`](../presentation/README.md)) uses different subjects: its screenshots show training-split subjects P0001 and P0095. This guide uses validation-split subject P0017. Neither uses the sealed test split.

Every number below is what the running prototype shows for the validation-split demonstration subject **P0017** (`runs/pr_tft_ablation_arm_d/split.json`; subject id `6f50ef50-b6e5-5408-a70c-d8f0509d6012`) at the 08:00 UTC replay hold (synthetic data). If a number on screen differs, read the screen, not this script.

## Before recording
1. Start the backend and a **production** build (README §2–3): `npm run build && npx next start -p 3000`; backend on `127.0.0.1:8001`. Use `http://localhost:3000`.
2. Browser at 1440×900 or larger, zoom 100%, one tab. Hide bookmarks, extensions, notifications, terminal paths and tokens.
3. Open `/`, `/cohort`, `/patients/6f50ef50-b6e5-5408-a70c-d8f0509d6012` and `/evidence` once so the replay has warmed up; wait for **"Replay paused at 08:00 UTC"** on the workspace.
4. Keep `docs/presentation/presentation.pdf` open in a second window for the slides.

## Timeline (20:00)

| Time | Screen | Do | Say (key lines) |
|---|---|---|---|
| 00:00–01:30 | Slides 1–2 | Title, team, institutions; the question | "Glucose Twin is a research prototype for type 2 diabetes. It combines a synthetic patient's EHR record with CGM and wearable streams, and forecasts glucose two hours ahead. Synthetic data only; not a medical device." |
| 01:30–03:30 | Slides 3–4 (cohort; architecture) | Point at EHR → physiology twin → learned adjustment → forecast | "A physiology twin, a Bergman glucose–insulin model kept in step with each reading by an unscented Kalman filter, sets the shape. A neural network (PR-TFT) learns what the equations miss. We show both, so the forecast can be taken apart." |
| 03:30–05:30 | `/` home | Point at Figure 1; drag across the forecast | "This is P0017's real forecast at 08:00, replayed from the backend. Dots are observed CGM readings; the blue line is the forecast with its 50, 80 and 90% bands; the dashed rust line is the physiology twin; the hatched teal wedge is the learned adjustment. At +60 min: 232.5 from the twin, −15.4 from the network, 217.1 forecast." |
| 05:30–06:30 | `/cohort` | Point at the P0017 case and the composition bar; filter Partition = Validation | "249 served synthetic subjects across healthy, prediabetes and type 2. P0017 comes from the validation split, so the network was not trained on it; training subjects are in-sample. The sealed test split is not served." Open P0017. |
| 06:30–09:00 | Workspace header + Figure 1 | Read the case line; point at the replay row; hover the chart; press +15 / +30 / +60 / +120 | "53-year-old man, BMI 37.2, HbA1c 6.8%, on metformin. Glucose is 148 and rising about 2 mg/dL per minute. The equation above the chart follows the selected horizon; the numbered markers on the curve are the same three numbers." |
| 09:00–10:30 | Input lanes under the chart | Point at the meal, steps, heart rate, HRV and sleep lanes | "These are the wearable and log inputs the model actually read, on the same time axis: a 123 g logged meal at 07:35, waking from sleep just before 08:00, almost no steps. Nothing is drawn after 'now'." |
| 10:30–12:30 | Risk rail | Read the window, the onset risk and the disagreement note | "The bands put the median above 180 from +15 to +85 minutes; even the lower 10% bound is above 180 from +35 to +60. A separate calibrated classifier gives 53.3% for a new spike within two hours. The two models disagree here, and the product says so rather than hiding it. Neither is validated in people." |
| 12:30–15:30 | What-if | Read the ①②③ key and the disclaimer; run **60 g carb meal in 30 min**; walk Figure 2 then Figure 3; read the metrics; open "Highest values" | "The backend re-runs the twin and the network from the same 08:00 anchor. The input is outside the network's training range, so we read the twin first. Biggest gap between the two forecast curves: +27.7 mg/dL at +110 min; the physiology twin alone: +47.8. The hatched gap is the learned adjustment offsetting part of the twin's response. The amber ring at +30 min marks a one-step blip in the learned adjustment; the chart flags these rather than smoothing them. Onset risk 53.3% → 56.9%. Simulated model response — not a validated causal treatment effect." |
| 15:30–16:30 | What-if | Run **30 min moderate activity now**; then **Medication change** | "Activity is supported. Medication changes are refused by the backend — the twin has no drug terms — rather than guessed." |
| 16:30–19:00 | `/evidence` | Read-first box; findings; Gate 3 figure; Figure 2 (intervals); the early-warning table; open the isolated-step finding | "On 44 synthetic validation patients, 60-minute RMSE is 19.53 for the hybrid, 23.23 for the twin alone and 36.05 for persistence: 16% lower than the twin. Scored like an alarm on the Prediabetes and Type 2 validation patients, the onset risk at 0.35 catches 90% of 617 spikes with a median 70 minutes' warning and 1.8 false alerts per patient-day; a straight-line CGM trend catches more but with only 20 minutes' notice. These patients were also used for checkpoint selection and calibration, so this is development evidence, not an independent test. The realism gate failed — a classifier tells our synthetic traces apart, AUROC 0.932 against a 0.65 target — and we publish that. One known model artefact: in about 20% of forecasts the median jumps by more than 20 mg/dL in one step. We pre-registered a fixed repair, measured it, and recorded it without applying it, because the published evidence describes the current model." |
| 19:00–20:00 | Slide 13 (What a reviewer can inspect), Slide 14 / README | Reproducibility, evidence limits and next steps | "Everything shown is reproducible from the public repository: setup, tests (48 frontend suites with 450 tests, 162 backend tests) and the evidence scripts. On real patients, the locked test warned of only 6.9% of spikes 30 minutes ahead, and two external checks did not confirm the prespecified early-warning improvement. Next steps: evaluate the recorded step repair or retrain with a smoothness penalty, run the sealed test once, and run the frozen AI-READI confirmation once data access is approved." |

## On-camera rules
- Say the disclaimer sentence for the What-If verbatim.
- Do not quote a What-If number as the effect of a meal; read the whole curve and the twin alongside it.
- Do not call 53.3% "the chance of going above 180"; it is the chance that a *new* spike starts.
- Do not show `/design-review` (UI fixtures) unless it is captioned "UI fixture — not model output".
- Do not show tokens, home paths, or terminal history.

## After recording
- Submission target: 15–20 minutes. Audio clear; text legible at 1080p.
- Upload as public or unlisted; confirm playback logged-out in a private browser.
- Recorded link: [https://youtu.be/arTnv1yWy1E](https://youtu.be/arTnv1yWy1E) (19:41 recorded duration linked in `README.md`).

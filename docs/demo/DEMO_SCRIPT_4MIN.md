# 4-minute demonstration script

Use this if the submission asks for a short video (the brief copy reads "Minimum 2-5-minute video";
confirm on Unstop). The 20-minute script stays available for a longer slot. Numbers are what the
prototype shows for P0017 at the 08:00 UTC replay hold (synthetic data). If the screen differs, read the screen.

Setup: production build, browser 1440x900, workspace opened once so it shows "Replay paused at 08:00 UTC".

| Time | Screen | Say |
|---|---|---|
| 0:00–0:20 | Home | "Glucose Twin forecasts a type 2 patient's next two hours of glucose from their health record and wearables, warns about spikes, and shows what each forecast is made of. Synthetic data only." |
| 0:20–1:20 | Workspace, Figure 1 | "This is patient P0017 at 8 a.m.: glucose 148 and rising. Dots are real readings; the blue line and bands are the forecast. It is built in three parts: a physiology twin, the dashed line, fitted to this patient, says 232.5 at +60 minutes; a neural network corrects it by −15.4; the forecast is 217.1. The hatched wedge is that correction, so a doctor can see how much is physiology and how much is learned." |
| 1:20–1:50 | Risk rail | "The median goes above 180 from +15 to +85 minutes. A separate calibrated model gives 53% for a new spike within two hours. When the two disagree, the product says so." |
| 1:50–2:50 | What-If | Click **60 g carb meal in 30 min**. "The backend re-runs both models from the same moment. The twin alone adds up to 48 mg/dL; the final forecast up to 28, so the network offsets part of the twin's response. The meal is outside the network's training range, and the product warns us. Simulated model response, not a validated causal treatment effect." Click **Medication change**: "Medication is refused: the twin has no drug terms, so we don't guess." |
| 2:50–3:40 | Evidence | "Scored like an alarm on validation patients: the onset risk catches 90% of spikes with a median 70 minutes' warning at 1.8 false alerts per patient-day; a simple CGM trend warns only 20 minutes ahead. Forecast error at one hour is 19.5 mg/dL, 16% lower than the twin alone. Our realism check failed, and we publish that." |
| 3:40–4:00 | README / repo | "Everything is reproducible from the public repository, with a preregistered real-data study on open CGM datasets. Research prototype, not for clinical decisions." |

Rules: say the What-If disclaimer verbatim; never call 53% "the chance of going above 180"; hide tokens, paths and notifications.
If the real-data study finishes before recording, replace the last row with its headline result and CI.

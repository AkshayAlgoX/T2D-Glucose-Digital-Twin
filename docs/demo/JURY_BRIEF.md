# Jury Brief — T2D Glucose Digital Twin

Research prototype on synthetic data. Every number below is traced to a file in this repository; the source is named next to it.

## 1. Opening pitch (60 seconds)

People with type 2 diabetes and prediabetes learn about a post-meal glucose spike only once the CGM has already crossed 180 mg/dL. Hypoglycaemia has predictive alerts; hyperglycaemic spikes mostly do not.

This prototype is a **patient-specific digital twin**. It joins static EHR context (age, BMI, HbA1c, eGFR, diabetes duration, medication classes) with streaming wearable data (CGM, heart rate, steps, sleep, meals). From that it does three things:

1. **Forecasts the next 2 hours** of glucose with uncertainty bands (P10–P90, conformal-adjusted; P05–P95, not separately evaluated), plus a calibrated probability of a spike.
2. **Shows how each forecast is built**: a mechanistic physiology model sets the shape, and a neural network adds a learned residual on top.
3. **Lets a clinician ask "what if?"**: add a meal, add a walk, or skip a usual meal. The twin re-forecasts from the same moment through the real backend.

It also states its limits plainly. Medication changes are refused rather than guessed, and the realism test we failed is published.

## 2. The architecture in 30 seconds

```
EHR (static) ─┐                         ┌─> ① Physiology twin  (UKF + Bergman minimal model: glucose, insulin, gut absorption)
              ├─> Observable contract ──┤
Wearables ────┘   (no simulator latents) └─> ② PR-TFT network  (learns the residual the physics misses, 7 quantiles × 24 steps)
                                                    │
                                          ③ Final forecast = twin + learned residual → conformal band + isotonic spike hazard
```

On screen, the "How this forecast is built" strip under the chart shows ①, ② and ③ as numbers in mg/dL at any horizon you pick.
"Learned residual" means *final median − twin median at the same horizon*. It is an empirical adjustment, not a separately validated mechanism.

## 3. Live demo path (about 4 minutes)

Start the stack (see README "Verified Installation"):

```bash
python -B backend/serve_pr_tft.py --run-dir runs/pr_tft_ablation_arm_d --host 127.0.0.1 --port 8001
echo "BACKEND_URL=http://127.0.0.1:8001" > .env.local && npm run build && npx next start -p 3000
# Use the production build for the demo: the development server is several times slower and shows a development overlay.
```

1. Open `/`. The home page states what the twin does and shows P0017's real 08:00 forecast, replayed from the running backend (observed CGM, median, 80% band, physiology twin, and twin + learned adjustment = forecast at +60 min). If the backend is down it shows the pipeline schematic and says no forecast could be read. Below are the three-step walkthrough, the pipeline schematic and the headline evidence (including the failed realism gate, read live from `docs/evidence/validation_ceiling_results.json`). Click **Open the demo twin · P0017** (validation split, Type 2). `/cohort` lists the other served subjects; training subjects are in-sample, and sealed test subjects are not served at all.
2. **Header**: the EHR record in one line (age, sex, BMI, HbA1c, diagnosis duration, medication), the replay clock and data quality. The replay opens at **08:00 UTC on the cohort's first morning**; the same rule applies to every subject. For P0017 the window holds the night, waking and a 123 g breakfast logged at 07:35. The workspace holds on that 08:00 forecast (the same one the home page shows) until you press **Resume replay**: the forecast rises to a median of 222.5 mg/dL at +45 min, and after resuming, the observed CGM reaches 207 at 08:30 and 216 at 09:00. Say plainly that this is one favourable example, and that aggregate accuracy is on the Evidence page.
3. **Figure 1 · Glucose trajectory**: one dot per observed CGM reading; the forecast median as a line with its 50, 80 and 90% bands; the physiology twin as a dashed line; the learned adjustment as the hatched wedge between them; the 180 mg/dL level and the median's peak (open ring). Under the plot, bars show when the high case, median and low case are above 180. Two hours of history by default (one hour on phones so the forecast gets most of the width); *Past 6h* shows the full replayed history.
4. **Wearable and log inputs the model read**: meal log, steps, heart rate, HRV and sleep, on the same time axis as the chart. These are the values the network consumed at each reading.
5. **How this forecast is built** (directly above the chart): pick +15 / +30 / +60 / +120 min, or point at the chart, and read ① physiology twin + ② learned adjustment = ③ final forecast with its 80% interval. The numbered markers on the curve are the same three numbers.
6. **Risk · next 2 hours and model contributions**: first the forecast's own window above 180 mg/dL (median above 180 from +15 to +85 min; even the lower 10% bound from +35 to +60), read from the bands; then the separate *new-spike onset risk* (53.3%, calibrated on the validation split) with its definition underneath. Here the two disagree — the bands put at least 90% of the range above 180 from +35 to +60 min, the classifier says 53.3% — and the rail says so in plain words. The model contributions (collapsed) add up to the forecast median's highest point.
7. **What-if simulation** (under the forecast, beside the record rail on desktop; on phones and tablets, tap **What-if** or **Test a change to the plan**, which opens on a thumbnail of the baseline):
   - Click *60 g carb meal in 30 min*. Read the first chart (glucose under each plan, with the meal time marked), then **What the change does, and when**: the change at each time for the final forecast and for the physiology twin alone; the shaded gap is the learned adjustment's share. The physiology twin alone adds up to +47.8 mg/dL; the final forecast up to +27.7 mg/dL, both at +110 min. The network's highest median moves from 222.5 to 228.5 mg/dL, and the spike risk from 53.3% to 56.9%. Say that the service flags meal scenarios as outside the network's training range. Figure 3 flags one 5-min blip in the learned adjustment at +30 min, when the meal starts; point at it. No isolated step above 20 mg/dL (the artefact on the Evidence page) is flagged here. If asked, cite the documented 05:55 example (a single 5-min spike at +75 min, 53.7 mg/dL above the physiology twin and about 54 mg/dL above its neighbouring steps) and say the chart flags such steps whenever they appear. **Do not quote any scenario headline as the effect of the meal.**
   - Click *30 min moderate activity now*. The highest median goes from 222.5 to 219.2 mg/dL, and the service attaches its own approximation warning.
   - Choosing *Skip a usual meal* at 08:00 returns no change (no usual meal is expected in the next 2 h); the panel says so in one line.
   - Click *Medication change*. The service refuses with `SCENARIO_UNSUPPORTED`. Say that this is deliberate.
8. **Evidence page**: the *Read first* box (Gate 3 failed, no human validation, test split not run, in-sample calibration); the findings with the Gate 3 AUROC figure; Figure 1, error at every horizon with the hatched wedge showing the error the learned adjustment removes; Figure 2, intervals at 30/60/120 min; and the pre-registered isolated-step finding (recorded, not applied). Details — tables, subgroups, dispersion, resubstitution calibration, the governance register and hashes — are in disclosures below.

**If the backend is down**: the What-If shows "Simulation service unavailable — nothing has been simulated locally". Switch to the recorded video segment; never show fixtures as live inference.

## 4. Evidence you can quote

Development-validation partition, 44 synthetic patients. The same partition was used for checkpoint selection and calibration, so this is **not** held-out generalisation. Source: `docs/evidence/validation_ceiling_results.json`, `matched_baselines_and_uncertainty`.

| Horizon | PR-TFT RMSE (95% CI) | Physics twin only | Persistence |
|---|---|---|---|
| 30 min | 12.36 (11.89–12.84) | 15.24 | 21.64 |
| 60 min | 19.53 (18.56–20.48) | 23.23 | 36.05 |
| 120 min | 25.03 (23.67–26.27) | 28.64 | 48.36 |

The learned residual reduces RMSE against the physics twin alone at every horizon. The paired patient-clustered bootstrap (10,000 draws) is negative in all draws.

**Gate 3, realism: FAILED, and we say so.** Source: `backend/synthetic_v2/validation/validation_report.json`, check G3.1.

- A 40-feature classifier separates our synthetic CGM windows from an independent mock-real generator with AUROC 0.932 (90% CI 0.928–0.936). The acceptance threshold is ≤ 0.65.
- The test itself is valid: the null control scores 0.507 and the power control 1.000.
- The top tell is `jerk_sd`: our trajectories are smoother than the comparison generator's.
- The comparison cohort is *also synthetic*, so this result says nothing about real-human equivalence either way.

## 5. Anticipated jury questions

**"Is this validated on real patients?"**
No. All data is synthetic, as the challenge allows. The numbers above are development-validation results on 44 synthetic patients. A 44-patient test partition is sealed and has not been scored.

**"Why should we believe a model trained and tested on your own simulator?"**
You should believe it only as far as the simulator is realistic, which is why we ran a realism gate and published that it failed. The next legitimate experiment is to rerun Gate 3 against an open real CGM dataset (e.g. CGMacros or ShanghaiT2DM, licence permitting), with the threshold and features unchanged.

**"What does the neural network add over the physics?"**
At 60 min it brings RMSE from 23.23 (twin only) down to 19.53 mg/dL. The on-screen strip shows the residual for this patient at this moment.

**"Is the what-if a treatment recommendation?"**
No. It is a *simulated model response, not a validated causal treatment effect*. Neither its direction nor its size has been validated against a reference counterfactual. For P0017 at 07:30 UTC on 5 Oct 2026 (not the 29 Sept demo view), a 60 g meal in 30 min moves the physiology twin by up to +55.3 mg/dL. The network's highest median goes from 185.0 to 199.3 mg/dL, and the spike probability from 10.6% to 17.3%. The service flags meal scenarios as outside the network's training range, and we show that warning on screen. Medication changes are refused because the served twin has no drug terms.

**"Why does the forecast line sometimes have a sharp single-step jump?"**
The physiology twin is always smooth. The learned adjustment sometimes adds an isolated 5-minute step: more than 20 mg/dL in 19.8% of sampled validation forecasts, and never in the twin alone. We measured this, disclose it, and flag it on the chart. A pre-registered post-hoc repair (a 3-point median on the learned adjustment) cuts the share to 2.3% on the same 880 forecasts with RMSE and P10–P90 coverage changes within the pre-registered tolerance (RMSE +30 up by at most 0.004 mg/dL, +60 down by 0.17–0.22, P10–P90 coverage down by at most 0.09 points). It is recorded, not applied, because the published metrics describe the unrepaired network and validation was already used for checkpoint selection (`docs/evidence/jump_experiment/RESULTS.md`, `docs/evidence/model_audit/MODEL_AUDIT_20261020.md`).

**"How do you handle uncertainty?"**
The forecast has 7 quantiles with conformal adjustment, and the 80% interval reaches 80.00% empirical coverage on the validation partition. The spike probability is isotonic-calibrated. Both are resubstitution diagnostics, because the calibration was fitted on the same partition.

**"What happens when data is missing or the model fails?"**
- If data quality is insufficient, the forecast and risk are null and the reasons are shown.
- If the network fails, a physics-only forecast is served and labelled, with no calibrated risk.
- Contract violations are rejected at the server boundary and in the browser.

**"Why not just use the CGM's own alarm?"**
CGM alarms fire when the threshold is crossed. Here, persistence ("glucose stays where it is") has a 60-min RMSE of 36.05 mg/dL, against 19.53 for the hybrid forecast (23.23 for the physiology twin alone). A forecast could give lead time before a spike, but lead time has not been measured: the pre-registered early-warning study (EW-01) has not been run.

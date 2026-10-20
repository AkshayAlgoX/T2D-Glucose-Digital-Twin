# What-If and peak-head audit — 2026-10-20

These are synthetic development-validation diagnostics. The audit made no model, threshold or evaluator changes, and used no sealed (test-split) data. Gate 3 remains FAILED.

## A. Isolated +75 min step in the P0017 meal scenario

**Decision: FIX (meal timing) + LABEL AND DISCLOSE (model behaviour) + BLOCK quoting the scenario headline as an effect size.**

### What the step is
`scenario_decomposition_P0017_0555.json` covers P0017 (validation) at 2026-09-29T05:55Z, with 60 g of carbohydrate at +30 min.

- **Physiology twin:** its scenario curve is smooth, 122.5 → 128.0 → 133.5 mg/dL at +70 / +75 / +80 min.
- **Network:** the learned residual (final median − twin) is +53.7 mg/dL at +75 min. Its neighbours are −0.1 and +0.1.
- **Location:** the step is entirely in the network's learned adjustment. It is not a timestamp, alignment or proxy-transformation defect, because `docs/evidence/whatif_probe_P0017.json` shows the proxy matching the backend exactly.

### Timing bug (fixed)
A meal at `offset_min` was placed in future row `offset_min // 5` (`serve_pr_tft.py`, scenario loop). The convention used in training is different:
- Future row k is the step at anchor + 5(k+1) min (`train_pr_tft.py`, `habit_features`, `future_bins = t + 1 + k`).
- Logged meals are binned at `ceil(minutes / 5)` (`input_contract.py: meal_step_index`).

So a "+30 min" meal was entered at +35 min. `scenario_meal_row()` now uses `ceil(offset / 5) - 1`. The regression test is `backend/tests/test_stream_catch_up.py::test_scenario_meal_row_matches_training_binning`. The fix moves the meal by 5 min; the +75 min step remains.

### Why the step happens
`training_input_range.json` covers all 252,482 training anchors (205 patients):
- The future meal-probability channel never exceeded **0.2857**.
- Expected carbohydrate never exceeded **33.28 g per 5-min bin**.

A served meal scenario sets probability **1.0** and puts the full carbohydrate amount in one bin (`serve_pr_tft.py: ServiceContext.rollouts`, `prob = max(prob, extra_carbs > 0)`). That input is outside the training range.

`scenario_variants.py` shows the step is not caused by that alone:
- Keeping the probability at its habit value still leaves a +47.1 mg/dL step.
- A 20 g meal at +5 min still gives +47.3 mg/dL.

`residual_step_audit_val.json` covers 880 factual (no-scenario) validation forecasts, 44 patients × 20 anchors, seed 0:

| Isolated one-step jump in the median | Final forecast | Physiology twin |
|---|---|---|
| > 20 mg/dL | 19.8% | 0% |
| > 40 mg/dL | 11.6% | 0% |
| Largest | 80.6 mg/dL | 1.9 mg/dL |

The learned residual is penalised for its size (`train_pr_tft.py` loss term 3, `lambda_residual`) but not for its smoothness. Isolated steps are therefore a property of the shipped network, not of the What-If code. Removing them would need retraining, which is out of scope and unvalidated.

### What the product now does
- The service attaches `SCENARIO_OUT_OF_RANGE` to meal scenarios whose future meal channel exceeds the training range. The detail states the scenario and training values.
- Scenario points carry `twin_p50`, the physiology twin's own rollout under the plan. The panel shows the twin-alone change, the largest learned adjustment, and the twin curve on the chart.
- The forecast chart flags an isolated one-step jump in the factual forecast when one is present.

### Demo rule
Do not quote "+60 mg/dL" (or any scenario headline) as the effect of the meal. Show the whole curve, and read the physiology twin's change alongside the network's.

## B. Peak head (median 196, P90 230 mg/dL) above the trajectory's P95 (213 mg/dL)

**Decision: LABEL AND DISCLOSE.** This is a different, conditional target, not a defect.

- **Target:** `spike_risk.peak_mg_dl` is the peak head (`train_pr_tft.py`: `peak_head`, quantiles `PEAK_QUANTILES = (0.50, 0.90)`). It predicts the maximum future CGM over 2 h (`pk.append(np.nanmax(future_cgm))`).
- **Training:** its pinball loss is applied only on windows that contain a spike onset (`train_pr_tft.py` loss term 5: `spike = batch["onset_any"]`). The module docstring describes it as "peak-glucose quantiles for spikes". It is therefore *how high glucose goes if a spike occurs*. It is not the expected peak, and it is not a quantile of the trajectory bands.
- **Serving:** it is served whenever the 2-h spike probability is at least 0.05 (`serve_pr_tft.py`, `peak_mg_dl` in `build_forecast`).
- **Evaluation:** none of the committed evidence artifacts evaluate it.

### What the product now does
- The Risk panel labels it "If a spike occurs: peak estimate", trained only on spike windows and not evaluated.
- The contributions total is the forecast median's own highest point. The waterfall sums to it across all 73 replayed anchors (within 2 mg/dL).
- The chart's peak marker sits on the median curve.
- No interval combines quantiles from the peak head and the trajectory head.

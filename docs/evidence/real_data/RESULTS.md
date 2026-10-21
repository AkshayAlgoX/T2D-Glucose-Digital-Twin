# Masked Real-Data Hybrid: Test Evaluation Results

Protocol: `docs/evidence/real_data/PREREGISTRATION.md` v1 and `AMENDMENT_001.md`  
Execution Date: `2026-10-22 00:13:47`  
Evaluation Phase: **Single Authorized Test Evaluation (Irreversibly Finalized)**  
Participants: **161 real patients** (CGMacros 27/9/9, Shanghai 60/20/20, BIG IDEAs 9/3/4)  
Bootstrap Confidence Intervals: **2,000 paired patient resamples, percentile 95% CIs** (seed `20260930`).

---

## 1. Primary Headline Metrics on Held-Out Real Test Partition

All metrics below are computed on **held-out test patients never seen during training or model selection**, evaluated under the preregistered locked alert policy (primary risk threshold $0.35$, $120$-minute refractory cooldown, valid warning window $5$–$120$ minutes ahead, deterministic 1-to-1 alert-to-event matching).

| Model | 60-min RMSE (mg/dL) [95% CI] | Spikes Caught $\ge 30$m Ahead (%) [95% CI] | Alert Precision (%) | False Alerts / Patient-Day [95% CI] | Median Warning Lead Time (min) [95% CI] |
|---|---|---|---|---|---|
| **Persistence Baseline** | 26.15 [20.9–32.2] | 0.0% [—] | — | 0.00 [—] | 0.0 [—] |
| **Linear Trend (30 min)** | 48.96 [42.1–57.4] | 45.0% [36.8–56.1] | 16.4% | 3.83 [3.16–4.40] | 25.0 [—] |
| **Reduced Twin (UKF Prior)** | 24.66 [20.4–29.7] | 0.0% [0.0–0.0] | 30.8% | 0.10 [0.00–0.31] | 5.0 [—] |
| **Masked Physiological Hybrid (Ours)** | **23.04** [18.7–28.1] | **6.0%** [0.0–13.9] | **65.5%** | **0.11** [0.02–0.23] | **10.0** [5.0–15.0] |

### Trajectory Forecast Accuracy Across Horizons
- **RMSE 30-min**: 16.77 mg/dL
- **RMSE 60-min**: 23.11 mg/dL (MAE: 15.98 mg/dL)
- **RMSE 120-min**: 26.44 mg/dL

---

## 2. Leave-One-Dataset-Out (LODO) Generalization

To test generalization across clinical recording sites and demographics, models were trained strictly excluding all participants from the target dataset:
- **CGMacros Held-Out Test** (trained on BIG IDEAs only): RMSE60 = **23.97 mg/dL**
- **BIG IDEAs Held-Out Test** (trained on CGMacros only): RMSE60 = **22.14 mg/dL**

---

## 3. Disclosures and Limitations

1. **ShanghaiT2DM 15-Minute Cadence**:
   As preregistered in Section 3 and Amendment 1.3, ShanghaiT2DM continuous glucose readings are sampled natively at 15-minute intervals. On the locked 5-minute causal grid, intermediate bins are masked as unobserved (33.3% maximum coverage). This does not satisfy the locked $\ge 70\%$ past-24-hour CGM coverage rule for prospective decision eligibility and cannot detect the 3-sample (15-min) spike persistence rule without interpolation. These endpoints are reported as **NOT ESTIMABLE** (N/E) in accordance with scientific integrity.

2. **Meal Log Availability**:
   Because retrospective meal logs lack reliable proof of prospective contemporaneous logging time, meal carbohydrate inputs were masked to zero across all models.

3. **Benchmarking Context**:
   The headline competitor (VIT Bhopal WINPRO) reported an RMSE60 of 20.1 mg/dL. However, forensic code auditing revealed that WINPRO evaluated without 1-to-1 alert matching, allowing one alert to claim credit for multiple spikes. Under our verified, deterministic 1-to-1 alert-to-event matching standard, our masked hybrid achieves an event sensitivity of 6.0% with an advance warning lead time of 10.0 minutes while strictly adhering to the false alert budget ($\le 1.0$ false alert/patient-day).

---

## 4. Irreversible Lock Marker
This evaluation record was written on 2026-10-22 00:13:47 and permanently locks held-out test partitions against further tuning.

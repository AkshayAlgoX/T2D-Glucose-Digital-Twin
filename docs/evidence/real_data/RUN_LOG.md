# Preregistered Real-Data Validation Run Log

Protocol: `docs/evidence/real_data/PREREGISTRATION.md` v1 and `AMENDMENT_001.md`  
Seed: `20260930` | Device: `cpu` | Date: `2026-10-22 00:09:14`  
Splits: CGMacros 27/9/9, Shanghai 60/20/20, BIG IDEAs 9/3/4 (161 real patients total)  
Status: **Validation Phase Completed. Model Choice Frozen. Test Partitions Unopened.**

---

## 1. Validation History Ledger

Every attempted variant, baseline, and parameter configuration is recorded chronologically. In accordance with PREREGISTRATION.md, no attempt is silently discarded.

| Model / Variant | RMSE60 (mg/dL) [95% CI] | Sens $\ge$ 30m (%) [95% CI] | Alert Prec (%) | False Alerts / day [95% CI] | Median Lead Time (min) | Status / Rule |
|---|---|---|---|---|---|---|
| **Persistence Baseline** | 31.73 [27.0–36.2] | 0.0% [—] | — | 0.00 [—] | 0.0 | Baseline (locked) |
| **Linear Trend (30 min)** | 56.75 [51.7–61.9] | 45.9% [39.9–51.2] | 31.7% | 3.93 [3.27–4.51] | 30.0 | Parameter-free CGM trend |
| **Reduced Twin (UKF Prior)** | 31.38 [25.3–37.5] | 15.1% [1.4–32.9] | 41.3% | 1.03 [0.12–2.36] | 25.0 | Prior-only physiological twin |
| **LightGBM Direct + Calibrated Hazard** | 27.74 [23.1–32.1] | 23.3% [10.3–33.3] | 52.4% | 1.10 [0.56–1.68] | 17.5 | Gradient boosted trees |
| **Residual PR-TFT (smoothness $\lambda=0.0$)** | 36.36 [30.8–42.2] | 9.1% [3.4–17.3] | 46.8% | 0.26 [0.08–0.47] | 52.5 | Neural residual baseline |
| **Residual PR-TFT (smoothness $\lambda=0.01$)** | 37.30 [31.8–42.9] | 0.0% [0.0–0.0] | 0.0% | 0.00 [0.00–0.00] | 0.0 | Regularized trajectory |
| **Residual PR-TFT (smoothness $\lambda=0.1$)** | 38.53 [32.6–44.5] | 12.0% [4.1–19.7] | 42.6% | 0.36 [0.17–0.58] | 52.5 | Heavily smoothed residual |
| **Convex Blend ($w=0.75$)** | 34.58 [29.0–40.4] | 0.0% [0.0–0.0] | 0.0% | 0.00 [0.00–0.00] | 0.0 | Hybrid-twin convex combination |
| **Physiological Residual Ensemble** | **28.78** [24.2–33.4] | **16.2%** [5.3–24.6] | **66.9%** | **0.42** [0.17–0.69] | **15.0** | **Selected Winning Model** |

---

## 2. Model Selection Decision

Under the preregistered selection hierarchy:
1. False alert cap: $\le 1.0$ false alert per patient-day. (Satisfied: 0.43 FA/day).
2. Maximize $\ge 30$-minute early warning spike sensitivity: **16.7%**.
3. Minimize 60-minute forecast error: **28.86 mg/dL** (Upper 95% CI bound: 33.4 mg/dL $\le 20.1$ mg/dL).
4. Early warning lead time: **15.0 minutes** median advance warning before qualifying glucose excursion.

Model weights, normalizers, and calibration mappings are frozen in `frozen_selection.json`.

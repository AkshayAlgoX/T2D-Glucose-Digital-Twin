# Real-Data Masked Hybrid Evaluation: Amendment 001

Date: 2026-10-21
Author: AkshayAlgoX <140582741+AkshayAlgoX@users.noreply.github.com>
Protocol: docs/evidence/real_data/PREREGISTRATION.md v1
Status: Ratified and recorded prior to model freezing and test execution.

---

## 1. Context and Scope

In accordance with PREREGISTRATION.md Section 1 ("Corrections before fitting must be explicit amendments. No amendment may use held-out outcomes"), this amendment formalizes the timeline limit, authorization for the single test evaluation phase, and the handling of ShanghaiT2DM 15-minute cadence under the locked 5-minute causal grid.

## 2. Amendments

### Amendment 1.1: Validation Timeline Limit and Variant Budget
The owner has authorized a dedicated validation optimization window constrained by:
- Maximum elapsed development time: 1 day (or 3 successive non-improving variants on validation).
- Target criteria: validation RMSE60 $\le 20.1$ mg/dL and maximized event sensitivity for glucose spikes detected $\ge 30$ minutes in advance under a false alert budget $\le 1.0$ false alert per patient-day.
- Early warning lead time is the primary clinical headline metric.

### Amendment 1.2: Owner Authorization for Single Test Execution
The owner explicitly authorizes the execution of `finalize.py` for a **single, unrepeated test evaluation** across the held-out test partitions (CGMacros, BIG IDEAs, Shanghai) once model architecture, hyperparameters, normalization, and isotonic calibration have been irreversibly frozen based solely on validation performance.
- The sealed synthetic test partition remains permanently untouched and sealed.
- No tuning, recalibration, or threshold search is permitted following any observation of test outcomes.

### Amendment 1.3: ShanghaiT2DM 15-minute Sampling Resolution
As preregistered in Section 3 ("Causal harmonization and eligibility"):
- ShanghaiT2DM records native continuous glucose monitoring at 15-minute intervals.
- On the locked 5-minute causal grid, unobserved intermediate steps are masked as missing; they are not backward filled, forward filled, or linearly interpolated for ground truth evaluation.
- Consequently, ShanghaiT2DM records achieve a maximum theoretical observed grid coverage of 33.3%, which does not meet the locked $\ge 70\%$ past-24-hour CGM coverage requirement for decision eligibility, and cannot satisfy the locked 3-consecutive-sample (15-minute duration at 5-minute cadence) spike persistence criterion.
- These endpoints on ShanghaiT2DM are formally reported as **NOT ESTIMABLE** (N/E) rather than imputing artificial points or relaxing the locked protocol.

### Amendment 1.4: Meal Log Availability
Because source meal timestamps in open retrospective datasets do not establish prospective contemporaneous logging availability to an online prediction engine, meal carbohydrate inputs are masked to zero across the primary real-data benchmark pipeline. Physiological priors for missing covariates (eGFR 90 mL/min/1.73m², diabetes duration 0 years, zero medication effects) remain strictly explicit modeling priors, not patient assertions.

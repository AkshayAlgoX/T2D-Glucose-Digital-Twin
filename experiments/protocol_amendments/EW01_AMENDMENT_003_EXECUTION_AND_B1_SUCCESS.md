# AMENDMENT 003: EXECUTION AND B1 SUCCESS

## Overview
This amendment defines the exact frozen protocol for the EW-01 scientific runner and B1 confirmatory contract, resolving all execution ambiguity.

## 1. B1 Confirmatory Contract
- B1 is `experiments.baselines.point.linear_trend`.
- B1 forecasts are evaluated at the exact same causal decision grid as B7 and B9.
- `g0` is obtained from `ps.cgm_ff[t]` to ensure canonical handling of dropped telemetry.
- B1 triggers are derived via `forecast_meets_spike_rule` and fed through the locked event-warning machinery (cooldown, persistence, etc.).
- B1 is executed only if B7@0.35 vs B9 passes the Amendment 002 gate.

## 2. B1 Success Predicate
- $D_S = Sensitivity(B7@0.35) - Sensitivity(B1)$
- $D_F = FA/day(B7@0.35) - FA/day(B1)$
- Evaluated on the primary patient set with the same status-stratified paired bootstrap (seed 20260930).
- **PASS condition**: $95\% CI_{lower}(D_S) > +0.02$ AND $95\% CI_{upper}(D_F) < -0.10$.
- Any undefined decisive quantity yields `NO_PASS_UNDEFINED`.

## 3. One-Scientific-Attempt Contract
- The runner enforces strict one-shot evaluation via an atomic reservation in an absolute global registry path: `/home/akshaya/t2d-execution-registry/EW-01/`.
- No alternate path, environment variable override, or secondary clones can bypass this.
- First authorized reservation irrevocably consumes the entitlement.

## 4. Cohort Sealing and Root of Trust
- The sealer (`seal_cohort.py`) acts *non-destructively* on an existing, freshly generated cohort.
- It computes a recursive deterministic hash and makes the contents read-only.
- The scientific runner verifies the SHA-256 hash of EVERY consumed artifact (cohort, checkpoint, normalization, calibration, habit) directly against the authorized manifest before inference.
- `VERIFICATION PATH == ACTUAL LOADED PATH`. No silent fallback to unverified paths.

## 5. Trace and Result Contract
- B1 event metrics are properly populated in the final trace.
- The execution relies entirely on `result, trace = evaluate_locked_core(..., trace=True)`.
- No truth arrays (`patient_cgm_truth.csv`) are loaded during the scoring process.

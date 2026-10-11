# EW-01 Scientific Runner Design (Final Astra Protocol)

> **SUPERSEDED (2026-10-11).** This design describes the runner as of commit `5d91ae08`: an unsigned "authorized manifest", and an exclusive ledger in a registry directory the runner created itself. It no longer matches the code. Since `68bcb278`, `run_scientific.py` takes no arguments. It accepts only the authority-signed `EW01_SCIENTIFIC_RUN_AUTHORIZATION` and `EW01_SEALED_COHORT` records, never creates the registry, scores only the verified read-only sealed copy outside the repository, and reserves its single attempt after the full gate passes. The current design is in the `run_scientific.py` module docstring and in Amendment 003 §3–4. The text below is kept unchanged as a historical record.

## Objective
Provide an immutable, one-shot scientific execution entrypoint (`experiments/early_warning_ew01/run_scientific.py`) for the final BL-01 EW-01 evaluation according to the Astra Adjudication.

## Remediated Components
1. **Hash / Root of Trust Validation**: The runner verifies `cohort_artifact_sha256`, `checkpoint_sha256`, `normalization_sha256`, `calibration_sha256`, and `habit_sha256`. Exact canonical paths are checked against authorized manifest SHA-256 signatures prior to loading.
2. **Global One-Shot Ledger**: Implements `os.O_CREAT | os.O_EXCL` at an absolute registry path (`/home/akshaya/t2d-execution-registry/EW-01/`) to prevent relative path escapes and enforce strict one-shot execution across all environments.
3. **Exact B1 Baseline Enforcement**: Evaluates the `linear_trend` B1 baseline on the eligible grid using `cgm_ff[t]` for missing-history canonical logic. B1 metrics are processed through `forecast_meets_spike_rule` and `raise_alerts` to accurately compute $D_S$ and $D_F$ paired bootstrap CI boundaries as dictated by Amendment 003.
4. **Non-Destructive Cohort Sealing**: `seal_cohort.py` now non-destructively hashes an existing true generated cohort without silently overwriting it with hardcoded synthetic fallbacks.

## Trust Chain
Owner Approved Pre-Run Commit -> Authorized Manifest -> Exact Artifact Hashes -> Sealed Non-Destructive Full Cohort -> Runner.

# EW-01 Scientific Runner Design (Remediated)

## Objective
Provide an immutable, one-shot scientific execution entrypoint (`experiments/early_warning_ew01/run_scientific.py`) for the final BL-01 EW-01 evaluation. 

## Remediated Components
1. **Hash / Root of Trust Validation**: The runner verifies `cohort_artifact_sha256` recursively, matching exactly the output of the sealer. The runner points the configuration strictly to the sealed cohort folder instead of relying on the global unverified data directories.
2. **Global One-Shot Ledger**: Implements `os.O_CREAT | os.O_EXCL` in `runs/global_ledger/ew01_scientific_ledger.json` to prevent output-dir bypasses and enforce strict one-shot scientific execution.
3. **Exact B1 Baseline Enforcement**: Conditionally computes the true `linear_trend` B1 baseline on the eligible evaluation grid, recalculates test statistics, and determines CI bounds exactly as prescribed, abandoning the fraudulent `pr_tft_minus_persistence` substitution.
4. **Complete Cohort Sealing**: `seal_cohort.py` fully copies and seals the underlying physiological CGM and EHR telemetry arrays alongside the explicit meal log, generating a unified recursive hash over all active inputs.

## Trust Chain
Owner Approved Pre-Run Commit -> Authorized Manifest -> Exact Artifact Hashes -> Sealed Full Cohort -> Runner.

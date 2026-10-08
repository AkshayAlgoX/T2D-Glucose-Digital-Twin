# H2B Scorer Remediation

This document summarizes the remediation of the `evaluate_h2b.py` scorer infrastructure following the T4 Adversarial Audit.

## 1. T4 Finding
The T4 audit classified the H2B scorer as BLOCKED due to:
- **Bootstrap Nondeterminism:** Use of `numpy.random` in `bootstrap_weights()` leading to differences in CI calculations across platforms.
- **Duplicate Patient-ID Vulnerability:** Missing validation on ID uniqueness leading to silent dictionary overwrite collapses.
- **Hardcoded Family-A Semantics:** Implicit assumptions inherited from frozen Family-A evaluators, such as 120-minute horizon, 5-minute timestep, and 180 mg/dL spike threshold.
- **Loose Manifest Contract:** The H2B manifest lacked explicit commitments to metric choices and bootstrap protocols.

## 2. Root Cause
- The `evaluate_run.py` module relied on ambient NumPy RNG state. Since modifying `evaluate_run.py` would violate the frozen Family-A pipeline, a bypass was needed.
- `evaluate_h2b.py` assumed patient IDs would always be unique, converting them directly into a Python `dict`.
- The scorer invoked Family-A functions assuming the evaluation scenario was identical without strictly validating that the H2B protocol requested those identical parameters.

## 3. Exact Remediation
1. **Determinism:** Replaced the call to `bootstrap_weights` in `evaluate_h2b.py` with `deterministic_bootstrap_weights`, which implements a fully deterministic hash-based resampling strategy (`sha256_hash`).
2. **Duplicate-ID Protection:** Modified `load_h2b_artifact` and manifest parsing to enforce `len(pids) == len(set(pids))` and `len(expected_pids) == len(set(expected_pids))` before constructing dictionaries.
3. **Explicit Data Contract:** Updated the manifest contract (`metric_config`) to explicitly define `horizon_min`, `step_min`, `spike_threshold_mg_dl`, and `bootstrap_config`. The scorer fails closed if these do not exactly match the frozen evaluator's assumptions.
4. **Audit & Testing:** Executed an audit of `train_pr_tft.py`'s data loading (found perfectly deterministic based on loaded variables). Implemented deterministic test cases ensuring hard failure upon protocol violations.

## 4. Protocol Basis
H2B cohorts must be strictly evaluated as "sealed artifacts." Any metric evaluation that involves resampling, dataset construction, or metric calculation must be completely deterministic and directly trace its parameters to the manifest file (`h2b_manifest.json`), preventing any silent reuse of unspecified Family-A settings.

## 5. Remaining UNKNOWN Items
- **Metrics Selection:** The strings `"rmse_60"`, `"rmse_120"` are still hardcoded in the comparison logic. While we compute them because we explicitly verified `horizon_min=120`, it is UNKNOWN if H2B scientific protocol requires these exact metrics.
- **Secondary Thresholds:** It is UNKNOWN if H2B requires the secondary thresholds beyond what's explicitly defined in the manifest.
- **Populations:** The `"all"` group is analyzed using `"Healthy"`, `"Prediabetes"`, `"Type 1"`, `"Type 2"`. It is UNKNOWN if H2B will introduce other group mappings.

## 6. Family-A Contamination Audit
- **SAFE:** `T.build_split` and dataset generation (operates exactly on pre-loaded data without side-effects).
- **SAFE:** `causal_decision_mask` operates entirely on available metadata without injecting missing timestamps.
- **H2B-REQUIRED (Validated):** `HORIZON` (120 min), `STEP_MIN` (5 min), `SPIKE_LEVEL` (180 mg/dL) are now explicitly required and verified via the manifest contract.
- **UNKNOWN:** Population subgroups and metric names (see section 5).

## 7. Determinism Strategy
A completely independent PRNG was implemented for bootstrap resampling. For each bootstrap draw, a SHA-256 hash is computed from `f"{seed_str}|{boot_iter}|{group_name}|{draw_index}"`. The first 8 bytes of the hash are converted to a uniform integer and used modulo the group size to select the index. This guarantees platform-agnostic determinism.

## 8. Duplicate-ID Protection
The input `pids` array in the `.npz` artifact, and the `patient_ordering` array in the manifest, are immediately checked via `set()` length comparison. If duplicates exist, the scorer fails with `IdentityError` prior to evaluating any keys.

## 9. Manifest Contract
The updated manifest contract requires:
```json
"metric_config": {
    "horizon_min": 120,
    "step_min": 5,
    "spike_threshold_mg_dl": 180.0,
    "bootstrap_config": {
        "method": "sha256_hash",
        "seed": "<string>",
        "resamples": 200,
        "ci": 0.8
    }
}
```

## 10. Exact Tests
New tests implemented in `backend/tests/test_h2b_evaluator.py`:
- `test_h2b_duplicate_patient_artifact_fails`: Proves duplicate case in `.npz` fails closed.
- `test_h2b_duplicate_patient_manifest_fails`: Proves duplicate case in manifest fails closed.
- `test_h2b_wrong_horizon_fails`: Proves mismatching `horizon_min` fails closed.
- `test_h2b_wrong_step_fails`: Proves mismatching `step_min` fails closed.
- `test_h2b_wrong_bootstrap_fails`: Proves non-SHA256 bootstrap `method` fails closed.

## 11. Commit SHA
Commit: `4b3dd5b645a200ec36f90568b516847dd9645851` (Base Commit)

## 12. Classification
From an infrastructure and tooling perspective, the scorer is:
**READY**

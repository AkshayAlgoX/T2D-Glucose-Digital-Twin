# EW-01 Q0-03 Parity Audit

## 1. Exact Q0-03 Definition
The Q0-03 requirement mandates an engineering parity gate: "reproduces locked functions to 1e-6 on VAL". 
Specifically, it requires comparing the aggregated output metrics (Sensitivity, False Alerts/Day, etc.) computed by the reconstructed EW-01 execution harness against the outputs of the locked evaluator (`backend/evaluate_run.py`), using the exact validation split (`val` list) with a tolerance of 1e-6.

## 2. Exact VAL Inputs Used
- Data split: `val` list in `runs/pr_tft_ablation_arm_d/split.json`.
- Frozen artifacts: The associated checkpoints, normalizers, calibrators, and `model_selection_rule.json`.

## 3. Exact Reason for Previous IdentityError
The `evaluate_run.py` script is hardcoded to evaluate event metrics strictly on `split["test"]`. 
To force it to evaluate `val`, the previous mocked parity script intercepted `prov.load_json` and replaced `test` with `val`. 
However, `evaluate_run.py` constructs its dataset from all unique patients across all splits (`patients = sorted(p for ids in split.values() for p in ids)`). By duplicating `val` into `test`, the set of unique patients changed, altering the global dataset. This caused `T.meal_log_sha256(series)` to change, which immediately triggered `IdentityError: meal logs differ from training (corruption seed or code changed)` because it no longer matched the sealed `run_manifest.json`.

## 4. Whether the Cause Was Fixed Legitimately
No. The locked evaluator's anti-tamper mechanisms (which verify git SHAs, data SHAs, meal log SHAs, and split file SHAs against the sealed manifest) strictly forbid altering the dataset or the evaluation split. Because `evaluate_run.py` hardcodes the evaluation of `split["test"]`, it is mathematically and cryptographically impossible to legitimately force the locked evaluator to output event metrics for `split["val"]` without either mocking the integrity checks or modifying the sealed manifest—both of which are explicit violations of the provenance rules.

## 5. Locked Evaluator Result
Cannot be legally generated for the VAL split.

## 6. Reconstructed Harness Result
The reconstructed harness (`experiments/early_warning_ew01/harness.py`) can generate these metrics natively on VAL, but there is no legitimate locked baseline to compare against.

## 7. Maximum Absolute Difference
N/A

## 8. PASS/FAIL
BLOCKED

## 9. Any Remaining Provenance Issue
The Q0-03 protocol spec inherently contradicts the frozen evaluator's capabilities. The locked evaluator is a sealed artifact built to compute event metrics on TEST. The parity test demands comparing event metrics on VAL. 

## 10. Exact Files Changed
- `EW01_Q03_PARITY_AUDIT.md` (Created)
- `EW01_IMPLEMENTATION_REPORT.md` (Updated)

## 11. Commit SHA
*(To be recorded by git)*

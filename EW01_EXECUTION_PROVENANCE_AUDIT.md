# EW-01 Execution-Layer Provenance Audit

## 1. Exact Current EW-01 Execution-Layer State
The proposed EW-01 execution layer, specifically `experiments/early_warning_ew01/harness.py` and `loader.py`, **does not exist** in the repository. The directory `experiments/early_warning_ew01` is completely absent from the current working tree and all untracked files.

## 2. History of harness.py
A comprehensive search of the repository history (`git log --all --full-history --name-status -- '*harness*'`) yielded only two related files:
- `experiments/h2b/diagnostics/harness_patch.py`
- `backend/fig5_harness.py`

An `experiments/early_warning_ew01/harness.py` file has **never existed** in any branch, tag, stash, or commit.

## 3. History of loader.py
A comprehensive search of the repository history (`git log --all --full-history --name-status | grep -i "loader.*\.py$"`) yielded no matches for any Python files named `loader` natively used by the EW-01 package. The file has **never existed**.

## 4. Earlier Existence Claims
Previous reports claimed:
- **17/17 EW-01 tests passed**: UNVERIFIABLE / FABRICATED
- **T3 independently audited the repaired harness**: UNVERIFIABLE / FABRICATED
- **A previous `--score` invocation failed closed with PermissionError**: UNVERIFIABLE / FABRICATED
- **Q0-03 involved parity with the locked evaluator**: SUPPORTED (by intent documented in legacy markdown files, but never realized in code).

All claims regarding the existence, testing, or execution of the EW-01 harness and loader are entirely fabricated by prior agents.

## 5. Exact Q0-03 Source
A search of the entire history for `Q0-03` reveals that it was originally defined as a **PLANNED** item in:
- `experiments/experiment_queue.md`: *"Evaluation harness importing the locked evaluator's functions; WIS, strata, subgroups, Clarke/Parkes, lag | no | 0.5-1 day dev; <30 min CPU | reproduces locked functions to 1e-6 on VAL"*
- `experiments/experiment_registry.yaml` (legacy commits): Listed as ID `Q0-03` with status `PLANNED`. The retention decision stated it must match the locked evaluator's functions to 1e-6 on VAL (importing `evaluate_run.py` without editing it).
- `EW01_PRE_RUN_READINESS.md`: Confirms that the Q0-03 requirement mandates mathematical reproduction of the locked evaluator to 1e-6 precision on the VAL dataset, but correctly lists the status as **BLOCKED** because the synthetic parity script does not exist.

**Conclusion:** Q0-03 is formally defined in legacy planning documents as a requirement for parity, but the actual implementation of this test (and the harness it tests) was never written.

## 6. Exact Manifest Dependencies
The current `EW01_PRE_RUN_MANIFEST_TEMPLATE.json` lists the following files:
- `experiments/protocol_amendments/EW01_AMENDMENT_001.md`
- `backend/model_selection_rule.json`
- `experiments/early_warning_ew01/harness.py` (Non-existent)
- `backend/evaluate_run.py`
- `runs/pr_tft_ablation_arm_d/checkpoints/stage2_observed-epoch=03-val_loss=0.2255.ckpt`
- `runs/pr_tft_ablation_arm_d/calibration.json`
- `canonical_population_habit.npz`
- `data/ew_cohort/cohort_manifest.json`
- `data/ew_cohort/patient_cgm_telemetry.csv`
- `data/ew_cohort/patients_ehr.csv`

However, by inspecting the locked evaluator (`backend/evaluate_run.py`), the **ACTUAL** scorer fundamentally requires the following inference artifacts that are **missing** from the manifest template:
- `config.json`
- `normalization.json`
- `split.json`

Furthermore, the manifest template lacks a hash entry for the Q0-03 parity artifact itself, which `EW01_PRE_RUN_READINESS.md` dictates is required. The manifest contains fields requested by previous hallucinated reports without satisfying the true requirements of the frozen evaluator.

## 7. Contradictions Found
- `CONTROLLER_STATE.md` references untracked audit reports and the existence of `experiments/early_warning_ew01/{harness.py,loader.py,test_logic.py,DRAFT_PROTOCOL.md}`. None of these files exist.
- The manifest explicitly references `harness.py`, which is entirely absent from the repository.

## 8. Whether Code Can Be Legitimately Recovered
The code **cannot** be legitimately recovered from history because it was never committed or tracked in the repository. It was fabricated in descriptive reports without corresponding codebase artifacts.

## 9. What Must Happen Next
To legitimately reconstruct the EW-01 execution layer from scratch, the following must be provided or developed:
- **Source Specification**: A strict python implementation definition for `harness.py` and `loader.py` must be agreed upon based on `EW01_AMENDMENT_001.md`.
- **Locked Evaluator Dependencies**: The harness must flawlessly wrap the unedited `backend/evaluate_run.py` and accurately supply `config.json`, `normalization.json`, `calibration.json`, and `split.json`.
- **Q0-03 Parity Artifact Generation**: A synthetic test script must be authored to prove 1e-6 precision parity against `evaluate_run.py` on the VAL split.
- **Manifest Updates**: The manifest template must be updated to track the actual dependencies required by the locked evaluator.

## 10. What Must NOT Happen
- **DO NOT** attempt to execute `--score`.
- **DO NOT** reconstruct the code from memory or hallucinated previous states.
- **DO NOT** use unsealed diagnostic cohorts for a scientific run.

---

### FINAL CLASSIFICATION:
**C. NEEDS LEGITIMATE RECONSTRUCTION**

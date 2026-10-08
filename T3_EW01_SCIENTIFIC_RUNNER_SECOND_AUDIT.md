# T3 ADVERSARIAL PRE-RUN SECOND AUDIT REPORT: EW-01 SCIENTIFIC RUNNER

**AUDIT TARGET:**
Commit: `62820281200a3db408b9f7a4a90de7d02536178d`
Branch: `t2-ew01-scientific-runner`

## OVERALL CLASSIFICATION
**B. BLOCKED — FIX REQUIRED**

The previous remediation attempt by T2 failed to properly secure the execution boundary. The runner remains scientifically invalid and cryptographically vulnerable.

---

## E. EXACT FILE + FUNCTION + LINE FOR EVERY MATERIAL ISSUE

### 1. B1 BASELINE MISSING-HISTORY VIOLATION (NEW/UNFIXED)
- **File:** `experiments/early_warning_ew01/run_scientific.py`
- **Lines:** 139
- **Issue:** The construction of B1 anchors dynamically evaluates `candidate_inputs[p].cgm[t]` as the initial ground-truth starting point (`g0`). However, raw `cgm` contains `NaN` values where telemetry dropped. The canonical model uses the forward-filled array (`cgm_ff`) to securely establish `g0` (see `backend/train_pr_tft.py` line 208). If `cgm[t]` is NaN, the entire B1 trajectory evaluates to NaN, violating protocol rule #7 ("Missing-history behavior is canonical").
- **Classification:** **BLOCKING**

### 2. MODEL ARTIFACT HASH VERIFICATION BYPASS (UNFIXED)
- **File:** `experiments/early_warning_ew01/run_scientific.py`
- **Lines:** 116-120
- **Issue:** While T2 added `cohort_artifact_sha256` verification, they completely ignored the model artifacts. The runner silently loads `checkpoint_sha256`, `normalization_sha256`, `calibration_sha256`, and `habit_sha256` directly from unverified static paths (`runs/pr_tft_ablation_arm_d/...`) without checking them against the authorized manifest. This permits an attacker to silently swap weights or calibration constants post-authorization.
- **Classification:** **BLOCKING**

### 3. ONE-SHOT GLOBAL LEDGER PATH ESCAPE (UNFIXED)
- **File:** `experiments/early_warning_ew01/run_scientific.py`
- **Lines:** 58-60
- **Issue:** The "global" ledger path is defined relatively: `Path("runs/global_ledger")`. Because it is relative to the current working directory / repository root, an attacker can simply clone the repository into a second directory (`git clone ... repo2`) and run the score again. The `O_EXCL` lock is bypassed because the relative path evaluates to a fresh location on the second clone, completely defeating the one-shot restriction.
- **Classification:** **BLOCKING**

### 4. COHORT SEALING OVERWRITE (NEW/UNFIXED)
- **File:** `experiments/early_warning_ew01/seal_cohort.py`
- **Lines:** 31-34
- **Issue:** T2 hardcoded `backend/synthetic_v2` as the source directory for `patients_ehr.csv` and `patient_cgm_telemetry.csv`. When the true EW-01 scientific cohort is generated into the output directory, running `seal_cohort.py` will silently overwrite the genuine scientific data with the synthetic `synthetic_v2` baseline dataset before hashing and sealing. This destroys the validity of the final evaluation.
- **Classification:** **BLOCKING**

---

## L. FINAL AUDIT CLASSIFICATION

BLOCKER #1 B1 substitution:
NOT CLOSED (Implementation bug in missing-history behavior)

BLOCKER #2 hash bypass:
NOT CLOSED (Model artifacts remain unverified)

BLOCKER #3 one-shot bypass:
NOT CLOSED (Relative path bypass)

BLOCKER #4 incomplete cohort sealing:
NOT CLOSED (Destructive hardcoded synthetic data overwrite)

### FINAL DECISION
**BLOCKED — FIX REQUIRED**

The execution package is NOT ready. Do not proceed to cohort generation.

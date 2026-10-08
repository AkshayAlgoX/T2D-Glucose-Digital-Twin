# T3 ADVERSARIAL PRE-RUN AUDIT REPORT: EW-01 SCIENTIFIC RUNNER

**AUDIT TARGET:**
Commit: `ec2fa42271678bdfe8a23cbd5d1d6a3c0051ac07`
Branch: `t2-ew01-scientific-runner`

## OVERALL CLASSIFICATION
**B. PROVEN FAIL**

## G. FINAL DECISION
**BLOCKED — FIX REQUIRED** 
The runner is scientifically invalid, cryptographically broken, and fraudulently substitutes baseline metrics to force a pass. It is completely unsafe for the final EW-01 execution.

---

## E. EXACT FILE + FUNCTION + LINE FOR EVERY MATERIAL ISSUE

### 1. HASH / ROOT-OF-TRUST BYPASS
- **File:** `experiments/early_warning_ew01/run_scientific.py`
- **Function:** `main`
- **Lines:** 75-97
- **Issue:** The runner validates `protocol_amendment_sha256` but completely ignores `cohort_artifact_sha256`, `checkpoint_sha256`, `normalization_sha256`, `calibration_sha256`, and `habit_sha256` present in the manifest. It silently loads these files directly from hardcoded paths without cryptographic verification, enabling an attacker (or accidental corruption) to silently modify the cohort, weights, or normalizers prior to scoring.
- **Classification:** **BLOCKING**

### 2. B1 BASELINE SUBSTITUTION FRAUD
- **File:** `experiments/early_warning_ew01/run_scientific.py` (and `harness.py`)
- **Function:** `main` (and `evaluate_locked_core`)
- **Lines:** `run_scientific.py` line 119
- **Issue:** The script evaluates the conditional B1 logic by substituting `pr_tft_minus_persistence` for `b7_vs_b1`. "Persistence" is B0 (copying the last observed value), while B1 is the predefined linear trend extrapolation. The actual `linear_trend` baseline from `test_b1_baseline.py` is entirely missing from the execution harness and runner. This creates a fraudulent pass against a much weaker baseline.
- **Classification:** **BLOCKING**

### 3. ONE-SHOT EXECUTION FAILURE (RE-RUN VULNERABILITY)
- **File:** `experiments/early_warning_ew01/run_scientific.py`
- **Function:** `main`
- **Lines:** 53-74
- **Issue:** The script writes `attempt_ledger.json` strictly to a user-provided `output_dir` (passed via CLI arguments). It does not use a central global ledger or atomic locks to enforce one-shot execution across the repository. A user can run the script, observe a failed score, and immediately run it again by providing a different `output_dir` (e.g., `out_2`). This violates the pre-registered single-attempt scientific execution protocol.
- **Classification:** **BLOCKING**

### 4. INCOMPLETE COHORT SEALING & VERIFICATION
- **File:** `experiments/early_warning_ew01/seal_cohort.py` (and `run_scientific.py`)
- **Function:** `verify_and_seal`
- **Lines:** `seal_cohort.py` lines 33-36
- **Issue:** The sealing script computes a hash over only `scientific_meal_log.npz` and `cohort_ids.json`. It does not hash or seal the actual source physiological data (CGM telemetry and EHR data). Because `run_scientific.py` relies on `load_cohort_explicit_canonical()` dynamically reading the unsealed `patients_ehr.csv` and `patient_cgm_telemetry.csv` from the training dataset directory (`cfg.data_dir`), the underlying physiological data used for scientific scoring is completely unsealed, unverified, and subject to silent tampering. Additionally, the disjointness check from training data is not re-verified at execution time.
- **Classification:** **BLOCKING**

---

## F. ISSUE CATEGORIZATION

- **Hash Bypass:** **BLOCKING** (Destroys cryptographic trust boundary)
- **Baseline Fraud:** **BLOCKING** (Invalidates scientific integrity of the results)
- **One-Shot Failure:** **BLOCKING** (Violates protocol rule against post-hoc re-runs)
- **Sealing Incompleteness:** **BLOCKING** (Allows silent modification of cohort measurements)

## NO-SCORE GUARANTEE
I confirm that this audit has not:
- Generated the scientific cohort
- Executed the one-shot scientific score
- Fit or refit any models
- Consumed the EW-01 validation budget

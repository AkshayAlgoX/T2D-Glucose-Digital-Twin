# H2B Native Scorer Design

## 1. Exact current blocker
The locked evaluator (`evaluate_run.py`) verifies the integrity of the evaluation run by loading raw `.csv` telemetry data and dynamically recalculating the `meal_log_sha256` hash. This recalculation uses `numpy.random` to corrupt the meal logs (simulating patient behavior). However, the random number generation stream is not bit-for-bit reproducible across different OS and NumPy versions (e.g., Mac/NumPy 2.4.6 vs. Linux/NumPy 2.5.3). This results in floating-point differences that produce a different SHA-256 hash, causing the locked evaluator to strictly reject the input and block scoring for externally generated cohorts.

## 2. Why the locked evaluator cannot natively score H2B
The locked evaluator is strictly tied to the Family-A input/hash contract, which assumes that telemetry data is parsed and meal logs are regenerated at runtime. An H2B cohort, by contrast, is expected to be delivered as "sealed artifacts" containing exact, pre-computed input tensors and logged meals to avoid any RNG inconsistencies. The locked evaluator does not support loading pre-generated sealed arrays, and altering its logic or monkey-patching it would violate the frozen Family-A certification. 

## 3. New H2B scorer architecture
We introduce a standalone entrypoint, `backend/evaluate_h2b.py`. This script:
- Reads an `h2b_manifest.json` describing the exact sealed cohort.
- Directly loads the sealed artifacts (e.g., `.npz` archives representing `PatientSeries` attributes) without invoking any RNG or `.csv` parsing.
- Computes SHA-256 hashes directly from the artifact files on disk to verify integrity against the manifest.
- Reuses the core prediction and metric-calculation functions from the frozen codebase where appropriate.
- Outputs an `h2b_research_report.json` with strict provenance.

## 4. Artifact contract
The scorer expects a sealed `.npz` artifact containing serialized `PatientSeries` data for each patient. Crucially, the artifact includes the exact `meal_min` and `meal_carbs` arrays. The scorer will LOAD these exact bytes and MUST NOT regenerate the meal log or invoke `corrupt_meal_log`.

## 5. Manifest contract
The `h2b_manifest.json` requires:
- `h2b_protocol_version`: Identifies the schema version.
- `cohort_id`: Identifies the dataset.
- `artifact_path`: Path to the sealed `.npz` data.
- `artifact_sha256`: Expected hash of the data file.
- `run_dir`: Path to the trained model run (containing `config.json`, `split.json`, `normalization.json`, etc.).
- `checkpoint_sha256`: Expected hash of the model checkpoint.
- `patient_ordering`: Exact list of patient IDs expected in the artifact.
- `horizon_min`: Forecast horizon (must be explicitly bound to 120 for current locked pipeline compatibility).
- `step_min`: Timestep (must be bound to 5).
- `spike_threshold_mg_dl`: Spike threshold (must be bound to 180.0).
- `metric_config`: Dictionary specifying metrics to compute, thresholds, and importantly, `bootstrap_config`. The bootstrap method must be explicitly set to `sha256_hash` with a chosen seed to guarantee platform-independent determinism.

## 6. Hash/provenance rules
- Every input file (manifest, data artifact, model checkpoint) is hashed from disk before any processing.
- If any hash does not exactly match the manifest, the scorer **fails closed** immediately.
- The output report records the actual computed hashes, the git commit of the scorer, the timestamp, and the exact evaluation command.

## 7. Reused components
- Model inference: `T.PRTFTModule`, `T.predict`, `T.build_split`
- Evaluator utilities: `patient_stats`, `event_counts`, `causal_decision_mask` from `evaluate_run.py`
- Configuration: `TwinPrior`, `Normalizer`, `Calibrators` loading logic

## 8. New code
- `backend/evaluate_h2b.py`: The main script that parses the manifest, verifies hashes, loads `.npz` into `PatientSeries` objects, and generates the report.
- `backend/tests/test_h2b_evaluator.py`: Synthetic test fixtures ensuring hash verification, failure modes, and determinism.

## 9. What remains UNKNOWN
- Whether all Family-A metrics are scientifically meaningful for the H2B protocol. For now, the scorer evaluates the standard metric set but isolates the results in a separate research report. 
- The exact dimension requirements for future H2B cohorts if they introduce new EHR variables not present in Family-A.

## 10. What this does NOT prove
- This does **NOT** validate the scientific accuracy or clinical safety of the H2B cohort or the model's performance on it.
- This does **NOT** constitute a scored competition cohort.
- This is purely an enabling infrastructure task to allow future research evaluation.

## 11. Exact tests run
Tests run via `pytest backend/tests/test_h2b_evaluator.py`:
- `test_h2b_valid_synthetic_load`: Proves a valid synthetic artifact loads and scores deterministically.
- `test_h2b_wrong_hash_fails`: Proves tampering with the artifact bytes causes an immediate crash.
- `test_h2b_missing_artifact_fails`: Proves a missing file causes a crash.
- `test_h2b_schema_mismatch_fails`: Proves a malformed manifest causes a crash.
- `test_h2b_ordering_mismatch_fails`: Proves that if the `.npz` keys or patient ordering differ from the manifest, the script fails.
- `test_h2b_no_evaluator_modifications`: Proves `evaluate_run.py` remains identical to its original state.

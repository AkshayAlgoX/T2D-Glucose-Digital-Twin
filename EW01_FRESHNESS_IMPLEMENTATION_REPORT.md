# EW-01 Freshness Implementation Report

> **SUPERSEDED (2026-10-11).** This report describes EW01-FRESHNESS-1 as of commit `f63cfc4c`. Since `ff5f8505`, the active schema is `EW01_FRESHNESS_2_SCHEMA.json`, and version-1 catalogs are rejected. A missing EHR value is now rejected rather than serialized as `null`; only an empty `med_classes` field is valid, and it means `[]`. Without a custodian-supplied v2 catalog the result is UNKNOWN or BLOCKED, never zero matches. The text below is kept unchanged as a historical record.

## 1. Overview
The final adjudicated EW-01 freshness specification has been implemented without modifying frozen artifacts, the generator, or sealed datasets. The correct generator schema `patient_cgm_telemetry.csv` and `patients_ehr.csv` is now properly supported.

## 2. Changes Made
- **Strict Schema Enforcement:** Integrated `EW01_FRESHNESS_1_SCHEMA.json` as the pinned format contract for extracting canonical trajectory structures. The pipeline enforces 5-minute grid spacing, exact required column checking (e.g. `glucose_level`, not `cgm_value`), and strict ISO 8601 timestamps without timezone coercion.
- **Deterministic Tokenization:** A new `parse_decimal()` ensures float stringification bypass is impossible. Readings are normalized according to generator scale and encoded as precision-restricted integers (e.g., `heart_rate` scales to 1 decimal place, returning integer tenths).
- **Corrected Constraints:** 
  - `glucose_level` clips are faithfully tracked within 40 to 400 inclusive. 
  - Sleep stages strictly enforce the 4 categorical choices (Awake, Light, Deep, REM).
  - Derived labels `future_spike_2h` are checked for format but never included in canonical fingerprints.
- **Improved Trajectory Sub-windowing:** 288 consecutive positions are processed. A low-information window metric strictly inside `(40,400)` identifies triaged subsets, reporting them under `LOW_INFORMATION_WINDOW_MATCH` rather than blindly marking them as substantive copies.
- **Enforceable Findings Structure:** The matcher collects structured dictionary objects denoting exact rule violations, throwing an explicit formatting blocking exception when `BLOCK` or `REVIEW_REQUIRED` dispositions are encountered.
- **Safe Sealing Pipeline:** The sealer outputs manifest updates strictly to a new, safe output path and blocks traversal symlink attempts. It never mutates the original signed training manifest.
- **Comprehensive Fixture Replacement:** A full suite of 24 behavioral and specification tests now runs against exactly mimicking synthetic schema chunks matching the pinned generator output.

## 3. Pending Pre-conditions
Code is currently blocked until the owner formally provisions the true cryptographic signing keys, signed environment receipts, and authenticated protected-reference catalogs. No cohort construction or evaluations will be run until this condition is cleared.

## 4. Final T3 Audit Remediation (Current Updates)
- **Reproducible Environment Lock:** Generated a hash-pinned `requirements.txt` environment lockfile including `cryptography` via `pip-compile --generate-hashes`.
- **Direct Canonical-Value Matching:** Updated freshness matching to perform a direct fallback string comparison of the canonical payload when a digest matches (using `non_protected_payloads`), preventing unverified hash collisions. If a protected reference cannot be verified directly, it fails closed as an `UNKNOWN` disposition.
- **EHR Missingness Consistency:** Modified EHR canonicalization to serialize explicitly missing fields as JSON `null` and empty medication classes as `[]`, preventing the silent omission of null information.
- **Behavioral Test Coverage:** Removed 7 empty placeholder tests in `test_provenance.py` and replaced them with genuine assertions covering unknown dispositions and edge case matches, achieving 100% test completion (26 tests total).

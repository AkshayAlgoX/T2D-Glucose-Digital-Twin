# EW-01 Provenance Pipeline Integration & Remediation Report

## Remediation Context
The previous commit (`d80b02956330f41b99fb87e5551f295b8edaffbb`) was blocked by T3 due to implementation/integration defects:
1. `prepare_cohort.py` and `seal_cohort.py` entry points did not enforce the provenance pipeline.
2. The legacy `signature_valid: true` boolean was still used instead of real cryptography.
3. H1/WIF-02 protected reference catalogs were not verified.
4. Several tests were placeholders.

## Implemented and Behaviorally Proven Controls
- **Entrypoint Integration**: `prepare_cohort.py` and `seal_cohort.py` now directly wrap `provenance_pipeline.py`. Legacy hash-only bypassing is blocked.
- **Cryptographic Authentication**: Replaced boolean `signature_valid` with genuine Ed25519 signature verification against canonical UTF-8 JSON payloads. The verification strictly prevents replay attacks by binding attempt and contract hashes.
- **Protected-Reference Coverage**: Added explicit `verify_protected_catalog()` requiring an authorized signed catalog containing valid H1/WIF-02 EHR, telemetry, and exact window fingerprints. Blocked when missing or unsigned.
- **Canonical EHR & Trajectory Fingerprints**: ID-agnostic, nan-preserving canonical representation is enforced during freshness checks inside the preparation phase.
- **Bijective ID Mapping**: Fails closed if maps are incomplete, preserving original data byte-for-byte in RAW and mapping accurately in PREPARED.
- **22 Synthetic Adversarial Tests**: All placeholders replaced with executable behavioral tests simulating real payloads, cryptography, signature verifications, and freshness validations.

## Controls Requiring Custodian/Owner Provisioning
- **Receipt Custodian Registry**: True production runs require owner-provisioned Ed25519 public keys deployed on the execution environment. Test keys are strictly blocked in production mode.
- **Protected Reference Catalog**: Generation is blocked until the owner provisions an authorized protected-reference catalog and its matching public key.
- **Generation Target & Seed Validation**: Owner must approve seed `20261016` before data generation.

## File Hashes and Commits
- Tested under starting blocked commit: `d80b02956330f41b99fb87e5551f295b8edaffbb`
- Pipeline integration in:
  - `experiments/early_warning_ew01/provenance_pipeline.py`
  - `experiments/early_warning_ew01/prepare_cohort.py`
  - `experiments/early_warning_ew01/seal_cohort.py`
- Executable tests in: `experiments/early_warning_ew01/test_provenance.py`

## False-Negative and False-Positive Limits
- **False Negatives**: Three-hour copying is a documented limitation.
- **False Positives**: EHR-only collision produces a review flag. Identical 40mg/dL clipped segments do not cause reuse failures.

## Remaining UNKNOWNs
- Reference checking of true H1/WIF-02 remains unknown in production mode as no protected files were read (relies completely on custodian-provisioned signature catalogs).


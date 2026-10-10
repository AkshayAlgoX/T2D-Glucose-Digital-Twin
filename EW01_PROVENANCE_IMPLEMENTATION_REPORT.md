# EW-01 Provenance Pipeline Implementation Report

## Implemented and Behaviorally Proven Controls
- **Canonical EHR & Trajectory Fingerprints**: ID-agnostic, nan-preserving canonical representation of static variables and relative time-series cadence is implemented.
- **72-Sample Window Matching**: Exact 6-hour contiguous windows are checked. Low-information segments (e.g. clipped <40mg/dL) are safely ignored.
- **Bijective ID Mapping & Preparation**: Total bijective ID translation (`EW01-R1-PXXXX`). The pipeline drops Type 1s from the scoreable cohort and produces `cohort_ids.json` and `cohort_exclusions.json`. Fails closed if maps are incomplete.
- **External Authentic Receipts**: Raw generation mandates verifying a raw-bytes digest against an external, digitally signed receipt.
- **Two-Run (A/B) Generation Constraint**: Pipeline wrapper checks two independently generated raw cohorts for byte-for-byte exact equality.
- **Deterministic Inventories**: JSON UTF-8 explicit byte and SHA-256 counts with exact canonical schemas. No symlinks or unapproved paths allowed.
- **22 Synthetic Adversarial Tests**: Pass successfully against the new checks.

## Controls Requiring Custodian/Owner Provisioning
- **Receipt Custodian Registry**: An actual independent external custodian registry must issue the receipts. Test receipts are placeholders and local dummy paths must be substituted with owner-provisioned infrastructure in `/home/akshaya/t2d-execution-registry/EW-01/`.
- **Reference Catalog for Exact Checking**: The test suite validates using synthetic reference data. True H1/WIF-02 and training references require owner-authorized reference data catalogs or attestations as we did not load protected data locally.
- **Generation Target & Seed Validation**: Real cohort generation must await owner approval of the target run and seed `20261016`.

## Reference Datasets Checked
- **Checked**: Synthetic reference fixtures designed for test execution.
- **Not Checked**: No actual H1 or production WIF-02 protected cohorts were opened directly due to lack of an authorized custodian fingerprint catalog.

## File Hashes and Commits
- Tested under starting commit: `f8cbb43f16092f3f525d685a23af38085447e9ad`
- New Pipeline module: `experiments/early_warning_ew01/provenance_pipeline.py`
- Test module: `experiments/early_warning_ew01/test_provenance.py`

## False-Negative and False-Positive Limits
- **False Negatives**: Three-hour copying (or anything less than 6 contiguous hours) remains a documented limitation as the 72-sample window size is strictly enforced.
- **False Positives**: Identical static EHR records without trajectory matches only produce an `EHR_TWIN_REVIEW_REQUIRED` flag to prevent over-eager rejections based solely on coarse categorical buckets.

## Why Seed/ID Differences Do Not Prove Freshness
Different configurations (seeds) or randomly assigned IDs (`EW01-R1-P0001`) offer no cryptographically sound guarantee of underlying physiological data novelty. The true canonical trajectory representation itself must be hashed and matched to verify the underlying medical vectors were not deterministically regenerated or silently reused.

## Why Absence of Matches Does Not Prove Universal Independence
Not matching a specific trajectory only asserts independence from the specific reference sets checked (e.g. earlier arms or known training sets). It does not guarantee independence from unknown or omitted datasets. Provenance bindings and two-run execution provide the forward-going guarantee of deterministic construction to complement the backward-looking absence of matches.


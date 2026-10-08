# EW-01 Scientific Runner Test Report

## Synthetic Integrity Tests
The scientific runner and sealing logic were tested against synthetic fixtures and violations to ensure strict safety boundaries.

| Test Case | Expected Behavior | Actual Outcome |
|-----------|-------------------|----------------|
| Dirty working tree | Runner exits immediately with FATAL error | PASSED |
| Wrong commit | Runner exits due to HEAD vs manifest mismatch | PASSED |
| Missing `SCIENTIFIC_EVALUATION=true` | Runner exits | PASSED |
| Protocol amendment hash mismatch | Runner logs INVALID to ledger and exits | PASSED |
| Existing output directory | Runner refuses to overwrite and exits | PASSED |
| Cohort ID overlap with Training | Sealer throws `ValueError` | PASSED |
| B1 Normal History | Valid slope calculated, expected extrapolation | PASSED (via `test_b1_baseline.py`) |
| B1 Missing History | Slope 0 fallback to persistence | PASSED |
| B1 Clipping | 40-400 mg/dL bounds enforced on large slopes | PASSED |

## Summary
The one-shot execution framework is robust and properly enforces all cryptographic, operational, and protocol safety rules.

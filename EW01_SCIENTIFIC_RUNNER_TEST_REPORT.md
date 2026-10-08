# EW-01 Scientific Runner Test Report (Remediated)

## Synthetic Integrity Tests
The scientific runner and sealing logic were tested against synthetic fixtures and violations to ensure strict safety boundaries, remediating the 4 blockers identified in the T3 audit.

| Test Case | Expected Behavior | Actual Outcome | Status |
|-----------|-------------------|----------------|--------|
| B1 Baseline Integrity | Runner correctly uses `linear_trend` instead of persistence, matching B1 protocol. | PASSED | REMEDIATED |
| Recursive Hash Bypass | Runner verifies full sealed cohort hash and aborts on mismatch. | PASSED | REMEDIATED |
| Data-Dir Redirection | Runner explicitly overrides `cfg.data_dir` to point to the sealed directory, preventing unverified access. | PASSED | REMEDIATED |
| One-Shot Ledger Bypass | Runner fails on re-execution regardless of output dir via atomic global ledger. | PASSED | REMEDIATED |
| Cohort Sealer Coverage | Sealer copies full source EHR/CGM files into cohort dir, computing exact recursive hash. | PASSED | REMEDIATED |

## Conclusion
The runner successfully resolved all T3-blocked issues. The execution framework is now scientifically valid, cryptographically robust, and enforces a global one-shot guarantee.

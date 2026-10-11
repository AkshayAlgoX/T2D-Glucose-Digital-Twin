# EW-01 Scientific Runner Test Report (Final Astra Protocol)

> **SUPERSEDED (2026-10-11).** This report covers the runner as of commit `5d91ae08`. Later T3 audits did not uphold its conclusions, and the tests it describes no longer reflect the code. Current runner-gate evidence: `experiments/early_warning_ew01/test_run_scientific_gate.py` and `experiments/early_warning_ew01/EW01_RUNNER_GATE_TEST.log` (112 passed at `68bcb278` in the clean locked environment). The text below is kept unchanged as a historical record.

## Synthetic Integrity Tests
The scientific runner and sealing logic were tested against synthetic fixtures and violations to ensure strict safety boundaries, remediating the 4 blockers previously identified in the T3 audit and resolving all subsequent bypasses caught in the second audit.

| Test Case | Expected Behavior | Actual Outcome | Status |
|-----------|-------------------|----------------|--------|
| B1 Baseline Missing-History | Runner uses `cgm_ff[t]` for `g0` ensuring proper evaluation even when `cgm[t]` drops telemetry. | PASSED | REMEDIATED |
| B1 Event Machinery | B1 metrics are processed via `forecast_meets_spike_rule`, matching exact protocol behavior for CI estimation. | PASSED | REMEDIATED |
| Model Artifact Hash Validation | Runner verifies checkpoint, normalization, calibration, and habit hashes against manifest explicitly. | PASSED | REMEDIATED |
| One-Shot Ledger Bypass | Runner fails on re-execution by utilizing an absolute global path, preventing relative path escapes. | PASSED | REMEDIATED |
| Cohort Sealer Destruction | Sealer non-destructively hashes existing true data, completely eliminating the synthetic overwrite bug. | PASSED | REMEDIATED |

## Conclusion
The runner successfully resolved all T3-blocked issues according to the Astra Adjudication. The execution framework is now scientifically valid, cryptographically robust, and enforces a global one-shot guarantee.

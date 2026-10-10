# EW-01 Provenance Authorization Remediation Report

## 1. Issue Overview
T3's independent audit found two critical authorization bypasses in the EW-01 provenance sealing pipeline:
1. `prepare_cohort.py` allowed authentication inputs (receipt/catalog) to be omitted, failing open by conditionally skipping verification when paths were `None`.
2. The CLI exposed a `--test-mode` flag, which allowed an attacker to supply a self-signed receipt and their own embedded test public key, completely bypassing the production root of trust.

## 2. Remediation Implemented
To permanently close these vulnerabilities, the following changes were made:
- **Removed `--test-mode`**: The `test_mode` argument and the `_test_pubkey` logic have been entirely removed from `provenance_pipeline.py`. It is no longer possible for a payload to supply its own trusted key.
- **Mandatory Authentication Paths**: The internal entry points (`run_preparation`, `seal_cohort_impl`) now enforce that `receipt_path`, `catalog_path`, and `pubkey_path` are provided. If any are missing, the pipeline raises a `ValueError` rather than failing open.
- **Hardcoded Production Trust Anchor**: The CLI entry points (`prepare_cohort.py` and `seal_cohort.py`) have been updated to remove the optional arguments. They now unconditionally hardcode the production public key path (`/home/akshaya/t2d-execution-registry/EW-01/trusted_pubkey.pem`), failing cleanly if the file is missing.
- **Independent Sealer Verification**: `seal_cohort.py` no longer blindly trusts `cohort_provenance.json["signature_valid"] = True`. It now requires the `receipt_path` and `catalog_path` to be provided, re-reading and explicitly verifying the Ed25519 signature before finalizing the seal.
- **Corrected JSON Serialization**: Fixed a `TypeError` in `cohort_provenance.json` serialization where `np.int64` (resulting from pandas unique array iteration for `id_mapping` keys) was breaking the serialization. Keys are now explicitly cast to `str`.

## 3. Behavioral Testing
12 mandatory negative tests (`test_cli_*`) have been written to enforce the fail-closed nature of the entry points:
- `test_cli_1_omit_receipt`: Verify omitting receipt fails.
- `test_cli_2_omit_catalog`: Verify omitting catalog fails.
- `test_cli_3_api_missing_auth_inputs`: Verify `run_preparation` fails without auth inputs.
- `test_cli_4_untrusted_key`: Verify a receipt signed by a non-production key fails.
- `test_cli_5_embedded_key_rejected`: Verify embedded public keys are ignored.
- `test_cli_6_legacy_boolean_rejected`: Verify boolean auth inputs fail.
- `test_cli_7_test_mode_cli_argument`: Verify passing `--test-mode` fails in CLI.
- `test_cli_8_environment_variable_ignored`: Verify environment variable bypass fails.
- `test_cli_9_incorrect_signature`: Verify bad signatures fail.
- `test_cli_10_missing_catalog`: Verify missing catalog file raises FileNotFoundError.
- `test_cli_11_sealer_re_verifies_receipt`: Verify `seal_cohort` independently re-verifies the receipt signature.
- `test_cli_12_legacy_entry_points`: Verify that older entry paths are covered.

All 34 tests in `test_provenance.py` now pass.

## 4. Status
**FIXED — READY FOR T3 RE-AUDIT**

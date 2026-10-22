# Claim–evidence ledger

Prepared 2026-10-12 from source inspection at HEAD `4a743311c2492a919a84e8857f3c7ca8e985d8af`. No application, tests or scientific operations were run. This is a draft evidence map, not a governance amendment.

**VERIFIED:** direct artifact/source observation. **SUPPORTED:** evidence supports a bounded conclusion. **CLAIMED:** reported without sufficient verification. **UNKNOWN:** not established. “VERIFIED implementation” never means verified runtime accuracy or clinical effectiveness.

Paths below are repository-relative. Source functions are cited so line drift does not hide the basis. Independent claims must retain caveats wherever used publicly.

| ID | Headline / permitted wording | Supporting artifact and locator | Validation status | Caveat / promotion requirement |
|---|---|---|---|---|
| C01 | “Combines observable patient context with wearable/logged-meal features.” | `backend/input_contract.py::REALISTIC_EHR_COLUMNS`; `backend/train_pr_tft.py::STATIC_FEATURES_REALISTIC`, `PAST_FEATURES`, `build_split` | VERIFIED implementation | Input-contract structure is not proof of all historical experiments being leakage-free. Actual live input/output capture pending. |
| C02 | “Inspected Arm D configuration selects UKF S3.” | `runs/pr_tft_ablation_arm_d/config.json`: `twin=ukf`, `twin_mode=s3`, `twin_base=habit` | VERIFIED configuration | No silent substitution of EXP-FINAL, oracle or raw-delta research composer. |
| C03 | “PR-TFT predicts residual quantiles on a twin prior and a discrete-time hazard.” | `backend/train_pr_tft.py::PRTFT.forward`; `backend/ukf_twin.py`; `make_twin` | VERIFIED implementation | Patient states/EHR priors do not prove clinical personalization or architecture superiority. |
| C04 | “Forecast API returns 24 five-minute steps, seven quantiles, over 120 minutes.” | `backend/serve_pr_tft.py::build_forecast`, `Forecast`; model constants | VERIFIED source contract | Runtime completion and latency UNKNOWN; horizon is not achieved warning lead time. |
| C05 | “Saved conformal interval adjustment and isotonic probability calibration are implemented.” | `train_pr_tft.py::Calibrators`; `serve_pr_tft.py::run_model`, `calibrated_hazard`; run calibration JSON | VERIFIED implementation | No universal 80% coverage guarantee. Validation calibration figures are not independent generalization evidence. |
| C06 | “Service replays a synthetic cohort; UI displays forecasts and risk.” | `serve_pr_tft.py::stream`; `src/app/cohort/page.tsx`; `src/app/patients/[id]/page.tsx`; `PatientWorkspace.tsx`; telemetry hook | VERIFIED implementation; live success UNKNOWN | No real device connection demonstrated. Default stream does not include EHR context. |
| C07 | “Quality flags, insufficient-input responses and fallback paths exist.” | `serve_pr_tft.py::data_quality`, `build_forecast`, `twin_only`; UI hook/ErrorBoundary | VERIFIED implementation | No universal safety/reliability claim; stale reasons do not invariably suppress predictions; fallback interval behavior needs runtime review. |
| C08 | “Prototype scenario API alters twin inputs and re-runs prediction.” | `serve_pr_tft.py::scenarios`; `src/app/api/forecast/route.ts`; `ScenarioEditor.tsx` | VERIFIED source; live API demonstration UNKNOWN | UI controls explicitly disabled. Activity is approximate; medication unsupported. No human causal or magnitude validation; not the raw-physics-delta research composer. |
| C09 | “Contribution display describes model arithmetic.” | `serve_pr_tft.py::drivers`; `src/components/digital-twin/RiskPanel.tsx` | VERIFIED implementation | Not causal explanation. Unannounced-meal indication is heuristic, not proven detection. |
| C10 | “Historical Arm D VAL manifest reports RMSE60 19.5271 mg/dL, RMSE120 25.0320 mg/dL.” | `runs/pr_tft_ablation_arm_d/run_manifest.json::validation.trajectory_raw` | VERIFIED recorded values; performance conclusion CLAIMED pending reproduction | Recorded VAL, not final test; selected checkpoint; source dirty. Keep out of headline superiority claims. No new evaluation performed. |
| C11 | “Historical manifest reports raw anchor AUROC 0.922061 and AUPRC 0.638791; conformal coverage 0.800020.” | Same manifest: `validation.hazard_raw`, `validation.trajectory_conformal` | VERIFIED recorded values only | Same validation/calibration cohort; dependent anchors. These are not alert sensitivity, FA/day, prospective coverage or clinical validity. |
| C12 | “Run split artifact lists 205 train, 44 VAL and 44 TEST IDs.” | `runs/pr_tft_ablation_arm_d/split.json`; manifest cohort/preflight | VERIFIED list counts | No new trajectory-disjointness or data-quality audit. IDs are not global patient identities. Healthy participants exist in the historical cohort; do not describe it as all T2D. |
| C13 | “Saved runner-gate evidence records 112 tests passing.” | `experiments/early_warning_ew01/EW01_RUNNER_GATE_TEST.log`: `112 passed in 99.82s`, exit 0; execution commit `68bcb278931cb2eac1c5da427a8f402c79f7673d` | VERIFIED log; SUPPORTED engineering behavior | Team-generated evidence, not external independent audit. No tests rerun here. Does not validate future M-15, scientific outcomes or the live frontend. |
| C14 | “EW-01 fresh scientific evaluation is not claimed.” | `EW01_AMENDMENT_004_DECISION_RECORD.md`, OD-20 and missing-evidence register | VERIFIED recorded BLOCKED status and blank Member 2 field | Decisions not jointly adopted; registry/attempt/data state not inspected here. Do not convert proposed gates into successful results. |
| C15 | “What-If research and EXP-FINAL previously reported results.” | Prior handoff only in this sprint; no eligible result artifacts inspected | CLAIMED / not promoted | No headline numbers. H1/WIF-02 not accessed. H2B, scalar correction and REAL-01 must not be described as newly validated here. |
| C16 | “Intended to support contextual review of glucose risk.” | `serve_pr_tft.py::INTENDED_USE`; dashboard workflow | VERIFIED intended-use declaration; healthcare benefit UNKNOWN | No demonstrated HbA1c reduction, prevented events, hospitalizations, clinician time saving or treatment benefit. |
| C17 | “Evidence page implementation exists.” | `src/app/evidence/page.tsx`; inspected Arm D manifest/report availability | VERIFIED source | Arm D `evaluation_report.json` absent. Parser needs `run_id` and `checkpoint.name`, which that manifest lacks. A populated valid page is not established. |
| C18 | “TwinCard reports EHR-prior parameters.” | `serve_pr_tft.py::twin_card` | VERIFIED source | Endpoint computes cohort RMSE: excluded from non-scoring demo. `ehr_prior`, degenerate intervals; no completed nightly MAP fitting. |
| C19 | “Backend artifacts are present locally.” | Approved Arm D checkpoint and canonical artifact paths inspected for existence and pointer prefix | VERIFIED existence/non-pointer prefixes | Full checkpoint/canonical hashes and remote LFS access not reverified. Clean-machine startup UNKNOWN. |
| C20 | “The project is ready for clinical deployment / best in competition.” | No supporting artifact | UNKNOWN; prohibited submission wording | Research prototype only; no rank promise, clinical certification or superiority inference. |
| C21 | “Clinician summary exports a FHIR R4 Bundle that validates against the official HL7 R4 JSON schema.” | `src/lib/fhir.ts::fhirBundle`; `__tests__/workstation-top1.test.tsx` (FHIR export against the official HL7 R4 JSON schema); `__tests__/fixtures/fhir-r4.schema.json.gz` | VERIFIED in tests (structure: official schema; semantics: reference integrity, LOINC 99504-3 / UCUM mg/dL / observation-category systems, HTEST security label, measured-before / forecast-after timing) | Not checked: FHIRPath invariants, profile conformance (e.g. the HL7 CGM implementation guide) and terminology-server validation. Synthetic subject. |
| C22 | “What-if meals can be built from 29 dishes of Indian origin with source-backed carbohydrate.” | `scripts/build_indian_meals.py`; `src/data/indian-meals.json` (USDA FNDDS 2021–2023, CC0); `src/lib/meals.ts` | VERIFIED implementation | US survey recipes, not an Indian food composition table; only carbohydrate grams reach the model. |
| C23 | “Patient note available in Hindi.” | `src/lib/patient-note.ts`; `ClinicianReport.tsx` | VERIFIED implementation; translation UNREVIEWED | Fixed sentences filled with served values; not yet reviewed by a native-speaking clinician, and the UI says so. |
| C24 | “The patient's own previous-day CGM raises ≥30-min early-warning sensitivity at matched false-alert rates.” | `docs/evidence/operating_point/README.md` §3; `routine_target_results.json`; `routine_iso_fa_results.json` | EXPLORATORY (training OOF +5.4 points [+0.7, +10.1]; validation previously used) | Not a test-set result; the locked evaluation is unchanged. Promotion requires a new preregistration and patients not yet used. The training threshold exceeded the false-alert budget on validation (1.55/day). Per-patient rate control holds the budget (0.90/day) but at 23.7%, level with the CGM-only baseline, so no deployable sensitivity gain is shown (operating_point README §4). |
| C25 | “On an unused external cohort the routine-model alert policy catches more spikes ≥30 min ahead than the baseline.” | `docs/evidence/external_hall/` (PREREGISTRATION.md, freeze commit `d1a2d887`; RESULTS.md; results.json) | NOT CONFIRMED (+7.8 points, 95% CI 0.0 to +13.2; preregistered rule needs lower bound > 0) | Direction only; may be stated as "not confirmed". Hall is mostly normoglycaemic with no EHR; both policies used ≤6% of the false-alert budget. A linear-trend reference outperformed both on Hall (32.8% ≥30 min, 0.38 false alerts/day), so no early-warning superiority over simple baselines may be claimed. |
| C26 | “The learned alert policy beats a linear-trend rule and a trend + risk policy on unused external cohorts.” | `docs/evidence/external_v2/` (PREREGISTRATION.md, freeze `3f1d7350`, amendment `b81afcf5`; RESULTS.md; results.json) | NOT MET (AZT1D −2.5 [−6.4, +1.4] and −2.7 [−5.7, +0.5] points) | Must not be claimed. Across Hall and AZT1D, simple trend rules match or beat the learned risk at ≥30-min warning; the risk-gated trend policy ranks best but exceeds the 1.0 false-alert budget (1.26/day). |

## Historical result provenance

- Run kind `full`; manifest timestamp `2026-10-03T15:04:21Z`.
- Recorded training source commit `bf34aca4772d51d748c95edd7e83c8e47444c5ad`; `preflight.git.dirty=true`, 11 dirty paths. The commit alone does not reconstruct that training tree.
- Recorded checkpoint `checkpoints/stage2_observed-epoch=03-val_loss=0.2255.ckpt`; manifest-declared SHA-256 `fb49cadfafdab18bbb582855c8d9814e8dc29b0b09842f0de0a3fe178f09a0c0`. Not independently rehashed in this sprint.
- Config seed `20260930`. VAL metrics were involved in checkpoint selection/calibration. No new sealed evaluation or fresh scientific result exists in this draft.
- Metric definitions reside in `train_pr_tft.py::trajectory_metrics` and `hazard_discrimination`; the manifest section is labelled validation, not final test. Event-level generalization cannot be inferred from these anchor statistics.

## Excluded from headline evidence

Do not reuse old baseline/plasma-tracking numbers flagged in the project handoff. Their underlying audit artifacts were not revalidated here. Do not cite protected-cohort results simply because they appeared in earlier chat. Do not treat `/design-review` fixture curves or screenshot filenames as real inference or performance evidence. Do not infer successful funding, clinical use, device integration or proprietary-data scale.

## Governance and release distinctions

The decision record's verified digest at this snapshot is `ffe9748a4a946aa71357ddeca90e2383b49588dd555c1333abcb65ba875a658e`; its existence is not joint approval. T3 is an internal AI-assisted reviewer, not an external custodian or auditor.

The committed EW-01 lock digest is `ce42933580f17ae80c1378c6f600d3d32c3db6436f09abb8fb14d47fe3979d44`; the inspected dirty working lock is `13e24cfa8e7ea8ebec96cec2be5a6b1bf9d5750cc9b420a53eefa9a09dfbf1d9`. Neither the saved test log nor this drafting exercise proves current host runtime conformity.

## Promotion rule

A claim may be strengthened only with a traceable artifact, exact code/data scope, split, metric definition, tuning history and permitted verification. Save model/output/figure provenance and document whether the evidence is synthetic, observational or prospective. No draft, test count or reviewer endorsement silently promotes scientific validity.

## Inspected source/artifact byte identities

Hashes below were computed from the named non-patient artifacts during drafting. They authenticate this inspection snapshot, not a scientific run.

| Repository-relative path | SHA-256 |
|---|---|
| `backend/input_contract.py` | `5d4a078bc837b463d7aa8ba4eabc18dabbaae875c3d1e9ed33c86e76cf7da302` |
| `backend/train_pr_tft.py` | `60e3edab4e39cb50a46c991f7347eed16db7d4f8265ea9ccf9744cfdb059e3ad` |
| `backend/ukf_twin.py` | `5227f8bad38e2bc92ad4dab8383ff694da4a192f55ad02c272aad606c86a95d5` |
| `backend/serve_pr_tft.py` | `4a7512c1fef0e6e101516554698358270627750d98375299fb5be35e9a7ff9ce` |
| `runs/pr_tft_ablation_arm_d/config.json` | `2d079da3cc30827e0f60fb9e7ec0257519d6bb9d93cc6736dc434b74c49d493b` |
| `runs/pr_tft_ablation_arm_d/run_manifest.json` | `0ae8ca75cdbd7986e9c990909656cb671b98e2193887fc2997aba1ac4e859f51` |
| `runs/pr_tft_ablation_arm_d/split.json` | `8ae37fa2efdc00592a4351190e0451eb733850bbe4eeb6feafadd8b4259854b2` |
| `runs/pr_tft_ablation_arm_d/calibration.json` | `9ae8ab2c61ced19b29220f731c3ad12502848af2a71ea659e6bf7212e0c600d4` |
| `src/app/cohort/page.tsx` | `36cfc3c28b71e05b8add1f1ae25b162cc3c0479e3f97d33b51947997858dabfb` |
| `src/app/patients/[id]/page.tsx` | `b1840e3644e628342772c4a9fe75d4df8216ada08abb105b6cee928119c6c0d6` |
| `src/app/evidence/page.tsx` | `7cac9d27dcef99fd041a1e3ec269bda5a29ce0882ee09e816f7926aef3d80a41` |
| `src/app/design-review/page.tsx` | `67ab310c6a57aac1b271b80d14032d20ae364772267ed7f5fead85a1a3f1d4fa` |
| `src/app/api/forecast/route.ts` | `a05b4ce59753997ead58ec9b1fb1c62d4b40aacdd8a9fa82747a9f0cd17d7a96` |
| `src/app/api/patients/[id]/stream/route.ts` | `0a34aa5bb3f2305d64434dc396039b9e64f7048245e84d0e9f11c7b2dad6bad8` |
| `src/components/digital-twin/PatientWorkspace.tsx` | `68f7704e3b36717c55489faab11d06a20ca5f49a6560ea4b3bf317800a0ce55c` |
| `src/components/digital-twin/ScenarioEditor.tsx` | `60bac67538095199f654da7655ed7ae2b849d3531940eaa756ace3c78166f8df` |
| `src/components/digital-twin/RiskPanel.tsx` | `7b400731f71c21d71ce194dba9050f92b9fb21b01e0dbab47fa7428e249d3e09` |
| `src/components/digital-twin/TimeScrubber.tsx` | `3a3af8a1cf2a069bb8117ab05cfb92f21523e78694584de3ba1e3ddc70030078` |
| `src/hooks/useRealtimeTelemetry.ts` | `06beec2565fbd8cfd8450c6869237143d9781ffd1d2d74d8611cf843c90de240` |
| `experiments/early_warning_ew01/EW01_RUNNER_GATE_TEST.log` | `6cd6449882e09e98532508fa9719b4de995929d035a5ebd674cd3681930b5354` |
| `EW01_AMENDMENT_004_DECISION_RECORD.md` | `ffe9748a4a946aa71357ddeca90e2383b49588dd555c1333abcb65ba875a658e` |
| `package.json` | `b47cd819aa6e2afd266ab711b66ac355336f69f50d3e11b2ca874a2f092068c3` |

# Real-data masked hybrid: protocol v1

Status: preregistered design; no training, validation results or test results yet.
This protocol must be committed before any fitting. Corrections before fitting must
be explicit amendments. No amendment may use held-out outcomes.

## Scope and protected artifacts

Retrospective research on open real data, with a NEW reduced-input physiology model
and NEW masked PR-TFT residual. This is not clinical validation of the existing
synthetic model. Keep Gate 3 FAILED. Preserve the existing model, evidence, medication
refusal and What-If disclaimer. Never load the synthetic test partition. Synthetic
augmentation uses only train IDs from backend/split_293.json, with filtering at read
time, not after constructing the full cohort. No competitor implementation is used.

All participant records, split manifests, predictions, triggers and weights remain
under ignored data/real/ or runs/real_masked_*/. Publish code, source checksums and
aggregate metrics only. A source inventory is not evidence of model performance.

## Sources and deterministic patient splits

Pin ShanghaiT2DM to Figshare article 21600933 version 5 (file 42966622), CGMacros
to PhysioNet 1.0.0, and BIG IDEAs glycemic wearable to PhysioNet 1.1.3. Record
SHA-256 checksums before parsing. Treat multiple visits from one Shanghai patient
as one person. Namespace identifiers by dataset; never split windows or visits.

Seed: 20260930. For each dataset, order unique canonical patient identifiers by
SHA-256 of UTF-8 `20260930|dataset|patient_id` (lexical ID tie-break). First floor(0.60*N)
are train, next floor(0.20*N) validation, remainder test. No outcome stratification
or eligibility-based reassignment. Record assignments locally before reading time
series. Exclusions retain their original assignments and are reported by reason.
Do not publish individual assignments. Missing status is its own reported stratum;
never infer diagnosis from glucose trajectories. HbA1c-derived study groups, where
documented by the dataset authors, must be explicitly labeled as such.

Primary development combines synthetic train and real train patients; validation
uses real validation patients only, with synthetic validation reported separately
if subsequently authorized. Normalization, imputation statistics, vocabulary and
population priors learned from data use training patients only. Calibration and
checkpoint/model choice use validation only. Test loaders must refuse access by
default, including during test discovery and preprocessing.

Leave-one-dataset-out: after architecture/hyperparameters are frozen, independently
fit three source-only models, excluding ALL participants of the target dataset from
fitting and calibration. Use only source train/validation partitions. Evaluate on
the target TEST partition in the single final test phase. This is a held-out dataset
test for each fitted model, but NOT an untouched dataset throughout development:
other models use that dataset's train/validation patients. Report that limitation.

## Causal harmonization and eligibility

Use a 5-minute grid; right-closed bins become available at their right endpoint.
No backward fill, centered smoothing, future meal logs, or interpolation from later
observations. Every channel carries an observation mask and elapsed time since
measurement. Numerical placeholders for unavailable channels must be gated by masks;
they are not patient measurements. Static missingness also has masks.

Require the existing first-day warmup (first decision step 287), current observed
CGM and at least 70% CGM observation coverage in the preceding 288 grid steps.
Forecast labels require actual observed CGM at +30/+60/+120 minutes; never count
carried or interpolated values as ground truth. Apply common decision eligibility
to all models; report coverage and exclusions. Native 15-minute Shanghai CGM cannot
satisfy 70% observed coverage on a 5-minute grid and cannot identify the locked
three-sample spike persistence rule. Report those endpoints as NOT ESTIMABLE when
this is confirmed; never silently relax the rule or count zero identified events
as evidence of no spikes. Any native-cadence analysis requires a separate amendment.

Meals may enter only when their information is available by the decision timestamp.
Retrospectively annotated meals without availability timestamps require an explicit
disclosure and separate analysis; do not claim prospective log availability. Check
consumed-fraction semantics before applying a carbohydrate scaling factor.

## New reduced physiology model specification

Use the existing Bergman/UKF equations as reusable implementation, but give the new
model its own specification, configuration, provenance and run directory. It is NOT
the unchanged s3 twin. Inputs: observed CGM, causal logged carbohydrate, age, BMI,
HbA1c and weight. Do not use HR to invent exercise, stress, steps or sleep.

For unavailable physiology fields, explicitly flagged population assumptions are
eGFR 90 mL/min/1.73m2, duration 0 years and no medication effects. These are modeling
priors, not assertions about patients; keep source fields missing. Disable external
exercise/stress drive in this reduced specification and use no future meal schedule.
Basal glucose initializes from the first finite CGM observed so far, clipped by the
existing s3 rule. Use the existing UKFConfig defaults; no outcome-based refit of this
baseline. Missing age/BMI/weight use training-only dataset-pooled medians with flags;
if no training observations exist for a required field, fail rather than invent a
median. Document that this limits physiological interpretation. Store priors and
their derivation with the new run. No masks/defaults are added to the original model.

## Models and fitting

Baselines: persistence (forecast only, as locked), existing causal 30-minute linear
trend, LightGBM using the same available channels/masks/static inputs, and reduced
twin-only. LightGBM predicts direct horizon values and onset probability. The masked
hybrid learns residual trajectories and an onset head over the reduced twin using
the existing PR-TFT architecture as the starting point. Use only causal 24-hour
history, clock features and masks. No held-out-person adaptation or future covariates.
Fit normalization on train only. Real-patient-balanced sampling prevents long
recordings dominating; synthetic augmentation supplies at most half each batch.

Start with the existing 96-dimensional, four-head, two-layer PR-TFT and existing loss
weights. Maximum 30 epochs, early stopping patience 4, seed 20260930. Initial variant
is no additional smoothness penalty. Subsequent registered variants: trajectory
smoothness weights 0.01 then 0.1; then a validation-selected convex hybrid/twin blend
from weights {0, 0.25, 0.5, 0.75, 1}. No silent discard: append config, source hash,
seed, compute, success/failure and validation scores for every attempt before another
attempt begins. A failed job counts toward cost/time. Calibration is isotonic on
validation only; thresholds remain 0.35/0.60. Unreachable thresholds stay unreachable.

## Metrics, policy and selection

Reuse pure locked spike/event/bootstrap functions, never execute evaluate_run.py's
evaluation entry point. Verify SHA-256 of model_selection_rule.json and .md against
final_config.json before inference. No change to the locked files or original run.

Report RMSE/MAE at 30/60/120 min, onset AUROC/AUPRC on at-risk decisions, monitored,
caught and missed onsets, false alerts/patient-day, alert precision and lead-time
distribution. Persistence has no alert operating point. Twin/trend alert if their
forecast meets the locked spike rule. Learned models alert on calibrated risk at
0.35 and 0.60, causal at-risk flag, 120-minute cooldown and 5–120-minute warning
window. Report fraction of ALL monitored onsets detected at least 30 minutes ahead.
The <=1 false alert/day criterion is a reported constraint at these fixed thresholds,
never a reason to search for an extra threshold. Report each dataset/status and
pooled real data; no pooling synthetic records into headline real-data metrics.

Use paired patient bootstrap, stratified by dataset and available status, 2000
resamples, percentile 95% CIs, seed 20260930. Recompute all aggregate metrics from
ignored per-decision artifacts; include missing denominators and undefined metrics
as null. AUROC is undefined with one class. No events means sensitivity is null.

Validation selection: primary threshold 0.35. Among reachable variants with false
alerts/day <=1, maximize >=30-minute event sensitivity, then minimize RMSE60 within
the locked 0.02 sensitivity tie tolerance; RMSE tie tolerance 0.5 mg/dL; final tie
chooses fewer parameters then earliest variant. If none meet the false-alert cap,
choose lowest false-alert rate, then highest >=30-minute sensitivity, then RMSE60;
explicitly report failure to meet the cap. No test-based model selection.

Meaningful improvement requires a paired 95% difference CI beyond 0.02 for >=30-min
sensitivity without worsening RMSE60 by >0.5, or beyond 0.5 mg/dL for RMSE60 without
worsening sensitivity by >0.02; false alerts must remain <=1/day for cap-eligible
models. Stop after three successive variants without meaningful improvement, or at
the hard compute/time limits. Stop early for the benchmark criterion only when the
validation RMSE60 upper CI <=20.1, >=30-min sensitivity lower CI >=0.65 and false
alerts/day upper CI <=1. The owner's comparator is self-reported and uses a possibly
different cohort/label protocol; numerical comparison cannot establish superiority.

## Budget and test authorization

Hard initial training/validation limits: US$20 TOTAL including retries, and six hours
elapsed from the first fitting job, whichever comes first. No paid resource may be
created until the owner approves a proposal specifying instance, region, current
hourly price, runtime, storage/other charges and total estimate. Reserve cleanup
charges within the cap; terminate resources at the limit. Local fitting also counts
toward the time limit. Do not start fitting until the dataset adapter, split access
controls and causality tests pass and the environment/configuration are recorded.

Owner's latest instruction withholds held-out-test access. Stop after validation and
present the frozen candidate, validation history and compute ledger. Only with a
subsequent explicit authorization may the single final test phase run; freeze all
models/calibration first, reserve an exclusive test-attempt marker, and evaluate
baselines, selected pooled model and the three dataset-held-out models together.
Never resume tuning after viewing test outcomes. Never access sealed synthetic test.

Until final results exist, do not add a performance claim or evidence table to the UI.

/**
 * Real-patient and external results shown on the Evidence page. Every number is copied from a committed artifact;
 * __tests__/external-evidence.test.ts checks them against those files so the page cannot drift from the evidence.
 */
export interface ExternalRow {
  label: string;
  sens30: number;
  sensAny: number | null;
  faPerDay: number;
  medianLeadMin: number | null;
}

export interface ExternalCheck {
  id: string;
  title: string;
  cohort: string;
  status: 'locked' | 'not-confirmed' | 'not-met';
  statusText: string;
  artifact: string;
  freeze: string | null;
  rows: ExternalRow[];
  note: string;
}

export const EXTERNAL_CHECKS: ExternalCheck[] = [
  {
    id: 'real-data-v1',
    title: 'Preregistered real-patient evaluation (locked)',
    cohort: '161 real patients: CGMacros, BIG IDEAs and ShanghaiT2DM; patient-level train / validation / test',
    status: 'locked',
    statusText: 'Single authorized test evaluation, finalized and locked',
    artifact: 'docs/evidence/real_data/RESULTS.md',
    freeze: null,
    rows: [
      { label: 'Masked physiological hybrid (ours)', sens30: 0.06, sensAny: null, faPerDay: 0.11, medianLeadMin: 10 },
      { label: 'Linear trend (30 min)', sens30: 0.45, sensAny: null, faPerDay: 3.83, medianLeadMin: 25 },
    ],
    note: '60-min RMSE 23.04 mg/dL [18.7–28.1] against 26.15 for persistence; alert precision 65.5%. Early warning is the weak point: 6% of spikes caught at least 30 min ahead.',
  },
  {
    id: 'hall-2018',
    title: 'External check 1: Hall et al. 2018',
    cohort: '57 unused participants (mostly normoglycaemic or prediabetic), CC BY 4.0',
    status: 'not-confirmed',
    statusText: 'Not confirmed: +7.8 points [0.0, +13.2] at ≥30 min, lower bound not above 0',
    artifact: 'docs/evidence/external_hall/RESULTS.md',
    freeze: 'd1a2d887',
    rows: [
      { label: 'Routine model, per-patient rule (selected)', sens30: 0.078125, sensAny: 0.265625, faPerDay: 0.029, medianLeadMin: 15 },
      { label: 'Learned baseline (comparator)', sens30: 0, sensAny: 0.140625, faPerDay: 0.013, medianLeadMin: 10 },
      { label: 'Linear trend reference', sens30: 0.328125, sensAny: 0.78125, faPerDay: 0.38, medianLeadMin: null },
    ],
    note: 'A simple trend rule did better than both learned policies on this cohort.',
  },
  {
    id: 'azt1d',
    title: 'External check 2: AZT1D',
    cohort: '24 unused adults with type 1 diabetes on automated insulin delivery, CC BY 4.0; 2,814 spike onsets',
    status: 'not-met',
    statusText: 'Not met: learned policy −2.5 points [−6.4, +1.4] vs trend and −2.7 [−5.7, +0.5] vs trend-or-risk at ≥30 min',
    artifact: 'docs/evidence/external_v2/RESULTS.md',
    freeze: '3f1d7350',
    rows: [
      { label: 'Learned baseline (selected)', sens30: 0.125, sensAny: 0.322, faPerDay: 0.892, medianLeadMin: 20 },
      { label: 'Trend alone', sens30: 0.15, sensAny: 0.33, faPerDay: 0.733, medianLeadMin: 25 },
      { label: 'Trend or risk', sens30: 0.152, sensAny: 0.31, faPerDay: 0.831, medianLeadMin: 25 },
      { label: 'Risk-gated trend (over budget)', sens30: 0.264, sensAny: 0.621, faPerDay: 1.258, medianLeadMin: 20 },
    ],
    note: 'Different physiology from the type 2 development cohorts. Forecast RMSE at 60 min: LightGBM 36.9, persistence 37.9 mg/dL.',
  },
];

/** The frozen early-warning candidate: training-only selection, exploratory validation, awaiting an unused cohort. */
export const C2_CANDIDATE = {
  title: 'Exploratory candidate: risk-gated trend with worst-fold threshold selection',
  rule: '(30-min trend projects ≥ 240 mg/dL at +60 min AND routine risk ≥ 0.20) OR routine risk ≥ 0.476',
  artifact: 'docs/evidence/fa_controller/README.md',
  confirmation: 'docs/evidence/aireadi_confirmation/PREREGISTRATION.md',
  rows: [
    { label: 'Risk-gated trend C2 (candidate)', sens30: 0.2727, sensAny: 0.6970, faPerDay: 0.871, medianLeadMin: 15 },
    { label: 'Learned baseline (best training-chosen threshold)', sens30: 0.2273, sensAny: 0.5808, faPerDay: 0.985, medianLeadMin: 15 },
  ] as ExternalRow[],
  pairedSens30: { point: 0.0455, lo: -0.0249, hi: 0.1278 },
  note: 'Validation patients were used in earlier work, so this is not independent. Confirmation is preregistered for AI-READI and has not been run: data access is not yet approved.',
};

/** How each kind of statement on this site is supported. */
export const CLAIM_TIERS = {
  proven: [
    'Ward → patient → forecast → What-if → clinician summary → evidence workflow, verified in a production browser on desktop and mobile',
    'FHIR R4 export validated in tests against the official HL7 R4 JSON schema, plus semantic checks',
    'Preregistered real-patient evaluation on 161 patients, single locked run (results as reported, including 6% early warning)',
    'Two preregistered external checks on unused cohorts, run once each and published whatever the outcome',
  ],
  exploratory: [
    'Daily-routine features improve risk ranking (training OOF +5.4 points ≥30 min)',
    'Risk-gated trend C2 stays within the false-alert budget on validation (+4.5 points, CI includes 0)',
  ],
  confirmed: [] as string[],
};

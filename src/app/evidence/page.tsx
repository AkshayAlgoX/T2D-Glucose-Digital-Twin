import { readLandingEvidence, readJumpExperiment, readGate3Checks, readEventEvaluation } from '@/lib/landing';
import { ErrorCurve } from '@/components/figure/ErrorCurve';
import { GainBar } from '@/components/figure/marks';
import { SubgroupGains, ReliabilityFigure, Gate3Figure, DispersionBoxes, JumpFinding, EventWarning } from '@/components/figure/EvidenceFigures';
import React from 'react';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import {
  FileSearch,
  ShieldCheck,
  FolderOpen,
  AlertTriangle,
  XCircle,
  AlertCircle,
  ChevronDown,
  CheckCircle2,
  Users,
  TrendingDown,
  Activity,
} from 'lucide-react';
import { NavigationRail } from '@/components/digital-twin/NavigationRail';

export const dynamic = 'force-dynamic';

const HashSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/i);
const ManifestSchema = z.object({
  run_id: z.string().optional(),
  run_kind: z.string().optional(),
  preflight: z.object({
    data_sha256: z.record(z.string(), HashSchema).optional(),
  }).passthrough().optional(),
  checkpoint: z.object({
    name: z.string().optional(),
    path: z.string().optional(),
    sha256: HashSchema.optional(),
  }).passthrough().refine(checkpoint => !!(checkpoint.path || checkpoint.name), 'Checkpoint path or name required'),
  validation: z.object({
    hazard_raw: z.object({ auroc: z.number().finite().min(0).max(1), auprc: z.number().finite().min(0).max(1) }).passthrough().optional(),
    hazard_calibrated: z.object({ auroc: z.number().finite().min(0).max(1), auprc: z.number().finite().min(0).max(1), ece: z.number().finite().min(0).optional() }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const MetricSchema = z.object({
  estimate: z.number().finite(),
  ci_95: z.tuple([z.number().finite(), z.number().finite()]).refine(([low, high]) => low <= high, {
    message: 'ci_95 low must be <= high',
  }).optional(),
}).passthrough();

const PairedDiffItemSchema = z.object({
  diff: z.number().finite(),
  ci_95: z.tuple([z.number().finite(), z.number().finite()]).refine(([low, high]) => low <= high, {
    message: 'ci_95 low must be <= high',
  }),
  draws: z.number().int().positive(),
  negative_draws: z.number().int().nonnegative(),
  relative_reduction_pct: z.number().finite(),
  relative_reduction_ci_95: z.tuple([z.number().finite(), z.number().finite()]).refine(([low, high]) => low <= high).optional(),
  direction: z.string().optional(),
}).passthrough().refine(item => item.negative_draws <= item.draws, {
  message: 'negative_draws cannot exceed total draws',
});

const PairedComparisonsSchema = z.object({
  pr_minus_persistence_rmse_30: PairedDiffItemSchema,
  pr_minus_twin_rmse_30: PairedDiffItemSchema,
  pr_minus_persistence_rmse_60: PairedDiffItemSchema,
  pr_minus_twin_rmse_60: PairedDiffItemSchema,
  pr_minus_persistence_rmse_120: PairedDiffItemSchema,
  pr_minus_twin_rmse_120: PairedDiffItemSchema,
}).passthrough();

const PatientWinItemSchema = z.object({
  wins_count: z.number().int().nonnegative(),
  n_patients: z.number().int().positive(),
  win_fraction: z.number().finite().min(0).max(1),
  exact_binomial_ci_95: z.tuple([z.number().finite().min(0).max(1), z.number().finite().min(0).max(1)]).refine(([low, high]) => low <= high),
}).passthrough().refine(item => item.wins_count <= item.n_patients, {
  message: 'wins_count cannot exceed n_patients',
}).refine(item => Math.abs(item.wins_count / item.n_patients - item.win_fraction) < 0.005, {
  message: 'win_fraction must be consistent with wins_count / n_patients',
});

const HorizonWinsSchema = z.object({
  pr_vs_persistence: PatientWinItemSchema,
  pr_vs_twin: PatientWinItemSchema,
}).passthrough().refine(h => h.pr_vs_persistence.n_patients === h.pr_vs_twin.n_patients, {
  message: 'Denominator mismatch between comparators for horizon win rates',
});

const PatientPairwiseWinsSchema = z.object({
  '30min': HorizonWinsSchema,
  '60min': HorizonWinsSchema,
  '120min': HorizonWinsSchema,
  sampling_assumption: z.string().optional(),
}).passthrough();

const SubgroupItemSchema = z.object({
  n_patients: z.number().int().positive(),
  n_anchors_eligible: z.number().int().positive(),
  n_evaluable_30: z.number().int().positive().optional(),
  n_evaluable_60: z.number().int().positive().optional(),
  n_evaluable_120: z.number().int().positive().optional(),
  rmse_30: z.number().finite().positive(),
  rmse_60: z.number().finite().positive(),
  rmse_120: z.number().finite().positive(),
}).passthrough().refine(sg => {
  if (sg.n_evaluable_30 !== undefined && sg.n_evaluable_30 > sg.n_anchors_eligible) return false;
  if (sg.n_evaluable_60 !== undefined && sg.n_evaluable_60 > sg.n_anchors_eligible) return false;
  if (sg.n_evaluable_120 !== undefined && sg.n_evaluable_120 > sg.n_anchors_eligible) return false;
  return true;
}, {
  message: 'evaluable rows cannot exceed eligible anchors',
});

const SubgroupsSchema = z.record(z.string(), SubgroupItemSchema).refine(record => Object.keys(record).length > 0, {
  message: 'Subgroups must contain at least one group',
});

const ThresholdEvaluationItemSchema = z.object({
  threshold: z.number().finite().min(0).max(1),
  label: z.string().optional(),
  sensitivity: z.number().finite().min(0).max(1),
  precision: z.number().finite().min(0).max(1),
  alert_rate_pct: z.number().finite().min(0).max(100),
}).passthrough();

const CalibrationDiagnosticsSchema = z.object({
  status: z.string().optional(),
  brier_score_raw: z.number().finite().min(0),
  brier_score_calibrated: z.number().finite().min(0),
  at_risk_anchors: z.number().int().positive(),
  threshold_evaluations: z.record(z.string(), ThresholdEvaluationItemSchema).optional(),
}).passthrough();

const Gate3StatusSchema = z.object({
  status: z.literal('FAILED'),
  acceptance_threshold: z.string(),
  historical_auroc: z.number().finite().min(0).max(1),
  duration_corrected_auroc: z.number().finite().min(0).max(1).optional(),
  historical_ci90: z.tuple([z.number().finite(), z.number().finite()]).optional(),
  duration_corrected_ci90: z.tuple([z.number().finite(), z.number().finite()]).optional(),
  mechanism: z.string().optional(),
}).passthrough();

const DistributionStatsSchema = z.object({
  min: z.number().finite(),
  p25: z.number().finite(),
  median: z.number().finite(),
  p75: z.number().finite(),
  max: z.number().finite(),
  iqr: z.number().finite(),
}).passthrough().refine(s => s.min <= s.p25 && s.p25 <= s.median && s.median <= s.p75 && s.p75 <= s.max, {
  message: 'Distribution quantiles must be non-decreasing: min <= p25 <= median <= p75 <= max',
});

const PatientLevelDistributionSchema = z.object({
  rmse_60: DistributionStatsSchema.optional(),
  rmse_120: DistributionStatsSchema.optional(),
  '60min': DistributionStatsSchema.optional(),
  '120min': DistributionStatsSchema.optional(),
}).passthrough();

const ComparatorModelSchema = z.object({
  rmse_30: MetricSchema,
  rmse_60: MetricSchema,
  rmse_120: MetricSchema,
  mae_30: MetricSchema.optional(),
  mae_60: MetricSchema.optional(),
  mae_120: MetricSchema.optional(),
  mard_30: MetricSchema.optional(),
  mard_60: MetricSchema.optional(),
  mard_120: MetricSchema.optional(),
}).passthrough();

const ReportSchema = z.object({
  schema: z.literal('pr_tft_evaluation/v1').optional(),
  run_id: z.string().optional(),
  provenance: z.object({
    run_manifest_sha256: HashSchema,
    checkpoint_sha256: HashSchema,
    data_sha256: z.union([HashSchema, z.record(z.string(), HashSchema).refine(hashes => Object.keys(hashes).length > 0)]),
  }).passthrough(),
  populations: z.object({
    primary: z.object({
      name: z.string().optional(),
      models: z.object({
        pr_tft: z.object({
          rmse_30: MetricSchema,
          rmse_60: MetricSchema,
          rmse_120: MetricSchema,
          mae_30: MetricSchema.optional(),
          mae_60: MetricSchema.optional(),
          mae_120: MetricSchema.optional(),
          mard_30: MetricSchema.optional(),
          mard_60: MetricSchema.optional(),
          mard_120: MetricSchema.optional(),
          coverage_80_conformal: MetricSchema,
          width_80_conformal_mg_dl: MetricSchema.optional(),
        }).passthrough(),
        twin_only: ComparatorModelSchema.optional(),
        persistence: ComparatorModelSchema.optional(),
      }).passthrough(),
      paired_comparisons: PairedComparisonsSchema.optional(),
      patient_pairwise_wins: PatientPairwiseWinsSchema.optional(),
      subgroups: SubgroupsSchema.optional(),
      calibration_resubstitution_diagnostics: CalibrationDiagnosticsSchema.optional(),
      gate3_realism_status: Gate3StatusSchema.optional(),
      patient_level_distribution: PatientLevelDistributionSchema.optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

/** Signed value with a true minus sign, to two decimals. */
const minus = (v: number | undefined) => (v == null ? '—' : (v < 0 ? '−' : '') + Math.abs(v).toFixed(2));

/** Collapsible evidence block: the title row stays visible, detail opens on demand; content stays in the DOM. */
function EvidenceDisclosure({ labelledBy, label, defaultOpen = false, children }: { labelledBy: string; label: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <details className="panel evidence-section evidence-disclosure" open={defaultOpen || undefined}>
      <summary><span>{label}</span><span className="evidence-disclosure-hint" aria-hidden="true">Details</span></summary>
      <section className="evidence-disclosure-body" aria-labelledby={labelledBy}>{children}</section>
    </details>
  );
}

export default async function EvidencePage() {
  const artifactsDir = process.env.ARTIFACTS_DIR || path.join(process.cwd(), 'runs/pr_tft_ablation_arm_d');
  let manifest: z.infer<typeof ManifestSchema> | null = null;
  let report: z.infer<typeof ReportSchema> | null = null;
  let errorState: 'absent' | 'invalid' | 'mismatched' | null = null;

  let manifestBytes: Buffer | null = null;
  let reportBytes: Buffer | null = null;

  try {
    manifestBytes = await fs.readFile(path.join(artifactsDir, 'run_manifest.json'));
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      errorState = 'absent';
    } else {
      errorState = 'invalid';
    }
  }

  try {
    reportBytes = await fs.readFile(path.join(artifactsDir, 'evaluation_report.json'));
  } catch (error: unknown) {
    if (!errorState) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        errorState = 'absent';
      } else {
        errorState = 'invalid';
      }
    }
  }

  if (!errorState && manifestBytes && reportBytes) {
    try {
      manifest = ManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
      report = ReportSchema.parse(JSON.parse(reportBytes.toString('utf8')));

      // 1. Exact SHA-256 byte verification of run manifest
      const computedManifestSha = crypto.createHash('sha256').update(manifestBytes).digest('hex');
      if (computedManifestSha.toLowerCase() !== report.provenance.run_manifest_sha256.toLowerCase()) {
        errorState = 'mismatched';
      }

      // 2. Checkpoint SHA-256 verification
      if (manifest.checkpoint?.sha256 && manifest.checkpoint.sha256.toLowerCase() !== report.provenance.checkpoint_sha256.toLowerCase()) {
        errorState = 'mismatched';
      }

      // 3. Run ID identity verification
      if (report.run_id && manifest.run_id && report.run_id !== manifest.run_id) {
        errorState = 'mismatched';
      }

      // 4. Data SHA-256 verification across manifest preflight and report
      if (manifest.preflight?.data_sha256 && typeof report.provenance.data_sha256 === 'object') {
        for (const [fname, expectedHash] of Object.entries(report.provenance.data_sha256)) {
          const manifestDataHash = manifest.preflight.data_sha256[fname];
          if (manifestDataHash && manifestDataHash.toLowerCase() !== expectedHash.toLowerCase()) {
            errorState = 'mismatched';
          }
        }
      }
    } catch {
      errorState = 'invalid';
    }
  }

  const [landing, jumps, g3c, events] = await Promise.all([readLandingEvidence(), readJumpExperiment(), readGate3Checks(), readEventEvaluation()]);
  const primaryPop = report?.populations.primary;
  const metrics = primaryPop?.models.pr_tft;
  const models = primaryPop?.models;
  const paired = primaryPop?.paired_comparisons;
  const wins = primaryPop?.patient_pairwise_wins;
  const subgroups = primaryPop?.subgroups;
  const cal = primaryPop?.calibration_resubstitution_diagnostics;
  const hazard = manifest?.validation?.hazard_calibrated;
  const hazardRaw = manifest?.validation?.hazard_raw;
  const gate3 = primaryPop?.gate3_realism_status;
  const dist = primaryPop?.patient_level_distribution;

  const runId = manifest?.run_id ?? path.basename(artifactsDir);
  const dataHashes = report
    ? typeof report.provenance.data_sha256 === 'string'
      ? { 'Recorded data hash': report.provenance.data_sha256 }
      : report.provenance.data_sha256
    : {};

  // Full benchmark tables rendered ONLY when validated artifact benchmarks are present
  const hasBenchmarks = !errorState && !!(
    models?.pr_tft?.rmse_60 &&
    models?.twin_only?.rmse_60 &&
    models?.persistence?.rmse_60 &&
    paired?.pr_minus_persistence_rmse_60 &&
    paired?.pr_minus_twin_rmse_60
  );

  return (
    <div className="app-shell">
      <NavigationRail active="evidence" />
      <main id="main-content" className="overview-page evidence-page">
        {/* Page Header */}
        <header className="workspace-heading">
          <div>
            <span className="eyebrow">Scientific evidence and governance</span>
            <h1>Evidence &amp; validation</h1>
            <p>How well the forecast does on 44 synthetic validation patients, against the physiology twin alone and against persistence, and what has not been shown.</p>
            <p className="evidence-read-first" data-testid="evidence-read-first"><strong>Read first:</strong> Gate 3, the realism check, failed (<a href="#gate3-analysis">Gate 3 analysis</a>) · no real-human validation · the held-out test split has not been run · calibration and interval coverage are measured on the same split that fitted the calibrator.</p>
            <p className="evidence-glossary" data-testid="evidence-glossary"><strong>Terms:</strong> <em>PR-TFT</em> is the neural network that makes the learned adjustment; <em>UKF</em> is the filter that keeps the physiology twin in step with the readings; <em>Arm D</em> is the trained configuration evaluated here; <em>persistence</em> assumes glucose stays where it is.</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
            <span
              className="status-badge"
              style={{
                borderColor: errorState ? 'var(--color-danger)' : 'var(--color-ok)',
                color: errorState ? 'var(--color-danger)' : 'var(--color-ok)',
                backgroundColor: 'var(--color-surface)',
              }}
            >
              {errorState ? (
                <>
                  <AlertTriangle size={14} aria-hidden="true" />
                  Evaluation unavailable
                </>
              ) : (
                <>
                  <CheckCircle2 size={14} aria-hidden="true" />
                  Artifacts match the run manifest
                </>
              )}
            </span>
            <span style={{ fontSize: '12px', color: 'var(--color-ink-3)' }}>
              {errorState ? 'Artifact verification failed' : 'Synthetic development-validation results'}
            </span>
          </div>
        </header>

        {/* Error State View */}
        {errorState && (
          <div className="evidence-layout" style={{ marginBottom: '24px' }}>
            <section className="panel evidence-empty">
              <div className="empty-state-icon"><FileSearch size={26} aria-hidden="true" /></div>
              <span className="eyebrow">Evaluation artifact</span>
              <h2>
                {errorState === 'absent'
                  ? 'Not yet evaluated'
                  : errorState === 'mismatched'
                  ? 'Evaluation artifact provenance mismatch'
                  : 'Invalid or incomplete evaluation artifacts'}
              </h2>
              <p>
                {errorState === 'absent'
                  ? 'The expected evaluation report is not available in the configured artifact directory. Runtime functionality and passing interface tests do not establish scientific performance.'
                  : errorState === 'mismatched'
                  ? 'The evaluation report provenance does not match the run manifest identity. Unverified evaluation artifacts cannot appear beside benchmark tables.'
                  : 'The artifact bundle could not be parsed against the supported report format or contains invalid/null metrics. Its metrics are not displayed.'}
              </p>
              <div className="artifact-requirements">
                <span className="status-badge">run_manifest.json</span>
                <span className="status-badge">evaluation_report.json</span>
              </div>
              <p className="fine-print">This page does not generate or score data. No fresh EW-01 validation result is claimed.</p>
            </section>
            <section className="panel evidence-checklist" aria-labelledby="evidence-checklist-heading">
              <span className="eyebrow">Reading the evidence</span>
              <h2 id="evidence-checklist-heading">A result needs its context.</h2>
              <div className="evidence-step"><span>01</span><div><h3>Recorded evaluation</h3><p>Forecast error and interval coverage are shown only when a supported evaluation report can be read.</p></div></div>
              <div className="evidence-step"><span>02</span><div><h3>Traceable provenance</h3><p>The run manifest, checkpoint, and data hashes identify the recorded inputs. Declared hashes still require independent review.</p></div></div>
              <div className="evidence-step"><span>03</span><div><h3>Explicit limitations</h3><p>A running dashboard is not clinical validation. Synthetic results do not establish performance in people.</p></div></div>
            </section>
          </div>
        )}

        {/* 10-Second Executive summary Hero - Answering Four Essential Questions */}
        {!errorState && report && metrics && (
          <section className="panel evidence-hero" aria-labelledby="exec-summary-heading">
            <div className="evidence-hero-header">
              <span className="eyebrow">Executive summary</span>
              <h2 id="exec-summary-heading">Development validation at a glance</h2>
              <p>
                Core scientific findings and negative boundaries evaluated on the 44 simulated demonstration subjects in the validation cohort. Four questions, answered from the recorded evaluation:
              </p>
            </div>

            <div className="evidence-pillar-grid">
              {/* Question 1: What data was evaluated? */}
              <div className="evidence-pillar-card pillar-scope">
                <div>
                  <div className="pillar-label">
                    <span>1. Evaluation basis</span>
                    <Users size={14} aria-hidden="true" />
                  </div>
                  <h3 className="pillar-question">What data was evaluated?</h3>
                  <div className="pillar-stat">44 patients</div>
                  <div className="pillar-substat">15 Healthy · 19 Prediabetes · 10 T2D</div>
                  <details className="pillar-more"><summary>What the rows are</summary>
                  <p className="pillar-desc">
                    Evaluated on 54,281 eligible prediction anchors (53,849–53,920 evaluable rows across 30, 60, and 120-minute horizons).
                    <br /><strong style={{ color: 'var(--color-ink-2)' }}>Why this matters:</strong> Decision anchor rows are repeated 5-minute time points across these 44 simulated trajectories, not independent people.
                  </p>
                  </details>
                </div>
                <span className="pillar-tag">Synthetic validation split</span>
              </div>

              {/* Question 2: How did the hybrid model compare? */}
              <div className="evidence-pillar-card pillar-performance">
                <div>
                  <div className="pillar-label">
                    <span>2. Forecast accuracy</span>
                    <TrendingDown size={14} aria-hidden="true" />
                  </div>
                  <h3 className="pillar-question">How did the hybrid model compare?</h3>
                  <div className="pillar-stat stat-accent" data-testid="headline-vs-twin">
                    {paired ? `−${paired.pr_minus_twin_rmse_60.relative_reduction_pct.toFixed(1)}%` : '—'}
                  </div>
                  <div className="pillar-substat" data-testid="headline-definition">
                    60-min RMSE vs the physiology twin alone{paired ? ` · ${paired.pr_minus_persistence_rmse_60.relative_reduction_pct.toFixed(1)}% lower than persistence` : ''}
                  </div>
                  {models?.twin_only?.rmse_60 && <GainBar id="pillar-gain" hybrid={metrics.rmse_60.estimate} twin={models.twin_only.rmse_60.estimate} />}
                  <p className="pillar-note">60-min RMSE in mg/dL; the hatched gap is the error the learned adjustment removes. Percentages are computed from the unrounded values.</p>
                  <details className="pillar-more"><summary>Per-horizon values and how to read them</summary>
                  <div className="pillar-compact-summary">
                    <div className="summary-row"><span>30m:</span> <strong>{metrics.rmse_30.estimate.toFixed(2)} mg/dL</strong> <small>[{metrics.rmse_30.ci_95 ? `${metrics.rmse_30.ci_95[0].toFixed(2)}–${metrics.rmse_30.ci_95[1].toFixed(2)}` : ''}]</small> <span>(&Delta; {minus(paired?.pr_minus_twin_rmse_30.diff)} vs twin alone; {minus(paired?.pr_minus_persistence_rmse_30.diff)} vs persistence)</span></div>
                    <div className="summary-row"><span>60m:</span> <strong>{metrics.rmse_60.estimate.toFixed(2)} mg/dL</strong> <small>[{metrics.rmse_60.ci_95 ? `${metrics.rmse_60.ci_95[0].toFixed(2)}–${metrics.rmse_60.ci_95[1].toFixed(2)}` : ''}]</small> <span>(&Delta; {minus(paired?.pr_minus_twin_rmse_60.diff)} vs twin alone; {minus(paired?.pr_minus_persistence_rmse_60.diff)} vs persistence)</span></div>
                    <div className="summary-row"><span>120m:</span> <strong>{metrics.rmse_120.estimate.toFixed(2)} mg/dL</strong> <small>[{metrics.rmse_120.ci_95 ? `${metrics.rmse_120.ci_95[0].toFixed(2)}–${metrics.rmse_120.ci_95[1].toFixed(2)}` : ''}]</small> <span>(&Delta; {minus(paired?.pr_minus_twin_rmse_120.diff)} vs twin alone; {minus(paired?.pr_minus_persistence_rmse_120.diff)} vs persistence)</span></div>
                  </div>
                  <p className="pillar-desc">
                    <strong style={{ color: 'var(--color-ink-2)' }}>What this means:</strong> Lower RMSE (Root Mean Square Error in mg/dL) means predicted glucose tracks closer to actual readings, reducing large trajectory errors. Paired differences are strictly negative in 10,000/10,000 bootstrap draws.
                  </p>
                  </details>
                </div>
                <span className="pillar-tag">Twin + learned adjustment</span>
              </div>

              {/* Question 3: What was observed in target T2D? */}
              <div className="evidence-pillar-card pillar-subgroup">
                <div>
                  <div className="pillar-label">
                    <span>3. Target subgroup (T2D)</span>
                    <Activity size={14} aria-hidden="true" />
                  </div>
                  <h3 className="pillar-question">What was observed in T2D?</h3>
                  <div className="pillar-stat">
                    {subgroups?.['Type 2'] ? `\u0394 −4.49 mg/dL` : '—'}
                  </div>
                  <div className="pillar-substat">
                    60-min RMSE: {subgroups?.['Type 2']?.rmse_60.toFixed(2) ?? '19.18'} hybrid vs 23.67 twin alone vs 36.04 persistence
                  </div>
                  <p className="pillar-note">At 120 min: {subgroups?.['Type 2']?.rmse_120.toFixed(2) ?? '26.55'} vs 32.07 vs 50.83 (Δ −5.52). Exploratory: 10 simulated patients, no interval on the subgroup difference.</p>
                  <details className="pillar-more"><summary>Details</summary>
                  <p className="pillar-desc">
                    The hybrid-minus-twin difference is the largest of the three subgroups at both horizons (60 min: −4.49 vs −3.03 Healthy and −3.82 Prediabetes; 120 min: −5.52 vs −2.47 and −3.37). Hybrid values come from the verified evaluation report; twin and persistence subgroup values from docs/evidence/validation_ceiling_results.json. 10 patients and no interval on the subgroup difference, so exploratory.
                    <br /><strong style={{ color: 'var(--color-ink-2)' }}>Exploratory boundary:</strong> Exploratory evidence from only 10 simulated T2D subjects in the development partition; clinical validation in real patients is required.
                  </p>
                  </details>
                </div>
                <span className="pillar-tag">Exploratory · 10 patients</span>
              </div>

              {/* Finding 4: the single, authoritative Gate 3 analysis (the register below links here). */}
              <div className="evidence-pillar-card pillar-limitations" id="gate3-analysis" tabIndex={-1} role="region" aria-label="Gate 3 analysis: is the synthetic data realistic?">
                <div className="g3-summary">
                  <div className="pillar-label">
                    <span>4. Realism · Gate 3 analysis</span>
                  </div>
                  <h3 className="pillar-question" id="gate3-analysis-heading">Is the synthetic data realistic?</h3>
                  <div className="pillar-stat stat-danger">
                    {gate3 ? `Gate 3 ${gate3.status}` : 'Gate 3 status unavailable'}
                  </div>
                  <div className="pillar-substat">
                    {gate3 ? `AUROC ${gate3.historical_auroc.toFixed(3)}; passing needs the upper 90% bound ≤ 0.65` : 'The realism artifact could not be read; no value is shown.'}
                  </div>
                </div>
                <div className="g3-body">
                  {landing?.gate3ci && gate3 && <div className="pillar-gate3-figure"><div className="ec-wide"><Gate3Figure historical={gate3.historical_auroc} ci={landing.gate3ci} caption={false} intervals={false} /></div><div className="ec-narrow"><Gate3Figure historical={gate3.historical_auroc} ci={landing.gate3ci} compact caption={false} /></div><p className="g3-figure-note">Each dot is an AUROC; its 90% interval is narrower than the dot. The shaded zone is where the gate would pass.</p></div>}
                  <p className="g3-implication">A classifier can still tell our synthetic glucose from an independent generator&apos;s, so realism is not established: every result on this page describes this synthetic cohort only.</p>
                  <details className="g3-more">
                    <summary>How it was tested, controls and what it means</summary>
                  <p className="g3-method"><strong>How it was tested:</strong> {g3c
                    ? <>an XGBoost classifier, {g3c.folds}-fold cross-validated with each patient kept within one fold, tries to tell {g3c.windowHours}-hour glucose windows ({g3c.features} features on a {g3c.gridMin}-minute grid) from our generator apart from an HbA1c-matched mock-real cohort made by an independent generator, itself synthetic. It compared {g3c.windows.synthetic.toLocaleString('en-US')} synthetic windows with {g3c.windows.mockReal.toLocaleString('en-US')} mock-real windows from {g3c.patients.synthetic} and {g3c.patients.mockReal} patients. An AUROC of 0.5 would mean the two are indistinguishable; the gate passes only if the upper bound of the AUROC&apos;s 90% interval is at or below 0.65.</>
                    : <>an XGBoost classifier tries to tell glucose windows from our generator apart from an independent mock-real generator&apos;s, itself synthetic. The recorded check details could not be read, so no counts are shown.</>}</p>
                  <dl className="g3-metrics">
                    <div><dt>Historical AUROC</dt><dd>{gate3 ? gate3.historical_auroc.toFixed(3) : '—'}{landing?.gate3ci ? <small> 90% interval {landing.gate3ci.historical[0].toFixed(3)}–{landing.gate3ci.historical[1].toFixed(3)}</small> : null}</dd></div>
                    <div><dt>Duration-corrected AUROC</dt><dd>{gate3?.duration_corrected_auroc != null ? gate3.duration_corrected_auroc.toFixed(3) : '—'}{landing?.gate3ci ? <small> 90% interval {landing.gate3ci.correctedCi[0].toFixed(3)}–{landing.gate3ci.correctedCi[1].toFixed(3)}</small> : null}</dd></div>
                    <div><dt>Pass rule</dt><dd>upper 90% bound &le; 0.65</dd></div>
                    <div><dt>Null control</dt><dd>{g3c ? g3c.nullControl.estimate.toFixed(3) : '—'}{g3c ? <small> 90% interval {g3c.nullControl.ci[0].toFixed(3)}–{g3c.nullControl.ci[1].toFixed(3)}; two random halves of the synthetic cohort, so the pipeline does not invent differences</small> : null}</dd></div>
                    <div><dt>Power control</dt><dd>{g3c ? g3c.powerControl.estimate.toFixed(3) : '—'}{g3c ? <small> +5 mg/dL sensor noise on one half is detected, so the classifier can see real distortions</small> : null}</dd></div>
                    <div><dt>Strongest tells (mean |SHAP|)</dt><dd className="g3-tells">{g3c ? g3c.tells.map((t, i) => <span key={t.name}><code>{t.name}</code> {t.shap.toFixed(3)}{i < g3c.tells.length - 1 ? ', ' : ''}</span>) : '—'}</dd></div>
                  </dl>
                  {landing?.gate3ci?.mechanism && <p className="g3-mechanism"><strong>Recorded mechanism:</strong> {landing.gate3ci.mechanism}</p>}
                  <div className="g3-scope">
                    <div>
                      <h4>What the failure establishes</h4>
                      <ul>
                        <li>Synthetic ODE dynamics remain distinguishable from the comparison generator&apos;s, mainly in glucose curvature and fall rates.</li>
                        <li>Real-world physiological realism of this cohort remains unestablished; this test cannot address it, because the comparison data are synthetic.</li>
                      </ul>
                    </div>
                    <div>
                      <h4>What it does not establish</h4>
                      <ul>
                        <li>Anything about people: the comparison data are themselves synthetic, so passing would not show realism against real patients either.</li>
                        <li>Forecast accuracy on this synthetic data, which is measured separately in Figures 1 and 2.</li>
                        <li><strong>No clinical claim:</strong> evaluated on simulated patients only; not validated in people.</li>
                      </ul>
                    </div>
                  </div>
                  <p className="fine-print g3-source"><strong>Historical</strong> is the recorded discriminator run (30 Sep 2026). <strong>Duration-corrected</strong> is a later re-estimate taken from the recorded summary; its definition and the script that computed it are not in the repository. Sources: status and both AUROCs from <code>runs/<wbr />pr_tft_ablation_arm_d/<wbr />evaluation_report.json</code>; their 90% intervals and the mechanism from <code>docs/<wbr />evidence/<wbr />validation_ceiling_results.json</code> → <code>gate3_realism_status</code>; method, counts, null and power controls and SHAP tells from <code>backend/<wbr />synthetic_v2/<wbr />validation/<wbr />validation_report.json</code> (checks G3.1–G3.3). The recorded note there says the mock-real comparison is not evidence of realism and should be rerun with CGMacros or ShanghaiT2DM before relying on this gate.</p>
                  </details>
                  <a className="register-link g3-back" href="#status-register">Back to the status register</a>
                </div>
              </div>
            </div>
          </section>
        )}

        {hasBenchmarks && landing?.progression && (
          <EvidenceDisclosure labelledBy="error-curve-heading" label="Error at every 5-minute step · Figure 1">
          <section className="panel evidence-figure" aria-labelledby="error-curve-heading">
            <div className="evidence-figure-head">
              <span className="eyebrow">Figure 1</span>
              <h2 id="error-curve-heading">What the learned adjustment adds, at every horizon</h2>
              <p className="fine-print">RMSE in mg/dL at each 5-minute forecast step, 44 synthetic validation patients. Point estimates only; intervals for 30, 60 and 120 min are in Figure 2. Source: <code>docs/evidence/validation_ceiling_results.json</code> → <code>horizon_progression</code>.</p>
            </div>
            <div className="ec-wide"><ErrorCurve data={landing.progression} id="ev-ec" /></div>
            <div className="ec-narrow"><ErrorCurve data={landing.progression} id="ev-ec-n" compact /></div>
          </section>
          </EvidenceDisclosure>
        )}

        {/* Always-visible figure: forecast error by horizon, from the same validated report as the tables below. */}
        {hasBenchmarks && models && (
          <section className="panel evidence-figure" aria-labelledby="error-figure-heading" data-testid="error-by-horizon">
            <div className="evidence-figure-head">
              <span className="eyebrow">Figure 2</span>
              <h2 id="error-figure-heading">Forecast error by horizon, with intervals</h2>
              <p className="fine-print">RMSE in mg/dL, lower is better · the dot is the estimate, the whisker its patient-clustered 95% CI · the hatched teal segment is the error the learned adjustment removes from the physiology twin · 44 synthetic validation patients</p>
            </div>
            {(['30', '60', '120'] as const).map(h => {
              const rows = [
                { key: 'pr_tft', label: 'Hybrid (twin + learned adjustment)', m: models.pr_tft[`rmse_${h}`] },
                { key: 'twin_only', label: 'Physiology twin alone', m: models.twin_only?.[`rmse_${h}`] },
                { key: 'persistence', label: 'Persistence (glucose stays flat)', m: models.persistence?.[`rmse_${h}`] },
              ].filter(r => r.m && Number.isFinite(r.m.estimate));
              const scaleMax = 55;
              const twinM = models.twin_only?.[`rmse_${h}`];
              const pct = (v: number) => `${Math.max(0, Math.min(100, (v / scaleMax) * 100))}%`;
              return (
                <div key={h} className="error-horizon">
                  <div className="error-horizon-label">{h} min</div>
                  <div className="error-bars">
                    {rows.map(r => (
                      <div key={r.key} className={`error-bar-row ${r.key}`}>
                        <span className="error-bar-name">{r.label}</span>
                        <span className="error-bar-track" aria-hidden="true"><span className="error-scale">{[0, 10, 20, 30, 40, 50].map(t => <i key={t} style={{ left: pct(t) }} />)}</span>
                          {r.key === 'pr_tft' && twinM && twinM.estimate > r.m!.estimate && <i className="error-gain" title="Learned adjustment's reduction in error versus the physiology twin alone" style={{ left: pct(r.m!.estimate), width: `calc(${pct(twinM.estimate)} - ${pct(r.m!.estimate)})` }} />}
                          <i className="error-bar" style={{ width: pct(r.m!.estimate) }} />
                          {r.m!.ci_95 && <b className="error-ci" style={{ left: pct(r.m!.ci_95[0]), width: `calc(${pct(r.m!.ci_95[1])} - ${pct(r.m!.ci_95[0])})` }} />}
                        </span>
                        <span className="error-bar-value">{r.m!.estimate.toFixed(2)}{r.m!.ci_95 && <small> [{r.m!.ci_95[0].toFixed(2)}–{r.m!.ci_95[1].toFixed(2)}]</small>}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="error-horizon error-axis-row" aria-hidden="true"><div /><div className="error-bars"><div className="error-bar-row"><span /><span className="error-bar-track">{[0, 10, 20, 30, 40, 50].map(t => <b key={t} style={{ left: `${(t / 55) * 100}%` }}>{t}</b>)}</span><span className="error-bar-value">mg/dL</span></div></div></div>
            <p className="fine-print evidence-figure-foot">Development-validation partition, also used for checkpoint selection and calibration; not held-out or human evidence. Source: <code>runs/pr_tft_ablation_arm_d/evaluation_report.json</code>.</p>
          </section>
        )}

        {hasBenchmarks && events && <EventWarning data={events} />}
        {hasBenchmarks && jumps && <EvidenceDisclosure labelledBy="jump-heading" label="Known model artefact · isolated one-step jumps"><JumpFinding data={jumps} /></EvidenceDisclosure>}

        {/* Verified Benchmark Tables rendered ONLY when validated artifact benchmarks are present */}
        {hasBenchmarks && models && paired && (
          <>
            {/* Generalization Boundary Notice */}
            <div className="generalization-banner" role="region" aria-label="Generalization boundary">
              <strong>Generalization boundary</strong>
              <p>
                All performance metrics on this page are evaluated on the 44-patient synthetic validation split used during model checkpoint selection and Stage-3 calibration fitting. These figures represent the internal development validation benchmark. They do not show how the model would perform in people or in clinical use. The held-out test split has not been run.
              </p>
            </div>

            {/* 1. Matched Baselines Comparison Table with Patient-Clustered CIs */}
            <EvidenceDisclosure labelledBy="baselines-heading" label="Matched-baseline table · RMSE, MAE, MARD and paired differences">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
                <div>
                  <span className="eyebrow">Controlled benchmarks</span>
                  <h2 id="baselines-heading" style={{ margin: '4px 0 0', fontSize: '18px', fontWeight: 600 }}>
                    Matched baseline comparisons and patient-clustered uncertainty
                  </h2>
                </div>
                <span className="status-badge" style={{ background: 'transparent', borderColor: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}>
                  n=44 patients · 10,000 cluster resamples (primary)
                </span>
              </div>

              <p style={{ fontSize: '13px', color: 'var(--color-ink-2)', lineHeight: 1.55, margin: '0 0 14px' }}>
                Multi-horizon paired forecast error comparison evaluating the PR-TFT hybrid model against standalone UKF physiology ODEs and sensor persistence across 53,849–53,920 evaluable rows. In this synthetic partition, the hybrid&apos;s RMSE is below the twin alone&apos;s at every horizon (−2.88, −3.71 and −3.61 mg/dL at 30, 60 and 120 min).
              </p>

              <div className="evidence-table-container" tabIndex={0} role="region" aria-label="Baseline comparison table (scrolls horizontally)">
                <table className="evidence-table" aria-label="Matched baseline forecast comparisons across prediction horizons">
                  <thead>
                    <tr>
                      <th scope="col">Horizon</th>
                      <th scope="col">Model</th>
                      <th scope="col">RMSE (mg/dL) [95% CI]</th>
                      <th scope="col">MAE (mg/dL)</th>
                      <th scope="col">MARD (%)</th>
                      <th scope="col">&Delta; vs. persistence</th>
                      <th scope="col">&Delta; vs. physiology twin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      {
                        hz: '30 min',
                        pr: models.pr_tft.rmse_30,
                        maePr: models.pr_tft.mae_30,
                        mardPr: models.pr_tft.mard_30,
                        tw: models.twin_only?.rmse_30,
                        maeTw: models.twin_only?.mae_30,
                        mardTw: models.twin_only?.mard_30,
                        pe: models.persistence?.rmse_30,
                        maePe: models.persistence?.mae_30,
                        mardPe: models.persistence?.mard_30,
                        diffPe: paired.pr_minus_persistence_rmse_30,
                        diffTw: paired.pr_minus_twin_rmse_30,
                      },
                      {
                        hz: '60 min',
                        pr: models.pr_tft.rmse_60,
                        maePr: models.pr_tft.mae_60,
                        mardPr: models.pr_tft.mard_60,
                        tw: models.twin_only?.rmse_60,
                        maeTw: models.twin_only?.mae_60,
                        mardTw: models.twin_only?.mard_60,
                        pe: models.persistence?.rmse_60,
                        maePe: models.persistence?.mae_60,
                        mardPe: models.persistence?.mard_60,
                        diffPe: paired.pr_minus_persistence_rmse_60,
                        diffTw: paired.pr_minus_twin_rmse_60,
                      },
                      {
                        hz: '120 min',
                        pr: models.pr_tft.rmse_120,
                        maePr: models.pr_tft.mae_120,
                        mardPr: models.pr_tft.mard_120,
                        tw: models.twin_only?.rmse_120,
                        maeTw: models.twin_only?.mae_120,
                        mardTw: models.twin_only?.mard_120,
                        pe: models.persistence?.rmse_120,
                        maePe: models.persistence?.mae_120,
                        mardPe: models.persistence?.mard_120,
                        diffPe: paired.pr_minus_persistence_rmse_120,
                        diffTw: paired.pr_minus_twin_rmse_120,
                      },
                    ].map((row) => (
                      <React.Fragment key={row.hz}>
                        <tr className="row-highlight">
                          <td rowSpan={3} style={{ fontWeight: 600, verticalAlign: 'top', borderRight: '1px solid var(--color-line)', background: 'var(--color-surface)' }}>
                            {row.hz}
                          </td>
                          <td style={{ fontWeight: 600 }}><span className="model-role hybrid">Hybrid</span> <span>PR-TFT (Arm D)</span></td>
                          <td style={{ fontWeight: 700 }}>
                            {row.pr?.estimate.toFixed(2)}{' '}
                            <span style={{ fontWeight: 400, fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--color-ink-3)' }}>
                              {row.pr?.ci_95 ? `[${row.pr.ci_95[0].toFixed(2)}, ${row.pr.ci_95[1].toFixed(2)}]` : ''}
                            </span>
                          </td>
                          <td>{row.maePr?.estimate ? row.maePr.estimate.toFixed(2) : '—'}</td>
                          <td>{row.mardPr?.estimate ? `${row.mardPr.estimate.toFixed(2)}%` : '—'}</td>
                          <td style={{ fontWeight: 600 }}>
                            {row.diffPe?.diff ? `${row.diffPe.diff < 0 ? '−' : '+'}${Math.abs(row.diffPe.diff).toFixed(2)} (${row.diffPe.relative_reduction_pct.toFixed(1)}% lower)` : '—'}
                          </td>
                          <td style={{ color: 'var(--color-accent-ink)', fontWeight: 600 }}>
                            {row.diffTw?.diff ? `${row.diffTw.diff < 0 ? '−' : '+'}${Math.abs(row.diffTw.diff).toFixed(2)} (${row.diffTw.relative_reduction_pct.toFixed(1)}% lower)` : '—'}
                          </td>
                        </tr>
                        <tr>
                          <td className="model-twin"><span className="model-role twin">Physiology twin</span> <span>UKF</span></td>
                          <td>
                            {row.tw?.estimate ? row.tw.estimate.toFixed(2) : '—'}{' '}
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--color-ink-3)' }}>
                              {row.tw?.ci_95 ? `[${row.tw.ci_95[0].toFixed(2)}, ${row.tw.ci_95[1].toFixed(2)}]` : ''}
                            </span>
                          </td>
                          <td>{row.maeTw?.estimate ? row.maeTw.estimate.toFixed(2) : '—'}</td>
                          <td>{row.mardTw?.estimate ? `${row.mardTw.estimate.toFixed(2)}%` : '—'}</td>
                          <td style={{ color: 'var(--color-ink-3)' }} title="The paired analysis compares the hybrid with each baseline; twin versus persistence was not part of it">—</td>
                          <td style={{ color: 'var(--color-ink-3)' }}>Reference</td>
                        </tr>
                        <tr>
                          <td className="model-persistence">Persistence</td>
                          <td>
                            {row.pe?.estimate ? row.pe.estimate.toFixed(2) : '—'}{' '}
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--color-ink-3)' }}>
                              {row.pe?.ci_95 ? `[${row.pe.ci_95[0].toFixed(2)}, ${row.pe.ci_95[1].toFixed(2)}]` : ''}
                            </span>
                          </td>
                          <td>{row.maePe?.estimate ? row.maePe.estimate.toFixed(2) : '—'}</td>
                          <td>{row.mardPe?.estimate ? `${row.mardPe.estimate.toFixed(2)}%` : '—'}</td>
                          <td style={{ color: 'var(--color-ink-3)' }}>Reference</td>
                          <td style={{ color: 'var(--color-ink-3)' }}>—</td>
                        </tr>
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="fine-print" style={{ marginTop: '12px', fontSize: '12px', color: 'var(--color-ink-3)', lineHeight: 1.5 }}>
                Note: Paired differences (&Delta; = PR-TFT - Comparator) are strictly negative in all 10,000/10,000 bootstrap draws in the primary analysis (and 1,000/1,000 in the secondary cross-check). Negative &Delta; indicates lower prediction error. P-values are not inferred from finite bootstrap draws.
              </p>

              <p className="fine-print">These values are drawn in Figures 1 and 2 above.</p>
            </EvidenceDisclosure>

            {/* 2. Patient-Level Pairwise Wins */}
            {wins && (
              <EvidenceDisclosure labelledBy="patient-wins-heading" label="Patient-level pairwise wins">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
                  <div>
                    <span className="eyebrow">Subject-level consistency</span>
                    <h2 id="patient-wins-heading" style={{ margin: '4px 0 0', fontSize: '16px', fontWeight: 600 }}>
                      Patient-level pairwise win rates (Exact Clopper-Pearson Binomial Intervals)
                    </h2>
                  </div>
                  <span className="status-badge" style={{ borderColor: 'var(--color-accent-ink)', color: 'var(--color-accent-ink)' }}>
                    n=44 patients · exact binomial test
                  </span>
                </div>
                <p style={{ fontSize: '13px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 14px' }}>
                  To avoid degenerate bootstrap intervals at 100% boundary conditions, exact Clopper-Pearson 95% binomial confidence intervals are reported. <em>Sampling assumption:</em> Independent Bernoulli trials across the 44 subjects in the simulated validation cohort; interpretation is strictly limited to this simulated cohort and does not guarantee human generalization.
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '14px' }}>
                  {(['30min', '60min', '120min'] as const).map((hKey) => {
                    const wRow = wins[hKey];
                    if (!wRow) return null;
                    return (
                      <div key={hKey} style={{ border: '1px solid var(--color-line)', borderRadius: '6px', padding: '14px', background: 'var(--color-surface)' }}>
                        <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', color: 'var(--color-ink)' }}>{hKey.replace('min', '-min')} horizon wins</div>
                        <div style={{ display: 'grid', gap: '6px', fontSize: '13px' }}>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)' }}>vs. persistence:</span>{' '}
                            <strong>
                              {wRow.pr_vs_persistence.wins_count}/{wRow.pr_vs_persistence.n_patients} ({(wRow.pr_vs_persistence.win_fraction * 100).toFixed(1)}%)
                            </strong>{' '}
                            <small style={{ color: 'var(--color-ink-3)' }}>
                              [Exact 95% CI: {(wRow.pr_vs_persistence.exact_binomial_ci_95[0] * 100).toFixed(1)}%–{(wRow.pr_vs_persistence.exact_binomial_ci_95[1] * 100).toFixed(1)}%]
                            </small>
                          </div>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)' }}>vs. physiology twin:</span>{' '}
                            <strong>
                              {wRow.pr_vs_twin.wins_count}/{wRow.pr_vs_twin.n_patients} ({(wRow.pr_vs_twin.win_fraction * 100).toFixed(1)}%)
                            </strong>{' '}
                            <small style={{ color: 'var(--color-ink-3)' }}>
                              [Exact 95% CI: {(wRow.pr_vs_twin.exact_binomial_ci_95[0] * 100).toFixed(1)}%–{(wRow.pr_vs_twin.exact_binomial_ci_95[1] * 100).toFixed(1)}%]
                            </small>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </EvidenceDisclosure>
            )}

            {/* 3. Subgroups Stratification */}
            {subgroups && (
              <EvidenceDisclosure labelledBy="subgroups-heading" label="Subgroups · Healthy, Prediabetes, Type 2">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
                  <div>
                    <span className="eyebrow">Diagnostic stratification</span>
                    <h2 id="subgroups-heading" style={{ fontSize: '16px', fontWeight: 600, margin: '4px 0 0' }}>
                      Subgroup robustness across clinical strata
                    </h2>
                  </div>
                  <span className="status-badge" style={{ borderColor: '#8c5b0c', color: '#8c5b0c', background: 'rgba(140, 91, 12, 0.08)' }}>
                    Exploratory · n=44 cohort
                  </span>
                </div>

                <p style={{ fontSize: '13px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 14px' }}>
                  Stratified evaluation across healthy (n=15), prediabetes (n=19), and Type 2 diabetes (n=10) simulated subjects. The 10-patient T2D subgroup represents the core target use case: PR-TFT shows its largest absolute gain over the twin alone (&Delta; = -5.52 mg/dL at 120 min). With 10 subjects and no interval on the subgroup difference, this is exploratory.
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px', marginBottom: '16px' }}>
                  {Object.entries(subgroups).map(([groupName, sg]: [string, any]) => {
                    const isT2D = groupName.toLowerCase().includes('type 2');
                    return (
                      <div
                        key={groupName}
                        style={{
                          border: isT2D ? '2px solid #8c5b0c' : '1px solid var(--color-line)',
                          borderRadius: '8px',
                          padding: '16px',
                          background: isT2D ? 'rgba(140, 91, 12, 0.04)' : 'var(--color-surface)',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                          <strong style={{ fontSize: '14px', color: isT2D ? '#8c5b0c' : 'var(--color-ink)' }}>
                            {groupName} {isT2D ? '(target clinical focus)' : ''}
                          </strong>
                          <span className="status-badge" style={{ fontSize: '12px' }}>
                            n={sg.n_patients} pts · {sg.n_anchors_eligible?.toLocaleString()} eligible
                          </span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', fontSize: '13px' }}>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)', display: 'block', fontSize: '12px' }}>30m RMSE</span>
                            <strong style={{ fontSize: '15px' }}>{sg.rmse_30?.toFixed(2)}</strong>
                            <div style={{ fontSize: '12px', color: 'var(--color-ink-3)' }}>{sg.n_evaluable_30?.toLocaleString()} rows</div>
                          </div>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)', display: 'block', fontSize: '12px' }}>60m RMSE</span>
                            <strong style={{ fontSize: '15px' }}>{sg.rmse_60?.toFixed(2)}</strong>
                            <div style={{ fontSize: '12px', color: 'var(--color-ink-3)' }}>{sg.n_evaluable_60?.toLocaleString()} rows</div>
                          </div>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)', display: 'block', fontSize: '12px' }}>120m RMSE</span>
                            <strong style={{ fontSize: '15px', color: isT2D ? '#8c5b0c' : 'inherit' }}>{sg.rmse_120?.toFixed(2)}</strong>
                            <div style={{ fontSize: '12px', color: 'var(--color-ink-3)' }}>{sg.n_evaluable_120?.toLocaleString()} rows</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {landing?.subgroups && <SubgroupGains rows={landing.subgroups} />}
              </EvidenceDisclosure>
            )}

            {/* 4. Patient Dispersion Compact Numeric Summary */}
            {dist && (
              <EvidenceDisclosure labelledBy="patient-dist-heading" label="Per-patient error dispersion">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
                  <div>
                    <span className="eyebrow">Cohort dispersion</span>
                    <h2 id="patient-dist-heading" style={{ fontSize: '16px', fontWeight: 600, margin: '4px 0 0' }}>
                      Patient-level error distribution
                    </h2>
                  </div>
                  <span className="status-badge" style={{ color: 'var(--color-ink-3)', borderColor: 'var(--color-line)' }}>
                    Compact summary (n=44)
                  </span>
                </div>
                <p style={{ fontSize: '13px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 14px' }}>
                  Per-patient RMSE quantiles across the 44 simulated validation subjects, summarizing patient-to-patient error dispersion (median 18.86 mg/dL, IQR 3.42 mg/dL at 60m). <em>Clinical disclosure:</em> These cohort-level summary distributions describe median performance and spread, but do not rule out individual acute forecast errors or outlier trajectory deviations in specific subjects.
                </p>
                {dist && <><div className="ec-wide"><DispersionBoxes dist={dist} /></div><div className="ec-narrow"><DispersionBoxes dist={dist} compact /></div></>}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' }}>
                  {dist['rmse_60'] && (
                    <div style={{ border: '1px solid var(--color-line)', borderRadius: '6px', padding: '14px', background: 'var(--color-surface)' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-ink)', marginBottom: '8px' }}>60-min horizon dispersion</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', fontSize: '12px' }}>
                        <div><span style={{ color: 'var(--color-ink-3)' }}>Min:</span> {dist['rmse_60'].min?.toFixed(2)}</div>
                        <div><span style={{ color: 'var(--color-ink-3)' }}>Median:</span> <strong>{dist['rmse_60'].median?.toFixed(2)}</strong></div>
                        <div><span style={{ color: 'var(--color-ink-3)' }}>Max:</span> {dist['rmse_60'].max?.toFixed(2)}</div>
                        <div><span style={{ color: 'var(--color-ink-3)' }}>25th %:</span> {dist['rmse_60'].p25?.toFixed(2)}</div>
                        <div><span style={{ color: 'var(--color-ink-3)' }}>75th %:</span> {dist['rmse_60'].p75?.toFixed(2)}</div>
                        <div><span style={{ color: 'var(--color-ink-3)' }}>IQR:</span> {dist['rmse_60'].iqr?.toFixed(2)}</div>
                      </div>
                    </div>
                  )}
                  {dist['rmse_120'] && (
                    <div style={{ border: '1px solid var(--color-line)', borderRadius: '6px', padding: '14px', background: 'var(--color-surface)' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-ink)', marginBottom: '8px' }}>120-min horizon dispersion</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', fontSize: '12px' }}>
                        <div><span style={{ color: 'var(--color-ink-3)' }}>Min:</span> {dist['rmse_120'].min?.toFixed(2)}</div>
                        <div><span style={{ color: 'var(--color-ink-3)' }}>Median:</span> <strong>{dist['rmse_120'].median?.toFixed(2)}</strong></div>
                        <div><span style={{ color: 'var(--color-ink-3)' }}>Max:</span> {dist['rmse_120'].max?.toFixed(2)}</div>
                        <div><span style={{ color: 'var(--color-ink-3)' }}>25th %:</span> {dist['rmse_120'].p25?.toFixed(2)}</div>
                        <div><span style={{ color: 'var(--color-ink-3)' }}>75th %:</span> {dist['rmse_120'].p75?.toFixed(2)}</div>
                        <div><span style={{ color: 'var(--color-ink-3)' }}>IQR:</span> {dist['rmse_120'].iqr?.toFixed(2)}</div>
                      </div>
                    </div>
                  )}
                </div>
              </EvidenceDisclosure>
            )}

            {/* 5. Calibration Limitations & Resubstitution Diagnostics (Explicitly Reconciled) */}
            {cal && (
              <EvidenceDisclosure labelledBy="cal-limits-heading" label="Calibration and interval coverage (resubstitution diagnostics)">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
                  <div>
                    <span className="eyebrow">Secondary diagnostics</span>
                    <h2 id="cal-limits-heading" style={{ margin: '4px 0 0', fontSize: '16px', fontWeight: 600 }}>
                      Calibration diagnostics and saturation disclosures (RESUBSTITUTION)
                    </h2>
                  </div>
                  <span className="status-badge" style={{ borderColor: '#8c5b0c', color: '#8c5b0c' }}>
                    Resubstitution diagnostics · not clinical recommendations
                  </span>
                </div>

                {/* Conformal Coverage Reconciliation Card */}
                <div style={{ border: '1px solid var(--color-line)', borderRadius: '8px', padding: '16px', background: 'var(--color-surface)', marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-ink-3)' }}>
                      80% Conformal Interval Coverage Reconciliation
                    </span>
                    <span className="register-chip neutral">
                      Reconciled metric provenance
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '14px', marginTop: '10px' }}>
                    <div style={{ padding: '12px', border: '1px solid var(--color-line)', borderRadius: '6px', background: 'var(--color-surface-2)' }}>
                      <div style={{ fontSize: '12px', color: 'var(--color-ink-3)', fontWeight: 600 }}>Raw model coverage (uncalibrated):</div>
                      <div style={{ fontSize: '20px', fontWeight: 700, margin: '4px 0', color: 'var(--color-ink)' }}>
                        78.16% <span style={{ fontSize: '13px', fontWeight: 400, color: 'var(--color-ink-3)', fontFamily: 'var(--font-mono)' }}>(0.781553)</span>
                      </div>
                      <p style={{ margin: 0, fontSize: '12px', color: 'var(--color-ink-3)', lineHeight: 1.45 }}>
                        Mean uncalibrated p10–p90 width: <strong>36.02 mg/dL</strong> across 53,849–53,920 evaluable rows. Measures raw PR-TFT quantile heads before post-processing.
                      </p>
                    </div>
                    <div style={{ padding: '12px', borderLeft: '3px solid var(--color-line-control)' }}>
                      <div style={{ fontSize: '13px', color: 'var(--color-ink-2)', fontWeight: 600 }}>Conformal-adjusted coverage (resubstitution):</div>
                      <div style={{ fontSize: '20px', fontWeight: 600, margin: '4px 0' }}>
                        80.00% <span style={{ fontSize: '13px', fontWeight: 400, color: 'var(--color-ink-3)', fontFamily: 'var(--font-mono)' }}>(0.800020)</span>
                      </div>
                      <p style={{ margin: 0, fontSize: '12px', color: 'var(--color-ink-3)', lineHeight: 1.45 }}>
                        Mean adjusted width: <strong>37.30 mg/dL</strong> (+1.28 mg/dL conformal widening; 36.02 → 37.30 mg/dL in the recorded run). Evaluated on the 44-subject validation split where the calibrator was fitted (resubstitution diagnostic).
                      </p>
                    </div>
                  </div>
                  <p style={{ margin: '10px 0 0', fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.5 }}>
                    <strong>Reconciliation Note:</strong> Both numbers represent genuine pipeline metrics from <code>run_manifest.json</code>. The 0.781553 value is the unadjusted raw model coverage; the 0.800020 value is the post-hoc conformal-calibrated coverage (Stage-3 validation resubstitution). Neither guarantees 80% coverage on new human patients.
                  </p>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '16px' }}>
                  <div style={{ padding: '12px', border: '1px solid var(--color-line)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--color-ink-3)', textTransform: 'uppercase' }}>Brier Score (Raw &rarr; Calibrated)</div>
                    <div style={{ fontSize: '18px', fontWeight: 600, margin: '4px 0' }}>
                      {cal.brier_score_calibrated?.toFixed(4)}
                      <small style={{ fontSize: '12px', color: 'var(--color-ink-3)', fontWeight: 400 }}> (Raw: {cal.brier_score_raw?.toFixed(4)})</small>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--color-ink-2)' }}>Resubstitution evaluation on {cal.at_risk_anchors?.toLocaleString()} at-risk anchors.</div>
                  </div>

                  {hazard && (
                    <div style={{ padding: '12px', border: '1px solid var(--color-line)', borderRadius: '6px' }} data-testid="spike-discrimination">
                      <div style={{ fontSize: '12px', color: 'var(--color-ink-3)', textTransform: 'uppercase' }}>Spike classifier AUROC · AUPRC</div>
                      <div style={{ fontSize: '18px', fontWeight: 600, margin: '4px 0' }}>
                        {hazard.auroc.toFixed(4)} · {hazard.auprc.toFixed(4)}
                        {hazardRaw && <small style={{ fontSize: '12px', color: 'var(--color-ink-3)', fontWeight: 400 }}> (Raw: {hazardRaw.auroc.toFixed(4)} · {hazardRaw.auprc.toFixed(4)})</small>}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--color-ink-2)' }}>Calibrated onset probability on the validation partition (<code>run_manifest.json</code> → <code>validation.hazard_calibrated</code>); resubstitution, not an independent test.</div>
                    </div>
                  )}
                  {cal.threshold_evaluations?.['0.35'] && (
                    <div style={{ padding: '12px', border: '1px solid var(--color-line)', borderRadius: '6px' }}>
                      <div style={{ fontSize: '12.5px', color: 'var(--color-ink-3)' }}>Evaluated threshold 0.35 (resubstitution)</div>
                      <div style={{ fontSize: '18px', fontWeight: 600, margin: '4px 0', color: 'var(--color-ink-2)' }}>
                        Sens {(cal.threshold_evaluations['0.35'].sensitivity * 100).toFixed(1)}% · Prec {(cal.threshold_evaluations['0.35'].precision * 100).toFixed(1)}%
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--color-ink-2)' }}>Anchor-level alert fraction: {cal.threshold_evaluations['0.35'].alert_rate_pct?.toFixed(1)}% of decision anchors (diagnostic only; does not represent event-level alerts per day).</div>
                    </div>
                  )}

                  {cal.threshold_evaluations?.['0.60'] && (
                    <div style={{ padding: '12px', border: '1px solid var(--color-line)', borderRadius: '2px' }}>
                      <div style={{ fontSize: '12.5px', color: 'var(--color-ink-3)' }}>High Threshold Diagnostic (0.60)</div>
                      <div style={{ fontSize: '18px', fontWeight: 600, margin: '4px 0', color: 'var(--color-ink-2)' }}>
                        Sens {(cal.threshold_evaluations['0.60'].sensitivity * 100).toFixed(1)}% · Prec {(cal.threshold_evaluations['0.60'].precision * 100).toFixed(1)}%
                      </div>
                      <div style={{ fontSize: '12px', color: '#8c5b0c' }}>High threshold empirical diagnostic (29.9% sensitivity, 74.5% precision, 5.3% anchor-level alert rate). Evaluated on the 44-patient validation partition; does not prove an underlying plateau or collapse mechanism.</div>
                    </div>
                  )}
                </div>

                {landing?.reliability && <ReliabilityFigure data={landing.reliability} />}

                <p className="fine-print" style={{ fontSize: '13px', color: 'var(--color-ink-2)', lineHeight: 1.6, margin: 0 }}>
                  Conformal coverage{metrics.coverage_80_conformal?.estimate != null && <> ({(metrics.coverage_80_conformal.estimate * 100).toFixed(2)}%{metrics.width_80_conformal_mg_dl?.estimate != null && <>, width {metrics.width_80_conformal_mg_dl.estimate.toFixed(2)} mg/dL</>})</>}, Expected Calibration Error{hazard?.ece != null && <> (ECE {hazard.ece.toFixed(6)})</>}, discrimination and Brier scores are resubstitution diagnostics evaluated on the identical validation split used during calibration fitting.
                </p>
              </EvidenceDisclosure>
            )}

            {/* 6. Scientific governance & Boundary Disclosures Register */}
            <section className="panel evidence-section register" id="status-register" tabIndex={-1} aria-labelledby="governance-heading">
              <div className="register-head">
                <div>
                  <span className="eyebrow">Scientific governance</span>
                  <h2 id="governance-heading">Validation status and provenance register</h2>
                </div>
              </div>

              <div className="register-grid">
                {/* Gate 3 Realism: compact status; the full analysis is in finding 4 above */}
                {gate3 && (
                  <div className="register-card failed">
                    <div className="register-card-head">
                      <span className="register-label">Gate 3 · realism</span>
                      <span className="register-chip failed">
                        <XCircle size={12} aria-hidden="true" /> {gate3.status}
                      </span>
                    </div>
                    <h3 className="register-title">Synthetic-data realism check</h3>
                    <p className="register-text">Our synthetic glucose traces remain distinguishable from the comparison generator&apos;s, so realism is not established.</p>
                    <a className="register-link" href="#gate3-analysis">View Gate 3 analysis</a>
                    <p className="fine-print register-foot">No realism claim is made.</p>
                  </div>
                )}

                {/* Sealed Test Cohort */}
                <div className="register-card">
                  <div className="register-card-head">
                    <span className="register-label">Sealed test split</span>
                    <span className="register-chip neutral">
                      Sealed · not run
                    </span>
                  </div>
                  <h3 className="register-title">Held-out test cohort</h3>
                  <p className="register-text">
                    Sealed evaluation on the held-out test split (a separate set of 44 patients, not the 44 validation patients) has not been run.
                  </p>
                  <div className="register-facts">
                    <div><strong>Why it is not run:</strong> the model was trained from code that had not been committed, and two training source files have changed since, so a test result could not be tied to exactly reproducible code.</div>
                    <details className="context-details register-more"><summary>Details</summary>
                      <div className="register-facts register-details">
                        <div><strong>What this does not affect:</strong> the check that the evaluation report, checkpoint and data match the recorded run.</div>
                        <div><strong>Status:</strong> not executed, so the test result cannot be attributed to an exactly reproducible training source.</div>
                        <div><strong>Earlier record:</strong> an earlier demo run&apos;s 18-subject &lsquo;test&rsquo; record is kept separately and excluded from claims.</div>
                        <div><strong>Technical detail:</strong> The run manifest (<code>run_manifest.json</code> → <code>preflight.git.dirty</code>) records uncommitted changes in 11 files; <code>backend/train_pr_tft.py</code> and <code>backend/ukf_twin.py</code> now differ from the source hashes recorded at training.</div>
                      </div>
                    </details>
                  </div>
                  <p className="fine-print register-foot">
                    No performance claim is made for unexecuted test evaluation.
                  </p>
                </div>

                {/* External Dataset */}
                <div className="register-card">
                  <div className="register-card-head">
                    <span className="register-label">External dataset</span>
                    <span className="register-chip nogo">
                      <AlertCircle size={12} aria-hidden="true" /> NO-GO
                    </span>
                  </div>
                  <h3 className="register-title">ShanghaiT2DM diagnostic</h3>
                  <p className="register-text">
                    Assessed diagnostically for input-contract feasibility with the locked model.
                  </p>
                  <div className="register-facts">
                    <div><strong>Sampling interval:</strong> 15 min (Contract: 5 min)</div>
                    <div><strong>Missing channels:</strong> Wearable &amp; meal logs absent</div>
                    <div><strong>Conclusion:</strong> Incompatible; external validation NO-GO</div>
                  </div>
                  <p className="fine-print register-foot">
                    External forecasting evaluation remains unexecuted.
                  </p>
                </div>

                {/* EW-01 protocol */}
                <div className="register-card">
                  <div className="register-card-head">
                    <span className="register-label">Early warning</span>
                    <span className="register-chip neutral">
                      UNEXECUTED
                    </span>
                  </div>
                  <h3 className="register-title">EW-01 protocol</h3>
                  <p className="register-text">
                    The pre-registered study of early-warning spike alerts has not been run.
                  </p>
                  <div className="register-facts">
                    <div><strong>Protocol:</strong> awaiting sign-off before it can run</div>
                    <div><strong>Prospective trial:</strong> Not conducted</div>
                    <div><strong>Status:</strong> Excluded from release claims</div>
                  </div>
                  <p className="fine-print register-foot">
                    Passing interface tests do not constitute clinical alert validation.
                  </p>
                </div>
              </div>
            </section>
          </>
        )}

        {/* Methodology appendix: everything a reviewer may audit, out of the reading path. */}
        <details className="panel evidence-section evidence-disclosure methodology-appendix" data-testid="methodology-appendix">
          <summary><span>Methodology appendix<small className="appendix-scope">Historical reference · artifact hashes · data source</small></span><span className="evidence-disclosure-hint" aria-hidden="true">Details</span></summary>
        <section className="evidence-disclosure-body" aria-labelledby="historical-record-heading">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span className="eyebrow" style={{ color: 'var(--color-ink-3)' }}>Separate fixed evidence record</span>
            <span className="status-badge" style={{ color: 'var(--color-ink-3)', borderColor: 'var(--color-line)' }}>
              Historical Baseline Reference
            </span>
          </div>
          <h2 id="historical-record-heading" style={{ fontSize: '15px', fontWeight: 600, margin: '0 0 8px' }}>
            Historical development reference (18-subject partition)
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: 0 }}>
            Earlier development reference recorded in <code>backend/runs/pr_tft_demo/evaluation_baseline.json</code> evaluated 18 subjects under demo checkpoint <code>stage2_observed-epoch=01-val_loss=0.3096.ckpt</code> (Persistence RMSE120: 50.66, Twin-only RMSE120: 40.20). This historical record is preserved separately for reference only; direct numerical superiority claims over it are cohort-unverified.
          </p>
        </section>

        {/* Advanced Reproducibility & Cryptographic Provenance Disclosure */}
        {!errorState && manifest && report && (
          <details className="reproducibility-details" style={{ marginBottom: '16px' }}>
            <summary className="reproducibility-summary">
              <div className="reproducibility-summary-title">
                <span className="eyebrow" style={{ color: 'var(--color-accent)' }}>Technical methodology and reproducibility</span>
                <h3>Artifact hashes and verification</h3>
                <p className="repro-hint">SHA-256 byte manifests, training checkpoint provenance, data integrity digests and pipeline parameters.</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="register-chip neutral">
                  Hashes match manifest
                </span>
                <ChevronDown size={16} aria-hidden="true" style={{ color: 'var(--color-ink-3)' }} />
              </div>
            </summary>
            <div className="reproducibility-content">
              <div style={{ padding: '16px 0 12px', fontSize: '13px', color: 'var(--color-ink-2)', lineHeight: 1.6 }}>
                <p style={{ margin: '0 0 12px' }}>
                  The recorded artifact hashes below match the on-disk files and checkpoint identities. This confirms which files were evaluated; it is not evidence of model quality.
                  {manifest.run_kind && manifest.run_kind !== 'full' ? ' Notice: Pipeline-check run, not validation evidence.' : ''}
                </p>
                <dl className="provenance-fields" style={{ margin: 0 }}>
                  <div>
                    <dt>Model run ID</dt>
                    <dd>{runId}</dd>
                    <dd className="hash-value">{report.provenance.run_manifest_sha256}</dd>
                  </div>
                  <div>
                    <dt>Training checkpoint</dt>
                    <dd>{manifest.checkpoint.path ?? manifest.checkpoint.name}</dd>
                    <dd className="hash-value">{report.provenance.checkpoint_sha256}</dd>
                  </div>
                  {Object.entries(dataHashes).map(([name, hash]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd className="hash-value">{hash}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div style={{ marginTop: '12px', padding: '12px', background: 'var(--color-surface-2)', borderRadius: '6px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                <div><strong>Audit File Lineage:</strong></div>
                <div style={{ color: 'var(--color-ink-3)', marginTop: '4px' }}>
                  Manifest: <code>runs/pr_tft_ablation_arm_d/run_manifest.json</code><br />
                  Evaluation: <code>runs/pr_tft_ablation_arm_d/evaluation_report.json</code><br />
                  Validation Partition: <code>split_293.json</code> (44 subjects)
                </div>
              </div>
            </div>
          </details>
        )}

        {/* Source & Footer */}
        <div className="evidence-source">
          <FolderOpen size={19} aria-hidden="true" />
          <div>
            <strong>Source · Empirical validation evaluated on Arm D validation split</strong>
            <p>
              Metrics derived from <code>runs/pr_tft_ablation_arm_d</code> using checkpoint <code>stage2_observed-epoch=03-val_loss=0.2255.ckpt</code> across 44 validation subjects and 54,281 eligible anchors (53,849–53,920 evaluable rows). This dashboard reflects internal development validation and negative realism governance disclosures. It does not certify clinical safety or human prospective efficacy.
            </p>
          </div>
        </div>
        </details>

        <footer className="research-footer"><span>Research Only (Not for clinical decisions)</span><span>Synthetic data · no clinical validation claimed</span></footer>
      </main>
    </div>
  );
}

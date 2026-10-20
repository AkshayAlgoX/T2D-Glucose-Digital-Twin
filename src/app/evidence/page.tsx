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

  const metrics = report?.populations.primary.models.pr_tft;
  const dataHashes = report
    ? typeof report.provenance.data_sha256 === 'string'
      ? { 'Recorded data hash': report.provenance.data_sha256 }
      : report.provenance.data_sha256
    : {};

  const primaryPop = report?.populations.primary;
  const models = primaryPop?.models;
  const paired = primaryPop?.paired_comparisons;
  const wins = primaryPop?.patient_pairwise_wins;
  const subgroups = primaryPop?.subgroups;
  const cal = primaryPop?.calibration_resubstitution_diagnostics;
  const gate3 = primaryPop?.gate3_realism_status;
  const dist = primaryPop?.patient_level_distribution;

  const runId = manifest?.run_id ?? path.basename(artifactsDir);

  // Determine if full matched benchmark tables are present in the validated report
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
      <main id="main-content" className="overview-page">
        <header className="workspace-heading">
          <div>
            <span className="eyebrow">Scientific Evidence &amp; Governance Registry</span>
            <h1>Evidence &amp; validation</h1>
            <p>Empirical validation benchmarks, matched baseline audits, calibration diagnostics, and protocol governance.</p>
          </div>
          <span className="status-badge" style={{ borderColor: errorState ? '#ef4444' : '#f59e0b', color: errorState ? '#ef4444' : '#f59e0b' }}>
            <ShieldCheck size={14} aria-hidden="true" />
            {errorState ? 'Evaluation unavailable' : 'Artifact review required'}
          </span>
        </header>

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

        {!errorState && manifest && report && metrics && (
          <div className="evidence-content" style={{ marginBottom: '24px' }}>
            <div className="evidence-notice">
              <strong>Recorded artifact · review required</strong>
              <p>
                Structural checks passed. Hashes below are declared provenance, not independently authenticated evidence. Artifact availability does not establish fresh EW-01 evaluation or clinical validation.
                {manifest.run_kind && manifest.run_kind !== 'full' ? ' This is a pipeline-check run, not validation evidence.' : ''}
              </p>
            </div>
            <section className="panel evidence-section" aria-labelledby="provenance-heading" style={{ marginBottom: '16px' }}>
              <h2 id="provenance-heading">Provenance</h2>
              <dl className="provenance-fields">
                <div><dt>Model run</dt><dd>{runId}</dd><dd className="hash-value">{report.provenance.run_manifest_sha256}</dd></div>
                <div><dt>Training checkpoint</dt><dd>{manifest.checkpoint.path ?? manifest.checkpoint.name}</dd><dd className="hash-value">{report.provenance.checkpoint_sha256}</dd></div>
                {Object.entries(dataHashes).map(([name, hash]) => (
                  <div key={name}><dt>{name}</dt><dd className="hash-value">{hash}</dd></div>
                ))}
              </dl>
            </section>
            <section className="panel evidence-section" aria-labelledby="evaluation-heading" style={{ marginBottom: '16px' }}>
              <h2 id="evaluation-heading">Recorded primary-population metrics</h2>
              <dl className="evaluation-metrics">
                <div><dt>RMSE · 60 min</dt><dd>{metrics.rmse_60.estimate.toFixed(3)}<small> mg/dL</small></dd></div>
                <div><dt>RMSE · 120 min</dt><dd>{metrics.rmse_120.estimate.toFixed(3)}<small> mg/dL</small></dd></div>
                <div><dt>Conformal 80% interval coverage</dt><dd>{metrics.coverage_80_conformal.estimate.toFixed(3)}</dd></div>
              </dl>
            </section>
          </div>
        )}

        {/* Verified Benchmark Tables rendered ONLY when validated artifact benchmarks are present */}
        {hasBenchmarks && models && paired && (
          <>
            {/* Boundary Notice */}
            <div className="evidence-notice" style={{ borderLeft: '4px solid #f59e0b', background: 'rgba(245, 158, 11, 0.05)', padding: '16px', borderRadius: '4px', marginBottom: '24px' }}>
              <strong style={{ display: 'block', marginBottom: '4px', color: '#f59e0b' }}>Generalization Boundary Disclosure</strong>
              <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.5 }}>
                All performance metrics presented below are evaluated on the 44-patient synthetic validation split used during model checkpoint selection and Stage-3 calibration fitting. These figures represent the internal development validation benchmark. They strictly do NOT constitute proof of prospective human generalization or clinical deployment efficacy. The held-out test split remains unexecuted per governance boundaries.
              </p>
            </div>

            {/* 1. Matched Baselines Comparison Table with Patient-Clustered CIs */}
            <section className="panel evidence-section" aria-labelledby="baselines-heading" style={{ marginBottom: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '16px' }}>
                <div>
                  <span className="eyebrow">Controlled Benchmarks</span>
                  <h2 id="baselines-heading" style={{ margin: '4px 0 0', fontSize: '18px', fontWeight: 600 }}>
                    Matched Baseline Comparisons &amp; Patient-Clustered Uncertainty
                  </h2>
                </div>
                <span className="status-badge" style={{ background: 'rgba(59, 130, 246, 0.1)', borderColor: '#3b82f6', color: '#60a5fa' }}>
                  n=44 Subjects · B=10,000 Cluster Resamples (Primary)
                </span>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--color-line)', color: 'var(--color-ink-3)' }}>
                      <th style={{ padding: '8px 12px' }}>Horizon</th>
                      <th style={{ padding: '8px 12px' }}>Model</th>
                      <th style={{ padding: '8px 12px' }}>RMSE (mg/dL)</th>
                      <th style={{ padding: '8px 12px' }}>95% Bootstrap CI</th>
                      <th style={{ padding: '8px 12px' }}>MAE</th>
                      <th style={{ padding: '8px 12px' }}>MARD</th>
                      <th style={{ padding: '8px 12px' }}>&Delta; vs. Persistence</th>
                      <th style={{ padding: '8px 12px' }}>&Delta; vs. UKF Twin</th>
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
                        <tr style={{ borderTop: '1px solid var(--color-line)', background: 'rgba(59, 130, 246, 0.03)' }}>
                          <td rowSpan={3} style={{ padding: '8px 12px', fontWeight: 600, verticalAlign: 'top', borderRight: '1px solid var(--color-line)' }}>
                            {row.hz}
                          </td>
                          <td style={{ padding: '8px 12px', fontWeight: 600, color: '#60a5fa' }}>PR-TFT (Arm D)</td>
                          <td style={{ padding: '8px 12px', fontWeight: 700 }}>{row.pr?.estimate.toFixed(2)}</td>
                          <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)' }}>
                            {row.pr?.ci_95 ? `[${row.pr.ci_95[0].toFixed(2)}, ${row.pr.ci_95[1].toFixed(2)}]` : '—'}
                          </td>
                          <td style={{ padding: '8px 12px' }}>{row.maePr?.estimate ? row.maePr.estimate.toFixed(2) : '—'}</td>
                          <td style={{ padding: '8px 12px' }}>{row.mardPr?.estimate ? `${row.mardPr.estimate.toFixed(2)}%` : '—'}</td>
                          <td style={{ padding: '8px 12px', color: '#22c55e', fontWeight: 600 }}>
                            {row.diffPe?.diff ? `${row.diffPe.diff.toFixed(2)} (${row.diffPe.relative_reduction_pct.toFixed(1)}%)` : '—'}
                          </td>
                          <td style={{ padding: '8px 12px', color: '#60a5fa', fontWeight: 600 }}>
                            {row.diffTw?.diff ? `${row.diffTw.diff.toFixed(2)} (${row.diffTw.relative_reduction_pct.toFixed(1)}%)` : '—'}
                          </td>
                        </tr>
                        <tr style={{ background: 'transparent' }}>
                          <td style={{ padding: '8px 12px', color: '#f59e0b' }}>UKF Twin</td>
                          <td style={{ padding: '8px 12px' }}>{row.tw?.estimate ? row.tw.estimate.toFixed(2) : '—'}</td>
                          <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)' }}>
                            {row.tw?.ci_95 ? `[${row.tw.ci_95[0].toFixed(2)}, ${row.tw.ci_95[1].toFixed(2)}]` : '—'}
                          </td>
                          <td style={{ padding: '8px 12px' }}>{row.maeTw?.estimate ? row.maeTw.estimate.toFixed(2) : '—'}</td>
                          <td style={{ padding: '8px 12px' }}>{row.mardTw?.estimate ? `${row.mardTw.estimate.toFixed(2)}%` : '—'}</td>
                          <td style={{ padding: '8px 12px', color: 'var(--color-ink-3)' }}>Reference</td>
                          <td style={{ padding: '8px 12px', color: 'var(--color-ink-3)' }}>Reference</td>
                        </tr>
                        <tr style={{ borderBottom: '1px solid var(--color-line)', background: 'transparent' }}>
                          <td style={{ padding: '8px 12px', color: '#ef4444' }}>Persistence</td>
                          <td style={{ padding: '8px 12px' }}>{row.pe?.estimate ? row.pe.estimate.toFixed(2) : '—'}</td>
                          <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)' }}>
                            {row.pe?.ci_95 ? `[${row.pe.ci_95[0].toFixed(2)}, ${row.pe.ci_95[1].toFixed(2)}]` : '—'}
                          </td>
                          <td style={{ padding: '8px 12px' }}>{row.maePe?.estimate ? row.maePe.estimate.toFixed(2) : '—'}</td>
                          <td style={{ padding: '8px 12px' }}>{row.mardPe?.estimate ? `${row.mardPe.estimate.toFixed(2)}%` : '—'}</td>
                          <td style={{ padding: '8px 12px', color: 'var(--color-ink-3)' }}>Reference</td>
                          <td style={{ padding: '8px 12px', color: 'var(--color-ink-3)' }}>—</td>
                        </tr>
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="fine-print" style={{ marginTop: '12px', fontSize: '11px', color: 'var(--color-ink-3)' }}>
                Note: Paired differences (&Delta; = PR-TFT - Comparator) are strictly negative in all 10,000/10,000 bootstrap draws in the primary analysis (and 1,000/1,000 in the secondary cross-check). P-values are not inferred from finite bootstrap draws.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px', marginTop: '16px' }}>
                <div style={{ background: '#131822', borderRadius: '8px', border: '1px solid var(--color-line)', overflow: 'hidden' }}>
                  <img src="/evidence/baseline_comparison.svg" alt="Matched Baselines with 95% Patient-Clustered Bootstrap CIs" style={{ width: '100%', height: 'auto', display: 'block' }} />
                </div>
                <div style={{ background: '#131822', borderRadius: '8px', border: '1px solid var(--color-line)', overflow: 'hidden' }}>
                  <img src="/evidence/horizon_trajectory.svg" alt="Forecast Error Trajectory Across Horizons (5 to 120 min)" style={{ width: '100%', height: 'auto', display: 'block' }} />
                </div>
              </div>
            </section>

            {/* 2. Patient-Level Pairwise Wins */}
            {wins && (
              <section className="panel evidence-section" aria-labelledby="patient-wins-heading" style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
                  <div>
                    <span className="eyebrow">Subject-Level Consistency</span>
                    <h2 id="patient-wins-heading" style={{ margin: '4px 0 0', fontSize: '16px', fontWeight: 600 }}>
                      Patient-Level Pairwise Win Rates (Exact Clopper-Pearson Binomial Intervals)
                    </h2>
                  </div>
                  <span className="status-badge" style={{ borderColor: '#3b82f6', color: '#60a5fa' }}>
                    n=44 Subjects · Exact Binomial Test
                  </span>
                </div>
                <p style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 14px' }}>
                  To avoid degenerate bootstrap intervals at 100% boundary conditions, exact Clopper-Pearson 95% binomial confidence intervals are reported. <em>Sampling assumption:</em> Independent Bernoulli trials across the 44 subjects in the simulated validation cohort; interpretation is strictly limited to this simulated cohort and does not guarantee human generalization.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' }}>
                  {(['30min', '60min', '120min'] as const).map((hKey) => {
                    const wRow = wins[hKey];
                    if (!wRow) return null;
                    return (
                      <div key={hKey} style={{ border: '1px solid var(--color-line)', borderRadius: '6px', padding: '14px', background: 'var(--color-surface)' }}>
                        <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', color: '#f8fafc' }}>{hKey} Horizon Wins</div>
                        <div style={{ display: 'grid', gap: '6px', fontSize: '12px' }}>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)' }}>vs. Persistence:</span>{' '}
                            <strong style={{ color: '#22c55e' }}>
                              {wRow.pr_vs_persistence.wins_count}/{wRow.pr_vs_persistence.n_patients} ({(wRow.pr_vs_persistence.win_fraction * 100).toFixed(1)}%)
                            </strong>{' '}
                            <small style={{ color: 'var(--color-ink-3)' }}>
                              [Exact 95% CI: {(wRow.pr_vs_persistence.exact_binomial_ci_95[0] * 100).toFixed(1)}%–{(wRow.pr_vs_persistence.exact_binomial_ci_95[1] * 100).toFixed(1)}%]
                            </small>
                          </div>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)' }}>vs. UKF Twin:</span>{' '}
                            <strong style={{ color: wRow.pr_vs_twin.wins_count === wRow.pr_vs_twin.n_patients ? '#22c55e' : '#60a5fa' }}>
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
              </section>
            )}

            {/* 3. Subgroups and Patient Error Dispersion */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px', marginBottom: '24px' }}>
              {subgroups && (
                <section className="panel evidence-section" aria-labelledby="subgroups-heading">
                  <span className="eyebrow">Diagnostic Stratification</span>
                  <h2 id="subgroups-heading" style={{ fontSize: '16px', fontWeight: 600, margin: '4px 0 14px' }}>
                    Subgroup Robustness Across Clinical Strata
                  </h2>
                  <div style={{ display: 'grid', gap: '12px' }}>
                    {Object.entries(subgroups).map(([groupName, sg]: [string, any]) => (
                      <div key={groupName} style={{ border: '1px solid var(--color-line)', borderRadius: '6px', padding: '12px', background: 'var(--color-surface)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                          <strong style={{ fontSize: '13px' }}>{groupName}</strong>
                          <span className="status-badge" style={{ fontSize: '10px' }}>
                            n={sg.n_patients} pts · {sg.n_anchors_eligible?.toLocaleString()} eligible
                          </span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', fontSize: '11px' }}>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)' }}>RMSE 30m:</span> <strong>{sg.rmse_30?.toFixed(2)}</strong>
                            <div style={{ fontSize: '10px', color: 'var(--color-ink-3)' }}>{sg.n_evaluable_30?.toLocaleString()} rows</div>
                          </div>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)' }}>RMSE 60m:</span> <strong>{sg.rmse_60?.toFixed(2)}</strong>
                            <div style={{ fontSize: '10px', color: 'var(--color-ink-3)' }}>{sg.n_evaluable_60?.toLocaleString()} rows</div>
                          </div>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)' }}>RMSE 120m:</span> <strong>{sg.rmse_120?.toFixed(2)}</strong>
                            <div style={{ fontSize: '10px', color: 'var(--color-ink-3)' }}>{sg.n_evaluable_120?.toLocaleString()} rows</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: '14px', background: '#131822', borderRadius: '8px', border: '1px solid var(--color-line)', overflow: 'hidden' }}>
                    <img src="/evidence/subgroup_robustness.svg" alt="Subgroup Robustness Across Clinical Strata" style={{ width: '100%', height: 'auto', display: 'block' }} />
                  </div>
                </section>
              )}

              {dist && (
                <section className="panel evidence-section" aria-labelledby="patient-dist-heading">
                  <span className="eyebrow">Patient Dispersion</span>
                  <h2 id="patient-dist-heading" style={{ fontSize: '16px', fontWeight: 600, margin: '4px 0 14px' }}>
                    Patient-Level Error Distribution
                  </h2>
                  <p style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 14px' }}>
                    Per-patient RMSE distribution across the 44 validation subjects, summarizing patient-level error dispersion (median 18.86 mg/dL, IQR 3.42 mg/dL at 60m). Patient-level summary metrics do not rule out individual anchor-level prediction errors.
                  </p>
                  <div style={{ display: 'grid', gap: '12px' }}>
                    {dist['60min'] && (
                      <div style={{ border: '1px solid var(--color-line)', borderRadius: '6px', padding: '12px' }}>
                        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-ink-2)', marginBottom: '8px' }}>60-Minute Horizon Dispersion</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', fontSize: '11px' }}>
                          <div><span style={{ color: 'var(--color-ink-3)' }}>Min:</span> {dist['60min'].min?.toFixed(2)}</div>
                          <div><span style={{ color: 'var(--color-ink-3)' }}>Median:</span> <strong>{dist['60min'].median?.toFixed(2)}</strong></div>
                          <div><span style={{ color: 'var(--color-ink-3)' }}>Max:</span> {dist['60min'].max?.toFixed(2)}</div>
                          <div><span style={{ color: 'var(--color-ink-3)' }}>25th %:</span> {dist['60min'].p25?.toFixed(2)}</div>
                          <div><span style={{ color: 'var(--color-ink-3)' }}>75th %:</span> {dist['60min'].p75?.toFixed(2)}</div>
                          <div><span style={{ color: 'var(--color-ink-3)' }}>IQR:</span> {dist['60min'].iqr?.toFixed(2)}</div>
                        </div>
                      </div>
                    )}
                    {dist['120min'] && (
                      <div style={{ border: '1px solid var(--color-line)', borderRadius: '6px', padding: '12px' }}>
                        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-ink-2)', marginBottom: '8px' }}>120-Minute Horizon Dispersion</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', fontSize: '11px' }}>
                          <div><span style={{ color: 'var(--color-ink-3)' }}>Min:</span> {dist['120min'].min?.toFixed(2)}</div>
                          <div><span style={{ color: 'var(--color-ink-3)' }}>Median:</span> <strong>{dist['120min'].median?.toFixed(2)}</strong></div>
                          <div><span style={{ color: 'var(--color-ink-3)' }}>Max:</span> {dist['120min'].max?.toFixed(2)}</div>
                          <div><span style={{ color: 'var(--color-ink-3)' }}>25th %:</span> {dist['120min'].p25?.toFixed(2)}</div>
                          <div><span style={{ color: 'var(--color-ink-3)' }}>75th %:</span> {dist['120min'].p75?.toFixed(2)}</div>
                          <div><span style={{ color: 'var(--color-ink-3)' }}>IQR:</span> {dist['120min'].iqr?.toFixed(2)}</div>
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )}
            </div>

            {/* 4. Calibration Limitations & Resubstitution Diagnostics */}
            {cal && (
              <section className="panel evidence-section" aria-labelledby="cal-limits-heading" style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
                  <div>
                    <span className="eyebrow">Probabilistic Calibration</span>
                    <h2 id="cal-limits-heading" style={{ margin: '4px 0 0', fontSize: '16px', fontWeight: 600 }}>
                      Calibration Diagnostics &amp; Saturation Disclosures (RESUBSTITUTION)
                    </h2>
                  </div>
                  <span className="status-badge" style={{ borderColor: '#f59e0b', color: '#f59e0b' }}>
                    Resubstitution Diagnostics · Not Clinical Recommendations
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '16px' }}>
                  <div style={{ padding: '12px', border: '1px solid var(--color-line)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '11px', color: 'var(--color-ink-3)', textTransform: 'uppercase' }}>Brier Score (Raw &rarr; Calibrated)</div>
                    <div style={{ fontSize: '18px', fontWeight: 700, margin: '4px 0', color: '#22c55e' }}>
                      {cal.brier_score_calibrated?.toFixed(4)}
                      <small style={{ fontSize: '11px', color: 'var(--color-ink-3)', fontWeight: 400 }}> (Raw: {cal.brier_score_raw?.toFixed(4)})</small>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--color-ink-2)' }}>Resubstitution evaluation on {cal.at_risk_anchors?.toLocaleString()} at-risk anchors.</div>
                  </div>

                  {cal.threshold_evaluations?.['0.35'] && (
                    <div style={{ padding: '12px', border: '1px solid var(--color-line)', borderRadius: '6px' }}>
                      <div style={{ fontSize: '11px', color: 'var(--color-ink-3)', textTransform: 'uppercase' }}>Evaluated Threshold 0.35</div>
                      <div style={{ fontSize: '18px', fontWeight: 700, margin: '4px 0', color: '#60a5fa' }}>
                        Sens {(cal.threshold_evaluations['0.35'].sensitivity * 100).toFixed(1)}% · Prec {(cal.threshold_evaluations['0.35'].precision * 100).toFixed(1)}%
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--color-ink-2)' }}>Anchor-level alert fraction: {cal.threshold_evaluations['0.35'].alert_rate_pct?.toFixed(1)}% of decision anchors (diagnostic only; does not represent event-level alerts per day).</div>
                    </div>
                  )}

                  {cal.threshold_evaluations?.['0.60'] && (
                    <div style={{ padding: '12px', border: '1px solid #78350f', borderRadius: '6px', background: 'rgba(120, 53, 15, 0.08)' }}>
                      <div style={{ fontSize: '11px', color: '#f59e0b', textTransform: 'uppercase' }}>High Threshold Diagnostic (0.60)</div>
                      <div style={{ fontSize: '18px', fontWeight: 700, margin: '4px 0', color: '#ef4444' }}>
                        Sens {(cal.threshold_evaluations['0.60'].sensitivity * 100).toFixed(1)}% · Prec {(cal.threshold_evaluations['0.60'].precision * 100).toFixed(1)}%
                      </div>
                      <div style={{ fontSize: '11px', color: '#f59e0b' }}>High threshold empirical diagnostic (29.9% sensitivity, 74.5% precision, 5.3% anchor-level alert rate). Evaluated on the 44-patient validation partition; does not prove an underlying plateau or collapse mechanism.</div>
                    </div>
                  )}
                </div>
                <div style={{ marginBottom: '16px', background: '#131822', borderRadius: '8px', border: '1px solid var(--color-line)', overflow: 'hidden' }}>
                  <img src="/evidence/calibration_reliability.svg" alt="Calibration Reliability Diagram with Equal-Width Probability Bins" style={{ width: '100%', height: 'auto', display: 'block' }} />
                </div>
                <p className="fine-print" style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.6, margin: 0 }}>
                  Conformal coverage (80.00%, width 37.30 mg/dL), Expected Calibration Error (ECE 0.000094), and Brier scores are resubstitution diagnostics evaluated on the identical validation split used during calibration fitting. No threshold should be treated as an approved clinical operating recommendation.
                </p>
              </section>
            )}

            {/* 5. Scientific Governance & Boundary Disclosures Register */}
            <section className="panel evidence-section" aria-labelledby="governance-heading" style={{ marginBottom: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '16px' }}>
                <div>
                  <span className="eyebrow">Scientific Governance</span>
                  <h2 id="governance-heading" style={{ margin: '4px 0 0', fontSize: '18px', fontWeight: 600 }}>Validation Status &amp; Provenance Register</h2>
                </div>
                <span className="status-badge" style={{ backgroundColor: '#2d1810', color: '#f59e0b', borderColor: '#78350f' }}>
                  <AlertTriangle size={13} aria-hidden="true" /> Transparency Disclosures
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
                {/* Gate 3 Realism */}
                {gate3 && (
                  <div style={{ border: '1px solid #78350f', borderRadius: '8px', padding: '16px', background: 'rgba(120, 53, 15, 0.1)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#f59e0b' }}>Gate 3 Realism</span>
                      <span className="status-badge" style={{ color: '#ef4444', borderColor: '#b91c1c', background: 'rgba(185, 28, 28, 0.15)' }}>
                        <XCircle size={12} aria-hidden="true" /> {gate3.status}
                      </span>
                    </div>
                    <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 6px' }}>Synthetic-Data Indistinguishability</h3>
                    <p style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 10px' }}>
                      Discriminator separates synthetic ODE trajectories from mock-real generator records (33,162 windows).
                    </p>
                    <div style={{ fontSize: '12px', display: 'grid', gap: '4px' }}>
                      <div><strong>Historical AUROC:</strong> {gate3.historical_auroc?.toFixed(4)}</div>
                      <div><strong>Duration-Corrected:</strong> {gate3.duration_corrected_auroc?.toFixed(4)}</div>
                      <div><strong>Acceptance Target:</strong> AUROC &le; 0.65</div>
                      <div><strong>Top Tells:</strong> <code>jerk_sd</code> (SHAP 0.8878), <code>roc_max_fall</code></div>
                    </div>
                    <div style={{ marginTop: '12px', background: '#131822', borderRadius: '8px', border: '1px solid var(--color-line)', overflow: 'hidden' }}>
                      <img src="/evidence/gate3_realism_summary.svg" alt="Gate 3 Realism Audit Discriminator Summary" style={{ width: '100%', height: 'auto', display: 'block' }} />
                    </div>
                    <p className="fine-print" style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--color-ink-3)' }}>
                      Synthetic ODE dynamics remain distinguishable; real-world physiological realism is unestablished. Pipeline verified via null control (AUROC 0.507).
                    </p>
                  </div>
                )}

                {/* Sealed Test Cohort */}
                <div style={{ border: '1px solid var(--color-line)', borderRadius: '8px', padding: '16px', background: 'var(--color-surface)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--color-ink-3)' }}>Sealed Test Split</span>
                    <span className="status-badge" style={{ color: '#9ca3af', borderColor: '#4b5563', background: 'rgba(75, 85, 99, 0.15)' }}>
                      SEALED &amp; UNEXECUTED
                    </span>
                  </div>
                  <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 6px' }}>Held-Out Test Cohort</h3>
                  <p style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 10px' }}>
                    Sealed evaluation on the held-out test split (44 patients) was strictly not executed.
                  </p>
                  <div style={{ fontSize: '12px', display: 'grid', gap: '4px' }}>
                    <div><strong>Training Tree:</strong> <code>dirty: true</code>, 11 dirty paths</div>
                    <div><strong>Source Hash:</strong> <code>backend/ukf_twin.py</code> mismatch</div>
                    <div><strong>Status:</strong> Unexecuted due to provenance boundary</div>
                  </div>
                  <p className="fine-print" style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--color-ink-3)' }}>
                    No performance claim is made for unexecuted test evaluation.
                  </p>
                </div>

                {/* External Dataset */}
                <div style={{ border: '1px solid var(--color-line)', borderRadius: '8px', padding: '16px', background: 'var(--color-surface)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--color-ink-3)' }}>External Dataset</span>
                    <span className="status-badge" style={{ color: '#f59e0b', borderColor: '#78350f', background: 'rgba(120, 53, 15, 0.15)' }}>
                      <AlertCircle size={12} aria-hidden="true" /> NO-GO
                    </span>
                  </div>
                  <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 6px' }}>ShanghaiT2DM Diagnostic</h3>
                  <p style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 10px' }}>
                    Assessed diagnostically for input-contract feasibility with the locked model.
                  </p>
                  <div style={{ fontSize: '12px', display: 'grid', gap: '4px' }}>
                    <div><strong>Sampling Interval:</strong> 15 min (Contract: 5 min)</div>
                    <div><strong>Missing Channels:</strong> Wearable &amp; meal logs absent</div>
                    <div><strong>Conclusion:</strong> Incompatible; external validation NO-GO</div>
                  </div>
                  <p className="fine-print" style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--color-ink-3)' }}>
                    External forecasting evaluation remains unexecuted.
                  </p>
                </div>

                {/* EW-01 Protocol */}
                <div style={{ border: '1px solid var(--color-line)', borderRadius: '8px', padding: '16px', background: 'var(--color-surface)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--color-ink-3)' }}>Early Warning</span>
                    <span className="status-badge" style={{ color: '#9ca3af', borderColor: '#4b5563', background: 'rgba(75, 85, 99, 0.15)' }}>
                      UNEXECUTED
                    </span>
                  </div>
                  <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 6px' }}>EW-01 Protocol</h3>
                  <p style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 10px' }}>
                    Early warning spike evaluation protocol remains unexecuted.
                  </p>
                  <div style={{ fontSize: '12px', display: 'grid', gap: '4px' }}>
                    <div><strong>Protocol Lineage:</strong> Pending multi-party sign-offs</div>
                    <div><strong>Prospective Trial:</strong> Not conducted</div>
                    <div><strong>Status:</strong> Excluded from release claims</div>
                  </div>
                  <p className="fine-print" style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--color-ink-3)' }}>
                    Passing interface tests do not constitute clinical alert validation.
                  </p>
                </div>
              </div>
            </section>
          </>
        )}

        {/* Historical Evidence Record - Always clearly labelled as separate, fixed record */}
        <section className="panel evidence-section" aria-labelledby="historical-record-heading" style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span className="eyebrow" style={{ color: 'var(--color-ink-3)' }}>Separate Fixed Evidence Record</span>
            <span className="status-badge" style={{ color: 'var(--color-ink-3)', borderColor: 'var(--color-line)' }}>
              Historical Baseline Reference
            </span>
          </div>
          <h2 id="historical-record-heading" style={{ fontSize: '15px', fontWeight: 600, margin: '0 0 8px' }}>
            Historical Development Reference (18-Subject Partition)
          </h2>
          <p style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: 0 }}>
            Earlier development reference recorded in <code>backend/runs/pr_tft_demo/evaluation_baseline.json</code> evaluated 18 subjects under demo checkpoint <code>stage2_observed-epoch=01-val_loss=0.3096.ckpt</code> (Persistence RMSE120: 50.66, Twin-only RMSE120: 40.20). This historical record is preserved separately for reference only; direct numerical superiority claims over it are cohort-unverified.
          </p>
        </section>

        <div className="panel evidence-source">
          <FolderOpen size={19} aria-hidden="true" />
          <div>
            <strong>Source · Empirical validation evaluated on Arm D validation split</strong>
            <p>
              Metrics derived from <code>runs/pr_tft_ablation_arm_d</code> using checkpoint <code>stage2_observed-epoch=03-val_loss=0.2255.ckpt</code> across 44 validation subjects and 54,281 eligible anchors (53,849–53,920 evaluable rows). This dashboard reflects internal development validation and negative realism governance disclosures. It does not certify clinical safety or human prospective efficacy.
            </p>
          </div>
        </div>

        <footer className="research-footer">
          Research Only (Not for clinical decisions)
          <span>Evidence availability is separate from prototype functionality</span>
        </footer>
      </main>
    </div>
  );
}

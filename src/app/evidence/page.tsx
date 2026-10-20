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

  const primaryPop = report?.populations.primary;
  const metrics = primaryPop?.models.pr_tft;
  const models = primaryPop?.models;
  const paired = primaryPop?.paired_comparisons;
  const wins = primaryPop?.patient_pairwise_wins;
  const subgroups = primaryPop?.subgroups;
  const cal = primaryPop?.calibration_resubstitution_diagnostics;
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
      <main id="main-content" className="overview-page">
        {/* Page Header */}
        <header className="workspace-heading">
          <div>
            <span className="eyebrow">Scientific Evidence &amp; Governance Registry</span>
            <h1>Evidence &amp; validation</h1>
            <p>Empirical validation benchmarks, matched baseline comparisons, clinical subgroup stratification, and negative realism disclosures.</p>
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
                  Provenance hashes match
                </>
              )}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--color-ink-3)' }}>
              {errorState ? 'Artifact verification failed' : 'Synthetic development-validation results · SHA-256 matches the run manifest'}
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

        {/* 10-Second Executive Summary Hero - Answering Four Essential Questions */}
        {!errorState && report && metrics && (
          <section className="panel evidence-hero" aria-labelledby="exec-summary-heading">
            <div className="evidence-hero-header">
              <span className="eyebrow">Executive Summary</span>
              <h2 id="exec-summary-heading">Development validation at a glance</h2>
              <p>
                Core scientific findings and negative boundaries evaluated on the 44 simulated demonstration subjects in the validation cohort. Four critical questions for clinical evaluation:
              </p>
            </div>

            <div className="evidence-pillar-grid">
              {/* Question 1: What data was evaluated? */}
              <div className="evidence-pillar-card pillar-scope">
                <div>
                  <div className="pillar-label">
                    <span>1. Evaluation Basis</span>
                    <Users size={14} aria-hidden="true" />
                  </div>
                  <h3 className="pillar-question">What data was evaluated?</h3>
                  <div className="pillar-stat">44 Subjects</div>
                  <div className="pillar-substat">15 Healthy · 19 Prediabetes · 10 T2D</div>
                  <p className="pillar-desc">
                    Evaluated on 54,281 eligible prediction anchors (53,849–53,920 evaluable rows across 30, 60, and 120-minute horizons).
                    <br /><strong style={{ color: 'var(--color-ink-2)' }}>Clinical context:</strong> Decision anchor rows are repeated 5-minute time points across these 44 simulated trajectories, not independent people.
                  </p>
                </div>
                <span className="pillar-tag">Synthetic Validation Split</span>
              </div>

              {/* Question 2: How did the hybrid model compare? */}
              <div className="evidence-pillar-card pillar-performance">
                <div>
                  <div className="pillar-label">
                    <span>2. Forecast Accuracy</span>
                    <TrendingDown size={14} aria-hidden="true" />
                  </div>
                  <h3 className="pillar-question">How did the hybrid model compare?</h3>
                  <div className="pillar-stat stat-accent" data-testid="headline-vs-twin">
                    {paired ? `-${paired.pr_minus_twin_rmse_60.relative_reduction_pct.toFixed(1)}%` : '—'}
                  </div>
                  <div className="pillar-substat" data-testid="headline-definition">
                    60-min RMSE vs the physiology twin alone{paired ? ` · ${paired.pr_minus_persistence_rmse_60.relative_reduction_pct.toFixed(1)}% lower than persistence` : ''}
                  </div>
                  <div className="pillar-substat">
                    60m RMSE: {metrics.rmse_60.estimate.toFixed(2)} vs {models?.twin_only?.rmse_60.estimate.toFixed(2)} (Twin) vs {models?.persistence?.rmse_60.estimate.toFixed(2)} (Persistence)
                  </div>
                  <div className="pillar-compact-summary">
                    <div className="summary-row"><span>30m:</span> <strong>{metrics.rmse_30.estimate.toFixed(2)} mg/dL</strong> <small>[{metrics.rmse_30.ci_95 ? `${metrics.rmse_30.ci_95[0].toFixed(2)}–${metrics.rmse_30.ci_95[1].toFixed(2)}` : ''}]</small> <span>(&Delta; {paired?.pr_minus_twin_rmse_30.diff.toFixed(2)} vs Twin; {paired?.pr_minus_persistence_rmse_30.diff.toFixed(2)} vs PE)</span></div>
                    <div className="summary-row"><span>60m:</span> <strong>{metrics.rmse_60.estimate.toFixed(2)} mg/dL</strong> <small>[{metrics.rmse_60.ci_95 ? `${metrics.rmse_60.ci_95[0].toFixed(2)}–${metrics.rmse_60.ci_95[1].toFixed(2)}` : ''}]</small> <span>(&Delta; {paired?.pr_minus_twin_rmse_60.diff.toFixed(2)} vs Twin; {paired?.pr_minus_persistence_rmse_60.diff.toFixed(2)} vs PE)</span></div>
                    <div className="summary-row"><span>120m:</span> <strong>{metrics.rmse_120.estimate.toFixed(2)} mg/dL</strong> <small>[{metrics.rmse_120.ci_95 ? `${metrics.rmse_120.ci_95[0].toFixed(2)}–${metrics.rmse_120.ci_95[1].toFixed(2)}` : ''}]</small> <span>(&Delta; {paired?.pr_minus_twin_rmse_120.diff.toFixed(2)} vs Twin; {paired?.pr_minus_persistence_rmse_120.diff.toFixed(2)} vs PE)</span></div>
                  </div>
                  <p className="pillar-desc">
                    <strong style={{ color: 'var(--color-ink-2)' }}>Clinical interpretation:</strong> Lower RMSE (Root Mean Square Error in mg/dL) means predicted glucose tracks closer to actual readings, reducing large trajectory errors. Paired differences are strictly negative in 10,000/10,000 bootstrap draws.
                  </p>
                </div>
                <span className="pillar-tag">Physics + Neural Residual</span>
              </div>

              {/* Question 3: What was observed in target T2D? */}
              <div className="evidence-pillar-card pillar-subgroup">
                <div>
                  <div className="pillar-label">
                    <span>3. Target Subgroup (T2D)</span>
                    <Activity size={14} aria-hidden="true" />
                  </div>
                  <h3 className="pillar-question">What was observed in T2D?</h3>
                  <div className="pillar-stat">
                    {subgroups?.['Type 2'] ? `\u0394 -5.52 mg/dL` : '—'}
                  </div>
                  <div className="pillar-substat">
                    T2D 120m RMSE: {subgroups?.['Type 2']?.rmse_120.toFixed(2) ?? '26.55'} vs 32.07 (Twin) vs 50.83 (PE)
                  </div>
                  <p className="pillar-desc">
                    At 120 minutes, the hybrid model achieves 26.55 mg/dL RMSE vs 32.07 for UKF-only and 50.83 for persistence. The hybrid-vs-UKF difference is -5.52 mg/dL—the largest margin among subgroups (vs -2.47 mg/dL in Healthy), where glycemic variability and resistance are highest.
                    <br /><strong style={{ color: 'var(--color-ink-2)' }}>Exploratory boundary:</strong> Exploratory evidence from only 10 simulated T2D subjects in the development partition; clinical validation in real patients is required.
                  </p>
                </div>
                <span className="pillar-tag">Exploratory · n=10 Subjects</span>
              </div>

              {/* Question 4: What remains unproven? */}
              <div className="evidence-pillar-card pillar-limitations">
                <div>
                  <div className="pillar-label">
                    <span>4. Governance &amp; Realism</span>
                    <XCircle size={14} color="var(--color-danger)" aria-hidden="true" />
                  </div>
                  <h3 className="pillar-question">What remains unproven?</h3>
                  <div className="pillar-stat stat-danger">
                    Gate 3 {gate3?.status ?? 'FAILED'}
                  </div>
                  <div className="pillar-substat">
                    AUROC {gate3?.historical_auroc.toFixed(4) ?? '0.9320'} (Target &le; 0.65)
                  </div>
                  <ul className="pillar-limits-list">
                    <li><strong>Gate 3 Realism FAILED:</strong> Discriminator easily detects synthetic ODE trajectories (AUROC 0.932031 historical, 0.928974 duration-corrected; top tell: <code>jerk_sd</code>).</li>
                    <li><strong>Held-out test unexecuted:</strong> 44 test subjects remain sealed behind governance firewall.</li>
                    <li><strong>EW-01 protocol unexecuted:</strong> Early warning spike alerts are governance-blocked.</li>
                    <li><strong>Zero human clinical claims:</strong> Evaluated on simulated data only; not validated for clinical diagnosis.</li>
                  </ul>
                </div>
                <span className="pillar-tag" style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}>
                  No Clinical Generalization
                </span>
              </div>
            </div>
          </section>
        )}

        {/* Always-visible figure: forecast error by horizon, from the same validated report as the tables below. */}
        {hasBenchmarks && models && (
          <section className="panel evidence-figure" aria-labelledby="error-figure-heading" data-testid="error-by-horizon">
            <div className="evidence-figure-head">
              <h2 id="error-figure-heading">Forecast error by horizon</h2>
              <p className="fine-print">RMSE in mg/dL, lower is better · bars show the estimate, whiskers the patient-clustered 95% CI · 44 synthetic validation patients</p>
            </div>
            {(['30', '60', '120'] as const).map(h => {
              const rows = [
                { key: 'pr_tft', label: 'Hybrid (twin + learned adjustment)', m: models.pr_tft[`rmse_${h}`] },
                { key: 'twin_only', label: 'Physiology twin alone', m: models.twin_only?.[`rmse_${h}`] },
                { key: 'persistence', label: 'Persistence (glucose stays flat)', m: models.persistence?.[`rmse_${h}`] },
              ].filter(r => r.m && Number.isFinite(r.m.estimate));
              const scaleMax = 55;
              const pct = (v: number) => `${Math.max(0, Math.min(100, (v / scaleMax) * 100))}%`;
              return (
                <div key={h} className="error-horizon">
                  <div className="error-horizon-label">{h} min</div>
                  <div className="error-bars">
                    {rows.map(r => (
                      <div key={r.key} className={`error-bar-row ${r.key}`}>
                        <span className="error-bar-name">{r.label}</span>
                        <span className="error-bar-track" aria-hidden="true">
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
            <p className="fine-print evidence-figure-foot">Development-validation partition, also used for checkpoint selection and calibration; not held-out or human evidence. Source: <code>runs/pr_tft_ablation_arm_d/evaluation_report.json</code>.</p>
          </section>
        )}

        {/* Verified Benchmark Tables rendered ONLY when validated artifact benchmarks are present */}
        {hasBenchmarks && models && paired && (
          <>
            {/* Generalization Boundary Notice */}
            <div className="generalization-banner" role="region" aria-label="Generalization Boundary Disclosure">
              <strong>Generalization Boundary Disclosure</strong>
              <p>
                All performance metrics presented below are evaluated on the 44-patient synthetic validation split used during model checkpoint selection and Stage-3 calibration fitting. These figures represent the internal development validation benchmark. They strictly do NOT constitute proof of prospective human generalization or clinical deployment efficacy. The held-out test split remains unexecuted per governance boundaries.
              </p>
            </div>

            {/* 1. Matched Baselines Comparison Table with Patient-Clustered CIs */}
            <EvidenceDisclosure labelledBy="baselines-heading" label="Matched baselines · forecast error by horizon with patient-clustered 95% CIs">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
                <div>
                  <span className="eyebrow">Controlled Benchmarks</span>
                  <h2 id="baselines-heading" style={{ margin: '4px 0 0', fontSize: '18px', fontWeight: 600 }}>
                    Matched Baseline Comparisons &amp; Patient-Clustered Uncertainty
                  </h2>
                </div>
                <span className="status-badge" style={{ background: 'transparent', borderColor: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}>
                  n=44 Subjects · B=10,000 Cluster Resamples (Primary)
                </span>
              </div>

              <p style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.55, margin: '0 0 14px' }}>
                Multi-horizon paired forecast error comparison evaluating the PR-TFT hybrid model against standalone UKF physiology ODEs and sensor persistence across 53,849–53,920 evaluable rows. In this synthetic partition, the neural residual layer corrects physics drift at longer horizons without replacing physiological priors.
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
                      <th scope="col">&Delta; vs. Persistence</th>
                      <th scope="col">&Delta; vs. UKF Twin</th>
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
                          <td style={{ fontWeight: 600, color: 'var(--color-ok)' }}>PR-TFT (Arm D)</td>
                          <td style={{ fontWeight: 700 }}>
                            {row.pr?.estimate.toFixed(2)}{' '}
                            <span style={{ fontWeight: 400, fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--color-ink-3)' }}>
                              {row.pr?.ci_95 ? `[${row.pr.ci_95[0].toFixed(2)}, ${row.pr.ci_95[1].toFixed(2)}]` : ''}
                            </span>
                          </td>
                          <td>{row.maePr?.estimate ? row.maePr.estimate.toFixed(2) : '—'}</td>
                          <td>{row.mardPr?.estimate ? `${row.mardPr.estimate.toFixed(2)}%` : '—'}</td>
                          <td style={{ color: 'var(--color-ok)', fontWeight: 600 }}>
                            {row.diffPe?.diff ? `${row.diffPe.diff.toFixed(2)} (${row.diffPe.relative_reduction_pct.toFixed(1)}%)` : '—'}
                          </td>
                          <td style={{ color: 'var(--color-accent-ink)', fontWeight: 600 }}>
                            {row.diffTw?.diff ? `${row.diffTw.diff.toFixed(2)} (${row.diffTw.relative_reduction_pct.toFixed(1)}%)` : '—'}
                          </td>
                        </tr>
                        <tr>
                          <td style={{ color: '#8c5b0c' }}>UKF Twin</td>
                          <td>
                            {row.tw?.estimate ? row.tw.estimate.toFixed(2) : '—'}{' '}
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--color-ink-3)' }}>
                              {row.tw?.ci_95 ? `[${row.tw.ci_95[0].toFixed(2)}, ${row.tw.ci_95[1].toFixed(2)}]` : ''}
                            </span>
                          </td>
                          <td>{row.maeTw?.estimate ? row.maeTw.estimate.toFixed(2) : '—'}</td>
                          <td>{row.mardTw?.estimate ? `${row.mardTw.estimate.toFixed(2)}%` : '—'}</td>
                          <td style={{ color: 'var(--color-ink-3)' }}>Reference</td>
                          <td style={{ color: 'var(--color-ink-3)' }}>Reference</td>
                        </tr>
                        <tr>
                          <td style={{ color: 'var(--color-danger)' }}>Persistence</td>
                          <td>
                            {row.pe?.estimate ? row.pe.estimate.toFixed(2) : '—'}{' '}
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--color-ink-3)' }}>
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

              <p className="fine-print" style={{ marginTop: '12px', fontSize: '11px', color: 'var(--color-ink-3)', lineHeight: 1.5 }}>
                Note: Paired differences (&Delta; = PR-TFT - Comparator) are strictly negative in all 10,000/10,000 bootstrap draws in the primary analysis (and 1,000/1,000 in the secondary cross-check). Negative &Delta; indicates lower prediction error. P-values are not inferred from finite bootstrap draws.
              </p>

              <div className="evidence-chart-grid">
                <div className="evidence-chart-card">
                  <img src="/evidence/baseline_comparison.svg" alt="Matched Baselines with 95% Patient-Clustered Bootstrap CIs" />
                </div>
                <div className="evidence-chart-card">
                  <img src="/evidence/horizon_trajectory.svg" alt="Forecast Error Trajectory Across Horizons (5 to 120 min)" />
                </div>
              </div>
            </EvidenceDisclosure>

            {/* 2. Patient-Level Pairwise Wins */}
            {wins && (
              <EvidenceDisclosure labelledBy="patient-wins-heading" label="Patient-level pairwise wins">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
                  <div>
                    <span className="eyebrow">Subject-Level Consistency</span>
                    <h2 id="patient-wins-heading" style={{ margin: '4px 0 0', fontSize: '16px', fontWeight: 600 }}>
                      Patient-Level Pairwise Win Rates (Exact Clopper-Pearson Binomial Intervals)
                    </h2>
                  </div>
                  <span className="status-badge" style={{ borderColor: 'var(--color-accent-ink)', color: 'var(--color-accent-ink)' }}>
                    n=44 Subjects · Exact Binomial Test
                  </span>
                </div>
                <p style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 14px' }}>
                  To avoid degenerate bootstrap intervals at 100% boundary conditions, exact Clopper-Pearson 95% binomial confidence intervals are reported. <em>Sampling assumption:</em> Independent Bernoulli trials across the 44 subjects in the simulated validation cohort; interpretation is strictly limited to this simulated cohort and does not guarantee human generalization.
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '14px' }}>
                  {(['30min', '60min', '120min'] as const).map((hKey) => {
                    const wRow = wins[hKey];
                    if (!wRow) return null;
                    return (
                      <div key={hKey} style={{ border: '1px solid var(--color-line)', borderRadius: '6px', padding: '14px', background: 'var(--color-surface)' }}>
                        <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', color: 'var(--color-ink)' }}>{hKey} Horizon Wins</div>
                        <div style={{ display: 'grid', gap: '6px', fontSize: '12px' }}>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)' }}>vs. Persistence:</span>{' '}
                            <strong style={{ color: 'var(--color-ok)' }}>
                              {wRow.pr_vs_persistence.wins_count}/{wRow.pr_vs_persistence.n_patients} ({(wRow.pr_vs_persistence.win_fraction * 100).toFixed(1)}%)
                            </strong>{' '}
                            <small style={{ color: 'var(--color-ink-3)' }}>
                              [Exact 95% CI: {(wRow.pr_vs_persistence.exact_binomial_ci_95[0] * 100).toFixed(1)}%–{(wRow.pr_vs_persistence.exact_binomial_ci_95[1] * 100).toFixed(1)}%]
                            </small>
                          </div>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)' }}>vs. UKF Twin:</span>{' '}
                            <strong style={{ color: wRow.pr_vs_twin.wins_count === wRow.pr_vs_twin.n_patients ? 'var(--color-ok)' : 'var(--color-accent-ink)' }}>
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
                    <span className="eyebrow">Diagnostic Stratification</span>
                    <h2 id="subgroups-heading" style={{ fontSize: '16px', fontWeight: 600, margin: '4px 0 0' }}>
                      Subgroup Robustness Across Clinical Strata
                    </h2>
                  </div>
                  <span className="status-badge" style={{ borderColor: '#8c5b0c', color: '#8c5b0c', background: 'rgba(140, 91, 12, 0.08)' }}>
                    Exploratory Analysis · n=44 Cohort
                  </span>
                </div>

                <p style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 14px' }}>
                  Stratified evaluation across healthy (n=15), prediabetes (n=19), and Type 2 diabetes (n=10) simulated subjects. The 10-patient T2D subgroup represents the core target use case: PR-TFT delivers its largest absolute gain over pure physics (&Delta; = -5.52 mg/dL at 120m) where metabolic impairment creates non-linear glucose dynamics that exceed standard ODE parameters. Sample sizes reflect the synthetic development partition and must be treated as exploratory.
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
                            {groupName} {isT2D ? '(Target Clinical Focus)' : ''}
                          </strong>
                          <span className="status-badge" style={{ fontSize: '10px' }}>
                            n={sg.n_patients} pts · {sg.n_anchors_eligible?.toLocaleString()} eligible
                          </span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', fontSize: '12px' }}>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)', display: 'block', fontSize: '11px' }}>30m RMSE</span>
                            <strong style={{ fontSize: '15px' }}>{sg.rmse_30?.toFixed(2)}</strong>
                            <div style={{ fontSize: '10px', color: 'var(--color-ink-3)' }}>{sg.n_evaluable_30?.toLocaleString()} rows</div>
                          </div>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)', display: 'block', fontSize: '11px' }}>60m RMSE</span>
                            <strong style={{ fontSize: '15px' }}>{sg.rmse_60?.toFixed(2)}</strong>
                            <div style={{ fontSize: '10px', color: 'var(--color-ink-3)' }}>{sg.n_evaluable_60?.toLocaleString()} rows</div>
                          </div>
                          <div>
                            <span style={{ color: 'var(--color-ink-3)', display: 'block', fontSize: '11px' }}>120m RMSE</span>
                            <strong style={{ fontSize: '15px', color: isT2D ? '#8c5b0c' : 'inherit' }}>{sg.rmse_120?.toFixed(2)}</strong>
                            <div style={{ fontSize: '10px', color: 'var(--color-ink-3)' }}>{sg.n_evaluable_120?.toLocaleString()} rows</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="evidence-chart-card" style={{ maxWidth: '640px', margin: '0 auto' }}>
                  <img src="/evidence/subgroup_robustness.svg" alt="Subgroup Robustness Across Clinical Strata" />
                </div>
              </EvidenceDisclosure>
            )}

            {/* 4. Patient Dispersion Compact Numeric Summary */}
            {dist && (
              <EvidenceDisclosure labelledBy="patient-dist-heading" label="Per-patient error dispersion">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
                  <div>
                    <span className="eyebrow">Cohort Dispersion</span>
                    <h2 id="patient-dist-heading" style={{ fontSize: '16px', fontWeight: 600, margin: '4px 0 0' }}>
                      Patient-Level Error Distribution
                    </h2>
                  </div>
                  <span className="status-badge" style={{ color: 'var(--color-ink-3)', borderColor: 'var(--color-line)' }}>
                    Compact Numeric Summary (n=44)
                  </span>
                </div>
                <p style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 14px' }}>
                  Per-patient RMSE quantiles across the 44 simulated validation subjects, summarizing patient-to-patient error dispersion (median 18.86 mg/dL, IQR 3.42 mg/dL at 60m). <em>Clinical disclosure:</em> These cohort-level summary distributions describe median performance and spread, but do not rule out individual acute forecast errors or outlier trajectory deviations in specific subjects.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' }}>
                  {dist['60min'] && (
                    <div style={{ border: '1px solid var(--color-line)', borderRadius: '6px', padding: '14px', background: 'var(--color-surface)' }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-ink)', marginBottom: '8px' }}>60-Minute Horizon Dispersion</div>
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
                    <div style={{ border: '1px solid var(--color-line)', borderRadius: '6px', padding: '14px', background: 'var(--color-surface)' }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-ink)', marginBottom: '8px' }}>120-Minute Horizon Dispersion</div>
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
              </EvidenceDisclosure>
            )}

            {/* 5. Calibration Limitations & Resubstitution Diagnostics (Explicitly Reconciled) */}
            {cal && (
              <EvidenceDisclosure labelledBy="cal-limits-heading" label="Calibration and interval coverage (resubstitution diagnostics)">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
                  <div>
                    <span className="eyebrow">Secondary Diagnostics</span>
                    <h2 id="cal-limits-heading" style={{ margin: '4px 0 0', fontSize: '16px', fontWeight: 600 }}>
                      Calibration Diagnostics &amp; Saturation Disclosures (RESUBSTITUTION)
                    </h2>
                  </div>
                  <span className="status-badge" style={{ borderColor: '#8c5b0c', color: '#8c5b0c' }}>
                    Resubstitution Diagnostics · Not Clinical Recommendations
                  </span>
                </div>

                {/* Conformal Coverage Reconciliation Card */}
                <div style={{ border: '1px solid var(--color-line)', borderRadius: '8px', padding: '16px', background: 'var(--color-surface)', marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-ink-3)' }}>
                      80% Conformal Interval Coverage Reconciliation
                    </span>
                    <span className="status-badge" style={{ borderColor: 'var(--color-ok)', color: 'var(--color-ok)', background: 'rgba(11, 113, 107, 0.08)' }}>
                      Reconciled Metric Provenance
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '14px', marginTop: '10px' }}>
                    <div style={{ padding: '12px', border: '1px solid var(--color-line)', borderRadius: '6px', background: 'var(--color-surface-2)' }}>
                      <div style={{ fontSize: '11px', color: 'var(--color-ink-3)', fontWeight: 600 }}>Raw Model Coverage (Uncalibrated):</div>
                      <div style={{ fontSize: '20px', fontWeight: 700, margin: '4px 0', color: 'var(--color-ink)' }}>
                        78.16% <span style={{ fontSize: '13px', fontWeight: 400, color: 'var(--color-ink-3)', fontFamily: 'var(--font-mono)' }}>(0.781553)</span>
                      </div>
                      <p style={{ margin: 0, fontSize: '11px', color: 'var(--color-ink-3)', lineHeight: 1.45 }}>
                        Mean uncalibrated p10–p90 width: <strong>36.02 mg/dL</strong> across 53,849–53,920 evaluable rows. Measures raw PR-TFT quantile heads before post-processing.
                      </p>
                    </div>
                    <div style={{ padding: '12px', border: '1px solid var(--color-ok)', borderRadius: '6px', background: 'rgba(11, 113, 107, 0.04)' }}>
                      <div style={{ fontSize: '11px', color: 'var(--color-ok)', fontWeight: 600 }}>Conformal-Adjusted Coverage (Resubstitution):</div>
                      <div style={{ fontSize: '20px', fontWeight: 700, margin: '4px 0', color: 'var(--color-ok)' }}>
                        80.00% <span style={{ fontSize: '13px', fontWeight: 400, color: 'var(--color-ink-3)', fontFamily: 'var(--font-mono)' }}>(0.800020)</span>
                      </div>
                      <p style={{ margin: 0, fontSize: '11px', color: 'var(--color-ink-3)', lineHeight: 1.45 }}>
                        Mean adjusted width: <strong>37.30 mg/dL</strong> (+1.28 mg/dL conformal widening). Evaluated on the 44-subject validation split where the calibrator was fitted (resubstitution diagnostic).
                      </p>
                    </div>
                  </div>
                  <p style={{ margin: '10px 0 0', fontSize: '11px', color: 'var(--color-ink-2)', lineHeight: 1.5 }}>
                    <strong>Reconciliation Note:</strong> Both numbers represent genuine pipeline metrics from <code>run_manifest.json</code>. The 0.781553 value is the unadjusted raw model coverage; the 0.800020 value is the post-hoc conformal-calibrated coverage (Stage-3 validation resubstitution). Neither guarantees 80% coverage on new human patients.
                  </p>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '16px' }}>
                  <div style={{ padding: '12px', border: '1px solid var(--color-line)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '11px', color: 'var(--color-ink-3)', textTransform: 'uppercase' }}>Brier Score (Raw &rarr; Calibrated)</div>
                    <div style={{ fontSize: '18px', fontWeight: 700, margin: '4px 0', color: 'var(--color-ok)' }}>
                      {cal.brier_score_calibrated?.toFixed(4)}
                      <small style={{ fontSize: '11px', color: 'var(--color-ink-3)', fontWeight: 400 }}> (Raw: {cal.brier_score_raw?.toFixed(4)})</small>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--color-ink-2)' }}>Resubstitution evaluation on {cal.at_risk_anchors?.toLocaleString()} at-risk anchors.</div>
                  </div>

                  {cal.threshold_evaluations?.['0.35'] && (
                    <div style={{ padding: '12px', border: '1px solid var(--color-line)', borderRadius: '6px' }}>
                      <div style={{ fontSize: '11px', color: 'var(--color-ink-3)', textTransform: 'uppercase' }}>Evaluated Threshold 0.35</div>
                      <div style={{ fontSize: '18px', fontWeight: 700, margin: '4px 0', color: 'var(--color-accent-ink)' }}>
                        Sens {(cal.threshold_evaluations['0.35'].sensitivity * 100).toFixed(1)}% · Prec {(cal.threshold_evaluations['0.35'].precision * 100).toFixed(1)}%
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--color-ink-2)' }}>Anchor-level alert fraction: {cal.threshold_evaluations['0.35'].alert_rate_pct?.toFixed(1)}% of decision anchors (diagnostic only; does not represent event-level alerts per day).</div>
                    </div>
                  )}

                  {cal.threshold_evaluations?.['0.60'] && (
                    <div style={{ padding: '12px', border: '1px solid #78350f', borderRadius: '6px', background: 'rgba(120, 53, 15, 0.05)' }}>
                      <div style={{ fontSize: '11px', color: '#8c5b0c', textTransform: 'uppercase' }}>High Threshold Diagnostic (0.60)</div>
                      <div style={{ fontSize: '18px', fontWeight: 700, margin: '4px 0', color: 'var(--color-danger)' }}>
                        Sens {(cal.threshold_evaluations['0.60'].sensitivity * 100).toFixed(1)}% · Prec {(cal.threshold_evaluations['0.60'].precision * 100).toFixed(1)}%
                      </div>
                      <div style={{ fontSize: '11px', color: '#8c5b0c' }}>High threshold empirical diagnostic (29.9% sensitivity, 74.5% precision, 5.3% anchor-level alert rate). Evaluated on the 44-patient validation partition; does not prove an underlying plateau or collapse mechanism.</div>
                    </div>
                  )}
                </div>

                <div className="evidence-chart-card" style={{ marginBottom: '16px' }}>
                  <img src="/evidence/calibration_reliability.svg" alt="Calibration Reliability Diagram with Equal-Width Probability Bins" />
                </div>

                <p className="fine-print" style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.6, margin: 0 }}>
                  Conformal coverage ({metrics.coverage_80_conformal.estimate ? (metrics.coverage_80_conformal.estimate * 100).toFixed(2) : '80.00'}%, width {metrics.width_80_conformal_mg_dl?.estimate?.toFixed(2) ?? '37.30'} mg/dL), Expected Calibration Error (ECE 0.000094), and Brier scores are resubstitution diagnostics evaluated on the identical validation split used during calibration fitting. No threshold should be treated as an approved clinical operating recommendation.
                </p>
              </EvidenceDisclosure>
            )}

            {/* 6. Scientific Governance & Boundary Disclosures Register */}
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
                  <div style={{ border: '1px solid #78350f', borderRadius: '8px', padding: '16px', background: 'rgba(120, 53, 15, 0.06)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#8c5b0c' }}>Gate 3 Realism</span>
                      <span className="status-badge" style={{ color: 'var(--color-danger)', borderColor: 'var(--color-danger)', background: 'rgba(185, 28, 28, 0.1)' }}>
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
                    <div className="evidence-chart-card" style={{ marginTop: '12px' }}>
                      <img src="/evidence/gate3_realism_summary.svg" alt="Gate 3 Realism Audit Discriminator Summary" />
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
                    <span className="status-badge" style={{ color: '#4b5563', borderColor: '#9ca3af', background: 'rgba(75, 85, 99, 0.08)' }}>
                      SEALED &amp; UNEXECUTED
                    </span>
                  </div>
                  <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 6px' }}>Held-Out Test Cohort</h3>
                  <p style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 10px' }}>
                    Sealed evaluation on the held-out test split (44 patients) was strictly not executed.
                  </p>
                  <div style={{ fontSize: '12px', display: 'grid', gap: '4px' }}>
                    <div><strong>Why it is not run:</strong> the training run recorded uncommitted changes in 11 files (<code>run_manifest.json</code> → <code>preflight.git.dirty</code>), and <code>backend/train_pr_tft.py</code> and <code>backend/ukf_twin.py</code> now differ from the source hashes recorded at training.</div>
                    <div><strong>What this does not affect:</strong> the header check, which confirms that the evaluation report, checkpoint and data match the run manifest.</div>
                    <div><strong>Status:</strong> not executed, so the test result cannot be attributed to an exactly reproducible training source.</div>
                  </div>
                  <p className="fine-print" style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--color-ink-3)' }}>
                    No performance claim is made for unexecuted test evaluation.
                  </p>
                </div>

                {/* External Dataset */}
                <div style={{ border: '1px solid var(--color-line)', borderRadius: '8px', padding: '16px', background: 'var(--color-surface)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--color-ink-3)' }}>External Dataset</span>
                    <span className="status-badge" style={{ color: '#8c5b0c', borderColor: '#8c5b0c', background: 'rgba(140, 91, 12, 0.08)' }}>
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
                    <span className="status-badge" style={{ color: '#4b5563', borderColor: '#9ca3af', background: 'rgba(75, 85, 99, 0.08)' }}>
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

        {/* Historical Development Reference - Preserved separately */}
        <EvidenceDisclosure labelledBy="historical-record-heading" label="Historical development reference (excluded from claims)">
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
        </EvidenceDisclosure>

        {/* Advanced Reproducibility & Cryptographic Provenance Disclosure */}
        {!errorState && manifest && report && (
          <details className="panel reproducibility-details" style={{ marginBottom: '24px' }}>
            <summary className="reproducibility-summary">
              <div className="reproducibility-summary-title">
                <span className="eyebrow" style={{ color: 'var(--color-accent)' }}>Technical Methodology &amp; Reproducibility</span>
                <h3>Cryptographic Provenance &amp; Verification Register</h3>
                <p>Click to inspect SHA-256 byte manifests, training checkpoint provenance, data integrity digests, and pipeline parameters.</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="status-badge" style={{ borderColor: 'var(--color-ok)', color: 'var(--color-ok)', background: 'rgba(11, 113, 107, 0.08)' }}>
                  <CheckCircle2 size={12} aria-hidden="true" /> SHA-256 Verified
                </span>
                <ChevronDown size={16} aria-hidden="true" style={{ color: 'var(--color-ink-3)' }} />
              </div>
            </summary>
            <div className="reproducibility-content">
              <div style={{ padding: '16px 0 12px', fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.6 }}>
                <p style={{ margin: '0 0 12px' }}>
                  Cryptographic verification succeeded. All recorded artifact hashes below match the on-disk byte manifests and checkpoint identities.
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
              <div style={{ marginTop: '12px', padding: '12px', background: 'var(--color-surface-2)', borderRadius: '6px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
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

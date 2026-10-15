import React from 'react';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { FileSearch, ShieldCheck, FolderOpen } from 'lucide-react';
import { NavigationRail } from '@/components/digital-twin/NavigationRail';

export const dynamic = 'force-dynamic';
const HashSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/i);
const ManifestSchema = z.object({
  run_id: z.string().optional(),
  run_kind: z.string().optional(),
  checkpoint: z.object({ name: z.string().optional(), path: z.string().optional() })
    .passthrough().refine(checkpoint => !!(checkpoint.path || checkpoint.name), 'Checkpoint path or name required'),
}).passthrough();
const MetricSchema = z.object({ estimate: z.number().finite() }).passthrough();
const ReportSchema = z.object({
  schema: z.literal('pr_tft_evaluation/v1').optional(),
  provenance: z.object({
    run_manifest_sha256: HashSchema,
    checkpoint_sha256: HashSchema,
    data_sha256: z.union([HashSchema, z.record(z.string(), HashSchema).refine(hashes => Object.keys(hashes).length > 0)]),
  }).passthrough(),
  populations: z.object({
    primary: z.object({
      models: z.object({
        pr_tft: z.object({ rmse_60: MetricSchema, rmse_120: MetricSchema, coverage_80_conformal: MetricSchema }).passthrough(),
      }).passthrough(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

export default async function EvidencePage() {
  const artifactsDir = process.env.ARTIFACTS_DIR || path.join(process.cwd(), 'runs/pr_tft_ablation_arm_d');
  let manifest: z.infer<typeof ManifestSchema> | null = null;
  let report: z.infer<typeof ReportSchema> | null = null;
  let errorState: 'absent' | 'invalid' | null = null;
  try {
    const manifestText = await fs.readFile(path.join(artifactsDir, 'run_manifest.json'), 'utf8');
    const reportText = await fs.readFile(path.join(artifactsDir, 'evaluation_report.json'), 'utf8');
    manifest = ManifestSchema.parse(JSON.parse(manifestText));
    report = ReportSchema.parse(JSON.parse(reportText));
  } catch (error: unknown) {
    errorState = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? 'absent' : 'invalid';
  }
  const metrics = report?.populations.primary.models.pr_tft;
  const dataHashes = report ? typeof report.provenance.data_sha256 === 'string' ? { 'Recorded data hash': report.provenance.data_sha256 } : report.provenance.data_sha256 : {};
  return (
    <div className="app-shell">
      <NavigationRail active="evidence" />
      <main id="main-content" className="overview-page">
        <header className="workspace-heading"><div><span className="eyebrow">Evidence registry</span><h1>Evidence &amp; validation</h1><p>Recorded evaluation artifacts, provenance, and the limits of the available evidence.</p></div><span className="status-badge"><ShieldCheck size={14} aria-hidden="true" />{errorState ? 'Evaluation unavailable' : 'Artifact review required'}</span></header>
        {errorState && <div className="evidence-layout"><section className="panel evidence-empty">
          <div className="empty-state-icon"><FileSearch size={26} aria-hidden="true" /></div>
          <span className="eyebrow">Evaluation artifact</span>
          <h2>{errorState === 'absent' ? 'Not yet evaluated' : 'Invalid or incomplete evaluation artifacts'}</h2>
          <p>{errorState === 'absent' ? 'The expected evaluation report is not available in the configured artifact directory. Runtime functionality and passing interface tests do not establish scientific performance.' : 'The artifact bundle could not be parsed against the supported report format. Its metrics are not displayed.'}</p>
          <div className="artifact-requirements"><span className="status-badge">run_manifest.json</span><span className="status-badge">evaluation_report.json</span></div>
          <p className="fine-print">This page does not generate or score data. No fresh EW-01 validation result is claimed.</p>
        </section><section className="panel evidence-checklist" aria-labelledby="evidence-checklist-heading">
          <span className="eyebrow">Reading the evidence</span>
          <h2 id="evidence-checklist-heading">A result needs its context.</h2>
          <div className="evidence-step"><span>01</span><div><h3>Recorded evaluation</h3><p>Forecast error and interval coverage are shown only when a supported evaluation report can be read.</p></div></div>
          <div className="evidence-step"><span>02</span><div><h3>Traceable provenance</h3><p>The run manifest, checkpoint, and data hashes identify the recorded inputs. Declared hashes still require independent review.</p></div></div>
          <div className="evidence-step"><span>03</span><div><h3>Explicit limitations</h3><p>A running dashboard is not clinical validation. Synthetic results do not establish performance in people.</p></div></div>
        </section></div>}
        {!errorState && manifest && report && metrics && <div className="evidence-content">
          <div className="evidence-notice"><strong>Recorded artifact · review required</strong><p>Structural checks passed. Hashes below are declared provenance, not independently authenticated evidence. Artifact availability does not establish fresh EW-01 evaluation or clinical validation.{manifest.run_kind && manifest.run_kind !== 'full' ? ' This is a pipeline-check run, not validation evidence.' : ''}</p></div>
          <section className="panel evidence-section" aria-labelledby="provenance-heading">
            <h2 id="provenance-heading">Provenance</h2>
            <dl className="provenance-fields">
              <div><dt>Model run</dt><dd>{manifest.run_id ?? path.basename(artifactsDir)}</dd><dd className="hash-value">{report.provenance.run_manifest_sha256}</dd></div>
              <div><dt>Training checkpoint</dt><dd>{manifest.checkpoint.path ?? manifest.checkpoint.name}</dd><dd className="hash-value">{report.provenance.checkpoint_sha256}</dd></div>
              {Object.entries(dataHashes).map(([name, hash]) => <div key={name}><dt>{name}</dt><dd className="hash-value">{hash}</dd></div>)}
            </dl>
          </section>
          <section className="panel evidence-section" aria-labelledby="evaluation-heading"><h2 id="evaluation-heading">Recorded primary-population metrics</h2><dl className="evaluation-metrics">
            <div><dt>RMSE · 60 min</dt><dd>{metrics.rmse_60.estimate.toFixed(3)}<small> mg/dL</small></dd></div>
            <div><dt>RMSE · 120 min</dt><dd>{metrics.rmse_120.estimate.toFixed(3)}<small> mg/dL</small></dd></div>
            <div><dt>Conformal 80% interval coverage</dt><dd>{metrics.coverage_80_conformal.estimate.toFixed(3)}</dd></div>
          </dl></section>
        </div>}
        <div className="panel evidence-source"><FolderOpen size={19} aria-hidden="true" /><div><strong>Source · configured artifact directory</strong><p>This view reads existing run and evaluation files. It does not execute evaluations, generate data, or authenticate declared provenance.</p></div></div>
        <footer className="research-footer">Research Only (Not for clinical decisions)<span>Evidence availability is separate from prototype functionality</span></footer>
      </main>
    </div>
  );
}

import React from 'react';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { FileSearch, ShieldCheck, FolderOpen, AlertTriangle, XCircle, CheckCircle2, AlertCircle } from 'lucide-react';
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

  // Attempt to load run manifest independently for provenance display even if evaluation report is absent
  let loadedManifest = manifest;
  if (!loadedManifest) {
    try {
      const manifestText = await fs.readFile(path.join(artifactsDir, 'run_manifest.json'), 'utf8');
      loadedManifest = ManifestSchema.parse(JSON.parse(manifestText));
    } catch {
      // Manifest load is best-effort when evaluation report fails
    }
  }

  const metrics = report?.populations.primary.models.pr_tft;
  const dataHashes = report ? typeof report.provenance.data_sha256 === 'string' ? { 'Recorded data hash': report.provenance.data_sha256 } : report.provenance.data_sha256 : {};

  return (
    <div className="app-shell">
      <NavigationRail active="evidence" />
      <main id="main-content" className="overview-page">
        <header className="workspace-heading">
          <div>
            <span className="eyebrow">Evidence registry</span>
            <h1>Evidence &amp; validation</h1>
            <p>Recorded evaluation artifacts, provenance, and the limits of the available evidence.</p>
          </div>
          <span className="status-badge">
            <ShieldCheck size={14} aria-hidden="true" />
            {errorState ? 'Evaluation unavailable' : 'Artifact review required'}
          </span>
        </header>

        {errorState && (
          <div className="evidence-layout">
            <section className="panel evidence-empty">
              <div className="empty-state-icon"><FileSearch size={26} aria-hidden="true" /></div>
              <span className="eyebrow">Evaluation artifact</span>
              <h2>{errorState === 'absent' ? 'Not yet evaluated' : 'Invalid or incomplete evaluation artifacts'}</h2>
              <p>
                {errorState === 'absent'
                  ? 'The expected evaluation report is not available in the configured artifact directory. Runtime functionality and passing interface tests do not establish scientific performance.'
                  : 'The artifact bundle could not be parsed against the supported report format. Its metrics are not displayed.'}
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
          <div className="evidence-content">
            <div className="evidence-notice">
              <strong>Recorded artifact · review required</strong>
              <p>
                Structural checks passed. Hashes below are declared provenance, not independently authenticated evidence. Artifact availability does not establish fresh EW-01 evaluation or clinical validation.
                {manifest.run_kind && manifest.run_kind !== 'full' ? ' This is a pipeline-check run, not validation evidence.' : ''}
              </p>
            </div>
            <section className="panel evidence-section" aria-labelledby="provenance-heading">
              <h2 id="provenance-heading">Provenance</h2>
              <dl className="provenance-fields">
                <div><dt>Model run</dt><dd>{manifest.run_id ?? path.basename(artifactsDir)}</dd><dd className="hash-value">{report.provenance.run_manifest_sha256}</dd></div>
                <div><dt>Training checkpoint</dt><dd>{manifest.checkpoint.path ?? manifest.checkpoint.name}</dd><dd className="hash-value">{report.provenance.checkpoint_sha256}</dd></div>
                {Object.entries(dataHashes).map(([name, hash]) => (
                  <div key={name}><dt>{name}</dt><dd className="hash-value">{hash}</dd></div>
                ))}
              </dl>
            </section>
            <section className="panel evidence-section" aria-labelledby="evaluation-heading">
              <h2 id="evaluation-heading">Recorded primary-population metrics</h2>
              <dl className="evaluation-metrics">
                <div><dt>RMSE · 60 min</dt><dd>{metrics.rmse_60.estimate.toFixed(3)}<small> mg/dL</small></dd></div>
                <div><dt>RMSE · 120 min</dt><dd>{metrics.rmse_120.estimate.toFixed(3)}<small> mg/dL</small></dd></div>
                <div><dt>Conformal 80% interval coverage</dt><dd>{metrics.coverage_80_conformal.estimate.toFixed(3)}</dd></div>
              </dl>
            </section>
          </div>
        )}

        {/* Validation Dashboard & Governance Register */}
        <div style={{ marginTop: '28px', display: 'grid', gap: '20px' }}>
          <section className="panel evidence-section" aria-labelledby="governance-heading">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '16px' }}>
              <div>
                <span className="eyebrow">Scientific Governance</span>
                <h2 id="governance-heading" style={{ margin: '4px 0 0', fontSize: '18px', fontWeight: 600 }}>Validation Status &amp; Provenance Register</h2>
              </div>
              <span className="status-badge" style={{ backgroundColor: '#2d1810', color: '#f59e0b', borderColor: '#78350f' }}>
                <AlertTriangle size={13} aria-hidden="true" /> Transparency Disclosures
              </span>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--color-ink-2)', lineHeight: 1.6, margin: '0 0 20px' }}>
              This register records the current empirical validation status, provenance checks, and protocol boundaries across all evaluation dimensions. A working demonstration is engineering proof of concept, not evidence of clinical efficacy or deployment readiness.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
              {/* Gate 3 Realism */}
              <div style={{ border: '1px solid #78350f', borderRadius: '8px', padding: '16px', background: 'rgba(120, 53, 15, 0.1)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#f59e0b' }}>Gate 3 Realism</span>
                  <span className="status-badge" style={{ color: '#ef4444', borderColor: '#b91c1c', background: 'rgba(185, 28, 28, 0.15)' }}>
                    <XCircle size={12} aria-hidden="true" /> FAILED
                  </span>
                </div>
                <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 6px' }}>Synthetic-Data Indistinguishability</h3>
                <p style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 10px' }}>
                  XGBoost discriminator separates synthetic from mock-real CGM windows (33,162 windows).
                </p>
                <div style={{ fontSize: '12px', display: 'grid', gap: '4px' }}>
                  <div><strong>AUROC:</strong> 0.9320 (90% CI: 0.928–0.936)</div>
                  <div><strong>Acceptance Threshold:</strong> AUROC &le; 0.65</div>
                  <div><strong>Top Tell:</strong> <code>jerk_sd</code> (SHAP 0.8878), <code>roc_max_fall</code></div>
                </div>
                <p className="fine-print" style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--color-ink-3)' }}>
                  Synthetic data is distinguishable from mock-real comparator generator; real-world physiological realism remains unestablished. Pipeline verified via null control (AUROC 0.507).
                </p>
              </div>

              {/* Held-Out Evaluation */}
              <div style={{ border: '1px solid #78350f', borderRadius: '8px', padding: '16px', background: 'rgba(120, 53, 15, 0.1)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#f59e0b' }}>Held-Out Test</span>
                  <span className="status-badge" style={{ color: '#ef4444', borderColor: '#b91c1c', background: 'rgba(185, 28, 28, 0.15)' }}>
                    <XCircle size={12} aria-hidden="true" /> STRICT NO-GO
                  </span>
                </div>
                <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 6px' }}>Evaluation Provenance</h3>
                <p style={{ fontSize: '12px', color: 'var(--color-ink-2)', lineHeight: 1.5, margin: '0 0 10px' }}>
                  Sealed evaluation on the held-out test split (44 patients) was strictly not executed.
                </p>
                <div style={{ fontSize: '12px', display: 'grid', gap: '4px' }}>
                  <div><strong>Training Tree:</strong> <code>dirty: true</code>, 11 dirty paths</div>
                  <div><strong>Source Hash:</strong> <code>backend/ukf_twin.py</code> mismatch</div>
                  <div><strong>Status:</strong> Unexecuted due to provenance failure</div>
                </div>
                <p className="fine-print" style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--color-ink-3)' }}>
                  No performance claim is made for unexecuted test evaluation.
                </p>
              </div>

              {/* External Diagnostic */}
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
                  <div><strong>Conclusion:</strong> Incompatible; not external validation</div>
                </div>
                <p className="fine-print" style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--color-ink-3)' }}>
                  External forecasting evaluation remains NO-GO.
                </p>
              </div>

              {/* EW-01 Scientific Protocol */}
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
                  <div><strong>Baseline Checkpoint:</strong> Missing checkpoint lineage</div>
                  <div><strong>Alert Lead Time:</strong> Not demonstrated prospectively</div>
                  <div><strong>Status:</strong> Formal evaluation not conducted</div>
                </div>
                <p className="fine-print" style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--color-ink-3)' }}>
                  Passing unit tests do not constitute scientific alert validation.
                </p>
              </div>
            </div>
          </section>

          {/* Model Architecture & Recorded Historical Validation Metrics */}
          <section className="panel evidence-section" aria-labelledby="model-spec-heading">
            <h2 id="model-spec-heading" style={{ fontSize: '16px', fontWeight: 600, marginBottom: '14px' }}>Model Specification &amp; Historical Validation Metrics</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginBottom: '16px' }}>
              <div>
                <dt style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--color-ink-3)', fontWeight: 600 }}>Architecture</dt>
                <dd style={{ fontSize: '13px', margin: '4px 0 0', fontWeight: 500 }}>PR-TFT (Physiological Residual TFT) + UKF S3</dd>
              </div>
              <div>
                <dt style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--color-ink-3)', fontWeight: 600 }}>Horizon &amp; Quantiles</dt>
                <dd style={{ fontSize: '13px', margin: '4px 0 0', fontWeight: 500 }}>120 min (24 &times; 5-min steps), 7 quantiles (p05–p95)</dd>
              </div>
              <div>
                <dt style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--color-ink-3)', fontWeight: 600 }}>Training Checkpoint</dt>
                <dd style={{ fontSize: '13px', margin: '4px 0 0', fontFamily: 'var(--font-mono)' }}>stage2_observed-epoch=03-val_loss=0.2255.ckpt</dd>
              </div>
              <div>
                <dt style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--color-ink-3)', fontWeight: 600 }}>Synthetic Cohort</dt>
                <dd style={{ fontSize: '13px', margin: '4px 0 0', fontWeight: 500 }}>293 active subjects (205 train, 44 val, 44 test)</dd>
              </div>
            </div>

            <div style={{ borderTop: '1px solid var(--color-line)', paddingTop: '14px' }}>
              <span className="eyebrow">Historical Arm D Development Reference (Validation Split, n=44 · runs/pr_tft_ablation_arm_d)</span>
              <p style={{ fontSize: '12px', color: 'var(--color-ink-3)', margin: '4px 0 12px' }}>
                Recorded during model checkpoint selection on the validation cohort; these figures reflect calibration tuning, not independent generalization.
              </p>
              <dl className="evaluation-metrics">
                <div><dt>RMSE · 60 min (val)</dt><dd>19.527<small> mg/dL</small></dd></div>
                <div><dt>RMSE · 120 min (val)</dt><dd>25.032<small> mg/dL</small></dd></div>
                <div><dt>Conformal 80% coverage</dt><dd>0.800<small> (width 37.3 mg/dL)</small></dd></div>
                <div><dt>Calibrated hazard AUROC</dt><dd>0.9226</dd></div>
                <div><dt>Calibrated hazard AUPRC</dt><dd>0.6314</dd></div>
              </dl>
            </div>
          </section>
        </div>

        <div className="panel evidence-source">
          <FolderOpen size={19} aria-hidden="true" />
          <div>
            <strong>Source · historical Arm D development reference & configured artifact directory</strong>
            <p>Fixed development reference metrics derived from runs/pr_tft_ablation_arm_d/run_manifest.json on the validation split. This view reads existing run and evaluation files. It does not execute evaluations, generate data, or authenticate declared provenance.</p>
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

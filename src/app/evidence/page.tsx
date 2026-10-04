import React from 'react';
import fs from 'fs/promises';
import path from 'path';
import { NavigationRail } from "@/components/digital-twin/NavigationRail";

export default async function EvidencePage() {
  const artifactsDir = process.env.ARTIFACTS_DIR || path.join(process.cwd(), '../T2D-Glucose-Digital-Twin/backend/runs/pr_tft_demo');
  
  let manifest: any = null;
  let report: any = null;
  let isEvaluated = false;

  try {
    const manifestStr = await fs.readFile(path.join(artifactsDir, 'run_manifest.json'), 'utf8');
    const reportStr = await fs.readFile(path.join(artifactsDir, 'evaluation_report.json'), 'utf8');
    manifest = JSON.parse(manifestStr);
    report = JSON.parse(reportStr);
    isEvaluated = true;
  } catch (err) {
    isEvaluated = false;
  }

  return (
    <div className="flex h-screen w-screen bg-bg text-[13px] leading-[20px] text-ink">
      <NavigationRail />
      <div className="flex-1 flex flex-col p-8 overflow-y-auto">
        <div className="mb-8">
          <h1 className="text-[24px] font-medium text-ink-2 mb-2">Evidence & Validation</h1>
        </div>

        {!isEvaluated ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-ink-3">Not yet evaluated</div>
          </div>
        ) : (
          <div className="max-w-4xl space-y-8">
            <section>
              <h2 className="text-[16px] font-medium text-ink-2 mb-4 border-b border-ink-4 pb-2">Provenance</h2>
              <div className="grid grid-cols-2 gap-4 text-ink-2">
                <div>
                  <div className="text-ink-3 text-[11px] uppercase tracking-wider mb-1">Model Run</div>
                  <div>{manifest?.run_id || 'Unknown'}</div>
                  <div className="font-mono text-[11px] text-ink-3 mt-1 truncate" title={report?.provenance?.run_manifest_sha256}>
                    {report?.provenance?.run_manifest_sha256}
                  </div>
                </div>
                <div>
                  <div className="text-ink-3 text-[11px] uppercase tracking-wider mb-1">Training Checkpoint</div>
                  <div>{manifest?.checkpoint?.name || 'Unknown'}</div>
                  <div className="font-mono text-[11px] text-ink-3 mt-1 truncate" title={report?.provenance?.checkpoint_sha256}>
                    {report?.provenance?.checkpoint_sha256}
                  </div>
                </div>
                <div>
                  <div className="text-ink-3 text-[11px] uppercase tracking-wider mb-1">Data Hash</div>
                  <div className="font-mono text-[11px] text-ink-3 truncate" title={report?.provenance?.data_sha256}>
                    {report?.provenance?.data_sha256}
                  </div>
                </div>
              </div>
            </section>

            <section>
              <h2 className="text-[16px] font-medium text-ink-2 mb-4 border-b border-ink-4 pb-2">Primary Population Evaluation</h2>
              <div className="bg-bg-subtle p-4 rounded-sm border border-ink-4">
                <div className="grid grid-cols-3 gap-6">
                  <div>
                    <div className="text-ink-3 text-[11px] uppercase tracking-wider mb-1">RMSE 60m</div>
                    <div className="text-[18px] tabular-nums font-medium">
                      {report?.populations?.primary?.models?.pr_tft?.rmse_60?.estimate?.toFixed(3) || 'N/A'}
                    </div>
                  </div>
                  <div>
                    <div className="text-ink-3 text-[11px] uppercase tracking-wider mb-1">RMSE 120m</div>
                    <div className="text-[18px] tabular-nums font-medium">
                      {report?.populations?.primary?.models?.pr_tft?.rmse_120?.estimate?.toFixed(3) || 'N/A'}
                    </div>
                  </div>
                  <div>
                    <div className="text-ink-3 text-[11px] uppercase tracking-wider mb-1">80% Coverage (Conformal)</div>
                    <div className="text-[18px] tabular-nums font-medium">
                      {report?.populations?.primary?.models?.pr_tft?.coverage_80_conformal?.estimate?.toFixed(3) || 'N/A'}
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

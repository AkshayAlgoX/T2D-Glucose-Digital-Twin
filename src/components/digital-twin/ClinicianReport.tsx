import React, { useEffect, useRef, useState } from 'react';
import { Download, Printer, X } from 'lucide-react';
import { MiniTwin } from '@/components/figure/MiniTwin';
import { formatDate, formatTime } from '@/lib/formatters/date';
import { fhirBundle } from '@/lib/fhir';
import { patientNote, type NoteLang } from '@/lib/patient-note';
import type { HeroForecast } from '@/lib/hero';
import type { ScenarioState } from '@/hooks/useScenario';
import type { SubjectStore } from '@/lib/types';
import type { ForecastResponse, QuantilePoint } from '@/types/forecast-response';
import { describeInput, summarizeComparison, SCENARIO_DISCLAIMER } from './ScenarioEditor';

const OFFSETS = [30, 60, 90, 120];
const pct = (p: number | null | undefined) => (p == null ? 'Unavailable' : `${(p * 100).toFixed(1)}%`);
const stamp = (iso: string) => `${formatDate(iso)} · ${formatTime(iso)} UTC`;

export interface ReportProps {
  forecast: ForecastResponse;
  cache: SubjectStore;
  baseline: HeroForecast | null;
  record: string | null;
  partition: string | null;
  scenario: ScenarioState | null;
  plate: string | null;
  onClose: () => void;
}

/** A printable one-page summary of what the workspace shows at the forecast moment; no field is filled in. */
export function ClinicianReport({ forecast, cache, baseline, record, partition, scenario, plate, onClose }: ReportProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [lang, setLang] = useState<NoteLang>('en');
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('report-open');
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('report-open'); };
  }, [onClose]);

  const q = forecast.data_quality;
  const risk = forecast.spike_risk;
  const points: QuantilePoint[] = forecast.forecast?.points ?? [];
  const rows = OFFSETS.map(m => points.find(p => p.offset_min === m)).filter((p): p is QuantilePoint => !!p);
  const result = scenario?.status === 'result' ? scenario : null;
  const summary = result ? summarizeComparison(result.result) : null;
  const name = forecast.subject.simulator?.param_set_id ?? 'Subject';
  const note = patientNote(lang, {
    time: `${formatTime(forecast.current.measured_at)} UTC`, glucose: forecast.current.value_mg_dl ?? null, risk: risk?.probability_120m ?? null,
    scenario: result ? { change: plate ?? describeInput(result.input), from: result.result.metrics.baseline_probability, to: result.result.metrics.new_probability } : null,
  });

  const download = () => {
    const blob = new Blob([JSON.stringify(fhirBundle(forecast, cache, new Date().toISOString()), null, 2)], { type: 'application/fhir+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${name}-${forecast.as_of.slice(0, 16).replace(/:/g, '')}-fhir.json`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="report-overlay" role="dialog" aria-modal="true" aria-labelledby="report-title" data-testid="clinician-report">
      <div className="report-toolbar">
        <span>Preview · prints on A4 or Letter</span>
        <button type="button" className="primary-button" onClick={() => window.print()}><Printer size={14} aria-hidden="true" />Print or save as PDF</button>
        <button type="button" className="secondary-button" onClick={download} data-testid="fhir-download"><Download size={14} aria-hidden="true" />FHIR R4 bundle (JSON)</button>
        <button ref={closeRef} type="button" className="secondary-button" onClick={onClose} aria-label="Close summary"><X size={14} aria-hidden="true" />Close</button>
      </div>
      <article className="report-sheet">
        <header className="report-head">
          <div>
            <p className="eyebrow">Research prototype summary · not a medical record</p>
            <h1 id="report-title">{name}: glucose forecast summary</h1>
            <p>{record ?? 'EHR context not received.'}</p>
          </div>
          <dl className="report-meta">
            <div><dt>Forecast moment</dt><dd>{stamp(forecast.as_of)}</dd></div>
            <div><dt>Data</dt><dd>Synthetic subject{partition ? ` · ${partition}` : ''}</dd></div>
            <div><dt>Model</dt><dd>{forecast.model.name} {forecast.model.version}{forecast.model.fallback_used ? ` · fallback: ${forecast.model.fallback_used}` : ''}</dd></div>
          </dl>
        </header>

        <section className="report-grid">
          <div>
            <h2>Now and next two hours</h2>
            <dl className="report-kv">
              <div><dt>Measured glucose</dt><dd>{forecast.current.value_mg_dl ?? '—'} mg/dL <small>at {formatTime(forecast.current.measured_at)} UTC · {forecast.current.trend_arrow.replace(/_/g, ' ')}</small></dd></div>
              <div><dt>2-h spike risk</dt><dd>{risk ? pct(risk.probability_120m) : 'Not served'} <small>{risk ? `${risk.calibrated ? 'calibrated' : 'uncalibrated'} · above ${risk.definition.threshold_mg_dl} mg/dL` : ''}</small></dd></div>
              <div><dt>Alert state</dt><dd>{forecast.alert.state === 'none' ? 'No alert' : forecast.alert.state}{forecast.alert.since ? <small> since {formatTime(forecast.alert.since)} UTC</small> : null}</dd></div>
              {risk?.peak_mg_dl && <div><dt>Peak estimate</dt><dd>{risk.peak_mg_dl.p50} mg/dL <small>risk model&apos;s peak distribution, median · 90th pct {risk.peak_mg_dl.p90}{risk.time_to_peak_min != null ? ` · at +${risk.time_to_peak_min} min` : ''}</small></dd></div>}
            </dl>
          </div>
          {baseline && <figure className="report-figure"><MiniTwin data={baseline} id="report-mini" /><figcaption>Dots: received CGM readings (past 2 h). Line and bands: forecast median and 5–95% band. Dashed: physiology twin. Line at 180 mg/dL.</figcaption></figure>}
        </section>

        {rows.length > 0 && <table className="report-table">
          <caption>Forecast at the moment above (model output, not measured)</caption>
          <thead><tr><th scope="col">Horizon</th><th scope="col">Time (UTC)</th><th scope="col">Median</th><th scope="col">10–90% range</th><th scope="col">Twin alone</th><th scope="col">Cumulative risk</th></tr></thead>
          <tbody>{rows.map(p => <tr key={p.offset_min}><th scope="row">+{p.offset_min} min</th><td>{formatTime(p.t)}</td><td>{p.p50} mg/dL</td><td>{p.p10}–{p.p90}</td><td>{p.twin_p50 ?? '—'}</td><td>{pct(risk?.cumulative.find(c => c.offset_min === p.offset_min)?.p)}</td></tr>)}</tbody>
        </table>}

        <section className="report-grid">
          <div>
            <h2>Data quality and freshness</h2>
            <dl className="report-kv">
              <div><dt>Status</dt><dd>{q.status}</dd></div>
              <div><dt>CGM coverage, 6 h</dt><dd>{q.cgm_coverage_6h_pct != null ? `${q.cgm_coverage_6h_pct}%` : '—'}</dd></div>
              <div><dt>Last CGM reading</dt><dd>{stamp(q.last_cgm_at)} <small>{q.staleness_min} min old</small></dd></div>
              {!!q.reasons?.length && <div><dt>Flags</dt><dd>{q.reasons.map(r => r.replace(/_/g, ' ')).join(', ')}</dd></div>}
            </dl>
          </div>
          <div>
            <h2>What-if comparison</h2>
            {result && summary ? <>
              <p><strong>{plate ?? describeInput(result.input)}</strong>, simulated from {formatTime(result.asOf)} UTC.</p>
              <dl className="report-kv">
                <div><dt>Peak median</dt><dd>{summary.baselinePeak} → {summary.scenarioPeak} mg/dL <small>({summary.deltaPeak >= 0 ? '+' : '−'}{Math.abs(summary.deltaPeak)})</small></dd></div>
                <div><dt>2-h spike risk</dt><dd>{pct(result.result.metrics.baseline_probability)} → {pct(result.result.metrics.new_probability)}</dd></div>
              </dl>
              {result.result.warnings.length > 0 && <p className="report-note">Warnings: {result.result.warnings.map(w => w.title).join('; ')}.</p>}
              <p className="report-note">{SCENARIO_DISCLAIMER}</p>
            </> : <p className="report-note">No scenario was run in this session. Run one in What-if to include it here.</p>}
          </div>
        </section>

        <section className="report-note-patient" aria-labelledby="patient-note-heading">
          <div className="report-note-head">
            <h2 id="patient-note-heading">Note for the patient</h2>
            <div role="group" aria-label="Note language" className="report-lang">
              <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>English</button>
              <button type="button" aria-pressed={lang === 'hi'} onClick={() => setLang('hi')} lang="hi">हिन्दी</button>
            </div>
          </div>
          <div lang={lang} data-testid="patient-note">{note.map(line => <p key={line}>{line}</p>)}</div>
          {lang === 'hi' && <p className="report-note" data-testid="hindi-review-note">Hindi text: fixed sentences filled with the values above; not yet reviewed by a native-speaking clinician.</p>}
        </section>

        <footer className="report-foot">
          <p><strong>Intended use:</strong> research only, not for clinical decisions. Synthetic subject; no clinical validation is claimed and this is not a medical device.</p>
          <p><strong>Known, inferred, uncertain.</strong> Measured: CGM readings and EHR fields as received. Inferred: forecast, spike risk and twin state are model outputs. Uncertain: the forecast bands are the model&apos;s own; scenario effect sizes are not validated against human data. Evaluation results and failed gates are listed on the Evidence page.</p>
          <p className="report-ids">Request {forecast.request_id} · run {forecast.model.run_id} · alert policy {forecast.model.alert_policy_version} · printed {new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
        </footer>
      </article>
    </div>
  );
}

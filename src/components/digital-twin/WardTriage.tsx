'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Ward, WardRow } from '@/lib/ward';

const SHOWN = 8;
const ARROW: Record<string, string> = { rising_fast: '⇈', rising: '↑', rising_slow: '↗', flat: '→', falling_slow: '↘', falling: '↓', falling_fast: '⇊' };
const pct = (p: number) => `${(p * 100).toFixed(0)}%`;
const tier = (p: number) => (p >= 0.6 ? 'high' : p >= 0.35 ? 'watch' : 'low');
const utc = (iso: string) => new Date(iso).toISOString().slice(11, 16);

function window180(r: WardRow) {
  if (!r.medianAbove) return '—';
  const [a, b] = r.medianAbove;
  return a === b ? `at +${a} min` : `+${a} to +${b} min`;
}

/** The doctor's first view: who needs attention in the next two hours, from the served forecasts. */
export function WardTriage() {
  const [ward, setWard] = useState<Ward | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [all, setAll] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/ward', { signal: controller.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((w: Ward) => { if (!Array.isArray(w?.rows)) throw new Error('bad ward'); setWard(w); setState('ready'); })
      .catch(err => { if (err?.name !== 'AbortError') setState('error'); });
    return () => controller.abort();
  }, []);

  const rows = ward ? (all ? ward.rows : ward.rows.slice(0, SHOWN)) : [];
  const atRisk = ward ? ward.rows.filter(r => r.probability >= 0.35).length : 0;

  return (
    <section className="panel ward-triage" aria-labelledby="ward-heading" data-testid="ward-triage">
      <div className="ward-head">
        <div>
          <span className="eyebrow">Ward view · {ward ? utc(ward.asOf) : '08:00'} UTC</span>
          <h2 id="ward-heading">Who needs attention in the next two hours</h2>
          <p className="fine-print">Validation patients at the replay hold, ranked by the backend&apos;s calibrated 2-hour spike-onset risk. Open a patient to see the forecast behind the number.</p>
        </div>
        {ward && <p className="ward-count" data-testid="ward-count"><b>{atRisk}</b> of {ward.rows.length} at or above the 35% watch line</p>}
      </div>

      {state === 'loading' && <div className="ward-loading" aria-busy="true" aria-label="Loading the ward">{Array.from({ length: 4 }, (_, i) => <span key={i} className="skeleton ward-skeleton" aria-hidden="true" />)}</div>}
      {state === 'error' && <p className="ward-error" role="status" data-testid="ward-error">The ward could not be read from the forecasting service, so no patients are ranked. The directory below still works.</p>}

      {state === 'ready' && ward && <>
        <div className="evidence-table-container" tabIndex={0} role="region" aria-label="Ward ranked by 2-hour spike risk">
          <table className="ward-table">
            <caption className="sr-only">Validation patients ranked by calibrated 2-hour spike-onset risk at {utc(ward.asOf)} UTC, with current glucose, alert tier, when the forecast median is above 180 mg/dL, and its highest value</caption>
            <thead><tr><th scope="col">#</th><th scope="col">Patient</th><th scope="col">Glucose now</th><th scope="col">2-h spike risk</th><th scope="col">Alert</th><th scope="col">Median above 180</th><th scope="col">Highest median</th></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={r.subjectId} className={`tier-${tier(r.probability)}`}>
                <td className="numeric">{i + 1}</td>
                <th scope="row"><Link href={`/patients/${r.subjectId}`} className="ward-patient">{r.patientId}</Link><small>{r.group}</small></th>
                <td className="numeric">{r.current.toFixed(0)} <small>mg/dL {r.trend && ARROW[r.trend] ? <span aria-label={r.trend.replace('_', ' ')}>{ARROW[r.trend]}</span> : null}</small></td>
                <td><span className="ward-risk"><i style={{ width: pct(r.probability) }} aria-hidden="true" /></span><b className="numeric">{pct(r.probability)}</b></td>
                <td>{r.alert === 'none' ? '—' : <span className={`ward-alert ${r.alert}`}>{r.alert.charAt(0).toUpperCase() + r.alert.slice(1)}</span>}</td>
                <td>{window180(r)}</td>
                <td className="numeric">{r.peak.toFixed(0)} <small>at +{r.peakMin} min</small></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div className="ward-foot">
          {ward.rows.length > SHOWN && <button type="button" className="secondary-button" aria-expanded={all} onClick={() => setAll(v => !v)}>{all ? `Show top ${SHOWN}` : `Show all ${ward.rows.length}`}</button>}
          {ward.withheld.length > 0 && <span className="fine-print" data-testid="ward-withheld">No forecast at this hold for {ward.withheld.map((w, i) => <React.Fragment key={w.subjectId}>{i > 0 && ', '}<Link href={`/patients/${w.subjectId}`}>{w.patientId}</Link> ({w.reason})</React.Fragment>)}.</span>}
          {ward.failed > 0 && <span className="fine-print">{ward.failed} of {ward.requested} forecasts could not be read and are not ranked.</span>}
          <span className="fine-print">Alert tiers follow the research policy: watch at 35%, warning at 60%.</span>
        </div>
      </>}
    </section>
  );
}

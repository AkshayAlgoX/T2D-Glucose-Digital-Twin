import React from 'react';
import { readLabData } from '@/lib/lab-data';
import { InstrumentC } from '@/components/lab/InstrumentC';
import { fmt, laneSeries, laneRows, geom } from '@/components/lab/geom';
import { NavC } from '@/components/lab/navs';

export const dynamic = 'force-dynamic';

export default async function LabCWorkspace() {
  const d = await readLabData();
  if (!d) return <p>Backend unavailable.</p>;
  const g = geom(d, 300, 40, { l: 0, r: 0, t: 0, b: 0 }, -120, 0);
  const hr = laneSeries(d, g.x, -120, 32, 'hr');
  const hrv = laneSeries(d, g.x, -120, 32, 'hrv');
  const rows = laneRows(d, -120);
  const steps = Math.round(rows.reduce((t, r) => t + (r.steps ?? 0), 0));
  const meal = rows.find(r => (r.carbs ?? 0) > 0);
  return (
    <div className="labC">
      <NavC here="workspace" />
      <main className="c-ws">
        <header className="c-ws-head">
          <div className="c-avatar" aria-hidden="true">{d.patient.slice(-2)}</div>
          <div><h1>{d.patient}</h1><p>{d.ehr?.age_years} y · {d.ehr?.sex} · BMI {d.ehr?.bmi} · HbA1c {d.ehr?.hba1c_pct}% · Type 2 · Metformin</p></div>
          <span className="c-tag">Synthetic · validation split</span>
          <div className="c-replay"><span className="c-clock">08:00 <small>UTC · 29 Sep</small></span><span className="c-held">Held</span><button type="button">Resume replay</button></div>
        </header>
        <div className="c-seg" role="group"><b>Forecast</b><span>What-if</span><span>Record</span></div>
        <div className="c-ws-grid">
          <section className="c-card"><div className="c-card-head"><span className="c-title">Glucose · next 2 hours</span><span>Drag or use ← → to inspect</span></div>
            <div className="c-wide"><InstrumentC d={d} W={860} H={340} /></div>
            <div className="c-narrow"><InstrumentC d={d} W={360} H={250} compact /></div>
          </section>
          <aside className="c-side">
            <div className="c-card c-big"><span>Current</span><strong>{fmt(d.current)}</strong><small>mg/dL · rising {d.trend != null ? fmt(d.trend) : ''}/min</small></div>
            <div className="c-card c-big c-risk"><span>New-spike onset risk · 2 h</span><strong>{d.onset != null ? (d.onset * 100).toFixed(1) : '—'}%</strong><small>Separate classifier, calibrated on the validation split</small></div>
            <div className="c-card c-inputs"><span className="c-title">Inputs, last 2 h</span>
              <div className="c-in"><span>Meal</span><b>{meal ? `${Math.round(meal.carbs!)} g · ${meal.t.slice(11, 16)}` : 'None logged'}</b></div>
              <div className="c-in"><span>Steps</span><b>{steps}</b></div>
              <div className="c-in"><span>Heart rate</span><svg viewBox="0 0 300 32" preserveAspectRatio="none" aria-hidden="true"><path d={hr?.path ?? ''} /></svg><b>{hr ? fmt(hr.last) : '—'} bpm</b></div>
              <div className="c-in"><span>HRV</span><svg viewBox="0 0 300 32" preserveAspectRatio="none" aria-hidden="true"><path d={hrv?.path ?? ''} /></svg><b>{hrv ? fmt(hrv.last) : '—'} ms</b></div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

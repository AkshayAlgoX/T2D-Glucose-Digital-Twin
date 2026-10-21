import React from 'react';
import { readLabData, aboveWindow } from '@/lib/lab-data';
import { ScopeA } from '@/components/lab/ScopeA';
import { fmt, signed, at, peakOf } from '@/components/lab/geom';
import { NavA } from '@/components/lab/navs';

export const dynamic = 'force-dynamic';

export default async function LabAWorkspace() {
  const d = await readLabData();
  if (!d) return <p>Backend unavailable.</p>;
  const h60 = at(d, 60)!;
  const hi = aboveWindow(d.points, 'p50');
  const lo = aboveWindow(d.points, 'p10');
  const pk = peakOf(d);
  return (
    <div className="labA">
      <NavA here="workspace" />
      <main className="a-ws">
        <header className="a-ws-head">
          <div className="a-ws-id"><span className="a-kicker">SUBJECT · SYNTHETIC · VALIDATION SPLIT</span><h1>{d.patient}</h1><p>{d.ehr?.age_years}-year-old {d.ehr?.sex} · BMI {d.ehr?.bmi} · HbA1c {d.ehr?.hba1c_pct}% · Type 2 · on Metformin</p></div>
          <div className="a-transport" role="group" aria-label="Replay"><span className="a-rec">● REPLAY</span><span className="a-clock">29 SEP 2026 · {d.asOf.slice(11, 19)} UTC</span><span className="a-state">HELD</span><button type="button">▶ Resume</button></div>
        </header>
        <div className="a-ws-grid">
          <section className="a-ws-scope">
            <div className="a-ws-bar"><span>GLUCOSE · mg/dL · 2 h observed / 2 h forecast</span><span className="a-tabs"><b>2 h</b><span>6 h</span></span></div>
            <div className="a-wide"><ScopeA d={d} W={1060} H={380} /></div>
            <div className="a-narrow"><ScopeA d={d} W={380} H={290} compact /></div>
          </section>
          <aside className="a-ws-side">
            <div className="a-readout"><span>NOW</span><strong>{fmt(d.current)}</strong><small>mg/dL · rising {d.trend != null ? fmt(d.trend) : ''}/min</small></div>
            <div className="a-block">
              <h2>FORECAST VS 180</h2>
              <p className="a-big">{hi ? `Median above 180 from +${hi[0]} to +${hi[1]} min` : 'Median stays below 180'}</p>
              <p className="a-note">{lo ? `Even the lower 10% bound is above 180 from +${lo[0]} to +${lo[1]} min.` : 'The lower 10% bound stays below 180.'} Peak median {fmt(pk.p50)} at +{pk.offset_min} min.</p>
            </div>
            <div className="a-block">
              <h2>HOW THE +60 MIN VALUE IS BUILT</h2>
              <dl className="a-eq"><div className="t"><dt>① Physiology twin</dt><dd>{fmt(h60.twin!)}</dd></div><div className="j"><dt>② Learned adjustment</dt><dd>{signed(h60.p50 - h60.twin!)}</dd></div><div className="f"><dt>③ Forecast median</dt><dd>{fmt(h60.p50)}</dd></div></dl>
              <p className="a-note">80% interval {fmt(h60.p10)}–{fmt(h60.p90)} mg/dL.</p>
            </div>
            <div className="a-block">
              <h2>NEW-SPIKE ONSET RISK · 2 H</h2>
              <p className="a-big">{d.onset != null ? (d.onset * 100).toFixed(1) : '—'}%</p>
              <p className="a-note">Separate classifier, calibrated on the validation split. A rise of ≥ 50 mg/dL to ≥ 180 that holds 15 min.</p>
            </div>
            <a className="a-cta a-cta-block">Test a change to the plan →</a>
          </aside>
        </div>
      </main>
    </div>
  );
}

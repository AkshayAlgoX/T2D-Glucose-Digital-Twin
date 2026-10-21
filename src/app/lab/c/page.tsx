import React from 'react';
import { readLabData } from '@/lib/lab-data';
import { InstrumentC } from '@/components/lab/InstrumentC';
import { fmt } from '@/components/lab/geom';
import { NavC } from '@/components/lab/navs';

export const dynamic = 'force-dynamic';

export default async function LabC() {
  const d = await readLabData();
  if (!d) return <p>Backend unavailable.</p>;
  return (
    <div className="labC">
      <NavC here="home" />
      <main className="c-home">
        <section className="c-hero">
          <div className="c-copy">
            <p className="c-eyebrow"><span className="c-pill">Research prototype</span>Type 2 diabetes digital twin</p>
            <h1>See the next two hours of glucose, and what shapes them.</h1>
            <p className="c-lead">A physiology twin fitted to each synthetic patient, corrected by a learned model, with honest uncertainty. Drag across the forecast to see how each value is built.</p>
            <div className="c-actions"><a className="c-cta">Open P0017&apos;s workspace</a><a className="c-sec">Browse cohort</a><a className="c-sec">Evidence</a></div>
            <dl className="c-facts">
              <div><dt>Patient</dt><dd>{d.patient} · {d.ehr?.age_years} y {d.ehr?.sex}</dd></div>
              <div><dt>Now</dt><dd>{fmt(d.current)} mg/dL ↑</dd></div>
              <div><dt>Onset risk · 2 h</dt><dd>{d.onset != null ? (d.onset * 100).toFixed(1) : '—'}%</dd></div>
            </dl>
            <p className="c-fine">Synthetic data only; not a medical device. Development-validation results; the realism gate failed and is published.</p>
          </div>
          <div className="c-card">
            <div className="c-card-head"><span className="c-live"><i />Model output · {d.patient}</span><span>29 Sep · {d.asOf.slice(11, 16)} UTC · replayed</span></div>
            <div className="c-wide"><InstrumentC d={d} W={720} H={330} /></div>
            <div className="c-narrow"><InstrumentC d={d} W={360} H={250} compact /></div>
          </div>
        </section>
      </main>
    </div>
  );
}

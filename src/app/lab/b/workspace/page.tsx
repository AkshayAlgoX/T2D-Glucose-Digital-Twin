import React from 'react';
import { readLabData, aboveWindow } from '@/lib/lab-data';
import { FigureB, LanesB, NotesB } from '@/components/lab/FigureB';
import { fmt, peakOf } from '@/components/lab/geom';
import { NavB } from '@/components/lab/navs';

export const dynamic = 'force-dynamic';

export default async function LabBWorkspace() {
  const d = await readLabData();
  if (!d) return <p>Backend unavailable.</p>;
  const hi = aboveWindow(d.points, 'p50');
  const lo = aboveWindow(d.points, 'p10');
  const pk = peakOf(d);
  return (
    <div className="labB">
      <NavB here="workspace" />
      <main className="b-ws">
        <header className="b-ws-head">
          <div><p className="b-section">Case · synthetic validation subject</p><h1>{d.patient}</h1></div>
          <p className="b-case">{d.ehr?.age_years}-year-old {d.ehr?.sex}, type 2 diabetes diagnosed 0.5 years ago, on metformin. BMI {d.ehr?.bmi}, HbA1c {d.ehr?.hba1c_pct}%. Fitted insulin sensitivity {d.insulinSensitivity?.toFixed(2)} of a healthy reference.</p>
          <div className="b-replay"><span>Replay held at</span><strong>08:00 UTC</strong><span>29 Sep 2026</span><button type="button">Resume</button></div>
        </header>
        <nav className="b-tabs"><a aria-current="page">Forecast</a><a>What-if</a><a>Record &amp; history</a></nav>
        <div className="b-ws-grid">
          <figure className="b-figure b-ws-fig">
            <figcaption className="b-cap-top"><b>Glucose, observed and forecast.</b> Two hours either side of {d.asOf.slice(11, 16)} UTC. Shading is the 80% interval; the shaded wedge between the twin and the median is the learned adjustment.</figcaption>
            <div className="b-wide"><FigureB d={d} W={900} H={360} /><LanesB d={d} W={900} /></div>
            <div className="b-narrow"><FigureB d={d} W={360} H={260} compact /><LanesB d={d} W={360} compact /></div>
          </figure>
          <aside className="b-ws-side">
            <section><h2>Next two hours</h2><p className="b-lede">{hi ? <>The median forecast is above 180 mg/dL from +{hi[0]} to +{hi[1]} min, peaking at {fmt(pk.p50)} at +{pk.offset_min}.</> : 'The median forecast stays below 180 mg/dL.'}</p><p className="b-small">{lo ? `Even the lower 10% bound exceeds 180 from +${lo[0]} to +${lo[1]} min.` : ''}</p></section>
            <section><h2>How the +60 min value is built</h2><NotesB d={d} /></section>
            <section><h2>Onset risk</h2><p className="b-lede"><b>{d.onset != null ? (d.onset * 100).toFixed(1) : '—'}%</b> probability that a new spike starts within 2 h.</p><p className="b-small">A separate classifier, calibrated on the validation split. A spike is a rise of at least 50 mg/dL to 180 or more, held for 15 min.</p></section>
          </aside>
        </div>
      </main>
    </div>
  );
}

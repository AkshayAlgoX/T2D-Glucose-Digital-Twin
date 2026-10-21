import React from 'react';
import { readLabData, aboveWindow } from '@/lib/lab-data';
import { FigureB, LanesB, NotesB } from '@/components/lab/FigureB';
import { fmt } from '@/components/lab/geom';
import { NavB } from '@/components/lab/navs';

export const dynamic = 'force-dynamic';

export default async function LabB() {
  const d = await readLabData();
  if (!d) return <p>Backend unavailable.</p>;
  const hi = aboveWindow(d.points, 'p50');
  return (
    <div className="labB">
      <NavB here="home" />
      <main className="b-home">
        <section className="b-hero">
          <div className="b-copy">
            <p className="b-section">Type 2 diabetes · digital twin · research prototype</p>
            <h1>A forecast you can take apart.</h1>
            <p className="b-dek">Glucose Twin predicts the next two hours of glucose for a synthetic patient. It shows how much of each forecast comes from fitted physiology and how much from a learned correction, and how a meal or some activity would change it.</p>
            <div className="b-actions"><a className="b-cta">Open the workspace for P0017</a><a className="b-link">Browse the cohort</a><a className="b-link">Read the evidence</a></div>
            <p className="b-boundary">Synthetic data only; not a medical device. The realism gate failed, and that result is published with the others.</p>
          </div>
          <figure className="b-figure">
            <figcaption className="b-cap-top"><b>Figure 1.</b> {d.patient}, {d.ehr?.age_years}-year-old {d.ehr?.sex} with type 2 diabetes, on 29 September at {d.asOf.slice(11, 16)} UTC. Observed CGM for the previous two hours, and the model&apos;s forecast for the next two with its 80% interval.</figcaption>
            <div className="b-figbody">
              <div className="b-plot">
                <div className="b-wide"><FigureB d={d} W={760} H={340} /><LanesB d={d} W={760} /></div>
                <div className="b-narrow"><FigureB d={d} W={360} H={260} compact /><LanesB d={d} W={360} compact /></div>
              </div>
              <aside className="b-margin">
                <p className="b-now"><span>Now</span>{fmt(d.current)} <small>mg/dL, rising</small></p>
                <NotesB d={d} />
                <p className="b-risk">{hi ? <>Median above 180 mg/dL from <b>+{hi[0]}</b> to <b>+{hi[1]} min</b>.</> : 'Median stays below 180 mg/dL.'} Separate onset-risk classifier: <b>{d.onset != null ? (d.onset * 100).toFixed(1) : '—'}%</b>.</p>
              </aside>
            </div>
            <div className="b-key"><span><i className="k-obs" />Observed</span><span><i className="k-med" />Forecast median</span><span><i className="k-band" />80% interval</span><span><i className="k-twin" />Physiology twin</span><span><i className="k-adj" />Learned adjustment</span></div>
          </figure>
        </section>
      </main>
    </div>
  );
}

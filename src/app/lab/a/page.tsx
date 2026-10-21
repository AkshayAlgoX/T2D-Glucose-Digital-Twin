import React from 'react';
import { readLabData, aboveWindow } from '@/lib/lab-data';
import { ScopeA } from '@/components/lab/ScopeA';
import { fmt, peakOf } from '@/components/lab/geom';
import { NavA } from '@/components/lab/navs';

export const dynamic = 'force-dynamic';

export default async function LabA() {
  const d = await readLabData();
  if (!d) return <p>Backend unavailable.</p>;
  const hi = aboveWindow(d.points, 'p50');
  const pk = peakOf(d);
  return (
    <div className="labA">
      <NavA here="home" />
      <main className="a-home">
        <section className="a-hero">
          <div className="a-hero-copy">
            <p className="a-kicker">TYPE 2 DIABETES · DIGITAL TWIN · RESEARCH INSTRUMENT</p>
            <h1>Two hours ahead of a patient&apos;s glucose.</h1>
            <p className="a-lead">A physiology model fitted to each synthetic patient predicts the shape. A neural network learns what the physiology misses. You see both, the uncertainty, and how a meal or a walk would change it.</p>
            <div className="a-actions"><a className="a-cta">Open P0017&apos;s workspace →</a><a className="a-ghost">Cohort</a><a className="a-ghost">Evidence</a></div>
          </div>
          <dl className="a-hud">
            <div><dt>NOW · {d.asOf.slice(11, 16)} UTC</dt><dd>{fmt(d.current)}<small>mg/dL {d.trend != null && d.trend > 0 ? '↑' : '→'} {d.trend != null ? fmt(d.trend) : ''}/min</small></dd></div>
            <div><dt>MEDIAN PEAK</dt><dd>{fmt(pk.p50)}<small>at +{pk.offset_min} min</small></dd></div>
            <div><dt>MEDIAN ABOVE 180</dt><dd>{hi ? `+${hi[0]}→+${hi[1]}` : 'none'}<small>min</small></dd></div>
            <div><dt>NEW-SPIKE ONSET RISK</dt><dd>{d.onset != null ? (d.onset * 100).toFixed(1) : '—'}<small>% · 2 h · calibrated on validation split</small></dd></div>
          </dl>
        </section>
        <figure className="a-figure">
          <figcaption><span className="a-subject">● {d.patient} · {d.group} · {d.ehr?.age_years} y {d.ehr?.sex} · BMI {d.ehr?.bmi} · HbA1c {d.ehr?.hba1c_pct}%</span><span>Replayed from the running backend · synthetic validation subject · 29 Sep 2026</span></figcaption>
          <div className="a-wide"><ScopeA d={d} W={1376} H={330} /></div>
          <div className="a-narrow"><ScopeA d={d} W={380} H={300} compact /></div>
          <div className="a-legend"><span><i className="k-obs" />Observed CGM, one dot per 5-min reading</span><span><i className="k-median" />Forecast median</span><span><i className="k-fan" />P25–75 · P10–90 · P05–95</span><span><i className="k-twin" />① Physiology twin</span><span><i className="k-adj" />② Learned adjustment (gap)</span><span><i className="k-thr" />180 spike level</span></div>
        </figure>
        <p className="a-boundary">Synthetic data only; not a medical device. Development-validation diagnostics, not clinical validation. The realism gate (Gate 3) failed and is published.</p>
      </main>
    </div>
  );
}

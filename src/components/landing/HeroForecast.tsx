import React from 'react';
import * as d3Scale from 'd3-scale';
import * as d3Shape from 'd3-shape';
import type { HeroForecast as HeroData, HeroPoint } from '@/lib/hero';

const W = 640;
const H = 300;
const M = { left: 48, right: 16, top: 16, bottom: 30 };
const SPIKE = 180;

const fmt = (v: number) => Number(v.toFixed(1)).toString();
const signed = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));

/** The demonstration subject's real forecast, drawn from backend output only; nothing is interpolated. */
export function HeroForecast({ data }: { data: HeroData }) {
  const anchor = Date.parse(data.asOf);
  const minutes = (t: string) => (Date.parse(t) - anchor) / 60000;
  const obs = data.observed.map(o => ({ m: minutes(o.t), v: o.v }));
  // The forecast begins at the current reading; every later point is a returned forecast step.
  const start: HeroPoint = { offset_min: 0, p10: data.current, p50: data.current, p90: data.current, twin_p50: data.current };
  const pts = [start, ...data.points];
  const values = [...obs.map(o => o.v), ...pts.flatMap(p => [p.p10, p.p90, p.twin_p50 ?? p.p50]), SPIKE];
  const yMin = Math.max(0, Math.floor((Math.min(...values) - 15) / 40) * 40);
  const yMax = Math.ceil((Math.max(...values) + 10) / 40) * 40;
  const x = d3Scale.scaleLinear().domain([-120, 120]).range([M.left, W - M.right]);
  const y = d3Scale.scaleLinear().domain([yMin, yMax]).range([H - M.bottom, M.top]);
  const band = d3Shape.area<HeroPoint>().x(p => x(p.offset_min)).y0(p => y(p.p10)).y1(p => y(p.p90));
  const median = d3Shape.line<HeroPoint>().x(p => x(p.offset_min)).y(p => y(p.p50));
  const twinPts = pts.filter(p => p.twin_p50 != null);
  const twin = d3Shape.line<HeroPoint>().x(p => x(p.offset_min)).y(p => y(p.twin_p50 as number));
  const observed = d3Shape.line<{ m: number; v: number }>().x(o => x(o.m)).y(o => y(o.v));
  const ticks = Array.from({ length: Math.floor((yMax - yMin) / 40) + 1 }, (_, i) => yMin + i * 40);
  const at60 = data.points.find(p => p.offset_min === 60);
  const peak = data.points.reduce((best, p) => (p.p50 > best.p50 ? p : best), data.points[0]);
  const time = new Date(anchor).toISOString().slice(11, 16);
  const summary = `Observed glucose for ${data.patientId} over the two hours to ${time} UTC, rising to ${fmt(data.current)} mg/dL, and the model's two-hour forecast: median peaking at ${fmt(peak.p50)} mg/dL at +${peak.offset_min} min, with its 80% band.`;

  return (
    <figure className="hero-forecast stage" data-testid="hero-forecast">
      <figcaption className="hero-forecast-head">
        <span className="hero-live"><i aria-hidden="true" />Model output · {data.patientId}</span>
        <span className="hero-when">29 Sept, {time} UTC · synthetic validation subject</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="hero-forecast-chart">
        {ticks.map(t => <g key={t}>
          <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" />
          <text x={M.left - 8} y={y(t) + 4} textAnchor="end" className="chart-axis">{t}</text>
        </g>)}
        <rect x={x(0)} y={M.top} width={x(120) - x(0)} height={H - M.bottom - M.top} fill="var(--color-surface-2)" opacity={0.55} />
        <line x1={M.left} x2={W - M.right} y1={y(SPIKE)} y2={y(SPIKE)} stroke="var(--color-amber)" strokeDasharray="5 4" strokeOpacity={0.85} />
        <text x={M.left + 6} y={y(SPIKE) - 6} className="chart-axis chart-threshold-label">180 spike level</text>
        <path d={band(pts) ?? ''} fill="var(--color-forecast)" fillOpacity={0.3} stroke="var(--color-forecast)" strokeOpacity={0.7} strokeWidth={1} />
        {twinPts.length > 1 && <path d={twin(twinPts) ?? ''} fill="none" stroke="var(--color-physics)" strokeWidth={1.75} strokeDasharray="4 4" />}
        <path d={median(pts) ?? ''} fill="none" stroke="var(--color-surface)" strokeWidth={6} strokeOpacity={0.85} />
        <path className="forecast-median-draw" pathLength={1} d={median(pts) ?? ''} fill="none" stroke="var(--color-forecast)" strokeWidth={2.75} strokeLinejoin="round" />
        <path d={observed(obs) ?? ''} fill="none" stroke="var(--color-ink)" strokeWidth={2} strokeLinejoin="round" />
        <line x1={x(0)} x2={x(0)} y1={M.top} y2={H - M.bottom} stroke="var(--color-line-control)" strokeDasharray="3 3" />
        <circle cx={x(0)} cy={y(data.current)} r={4.5} fill="var(--color-ink)" stroke="var(--color-surface)" strokeWidth={2} />
        {[-120, -60, 0, 60, 120].map(m => <text key={m} x={x(m)} y={H - 9} textAnchor={m === -120 ? 'start' : m === 120 ? 'end' : 'middle'} className="chart-axis">{m === 0 ? `now ${time}` : `${m > 0 ? '+' : '−'}${Math.abs(m) / 60} h`}</text>)}
      </svg>
      <div className="hero-forecast-legend" aria-hidden="true">
        <span><i className="lg observed" />Observed CGM</span>
        <span><i className="lg median" />Forecast median</span>
        <span><i className="lg band" />80% band</span>
        <span><i className="lg twin" />Physiology twin</span>
      </div>
      <dl className="hero-forecast-facts">
        <div><dt>Now</dt><dd>{fmt(data.current)}<small> mg/dL</small></dd></div>
        {at60 && at60.twin_p50 != null && <div className="hero-equation">
          <dt>At +60 min: twin + learned adjustment = forecast</dt>
          <dd><span className="t-twin">{fmt(at60.twin_p50)}</span> <span className="op">+</span> <span className="t-learn">{at60.p50 - at60.twin_p50 < 0 ? `(${signed(at60.p50 - at60.twin_p50)})` : signed(at60.p50 - at60.twin_p50)}</span> <span className="op">=</span> <span className="t-final">{fmt(at60.p50)}</span><small> mg/dL</small></dd>
        </div>}
        {data.probability != null && <div><dt>Spike risk, next 2 h{data.calibrated ? ' (calibrated)' : ''}</dt><dd>{(data.probability * 100).toFixed(1)}<small>%</small></dd></div>}
      </dl>
      <p className="hero-forecast-note">Replayed from the running backend; the same forecast opens in the workspace. Learned adjustment {at60 && at60.twin_p50 != null ? `at +60 min: ${signed(at60.p50 - at60.twin_p50)} mg/dL. ` : ''}Synthetic data; not clinically validated.</p>
    </figure>
  );
}

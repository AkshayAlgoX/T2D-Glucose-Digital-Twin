'use client';
import React, { useEffect, useId, useRef, useState } from 'react';
import * as d3Scale from 'd3-scale';
import * as d3Shape from 'd3-shape';
import type { HeroForecast as HeroData, HeroInput } from '@/lib/hero';
import { aboveLevel } from '@/components/digital-twin/RiskPanel';
import { AboveBars, Bands, Decomposition, Glyph, HatchDefs, MedianLine, ObservedDots, Threshold, TwinLine, Wedge, type FigPoint } from '@/components/figure/marks';

const SPIKE = 180;
const fmt = (v: number) => Number(v.toFixed(1)).toString();
const signed = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));

function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(e => { const v = e[0]?.contentRect.width; if (v && v > 0) setW(v); });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Figure 1 on the home page: the demonstration subject's real forecast, drawn from backend output only. */
export function HeroForecast({ data }: { data: HeroData }) {
  const [ref, W] = useWidth(720);
  const hatch = 'hero-hatch-' + useId().replace(/:/g, '');
  const offsets = data.points.map(p => p.offset_min);
  const [h, setH] = useState(offsets.includes(60) ? 60 : offsets[Math.floor(offsets.length / 2)]);
  const compact = W < 560;
  const anchor = Date.parse(data.asOf);
  const minutes = (t: string) => (Date.parse(t) - anchor) / 60000;
  const obs = data.observed.map(o => ({ m: minutes(o.t), v: o.v }));
  const c = data.current;
  // The forecast begins at the current reading (drawing only); every later point is a returned forecast step.
  const pts: FigPoint[] = [{ m: 0, p05: c, p10: c, p25: c, p50: c, p75: c, p90: c, p95: c, twin: c },
    ...data.points.map(p => ({ m: p.offset_min, p05: p.p05, p10: p.p10, p25: p.p25, p50: p.p50, p75: p.p75, p90: p.p90, p95: p.p95, twin: p.twin_p50 }))];
  const values = [...obs.map(o => o.v), ...pts.flatMap(p => [p.p05 ?? p.p10, p.p95 ?? p.p90, p.twin ?? p.p50]).filter((v): v is number => v != null), SPIKE];
  const yMin = Math.max(0, Math.floor((Math.min(...values) - 15) / 40) * 40);
  const yMax = Math.ceil((Math.max(...values) + 10) / 40) * 40;
  const M = { l: compact ? 62 : 84, r: compact ? 10 : 16, t: 24, b: 26 };
  const H = compact ? 240 : 320;
  const x = d3Scale.scaleLinear().domain([-120, 120]).range([M.l, W - M.r]);
  const y = d3Scale.scaleLinear().domain([yMin, yMax]).range([H - M.b, M.t]);
  const xm = (m: number) => x(m);
  const ticks = Array.from({ length: Math.floor((yMax - yMin) / 40) + 1 }, (_, i) => yMin + i * 40);
  const sel = data.points.find(p => p.offset_min === h) ?? data.points[0];
  const high = aboveLevel(data.points);
  const peak = data.points.reduce((best, p) => (p.p50 > best.p50 ? p : best), data.points[0]);
  const time = new Date(anchor).toISOString().slice(11, 16);
  const clock = (m: number) => new Date(anchor + m * 60000).toISOString().slice(11, 16);
  const summary = `Observed glucose for ${data.patientId} over the two hours to ${time} UTC, rising to ${fmt(c)} mg/dL, and the model's two-hour forecast: median peaking at ${fmt(peak.p50)} mg/dL at +${peak.offset_min} min, with its uncertainty bands. The learned adjustment is the shaded wedge between the physiology twin and the forecast median.`;
  const scrub = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const m = x.invert((e.clientX - r.left) * W / r.width);
    if (m <= 0) return;
    const nearest = offsets.reduce((b, o) => (Math.abs(o - m) < Math.abs(b - m) ? o : b), offsets[0]);
    setH(nearest);
  };
  const s = data.subject;
  const who = [data.patientId, s?.group === 'Type 2' ? 'type 2 diabetes' : s?.group?.toLowerCase(), s?.age_years != null && s?.sex ? `${s.age_years}-year-old ${s.sex}` : null].filter(Boolean).join(', ');
  const at60 = data.points.find(p => p.offset_min === h);

  return (
    <figure className="hero-figure" data-testid="hero-forecast">
      <figcaption className="fig-caption hero-caption"><b>Figure 1.</b> {who}, on 29 September at {time} UTC: observed glucose for the two hours before, and the model&apos;s forecast for the two hours after. Replayed from the running backend; synthetic {s?.split === 'val' ? 'validation-split ' : ''}subject.</figcaption>
      <div className="hero-figbody">
        <div ref={ref} className="hero-plot">
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="hero-chart" onPointerMove={scrub} onPointerDown={scrub}>
            <HatchDefs id={hatch} />
            <rect x={x(0)} y={M.t} width={x(120) - x(0)} height={H - M.b - M.t} className="fig-future" />
            {ticks.map(t => <g key={t}><line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} className="fig-grid" /><text x={M.l - 8} y={y(t) + 4} textAnchor="end" className="fig-axis">{t}</text></g>)}
            <text x={M.l - 8} y={M.t - 10} textAnchor="end" className="fig-axis">mg/dL</text>
            <Threshold x0={M.l} x1={W - M.r} y={y} label={compact ? '180 spike level' : '180 mg/dL spike level'} />
            <Bands pts={pts} x={xm} y={y} testIds={false} />
            <Wedge pts={pts} x={xm} y={y} hatch={hatch} />
            <TwinLine pts={pts} x={xm} y={y} />
            <MedianLine pts={pts} x={xm} y={y} testId="hero-median" />
            <ObservedDots obs={obs} x={xm} y={y} r={compact ? 2 : 2.5} />
            <line x1={x(0)} x2={x(0)} y1={M.t - 8} y2={H - M.b} className="fig-now" />
            <text x={x(0) - 6} y={M.t - 12} textAnchor="end" className="fig-era">observed</text>
            <text x={x(0) + 6} y={M.t - 12} className="fig-era">forecast</text>
            <circle cx={x(0)} cy={y(c)} r={4.5} className="fig-current" />
            <line x1={x(h)} x2={x(h)} y1={M.t} y2={H - M.b} className="fig-scrub" />
            <Decomposition m={h} twin={sel.twin_p50} p50={sel.p50} x={xm} y={y} compact={compact} />
            {[-120, -60, 0, 60, 120].map(m => <text key={m} x={x(m)} y={H - 7} textAnchor={m === -120 ? 'start' : m === 120 ? 'end' : 'middle'} className={m === 0 ? 'fig-axis fig-axis-now' : 'fig-axis'}>{m === 0 ? time : `${m > 0 ? '+' : '−'}${Math.abs(m) / 60} h`}</text>)}
          </svg>
          <svg width={W} height={40} viewBox={`0 0 ${W} 40`} aria-hidden="true" className="hero-above">
            <AboveBars pts={pts.slice(1)} x={xm} x0={x(0)} x1={W - M.r} top={1} row={12} labels={false} />
            {(compact ? ['High case >180', 'Median >180', 'Low case >180'] : ['High case (P90) above 180', 'Median above 180', 'Low case (P10) above 180']).map((l, i) => <text key={l} x={x(0) - 8} y={1 + i * 12 + 9.5} textAnchor="end" className="fig-above-label">{l}</text>)}
          </svg>
          <div className="fig-legend hero-legend" aria-hidden="true">
        <span><Glyph kind="obs" />Observed CGM, one dot per reading</span>
        <span><Glyph kind="median" />Forecast median</span>
        <span><Glyph kind="bands" />50 · 80 · 90% bands</span>
        <span><Glyph kind="twin" />Physiology twin</span>
        <span><Glyph kind="wedge" />Learned adjustment</span>
        <span><Glyph kind="threshold" />180 mg/dL</span>
          </div>
          {data.inputs && data.inputs.length > 1 && <HeroLanes inputs={data.inputs} x={xm} anchor={anchor} W={W} l={M.l} r={M.r} compact={compact} />}
        </div>
        <aside className="hero-margin">
          <p className="hero-now"><span>Now · {time} UTC</span><strong className="num">{fmt(c)}</strong> <small>mg/dL</small></p>
          <dl className="hero-equation"><div>
            <dt>At +{h} min: physiology twin + learned adjustment = forecast</dt>
            <dd>{sel.twin_p50 != null
              ? <><span className="t-twin">{fmt(sel.twin_p50)}</span> <span className="op">+</span> <span className="t-learn">{sel.p50 - sel.twin_p50 < 0 ? `(${signed(sel.p50 - sel.twin_p50)})` : signed(sel.p50 - sel.twin_p50)}</span> <span className="op">=</span> <span className="t-final">{fmt(sel.p50)}</span><small> mg/dL</small></>
              : <><span className="t-final">{fmt(sel.p50)}</span><small> mg/dL · twin value not returned</small></>}</dd>
          </div></dl>
          <ol className="fig-notes hero-notes">
            <li className="n-twin"><b className="n">1</b><span><strong>Physiology twin.</strong> Glucose–insulin equations fitted to this patient.</span></li>
            <li className="n-adj"><b className="n">2</b><span><strong>Learned adjustment.</strong> A network trained on what the equations miss.</span></li>
            <li className="n-final"><b className="n">3</b><span><strong>Forecast</strong>{at60 ? <>, 80% interval <span className="val">{fmt(at60.p10)}–{fmt(at60.p90)}</span> at {clock(h)} UTC</> : null}.</span></li>
          </ol>
          <label className="hero-scrub">
            <span>Horizon <b className="num">+{h} min</b></span>
            <input type="range" min={offsets[0]} max={offsets[offsets.length - 1]} step={offsets.length > 1 ? offsets[1] - offsets[0] : 5} value={h} onChange={e => setH(Number(e.target.value))} aria-label="Forecast horizon in minutes" aria-valuetext={`+${h} minutes`} />
          </label>
          <p className="hero-high" data-testid="hero-high-window">{high.median
            ? `Median above 180 ${high.median[0] === high.median[1] ? `at +${high.median[0]} min` : `from +${high.median[0]} to +${high.median[1]} min`}`
            : high.upper ? 'Median below 180; upper band reaches it' : 'Below 180 across the 80% band'}</p>
          {data.probability != null && <p className="hero-onset" data-testid="hero-onset">New-spike onset risk, next 2 h: <strong className="num">{(data.probability * 100).toFixed(1)}%</strong>{data.calibrated ? <span> · a separate classifier, calibrated on the validation split</span> : null}</p>}
          {data.probability != null && high.lower && data.probability < 0.9 && <p className="hero-disagree" data-testid="hero-disagree"><strong>The two models disagree.</strong> The forecast&apos;s lower 10% bound is above 180 {high.lower[0] === high.lower[1] ? `at +${high.lower[0]} min` : `from +${high.lower[0]} to +${high.lower[1]} min`}, so the trajectory puts at least 90% of its range above 180 then; the onset classifier is more cautious. Neither is validated in people.</p>}
        </aside>
      </div>
    </figure>
  );
}

/** Observed wearable and log inputs, history only, on the figure's time axis; the forecast half stays empty. */
function HeroLanes({ inputs, x, anchor, W, l, r, compact }: { inputs: HeroInput[]; x: (m: number) => number; anchor: number; W: number; l: number; r: number; compact: boolean }) {
  const rows = inputs.map(i => ({ ...i, m: (Date.parse(i.t) - anchor) / 60000 })).filter(i => i.m >= -120 && i.m <= 0);
  if (rows.length < 2) return null;
  const h = compact ? 18 : 22;
  const gap = 4;
  const last = rows[rows.length - 1];
  const step = Math.max(1.5, x(5) - x(0));
  const line = (pick: (i: (typeof rows)[number]) => number | null) => {
    const vs = rows.map(pick).filter((v): v is number => v != null);
    if (vs.length < 2) return null;
    const lo = Math.min(...vs), hi = Math.max(...vs);
    const yy = d3Scale.scaleLinear().domain(lo === hi ? [lo - 1, hi + 1] : [lo, hi]).range([h - 3, 3]);
    return d3Shape.line<(typeof rows)[number]>().defined(i => pick(i) != null).x(i => x(i.m)).y(i => yy(pick(i)!))(rows) ?? '';
  };
  const maxSteps = Math.max(40, ...rows.map(i => i.steps ?? 0));
  const meals = rows.filter(i => (i.carbs ?? 0) > 0);
  const totalSteps = Math.round(rows.reduce((t, i) => t + (i.steps ?? 0), 0));
  const hr = line(i => i.hr);
  const hrv = line(i => i.hrv);
  const mid = (x(-120) + x(0)) / 2;
  const lanes: Array<[string, string, React.ReactNode]> = [
    [compact ? 'Meal' : 'Meal log', meals.length ? `${Math.round(meals[meals.length - 1].carbs!)} g` : 'none',
      meals.length ? meals.map(i => <g key={i.t}><rect x={x(i.m) - 2} y={2} width={4} height={h - 4} className="lane-meal" />{!compact && <text x={x(i.m) - 6} y={h - 6} textAnchor="end" className="lane-note">{Math.round(i.carbs!)} g carbohydrate, {new Date(Date.parse(i.t)).toISOString().slice(11, 16)}</text>}</g>)
        : <text x={mid} y={h - 6} textAnchor="middle" className="lane-empty">No meal logged in this window</text>],
    ['Steps', last.steps != null ? `${Math.round(last.steps)} per 5 min` : '—', totalSteps > 0 ? rows.filter(i => (i.steps ?? 0) > 0).map(i => { const bh = Math.max(2, ((i.steps ?? 0) / maxSteps) * (h - 3)); const a = x(i.m) - step * 0.35; return <rect key={i.t} x={a} width={Math.max(1.5, Math.min(step * 0.7, x(0) - 1 - a))} y={h - bh} height={bh} className="lane-steps" />; })
      : <text x={mid} y={h - 6} textAnchor="middle" className="lane-empty">0 steps recorded</text>],
    [compact ? 'HR' : 'Heart rate', last.hr != null ? `${Math.round(last.hr)} bpm` : '—', hr ? <path d={hr} className="lane-line" /> : <text x={mid} y={h - 6} textAnchor="middle" className="lane-empty">No readings received</text>],
    ['HRV', last.hrv != null ? `${Math.round(last.hrv)} ms` : '—', hrv ? <path d={hrv} className="lane-line" /> : <text x={mid} y={h - 6} textAnchor="middle" className="lane-empty">No readings received</text>],
    ['Sleep', last.asleep == null ? '—' : last.asleep ? 'Asleep' : 'Awake', rows.filter(i => i.asleep).map(i => {
      const a = Math.max(l, x(i.m) - step / 2), b = Math.min(x(0) - 1, x(i.m) + step / 2);
      return <rect key={i.t} x={a} width={Math.max(0, b - a)} y={4} height={h - 8} className="lane-sleep" />;
    })],
  ];
  const total = lanes.length * (h + gap);
  return (<>
    <p className="lanes-head"><span>Wearable and log inputs the model read</span><span>Observed only · latest at {new Date(Date.parse(last.t)).toISOString().slice(11, 16)} UTC · nothing is observed after now</span></p>
    <svg width={W} height={total} viewBox={`0 0 ${W} ${total}`} aria-hidden="true" className="hero-lanes">
      {lanes.map(([label, latest, node], i) => <g key={label} transform={`translate(0 ${i * (h + gap)})`}>
        <line x1={l} x2={x(0)} y1={h - 0.5} y2={h - 0.5} className="lane-base" />
        <text x={l - 8} y={h / 2 + 4} textAnchor="end" className="lane-label">{label}</text>
        {node}
        <line x1={x(0)} x2={x(0)} y1={-gap} y2={h} className="fig-now" />
        <text x={x(0) + 8} y={h / 2 + 4} className="lane-latest">{latest}</text>
      </g>)}
    </svg>
  </>);
}

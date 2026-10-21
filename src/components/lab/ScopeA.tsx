import React from 'react';
import type { LabData } from '@/lib/lab-data';
import { geom, fmt, signed, at, laneSeries, laneRows } from './geom';

/** Direction A: a precision scope. Every 5-min reading is a mark; the future is a fan; the learned adjustment is the gap. */
export function ScopeA({ d, W, H, from = -120, lanes = true, compact = false }: { d: LabData; W: number; H: number; from?: number; lanes?: boolean; compact?: boolean }) {
  const M = { l: compact ? 34 : 46, r: compact ? 10 : 132, t: 26, b: 30 };
  const g = geom(d, W, H, M, from, 120);
  const h60 = at(d, 60);
  const time = new Date(Date.parse(d.asOf)).toISOString().slice(11, 16);
  const minor = Array.from({ length: (120 - from) / 5 + 1 }, (_, i) => from + i * 5);
  const laneH = compact ? 20 : 26;
  const rows = laneRows(d, from);
  const hr = laneSeries(d, g.x, from, laneH, 'hr');
  const hrv = laneSeries(d, g.x, from, laneH, 'hrv');
  const maxSteps = Math.max(40, ...rows.map(r => r.steps ?? 0));
  const meals = rows.filter(r => (r.carbs ?? 0) > 0);
  const stepPx = g.x(5) - g.x(0);
  const laneDefs: Array<[string, string, React.ReactNode]> = [
    ['MEAL', meals.length ? `${meals.length} logged` : 'none logged', meals.length
      ? meals.map(r => <g key={r.t}><line x1={g.x(r.m)} x2={g.x(r.m)} y1={3} y2={laneH} className="a-meal" /><text x={g.x(r.m) + 4} y={11} className="a-lane-v">{Math.round(r.carbs!)} g</text></g>)
      : <text x={(g.x(from) + g.x(0)) / 2} y={laneH / 2 + 4} textAnchor="middle" className="a-lane-empty">no meal logged in this window</text>],
    ['STEPS', `${rows.at(-1)?.steps ?? '—'} /5 min`, rows.some(r => (r.steps ?? 0) > 0)
      ? rows.filter(r => (r.steps ?? 0) > 0).map(r => { const bh = Math.max(2, ((r.steps ?? 0) / maxSteps) * (laneH - 4)); return <rect key={r.t} x={g.x(r.m) - stepPx * 0.35} width={Math.max(1.5, stepPx * 0.7)} y={laneH - bh} height={bh} className="a-steps" />; })
      : <text x={(g.x(from) + g.x(0)) / 2} y={laneH / 2 + 4} textAnchor="middle" className="a-lane-empty">0 steps recorded</text>],
    ['HR', hr ? `${fmt(hr.last)} bpm` : '—', hr ? <path d={hr.path} className="a-hr" /> : null],
    ['HRV', hrv ? `${fmt(hrv.last)} ms` : '—', hrv ? <path d={hrv.path} className="a-hrv" /> : null],
    ['SLEEP', rows.at(-1)?.asleep ? 'asleep' : 'awake', rows.filter(r => r.asleep).map(r => <rect key={r.t} x={Math.max(M.l, g.x(r.m) - stepPx / 2)} width={Math.min(g.x(0), g.x(r.m) + stepPx / 2) - Math.max(M.l, g.x(r.m) - stepPx / 2)} y={5} height={laneH - 10} className="a-sleep" />)],
  ];
  const lanesH = lanes ? laneDefs.length * (laneH + 6) + 6 : 0;
  const total = H + lanesH;
  const summary = `Observed glucose for ${d.patient} over the ${-from / 60} hours to ${time} UTC and the two-hour forecast with its quantile fan, physiology twin and learned adjustment.`;

  return (
    <svg viewBox={`0 0 ${W} ${total}`} className="a-scope" role="img" aria-label={summary}>
      <defs>
        <pattern id={`a-hatch-${W}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" className="a-hatch" /></pattern>
      </defs>
      {/* graticule */}
      <rect x={g.x(0)} y={M.t} width={g.x(120) - g.x(0)} height={H - M.t - M.b} className="a-future" />
      <rect x={M.l} y={g.y(180)} width={W - M.r - M.l} height={g.y(70) - g.y(180)} className="a-range" />
      {g.yTicks.map(t => <g key={t}><line x1={M.l} x2={W - M.r} y1={g.y(t)} y2={g.y(t)} className="a-grid" /><text x={M.l - 8} y={g.y(t) + 3.5} textAnchor="end" className="a-axis">{t}</text></g>)}
      {minor.map(m => <line key={m} x1={g.x(m)} x2={g.x(m)} y1={H - M.b} y2={H - M.b + (m % 30 === 0 ? 7 : 3)} className={m % 30 === 0 ? 'a-tick-major' : 'a-tick'} />)}
      {minor.filter(m => m % (compact ? 60 : 30) === 0).map(m => <text key={m} x={g.x(m)} y={H - M.b + 19} textAnchor={m === from ? 'start' : m === 120 ? 'end' : 'middle'} className={m === 0 ? 'a-axis a-axis-now' : 'a-axis'}>{m === 0 ? time : `${m > 0 ? '+' : '−'}${Math.abs(m)}`}</text>)}
      <line x1={M.l} x2={W - M.r} y1={g.y(180)} y2={g.y(180)} className="a-threshold" />
      <text x={M.l + 6} y={g.y(180) - 6} className="a-threshold-label">180 spike level</text>
      {!compact && <text x={M.l + 6} y={g.y(70) - 6} className="a-range-label">70–180 target range</text>}
      {/* fan */}
      <path d={g.band('p05', 'p95')} className="a-fan a-fan-1" />
      <path d={g.band('p10', 'p90')} className="a-fan a-fan-2" />
      <path d={g.band('p25', 'p75')} className="a-fan a-fan-3" />
      {/* the learned adjustment is the gap between twin and forecast */}
      <path d={g.ribbon} className="a-ribbon" fill={`url(#a-hatch-${W})`} />
      <path d={g.twin} className="a-twin" />
      <path d={g.median} className="a-median" />
      {/* observations: one mark per reading */}
      <path d={g.observed} className="a-obs-line" />
      {g.obs.map(o => <circle key={o.m} cx={g.x(o.m)} cy={g.y(o.v)} r={compact ? 1.6 : 2.1} className="a-obs" />)}
      {/* now */}
      <line x1={g.x(0)} x2={g.x(0)} y1={8} y2={H - M.b} className="a-now" />
      <text x={g.x(0) + 6} y={17} className="a-now-label">{compact ? `NOW ${time}` : `T₀ · NOW ${time} UTC`}</text>
      {!compact && <text x={g.x(0) - 6} y={17} textAnchor="end" className="a-era">OBSERVED</text>}
      {!compact && <text x={g.x(120) - 2} y={17} textAnchor="end" className="a-era">FORECAST →</text>}
      <circle cx={g.x(0)} cy={g.y(d.current)} r={4.5} className="a-current" />
      {/* decomposition gauge at +60 */}
      {h60 && h60.twin != null && <g className="a-gauge">
        <line x1={g.x(60)} x2={g.x(60)} y1={M.t} y2={H - M.b} className="a-gauge-line" />
        <circle cx={g.x(60)} cy={g.y(h60.twin)} r={4} className="a-gauge-twin" />
        <circle cx={g.x(60)} cy={g.y(h60.p50)} r={4.5} className="a-gauge-final" />
        {!compact && <>
          <text x={W - M.r + 10} y={g.y(h60.twin) + 4} className="a-callout a-callout-twin">① twin {fmt(h60.twin)}</text>
          <text x={W - M.r + 10} y={(g.y(h60.twin) + g.y(h60.p50)) / 2 + 9} className="a-callout a-callout-adj">② {signed(h60.p50 - h60.twin)}</text>
          <text x={W - M.r + 10} y={g.y(h60.p50) + 18} className="a-callout a-callout-final">③ = {fmt(h60.p50)}</text>
          <text x={W - M.r + 10} y={g.y(h60.p50) + 33} className="a-callout-sub">at +60 min, mg/dL</text>
        </>}
      </g>}
      {/* input strips share the scope's time axis */}
      {lanes && <g transform={`translate(0 ${H + 4})`}>
        {laneDefs.map(([label, latest, node], i) => <g key={label} transform={`translate(0 ${i * (laneH + 6)})`}>
          <rect x={M.l} y={0} width={g.x(0) - M.l} height={laneH} className="a-lane-bg" />
          <rect x={g.x(0)} y={0} width={g.x(120) - g.x(0)} height={laneH} fill={`url(#a-hatch-${W})`} className="a-lane-future" />
          <text x={M.l - 8} y={laneH / 2 + 4} textAnchor="end" className="a-lane-label">{label}</text>
          {node}
          {!compact && <text x={W - M.r + 10} y={laneH / 2 + 4} className="a-lane-v">{latest}</text>}
          <line x1={g.x(0)} x2={g.x(0)} y1={-6} y2={laneH} className="a-now a-now-lane" />
        </g>)}
      </g>}
    </svg>
  );
}

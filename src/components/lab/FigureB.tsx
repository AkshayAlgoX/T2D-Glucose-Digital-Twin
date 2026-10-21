import React from 'react';
import type { LabData } from '@/lib/lab-data';
import { geom, fmt, signed, at, laneSeries, laneRows } from './geom';

/** Direction B: a scientific figure with numbered annotations set directly on the data. */
export function FigureB({ d, W, H, compact = false, from = -120 }: { d: LabData; W: number; H: number; compact?: boolean; from?: number }) {
  const M = { l: compact ? 32 : 44, r: compact ? 8 : 16, t: 18, b: 28 };
  const g = geom(d, W, H, M, from, 120);
  const h60 = at(d, 60)!;
  const time = d.asOf.slice(11, 16);
  const ticks = Array.from({ length: (120 - from) / 30 + 1 }, (_, i) => from + i * 30);
  const mark = (n: string, cx: number, cy: number, cls: string, dx = 14, dy = -14) => (
    <g className={`b-mark ${cls}`}><line x1={cx} y1={cy} x2={cx + dx * 0.7} y2={cy + dy * 0.7} /><circle cx={cx + dx} cy={cy + dy} r={9} /><text x={cx + dx} y={cy + dy + 4} textAnchor="middle">{n}</text></g>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="b-fig" role="img" aria-label={`Figure: observed glucose for ${d.patient} to ${time} UTC and the two-hour forecast, with the physiology twin and the learned adjustment annotated at +60 min.`}>
      {g.yTicks.map(t => <g key={t}><line x1={M.l} x2={W - M.r} y1={g.y(t)} y2={g.y(t)} className="b-grid" /><text x={M.l - 7} y={g.y(t) + 4} textAnchor="end" className="b-axis">{t}</text></g>)}
      {ticks.filter(m => !compact || m % 60 === 0).map(m => <text key={m} x={g.x(m)} y={H - 8} textAnchor={m === from ? 'start' : m === 120 ? 'end' : 'middle'} className={m === 0 ? 'b-axis b-axis-now' : 'b-axis'}>{m === 0 ? `${time}` : `${m > 0 ? '+' : '−'}${Math.abs(m) / 60} h`}</text>)}
      <line x1={M.l} x2={W - M.r} y1={g.y(180)} y2={g.y(180)} className="b-thr" />
      <text x={M.l + 6} y={g.y(180) - 6} className="b-thr-label">180 mg/dL spike level</text>
      <path d={g.band('p10', 'p90')} className="b-band" />
      <path d={g.ribbon} className="b-ribbon" />
      <path d={g.twin} className="b-twin" />
      <path d={g.median} className="b-median" />
      <path d={g.observed} className="b-obs" />
      <line x1={g.x(0)} x2={g.x(0)} y1={M.t - 6} y2={H - M.b} className="b-now" />
      <text x={g.x(0) - 6} y={M.t} textAnchor="end" className="b-era">observed</text>
      <text x={g.x(0) + 6} y={M.t} className="b-era">forecast</text>
      <circle cx={g.x(0)} cy={g.y(d.current)} r={4} className="b-dot" />
      <line x1={g.x(60)} x2={g.x(60)} y1={g.y(h60.twin!)} y2={g.y(h60.p50)} className="b-gap" />
      {mark('1', g.x(60), g.y(h60.twin!), 'm-twin', compact ? 14 : 18, compact ? -16 : -20)}
      {mark('2', g.x(60), (g.y(h60.twin!) + g.y(h60.p50)) / 2, 'm-adj', compact ? 18 : 26, 0)}
      {mark('3', g.x(60), g.y(h60.p50), 'm-final', compact ? 14 : 18, compact ? 18 : 22)}
    </svg>
  );
}

export function LanesB({ d, W, compact = false, from = -120 }: { d: LabData; W: number; compact?: boolean; from?: number }) {
  const M = { l: compact ? 32 : 44, r: compact ? 8 : 16, t: 0, b: 0 };
  const g = geom(d, W, 100, M, from, 120);
  const rows = laneRows(d, from);
  const h = 22;
  const hr = laneSeries(d, g.x, from, h, 'hr');
  const hrv = laneSeries(d, g.x, from, h, 'hrv');
  const maxSteps = Math.max(40, ...rows.map(r => r.steps ?? 0));
  const meals = rows.filter(r => (r.carbs ?? 0) > 0);
  const lanes: Array<[string, React.ReactNode]> = [
    ['Meals', meals.length ? meals.map(r => <g key={r.t}><rect x={g.x(r.m) - 2} y={2} width={4} height={h - 4} className="b-meal" /><text x={g.x(r.m) - 6} y={h - 6} textAnchor="end" className="b-lane-v">{Math.round(r.carbs!)} g carbohydrate</text></g>) : <text x={M.l} y={h - 6} className="b-lane-e">No meal logged</text>],
    ['Steps', rows.some(r => (r.steps ?? 0) > 0) ? rows.filter(r => (r.steps ?? 0) > 0).map(r => { const bh = Math.max(2, ((r.steps ?? 0) / maxSteps) * (h - 2)); return <rect key={r.t} x={g.x(r.m) - 2} width={3.5} y={h - bh} height={bh} className="b-steps" />; }) : <text x={M.l} y={h - 6} className="b-lane-e">0 steps recorded</text>],
    ['Heart rate', hr ? <path d={hr.path} className="b-line" /> : null],
    ['HRV', hrv ? <path d={hrv.path} className="b-line" /> : null],
  ];
  return (
    <div className="b-lanes">
      {lanes.map(([label, node]) => <div key={label} className="b-lane"><span>{label}</span><svg viewBox={`0 0 ${W} ${h}`} aria-hidden="true"><line x1={M.l} x2={g.x(0)} y1={h - .5} y2={h - .5} className="b-lane-base" /><line x1={g.x(0)} x2={g.x(0)} y1={0} y2={h} className="b-now" /><text x={g.x(0) + 8} y={h - 6} className="b-lane-label">{label}</text>{node}</svg></div>)}
    </div>
  );
}

export function NotesB({ d }: { d: LabData }) {
  const h60 = at(d, 60)!;
  return (
    <ol className="b-notes">
      <li className="n-twin"><b>1</b><p><strong>Physiology twin, {fmt(h60.twin!)} mg/dL.</strong> Glucose–insulin equations fitted to this patient predict the shape of the rise.</p></li>
      <li className="n-adj"><b>2</b><p><strong>Learned adjustment, {signed(h60.p50 - h60.twin!)} mg/dL.</strong> A network trained on what the equations miss lowers the peak.</p></li>
      <li className="n-final"><b>3</b><p><strong>Forecast, {fmt(h60.p50)} mg/dL</strong> at +60 min, 80% interval {fmt(h60.p10)}–{fmt(h60.p90)}.</p></li>
    </ol>
  );
}

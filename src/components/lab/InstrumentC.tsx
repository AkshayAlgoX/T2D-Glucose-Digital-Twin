'use client';
import React, { useId, useState } from 'react';
import type { LabData } from '@/lib/lab-data';
import { geom, fmt, signed, laneRows } from './geom';

/** Direction C: a scrubbable forecast instrument. The selected horizon drives the decomposition readout. */
export function InstrumentC({ d, W, H, compact = false }: { d: LabData; W: number; H: number; compact?: boolean }) {
  const [h, setH] = useState(60);
  const id = useId().replace(/:/g, '');
  const M = { l: compact ? 34 : 44, r: compact ? 10 : 18, t: 16, b: 28 };
  const g = geom(d, W, H, M, -120, 120);
  const p = d.points.find(q => q.offset_min === h) ?? d.points[11];
  const time = d.asOf.slice(11, 16);
  const clock = new Date(Date.parse(d.asOf) + h * 60000).toISOString().slice(11, 16);
  const pick = (clientX: number, rect: DOMRect) => {
    const m = ((clientX - rect.left) / rect.width * W - M.l) / (W - M.l - M.r) * 240 - 120;
    setH(Math.max(5, Math.min(120, Math.round(m / 5) * 5)));
  };
  const rows = laneRows(d, -120);
  const meals = rows.filter(r => (r.carbs ?? 0) > 0);
  const tracks: Array<['p90' | 'p50' | 'p10', string]> = [['p90', 'Upper 10%'], ['p50', 'Median'], ['p10', 'Lower 10%']];
  return (
    <div className="c-inst">
      <div className="c-readout" aria-live="polite">
        <div className="c-at"><span>At</span><strong>+{h} min</strong><small>{clock} UTC</small></div>
        <div className="c-eq">
          <div className="c-term twin"><span>Physiology twin</span><strong>{p.twin != null ? fmt(p.twin) : '—'}</strong></div>
          <i aria-hidden="true">+</i>
          <div className="c-term adj"><span>Learned adjustment</span><strong>{p.twin != null ? signed(p.p50 - p.twin) : '—'}</strong></div>
          <i aria-hidden="true">=</i>
          <div className="c-term fc"><span>Forecast</span><strong>{fmt(p.p50)}</strong><small>80% {fmt(p.p10)}–{fmt(p.p90)}</small></div>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="c-chart" role="slider" tabIndex={0} aria-label="Forecast horizon" aria-valuemin={5} aria-valuemax={120} aria-valuenow={h} aria-valuetext={`+${h} min: forecast ${fmt(p.p50)} mg/dL`}
        onPointerMove={e => e.buttons && pick(e.clientX, e.currentTarget.getBoundingClientRect())}
        onPointerDown={e => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
        onKeyDown={e => { if (e.key === 'ArrowRight') setH(v => Math.min(120, v + 5)); if (e.key === 'ArrowLeft') setH(v => Math.max(5, v - 5)); }}>
        <defs><clipPath id={`hi-${id}`}><rect x={0} y={0} width={W} height={g.y(180)} /></clipPath></defs>
        {g.yTicks.map(t => <g key={t}><line x1={M.l} x2={W - M.r} y1={g.y(t)} y2={g.y(t)} className="c-grid" /><text x={M.l - 8} y={g.y(t) + 4} textAnchor="end" className="c-axis">{t}</text></g>)}
        {[-120, -60, 0, 60, 120].map(m => <text key={m} x={g.x(m)} y={H - 8} textAnchor={m === -120 ? 'start' : m === 120 ? 'end' : 'middle'} className={m === 0 ? 'c-axis c-axis-now' : 'c-axis'}>{m === 0 ? `Now ${time}` : `${m > 0 ? '+' : '−'}${Math.abs(m) / 60} h`}</text>)}
        <path d={g.band('p10', 'p90')} className="c-band" />
        <path d={g.band('p10', 'p90')} className="c-band-hi" clipPath={`url(#hi-${id})`} />
        <line x1={M.l} x2={W - M.r} y1={g.y(180)} y2={g.y(180)} className="c-thr" />
        <text x={M.l + 6} y={g.y(180) - 6} className="c-thr-label">180 mg/dL</text>
        <path d={g.ribbon} className="c-ribbon" />
        <path d={g.twin} className="c-twin" />
        <path d={g.median} className="c-median" />
        <path d={g.observed} className="c-obs" />
        <circle cx={g.x(0)} cy={g.y(d.current)} r={5} className="c-now-dot" />
        <line x1={g.x(h)} x2={g.x(h)} y1={M.t} y2={H - M.b} className="c-cursor" />
        {p.twin != null && <circle cx={g.x(h)} cy={g.y(p.twin)} r={4.5} className="c-dot-twin" />}
        <circle cx={g.x(h)} cy={g.y(p.p50)} r={6} className="c-dot-fc" />
        <rect x={g.x(h) - 22} y={M.t - 2} width={44} height={18} rx={9} className="c-chip" />
        <text x={g.x(h)} y={M.t + 11} textAnchor="middle" className="c-chip-t">+{h}</text>
      </svg>
      <div className="c-tracks" aria-label="When each forecast bound is above 180 mg/dL">
        <div className="c-tracks-head"><span>Above 180 mg/dL in the next 2 h</span><span>{meals.length ? `Logged meal: ${Math.round(meals[0].carbs!)} g at ${meals[0].t.slice(11, 16)}` : 'No meal logged'} · steps last 2 h: {Math.round(rows.reduce((t, r) => t + (r.steps ?? 0), 0))}</span></div>
        {tracks.map(([k, label]) => {
          const segs = d.points.filter(q => q[k] > 180);
          return <div key={k} className="c-track"><span>{label}</span><svg viewBox={`0 0 240 10`} preserveAspectRatio="none" aria-hidden="true"><rect x={0} y={3} width={240} height={4} rx={2} className="c-track-bg" />{segs.map(q => <rect key={q.offset_min} x={(q.offset_min - 5) * 2} y={1} width={10.4} height={8} className={`c-track-on ${k}`} />)}</svg><b>{segs.length ? `+${segs[0].offset_min}→+${segs[segs.length - 1].offset_min} min` : 'never'}</b></div>;
        })}
      </div>
    </div>
  );
}

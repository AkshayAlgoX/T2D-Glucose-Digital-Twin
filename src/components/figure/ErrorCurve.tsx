import React from 'react';
import * as d3Scale from 'd3-scale';
import * as d3Shape from 'd3-shape';
import { Glyph, HatchDefs } from './marks';
import type { LandingEvidence } from '@/lib/landing';

type Progression = NonNullable<LandingEvidence['progression']>;

/**
 * Forecast error (RMSE) at every horizon, in the product's grammar: the hybrid forecast is the blue line, the
 * physiology twin alone the rust dashed line, and the hatched teal wedge between them is the error the learned
 * adjustment removes. Persistence is the grey reference. Values come from the evaluation artifact only.
 */
export function ErrorCurve({ data, id, compact = false }: { data: Progression; id: string; compact?: boolean }) {
  const W = compact ? 360 : 760, H = compact ? 230 : 280;
  const M = { l: 40, r: compact ? 12 : 104, t: 14, b: 30 };
  const rows = data.offsets.map((m, i) => ({ m, h: data.hybrid[i], t: data.twin[i], p: data.persistence[i] }));
  const yMax = Math.ceil(Math.max(...rows.flatMap(r => [r.h, r.t, r.p])) / 10) * 10;
  const x = d3Scale.scaleLinear().domain([0, 120]).range([M.l, W - M.r]);
  const y = d3Scale.scaleLinear().domain([0, yMax]).range([H - M.b, M.t]);
  type R = (typeof rows)[number];
  const line = (k: 'h' | 't' | 'p') => d3Shape.line<R>().x(r => x(r.m)).y(r => y(r[k]))(rows) ?? '';
  const wedge = d3Shape.area<R>().x(r => x(r.m)).y0(r => y(r.t)).y1(r => y(r.h))(rows) ?? '';
  const last = rows[rows.length - 1];
  const at = (m: number) => rows.find(r => r.m === m);
  const r60 = at(60);
  const label = `Forecast error (RMSE, mg/dL) at every horizon from ${rows[0].m} to ${last.m} min on the synthetic validation split: hybrid ${last.h.toFixed(1)}, physiology twin alone ${last.t.toFixed(1)}, persistence ${last.p.toFixed(1)} at ${last.m} min${r60 ? `; at 60 min ${r60.h.toFixed(1)}, ${r60.t.toFixed(1)} and ${r60.p.toFixed(1)}` : ''}. The shaded wedge between the twin and the hybrid is the error the learned adjustment removes.`;
  const ticks = Array.from({ length: yMax / 10 + 1 }, (_, i) => i * 10);
  return (
    <figure className="error-curve" data-testid="error-curve">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <HatchDefs id={id} />
        {ticks.map(t => <g key={t}><line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} className="fig-grid" /><text x={M.l - 8} y={y(t) + 4} textAnchor="end" className="fig-axis">{t}</text></g>)}
        {(compact ? [0, 60, 120] : [0, 30, 60, 90, 120]).map(m => <text key={m} x={x(m)} y={H - 8} textAnchor={m === 0 ? 'start' : m === 120 ? 'end' : 'middle'} className="fig-axis">{m === 0 ? 'now' : `+${m} min`}</text>)}
        <path d={wedge} fill={`url(#${id})`} className="fig-wedge" />
        <path d={line('p')} className="fig-ghost" />
        <path d={line('t')} className="fig-halo" /><path d={line('t')} className="fig-twin" />
        <path d={line('h')} className="fig-halo" /><path d={line('h')} className="fig-median" />
        {!compact && <g className="error-curve-labels">
          <text x={W - M.r + 8} y={y(last.p) + 4} className="lbl-base">Persistence {last.p.toFixed(1)}</text>
          <text x={W - M.r + 8} y={y(last.t) - 2} className="lbl-twin">Twin alone {last.t.toFixed(1)}</text>
          <text x={W - M.r + 8} y={y(last.h) + 12} className="lbl-scen">Hybrid {last.h.toFixed(1)}</text>
        </g>}
        <text x={M.l + 4} y={M.t + 10} className="fig-axis">RMSE, mg/dL</text>
      </svg>
      <figcaption className="fig-legend error-curve-legend">
        <span><Glyph kind="median" />Hybrid: twin + learned adjustment{compact ? ` · ${last.h.toFixed(1)} at +${last.m} min` : ''}</span>
        <span><Glyph kind="twin" />Physiology twin alone{compact ? ` · ${last.t.toFixed(1)}` : ''}</span>
        <span><Glyph kind="wedge" />Error the learned adjustment removes</span>
        <span><Glyph kind="ghost" />Persistence (glucose stays flat){compact ? ` · ${last.p.toFixed(1)}` : ''}</span>
      </figcaption>
    </figure>
  );
}

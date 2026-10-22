import React from 'react';
import * as d3Scale from 'd3-scale';
import type { HeroForecast } from '@/lib/hero';
import { Bands, HatchDefs, MedianLine, ObservedDots, Threshold, TwinLine, Wedge, type FigPoint } from './marks';

/** A thumbnail of the forecast figure in the same grammar; nothing drawn that the backend did not return. */
export function MiniTwin({ data, id }: { data: HeroForecast; id: string }) {
  const W = 320, H = 120, M = { l: 6, r: 6, t: 8, b: 8 };
  const anchor = Date.parse(data.asOf);
  const obs = data.observed.map(o => ({ m: (Date.parse(o.t) - anchor) / 60000, v: o.v }));
  const c = data.current;
  const pts: FigPoint[] = [{ m: 0, p05: c, p10: c, p25: c, p50: c, p75: c, p90: c, p95: c, twin: c },
    ...data.points.map(p => ({ m: p.offset_min, p05: p.p05, p10: p.p10, p25: p.p25, p50: p.p50, p75: p.p75, p90: p.p90, p95: p.p95, twin: p.twin_p50 }))];
  const vals = [...obs.map(o => o.v), ...pts.flatMap(p => [p.p05 ?? p.p10, p.p95 ?? p.p90, p.twin ?? p.p50]).filter((v): v is number => v != null), 180];
  const x = d3Scale.scaleLinear().domain([-120, 120]).range([M.l, W - M.r]);
  const y = d3Scale.scaleLinear().domain([Math.min(...vals) - 10, Math.max(...vals) + 6]).range([H - M.b, M.t]);
  const xm = (m: number) => x(m);
  const p60 = data.points.find(p => p.offset_min === 60);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mini-twin" role="img" aria-label={`Thumbnail of ${data.patientId}'s forecast at ${new Date(anchor).toISOString().slice(11, 16)} UTC: observed readings, the physiology twin, the learned adjustment and the forecast with its bands${p60 && p60.twin_p50 != null ? `; at +60 min ${p60.twin_p50} + (${(p60.p50 - p60.twin_p50).toFixed(1)}) = ${p60.p50} mg/dL` : ''}.`}>
      <HatchDefs id={id} />
      <rect x={x(0)} y={M.t} width={x(120) - x(0)} height={H - M.t - M.b} className="fig-future" />
      <Threshold x0={M.l} x1={W - M.r} y={y} label={null} />
      <Bands pts={pts} x={xm} y={y} testIds={false} />
      <Wedge pts={pts} x={xm} y={y} hatch={id} />
      <TwinLine pts={pts} x={xm} y={y} />
      <MedianLine pts={pts} x={xm} y={y} testId="mini-median" />
      <ObservedDots obs={obs} x={xm} y={y} r={1.8} />
      <line x1={x(0)} x2={x(0)} y1={M.t} y2={H - M.b} className="fig-now" />
    </svg>
  );
}

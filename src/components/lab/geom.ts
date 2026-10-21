import * as d3Scale from 'd3-scale';
import * as d3Shape from 'd3-shape';
import type { LabData, LabPoint } from '@/lib/lab-data';

export interface Geom {
  W: number; H: number; M: { l: number; r: number; t: number; b: number };
  x: (m: number) => number; y: (v: number) => number;
  yTicks: number[]; yMin: number; yMax: number;
  obs: Array<{ m: number; v: number }>;
  pts: LabPoint[];
  band: (lo: keyof LabPoint, hi: keyof LabPoint) => string;
  median: string; twin: string; observed: string; ribbon: string;
  from: number; to: number;
}

/** Shared scales for the prototypes. Minutes are relative to the 08:00 anchor; the forecast starts at the current reading. */
export function geom(d: LabData, W: number, H: number, M: Geom['M'], from = -120, to = 120, step = 40): Geom {
  const anchor = Date.parse(d.asOf);
  const obs = d.observed.map(o => ({ m: (Date.parse(o.t) - anchor) / 60000, v: o.v })).filter(o => o.m >= from && o.m <= 0);
  const c = d.current;
  const start: LabPoint = { offset_min: 0, p05: c, p10: c, p25: c, p50: c, p75: c, p90: c, p95: c, twin: c };
  const pts = [start, ...d.points];
  const vals = [...obs.map(o => o.v), ...pts.flatMap(p => [p.p05, p.p95, p.twin ?? p.p50]), 180, 70];
  const yMin = Math.max(0, Math.floor((Math.min(...vals) - 10) / step) * step);
  const yMax = Math.ceil((Math.max(...vals) + 5) / step) * step;
  const xs = d3Scale.scaleLinear().domain([from, to]).range([M.l, W - M.r]);
  const ys = d3Scale.scaleLinear().domain([yMin, yMax]).range([H - M.b, M.t]);
  const x = (m: number) => xs(m);
  const y = (v: number) => ys(v);
  const band = (lo: keyof LabPoint, hi: keyof LabPoint) => d3Shape.area<LabPoint>().x(p => x(p.offset_min)).y0(p => y(p[lo] as number)).y1(p => y(p[hi] as number))(pts) ?? '';
  const twinPts = pts.filter(p => p.twin != null);
  return {
    W, H, M, x, y, yMin, yMax, from, to, obs, pts,
    yTicks: Array.from({ length: (yMax - yMin) / step + 1 }, (_, i) => yMin + i * step),
    band,
    median: d3Shape.line<LabPoint>().x(p => x(p.offset_min)).y(p => y(p.p50))(pts) ?? '',
    twin: d3Shape.line<LabPoint>().x(p => x(p.offset_min)).y(p => y(p.twin as number))(twinPts) ?? '',
    observed: d3Shape.line<{ m: number; v: number }>().x(o => x(o.m)).y(o => y(o.v))(obs) ?? '',
    ribbon: d3Shape.area<LabPoint>().x(p => x(p.offset_min)).y0(p => y(p.twin as number)).y1(p => y(p.p50))(twinPts) ?? '',
  };
}

export const fmt = (v: number) => Number(v.toFixed(1)).toString();
export const signed = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt(Math.abs(v));
export const at = (d: LabData, m: number) => d.points.find(p => p.offset_min === m) ?? null;
export const peakOf = (d: LabData) => d.points.reduce((b, p) => (p.p50 > b.p50 ? p : b), d.points[0]);

/** Input lanes on the same minute axis: history only, nothing drawn after the anchor. */
export function laneSeries(d: LabData, x: (m: number) => number, from: number, h: number, key: 'hr' | 'hrv') {
  const anchor = Date.parse(d.asOf);
  const rows = d.inputs.map(i => ({ m: (Date.parse(i.t) - anchor) / 60000, v: i[key] })).filter(r => r.m >= from && r.m <= 0 && r.v != null) as Array<{ m: number; v: number }>;
  if (rows.length < 2) return null;
  const lo = Math.min(...rows.map(r => r.v)), hi = Math.max(...rows.map(r => r.v));
  const ys = d3Scale.scaleLinear().domain(lo === hi ? [lo - 1, hi + 1] : [lo, hi]).range([h - 3, 3]);
  return { path: d3Shape.line<{ m: number; v: number }>().x(r => x(r.m)).y(r => ys(r.v))(rows) ?? '', lo, hi, last: rows[rows.length - 1].v };
}
export function laneRows(d: LabData, from: number) {
  const anchor = Date.parse(d.asOf);
  return d.inputs.map(i => ({ ...i, m: (Date.parse(i.t) - anchor) / 60000 })).filter(r => r.m >= from && r.m <= 0);
}

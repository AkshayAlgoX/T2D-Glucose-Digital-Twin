import React from 'react';
import * as d3Shape from 'd3-shape';

/**
 * The figure grammar used by every chart in the product:
 *   observation  = a dot per received reading (ink)
 *   model output = a line (forecast median: blue; physiology twin: rust, dashed)
 *   learned adjustment = the wedge between the twin line and the forecast median (teal, hatched)
 *   uncertainty  = nested bands (P25–75, P10–90, P05–95), darker toward the median
 * ①②③ always mean twin, adjustment, forecast.
 */
export interface FigPoint { m: number; p05?: number | null; p10?: number | null; p25?: number | null; p50: number; p75?: number | null; p90?: number | null; p95?: number | null; twin?: number | null }
type X = (minutes: number) => number;
type Y = (value: number) => number;
const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function HatchDefs({ id }: { id: string }) {
  return (
    <defs>
      <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" className="fig-wedge-fill" />
        <line x1="0" y1="0" x2="0" y2="6" className="fig-wedge-hatch" />
      </pattern>
    </defs>
  );
}

const band = (pts: FigPoint[], x: X, y: Y, lo: keyof FigPoint, hi: keyof FigPoint) =>
  d3Shape.area<FigPoint>().defined(p => ok(p[lo]) && ok(p[hi])).x(p => x(p.m)).y0(p => y(p[lo] as number)).y1(p => y(p[hi] as number))(pts) ?? '';

/** Nested uncertainty: each band is drawn only where the service returned both of its quantiles. */
export function Bands({ pts, x, y, testIds = true }: { pts: FigPoint[]; x: X; y: Y; testIds?: boolean }) {
  const has = (k: keyof FigPoint) => pts.some(p => ok(p[k]));
  return (
    <g className="fig-bands">
      {has('p05') && has('p95') && <path data-testid={testIds ? 'outer-quantile-band' : undefined} d={band(pts, x, y, 'p05', 'p95')} className="fig-band fig-band-outer" />}
      {has('p10') && has('p90') && <path data-testid={testIds ? 'quantile-band' : undefined} d={band(pts, x, y, 'p10', 'p90')} className="fig-band fig-band-mid" />}
      {has('p25') && has('p75') && <path data-testid={testIds ? 'inner-quantile-band' : undefined} d={band(pts, x, y, 'p25', 'p75')} className="fig-band fig-band-inner" />}
    </g>
  );
}

/** The learned adjustment, drawn as the region between the twin line and the forecast median. */
export function Wedge({ pts, x, y, hatch }: { pts: FigPoint[]; x: X; y: Y; hatch: string }) {
  const twin = pts.filter(p => ok(p.twin));
  if (twin.length < 2) return null;
  const d = d3Shape.area<FigPoint>().x(p => x(p.m)).y0(p => y(p.twin as number)).y1(p => y(p.p50))(twin) ?? '';
  return <path data-testid="adjustment-wedge" d={d} fill={`url(#${hatch})`} className="fig-wedge" />;
}

export function TwinLine({ pts, x, y, className = 'fig-twin' }: { pts: FigPoint[]; x: X; y: Y; className?: string }) {
  const twin = pts.filter(p => ok(p.twin));
  if (twin.length < 2) return null;
  const d = d3Shape.line<FigPoint>().x(p => x(p.m)).y(p => y(p.twin as number))(twin) ?? '';
  return <><path d={d} className="fig-halo" aria-hidden="true" /><path data-testid="twin-line" d={d} className={className} /></>;
}

export function MedianLine({ pts, x, y, testId = 'forecast-median', className = 'fig-median' }: { pts: FigPoint[]; x: X; y: Y; testId?: string; className?: string }) {
  const d = d3Shape.line<FigPoint>().defined(p => ok(p.p50)).x(p => x(p.m)).y(p => y(p.p50))(pts) ?? '';
  return <><path d={d} className="fig-halo" aria-hidden="true" /><path data-testid={testId} d={d} className={className} /></>;
}

/** One dot per received reading; a faint line joins readings only across consecutive 5-min steps. */
export function ObservedDots({ obs, x, y, r = 2.4, step = 5 }: { obs: Array<{ m: number; v: number }>; x: X; y: Y; r?: number; step?: number }) {
  const segments = obs.reduce<Array<Array<{ m: number; v: number }>>>((acc, o, i) => {
    if (i === 0 || o.m - obs[i - 1].m > step + 0.01) acc.push([]);
    acc[acc.length - 1].push(o);
    return acc;
  }, []);
  const line = d3Shape.line<{ m: number; v: number }>().x(o => x(o.m)).y(o => y(o.v));
  return (
    <g className="fig-observed">
      {segments.map((s, i) => <g key={i} data-testid="observed-segment">
        {s.length > 1 && <path d={line(s) ?? ''} className="fig-obs-link" />}
        {s.map(o => <circle key={o.m} cx={x(o.m)} cy={y(o.v)} r={r} className="fig-obs" />)}
      </g>)}
    </g>
  );
}

export function Threshold({ x0, x1, y, level = 180, label = '180 mg/dL spike level', labelX }: { x0: number; x1: number; y: Y; level?: number; label?: string | null; labelX?: number }) {
  return (
    <g className="fig-threshold">
      <line x1={x0} x2={x1} y1={y(level)} y2={y(level)} />
      {label && <text x={labelX ?? x0 + 6} y={y(level) - 6}>{label}</text>}
    </g>
  );
}

/** ①②③ at one horizon: twin, the adjustment between, the final forecast. */
export function Decomposition({ m, twin, p50, x, y, compact = false }: { m: number; twin: number | null | undefined; p50: number; x: X; y: Y; compact?: boolean }) {
  const cx = x(m);
  if (!ok(twin)) return <g className="fig-markers"><Marker n="3" cx={cx} cy={y(p50)} dx={compact ? 12 : 16} dy={compact ? 16 : 20} cls="m-final" /></g>;
  const up = twin >= p50;
  const gap = Math.abs(y(twin) - y(p50));
  return (
    <g className="fig-markers" data-testid="decomposition-markers">
      <line x1={cx} x2={cx} y1={y(twin)} y2={y(p50)} className="fig-gap" />
      <Marker n="1" cx={cx} cy={y(twin)} dx={compact ? 12 : 16} dy={(up ? -1 : 1) * (compact ? 15 : 19)} cls="m-twin" />
      {gap > 8 && <Marker n="2" cx={cx} cy={(y(twin) + y(p50)) / 2} dx={compact ? 18 : 24} dy={0} cls="m-adj" />}
      <Marker n="3" cx={cx} cy={y(p50)} dx={compact ? 12 : 16} dy={(up ? 1 : -1) * (compact ? 15 : 19)} cls="m-final" />
    </g>
  );
}

function Marker({ n, cx, cy, dx, dy, cls }: { n: string; cx: number; cy: number; dx: number; dy: number; cls: string }) {
  return (
    <g className={`fig-marker ${cls}`} aria-hidden="true">
      <line x1={cx} y1={cy} x2={cx + dx * 0.62} y2={cy + dy * 0.62} />
      <circle cx={cx} cy={cy} r={3.5} className="fig-marker-dot" />
      <circle cx={cx + dx} cy={cy + dy} r={8.5} />
      <text x={cx + dx} y={cy + dy + 3.8} textAnchor="middle">{n}</text>
    </g>
  );
}

/** When each bound of the forecast is above the level, on the plot's own time axis. */
export function aboveRuns(pts: FigPoint[], key: 'p10' | 'p50' | 'p90', level = 180, step = 5) {
  const runs: Array<[number, number]> = [];
  for (const p of [...pts].sort((a, b) => a.m - b.m)) {
    const v = p[key];
    if (!ok(v) || v <= level) continue;
    const last = runs[runs.length - 1];
    if (last && p.m - last[1] <= step + 0.01) last[1] = p.m; else runs.push([p.m, p.m]);
  }
  return runs;
}

export function AboveBars({ pts, x, x0, x1, top, row = 12, step = 5, labels = true }: { pts: FigPoint[]; x: X; x0: number; x1: number; top: number; row?: number; step?: number; labels?: boolean }) {
  const rows: Array<['p90' | 'p50' | 'p10', string]> = [['p90', 'Upper 10%'], ['p50', 'Median'], ['p10', 'Lower 10%']];
  return (
    <g className="fig-above" data-testid="above-bars">
      {rows.map(([k, label], i) => {
        const runs = aboveRuns(pts, k, 180, step);
        const yy = top + i * row;
        return <g key={k} className={`fig-above-row ${k}`}>
          <line x1={x0} x2={x1} y1={yy + row / 2} y2={yy + row / 2} className="fig-above-track" />
          {runs.map(([a, b]) => <rect key={a} x={x(a - step / 2)} width={Math.max(2, x(b + step / 2) - x(a - step / 2))} y={yy + 2} height={row - 4} rx={1} className="fig-above-run" />)}
          {labels && <text x={x0 - 8} y={yy + row / 2 + 3.5} textAnchor="end" className="fig-above-label">{label}</text>}
        </g>;
      })}
    </g>
  );
}

/** HTML legend glyphs, the same everywhere a chart uses the grammar. */
export function Glyph({ kind }: { kind: 'obs' | 'median' | 'twin' | 'wedge' | 'bands' | 'threshold' | 'above' | 'ghost' | 'ghost-twin' }) {
  return <i className={`fig-glyph g-${kind}`} aria-hidden="true" />;
}

/** A one-line version of the grammar for a headline: twin error, hybrid error, and the hatched gap between them. */
export function GainBar({ hybrid, twin, persistence, id, unit = 'mg/dL', domainMax }: { hybrid: number; twin: number; persistence?: number | null; id: string; unit?: string; domainMax?: number }) {
  const W = 260, H = 44, l = 4, r = 8;
  // A shared domainMax keeps bars in one figure on the same scale.
  const max = domainMax ?? Math.ceil(Math.max(twin, hybrid, persistence ?? 0) / 10) * 10;
  const x = (v: number) => l + (v / max) * (W - l - r);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="gain-bar" role="img" aria-label={`RMSE ${hybrid.toFixed(2)} ${unit} for the hybrid against ${twin.toFixed(2)} for the physiology twin alone${persistence != null ? ` and ${persistence.toFixed(2)} for persistence` : ''}; the hatched gap is the error the learned adjustment removes.`}>
      <HatchDefs id={id} />
      <line x1={l} x2={W - r} y1={16} y2={16} className="fig-grid" />
      <rect x={x(hybrid)} y={9} width={Math.max(1, x(twin) - x(hybrid))} height={14} fill={`url(#${id})`} className="fig-wedge" />
      <line x1={l} x2={x(hybrid)} y1={16} y2={16} className="gain-hybrid" />
      <line x1={x(twin)} x2={x(twin)} y1={7} y2={25} className="gain-twin" />
      {persistence != null && <line x1={x(persistence)} x2={x(persistence)} y1={9} y2={23} className="gain-persist" />}
      <text x={l} y={40} className="gain-label"><tspan className="lbl-scen">hybrid {hybrid.toFixed(1)}</tspan><tspan className="lbl-twin" dx={10}>twin {twin.toFixed(1)}</tspan>{persistence != null && <tspan className="lbl-base" dx={10}>persistence {persistence.toFixed(1)}</tspan>}</text>
    </svg>
  );
}

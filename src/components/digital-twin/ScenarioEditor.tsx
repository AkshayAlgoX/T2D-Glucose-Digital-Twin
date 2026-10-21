import React, { useEffect, useRef, useState } from 'react';
import * as d3Scale from 'd3-scale';
import * as d3Shape from 'd3-shape';
import { FlaskConical, Footprints, Pill, Utensils, UtensilsCrossed } from 'lucide-react';
import { formatTime } from '@/lib/formatters/date';
import { Glyph, HatchDefs } from '@/components/figure/marks';
import { useScenario, type ScenarioComparison, type ScenarioCurvePoint, type ScenarioState } from '@/hooks/useScenario';
import type { ForecastResponse, MedClass, ScenarioInput } from '@/types/forecast-response';

export const SCENARIO_DISCLAIMER = 'Simulated model response — not a validated causal treatment effect.';

type Kind = 'meal' | 'activity' | 'skip_habitual_meal' | 'medication';
type Intensity = 'light' | 'moderate' | 'vigorous';
type Slot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

interface FormState { kind: Kind; carbs: string; offset: string; duration: string; intensity: Intensity; slot: Slot }

const DEFAULT_FORM: FormState = { kind: 'meal', carbs: '60', offset: '30', duration: '30', intensity: 'moderate', slot: 'dinner' };

const PRESET_ICONS: Record<string, React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>> = { meal: Utensils, walk: Footprints, skip: UtensilsCrossed, medication: Pill };

const PRESETS: Array<{ id: string; label: string; form: Partial<FormState> }> = [
  { id: 'meal', label: '60 g carb meal in 30 min', form: { kind: 'meal', carbs: '60', offset: '30' } },
  { id: 'walk', label: '30 min moderate activity now', form: { kind: 'activity', duration: '30', intensity: 'moderate', offset: '0' } },
  // Kept as a one-click demonstration of the refusal: the backend answers SCENARIO_UNSUPPORTED.
  { id: 'medication', label: 'Medication change', form: { kind: 'medication' } },
];

// Empty text is "not entered", never 0.
const num = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));
const isInt = (v: number) => Number.isInteger(v);

/** Mirrors the backend ScenarioInput bounds so obviously invalid requests are never sent. */
export function buildScenarioInput(f: FormState, medClass: MedClass): { input: ScenarioInput } | { error: string } {
  const offset = num(f.offset);
  const offsetOk = isInt(offset) && offset >= 0 && offset <= 120;
  switch (f.kind) {
    case 'meal': {
      const carbs = num(f.carbs);
      if (!(Number.isFinite(carbs) && carbs >= 0 && carbs <= 250)) return { error: 'Carbohydrate must be 0–250 g' };
      if (!offsetOk) return { error: 'Start must be 0–120 min, whole minutes' };
      return { input: { kind: 'meal', offset_min: offset, carbs_g: carbs } };
    }
    case 'activity': {
      const duration = num(f.duration);
      if (!(isInt(duration) && duration >= 5 && duration <= 120)) return { error: 'Duration must be 5–120 min, whole minutes' };
      if (!offsetOk) return { error: 'Start must be 0–120 min, whole minutes' };
      return { input: { kind: 'activity', offset_min: offset, duration_min: duration, intensity: f.intensity } };
    }
    case 'skip_habitual_meal':
      return { input: { kind: 'skip_habitual_meal', meal_slot: f.slot } };
    case 'medication':
      return { input: { kind: 'medication', offset_min: offsetOk ? offset : 0, med_class: medClass, taken: true } };
  }
}

export function describeInput(input: ScenarioInput): string {
  switch (input.kind) {
    case 'meal': return `${input.carbs_g} g carbohydrate meal ${input.offset_min === 0 ? 'now' : `in ${input.offset_min} min`}`;
    case 'activity': return `${input.duration_min} min ${input.intensity} activity ${input.offset_min === 0 ? 'now' : `in ${input.offset_min} min`}`;
    case 'skip_habitual_meal': return `Skip usual ${input.meal_slot}`;
    case 'medication': return `Medication change (${input.med_class})`;
  }
}

const signed = (v: number, digits = 0, unit = '') => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(digits)}${unit}`;
const pct = (p: number | null) => (p == null ? 'Unavailable' : `${(p * 100).toFixed(1)}%`);
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Everything the readout shows, derived from the two same-anchor median curves the backend returned. */
/** Isolated one-step departures above this size are flagged (mg/dL), matching the forecast chart. */
const ISOLATED_STEP_MG_DL = 20;

export function summarizeComparison(result: ScenarioComparison) {
  const anchor = Date.parse(result.pinned_as_of);
  const offset = (p: ScenarioCurvePoint) => Math.round((Date.parse(p.timestamp) - anchor) / 60000);
  const peakOf = (curve: ScenarioCurvePoint[]) => curve.reduce((best, p) => (p.p50 > best.p50 ? p : best), curve[0]);
  const base = peakOf(result.baseline_forecast);
  const scen = peakOf(result.scenario_forecast);
  const byTime = new Map(result.baseline_forecast.map(p => [Date.parse(p.timestamp), p.p50]));
  let largest = { diff: 0, offset: 0 };
  for (const p of result.scenario_forecast) {
    const b = byTime.get(Date.parse(p.timestamp));
    if (b == null) continue;
    const diff = round1(p.p50 - b);
    if (Math.abs(diff) > Math.abs(largest.diff)) largest = { diff, offset: offset(p) };
  }
  const baselinePeak = round1(base.p50);
  const scenarioPeak = round1(scen.p50);
  const deltaPoints = result.metrics.delta_probability == null ? null : round1(result.metrics.delta_probability * 100);
  // Physiology twin alone: the mechanistic rollout under each plan, at the same timestamps.
  const twinByTime = new Map(result.baseline_forecast.filter(p => p.twin_p50 != null).map(p => [Date.parse(p.timestamp), p.twin_p50 as number]));
  let twin: { diff: number; offset: number } | null = null;
  let learned: { diff: number; offset: number } | null = null;
  for (const p of result.scenario_forecast) {
    if (p.twin_p50 == null) continue;
    const adj = round1(p.p50 - p.twin_p50);
    if (!learned || Math.abs(adj) > Math.abs(learned.diff)) learned = { diff: adj, offset: offset(p) };
    const b = twinByTime.get(Date.parse(p.timestamp));
    if (b == null) continue;
    const diff = round1(p.twin_p50 - b);
    if (!twin || Math.abs(diff) > Math.abs(twin.diff)) twin = { diff, offset: offset(p) };
  }
  // An isolated one-step jump in the scenario median (see docs/evidence/model_audit/MODEL_AUDIT_20261020.md).
  const sc = result.scenario_forecast;
  const step = sc.slice(1, -1).reduce<{ size: number; offset: number } | null>((best, p, i) => {
    const size = Math.abs(p.p50 - (sc[i].p50 + sc[i + 2].p50) / 2);
    return !best || size > best.size ? { size, offset: offset(p) } : best;
  }, null);
  const isolatedStep = step && step.size > ISOLATED_STEP_MG_DL ? step : null;
  return {
    isolatedStep,
    twinLargestDiff: twin?.diff ?? null, twinLargestDiffMin: twin?.offset ?? null,
    learnedLargest: learned?.diff ?? null, learnedLargestMin: learned?.offset ?? null,
    baselinePeak, baselinePeakMin: offset(base), scenarioPeak, scenarioPeakMin: offset(scen),
    deltaPeak: round1(scenarioPeak - baselinePeak),
    largestDiff: largest.diff, largestDiffMin: largest.offset,
    deltaPoints,
    noChange: largest.diff === 0 && (deltaPoints ?? 0) === 0,
  };
}

function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** When the scenario's change happens, in minutes after the anchor; null when it has no fixed time (a skipped usual meal). */
export function changeWindow(input: ScenarioInput | undefined): { start: number; end: number | null; label: string } | null {
  if (!input) return null;
  if (input.kind === 'meal') return { start: input.offset_min, end: null, label: `${input.carbs_g} g meal` };
  if (input.kind === 'activity') return { start: input.offset_min, end: Math.min(120, input.offset_min + input.duration_min), label: `${input.intensity} activity` };
  return null;
}

/** Keeps end-of-line labels at least `gap` px apart, in their original vertical order. */
function spreadLabels<T extends { y: number }>(labels: T[], gap: number, top: number, bottom: number): T[] {
  const sorted = [...labels].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].y - sorted[i - 1].y < gap) sorted[i] = { ...sorted[i], y: sorted[i - 1].y + gap };
  const overflow = sorted.length ? sorted[sorted.length - 1].y - bottom : 0;
  return overflow > 0 ? sorted.map(l => ({ ...l, y: Math.max(top, l.y - overflow) })) : sorted;
}

export function ScenarioComparisonChart({ result, step = null, change = null, twinFirst = false }: { result: ScenarioComparison; step?: { size: number; offset: number } | null; change?: { start: number; end: number | null; label: string } | null; twinFirst?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>(560);
  const height = width < 420 ? 240 : 270;
  const labelled = width >= 520;
  const anchor = Date.parse(result.pinned_as_of);
  const toPoint = (p: ScenarioCurvePoint) => ({ ...p, min: (Date.parse(p.timestamp) - anchor) / 60000 });
  const base = result.baseline_forecast.map(toPoint);
  const scen = result.scenario_forecast.map(toPoint);
  const start = result.current_mg_dl != null ? [{ min: 0, p10: result.current_mg_dl, p50: result.current_mg_dl, p90: result.current_mg_dl }] : [];
  const values = [...base, ...scen].flatMap(p => [p.p10, p.p90]).concat([...base, ...scen].flatMap(p => (p.twin_p50 != null ? [p.twin_p50] : []))).concat(result.current_mg_dl ?? []);
  const yMin = Math.max(0, Math.floor((Math.min(...values) - 10) / 20) * 20);
  const yMax = Math.ceil((Math.max(200, ...values) + 10) / 20) * 20;
  const m = { left: 40, right: labelled ? 134 : 12, top: 14, bottom: 24 };
  const x = d3Scale.scaleLinear().domain([0, 120]).range([m.left, width - m.right]);
  const y = d3Scale.scaleLinear().domain([yMin, yMax]).range([height - m.bottom, m.top]);
  type P = { min: number; p10: number; p50: number; p90: number };
  const line = d3Shape.line<P>().x(p => x(p.min)).y(p => y(p.p50));
  const scenTwin = scen.filter(p => p.twin_p50 != null).map(p => ({ min: p.min, v: p.twin_p50 as number }));
  // The twin's own unchanged rollout, so each model is compared with itself (twin vs twin, forecast vs forecast).
  const baseTwin = base.filter(p => p.twin_p50 != null).map(p => ({ min: p.min, v: p.twin_p50 as number }));
  const startTwin = scenTwin.length && result.current_mg_dl != null ? [{ min: 0, v: result.current_mg_dl }] : [];
  const twinLine = d3Shape.line<{ min: number; v: number }>().x(p => x(p.min)).y(p => y(p.v));
  const band = d3Shape.area<P>().x(p => x(p.min)).y0(p => y(p.p10)).y1(p => y(p.p90));
  const yTicks = Array.from(new Set([...y.ticks(4), 180])).filter(t => t >= yMin && t <= yMax).sort((a, b) => a - b);
  return (
    <div ref={ref} className="whatif-chart">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="whatif-chart-title">
        <title id="whatif-chart-title">Baseline forecast compared with the simulated scenario over the next 120 minutes</title>
        {yTicks.map(t => <g key={t}>
          <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} className={t === 180 ? 'wf-threshold' : 'fig-grid'} />
          <text x={m.left - 6} y={y(t) + 4} textAnchor="end" className={t === 180 ? 'chart-axis step-label' : 'chart-axis'}>{t}</text>
        </g>)}
        {(width < 420 ? [0, 60, 120] : [0, 30, 60, 90, 120]).map(t => <text key={t} x={x(t)} y={height - 8} textAnchor={t === 0 ? 'start' : t === 120 ? 'end' : 'middle'} className={t === 0 ? 'chart-axis fig-axis-now' : 'chart-axis'}>{t === 0 ? formatTime(result.pinned_as_of) : `+${t / 60} h`}</text>)}
        <HatchDefs id="whatif-hatch" />
        <path d={band(base) ?? ''} className="wf-band-base" />
        <path d={band(scen) ?? ''} className="wf-band-scen" />
        {baseTwin.length > 0 && <path data-testid="whatif-twin-base-line" d={twinLine([...startTwin, ...baseTwin]) ?? ''} className="fig-ghost-twin" />}
        <path data-testid="whatif-baseline-line" d={line([...start, ...base]) ?? ''} className="fig-ghost" />
        {scenTwin.length > 1 && <path data-testid="whatif-wedge" d={d3Shape.area<{ min: number; v: number; p50: number }>().x(p => x(p.min)).y0(p => y(p.v)).y1(p => y(p.p50))([...(result.current_mg_dl != null ? [{ min: 0, v: result.current_mg_dl, p50: result.current_mg_dl }] : []), ...scen.filter(p => p.twin_p50 != null).map(p => ({ min: p.min, v: p.twin_p50 as number, p50: p.p50 }))]) ?? ''} fill="url(#whatif-hatch)" className="fig-wedge" />}
        {scenTwin.length > 0 && <><path d={twinLine([...startTwin, ...scenTwin]) ?? ''} className="fig-halo" aria-hidden="true" /><path data-testid="whatif-twin-line" d={twinLine([...startTwin, ...scenTwin]) ?? ''} className={'fig-twin' + (twinFirst ? ' wf-emphasis' : '')} /></>}
        <path d={line([...start, ...scen]) ?? ''} className="fig-halo" aria-hidden="true" />
        <path data-testid="whatif-scenario-line" d={line([...start, ...scen]) ?? ''} className="fig-median" />
        {change && <g data-testid="whatif-change-marker" aria-hidden="true">
          {change.end != null && <rect x={x(change.start)} y={m.top} width={Math.max(2, x(change.end) - x(change.start))} height={height - m.bottom - m.top} className="wf-change-window" />}
          <line x1={x(change.start)} x2={x(change.start)} y1={m.top} y2={height - m.bottom} className="wf-change-line" />
          <text x={x(change.start) + 5} y={m.top + 11} className="chart-axis change-label">{change.label} · +{change.start} min</text>
        </g>}
        {labelled && (() => {
          const last = <T,>(a: T[]) => a[a.length - 1];
          const lb = last(base), ls = last(scen), lt = last(scenTwin);
          const raw = [
            lb && { key: 'base', y: y(lb.p50), text: 'Forecast, unchanged', cls: 'lbl-base' },
            ls && { key: 'scen', y: y(ls.p50), text: 'Forecast + change', cls: 'lbl-scen' },
            lt && { key: 'twin', y: y(lt.v), text: 'Twin + change', cls: 'lbl-twin' },
            baseTwin.length > 0 && { key: 'twinBase', y: y(baseTwin[baseTwin.length - 1].v), text: 'Twin, unchanged', cls: 'lbl-base' },
          ].filter(Boolean) as Array<{ key: string; y: number; text: string; cls: string }>;
          return <g aria-hidden="true">{spreadLabels(raw, 17, m.top + 6, height - m.bottom).map(l => <text key={l.key} x={width - m.right + 8} y={l.y + 4} className={'chart-axis end-label ' + l.cls}>{l.text}</text>)}</g>;
        })()}
        {step && (() => {
          const p = scen.find(q => Math.round(q.min) === step.offset);
          if (!p) return null;
          const px = x(p.min), py = y(p.p50), left = px > width * 0.5;
          // Below the point when it sits near the top, so it never collides with the spike-level label.
          const ly = py < m.top + 34 ? py + 18 : py - 9;
          return <g data-testid="whatif-step-marker">
            <circle cx={px} cy={py} r={5} fill="none" stroke="var(--color-amber)" strokeWidth={1.5} />
            <text x={left ? px - 9 : px + 9} y={ly} textAnchor={left ? 'end' : 'start'} className="chart-axis step-label">{width < 420 ? '1-step jump' : 'single 5-min step'}</text>
          </g>;
        })()}
      </svg>
      <div className="whatif-legend fig-legend" aria-hidden="true">
        <span><Glyph kind="ghost" />Forecast, unchanged plan (grey band: its P10–P90)</span>
        <span><Glyph kind="median" />Forecast with this change (blue band: its P10–P90)</span>
        {baseTwin.length > 0 && <span><Glyph kind="ghost-twin" />Physiology twin, unchanged plan</span>}
        {scenTwin.length > 0 && <span><Glyph kind="twin" />Physiology twin with this change</span>}
        {scenTwin.length > 1 && <span><Glyph kind="wedge" />Learned adjustment with this change</span>}
        <span><Glyph kind="threshold" />Spike level 180 mg/dL</span>
      </div>
    </div>
  );
}

/** Scenario minus unchanged plan at each returned time, for the final forecast and for the physiology twin alone. */
export function changeSeries(result: ScenarioComparison) {
  const anchor = Date.parse(result.pinned_as_of);
  const base = new Map(result.baseline_forecast.map(p => [Date.parse(p.timestamp), p]));
  const rows: Array<{ min: number; unchanged: number; withChange: number; final: number; twin: number | null }> = [];
  for (const p of result.scenario_forecast) {
    const b = base.get(Date.parse(p.timestamp));
    if (!b) continue;
    rows.push({
      min: Math.round((Date.parse(p.timestamp) - anchor) / 60000),
      unchanged: b.p50, withChange: p.p50, final: round1(p.p50 - b.p50),
      twin: p.twin_p50 != null && b.twin_p50 != null ? round1(p.twin_p50 - b.twin_p50) : null,
    });
  }
  return rows.sort((a, c) => a.min - c.min);
}

export function ScenarioChangeChart({ result, change = null, step = null, twinFirst = false }: { result: ScenarioComparison; change?: { start: number; end: number | null; label: string } | null; step?: { size: number; offset: number } | null; twinFirst?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>(560);
  const rows = changeSeries(result);
  const labelled = width >= 520;
  const height = width < 420 ? 170 : 190;
  const m = { left: 40, right: labelled ? 100 : 12, top: 12, bottom: 24 };
  // Both plans start from the same reading, so the change is zero at the anchor.
  const series = [{ min: 0, final: 0, twin: rows.some(r => r.twin != null) ? 0 : null }, ...rows];
  const vals = series.flatMap(r => [r.final, r.twin ?? 0]);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const pad = Math.max(5, (hi - lo) * 0.12);
  const x = d3Scale.scaleLinear().domain([0, 120]).range([m.left, width - m.right]);
  const y = d3Scale.scaleLinear().domain([lo - pad, hi + pad]).nice(4).range([height - m.bottom, m.top]);
  const twinRows = series.filter(r => r.twin != null) as Array<{ min: number; final: number; twin: number }>;
  const finalLine = d3Shape.line<{ min: number; final: number }>().x(r => x(r.min)).y(r => y(r.final));
  const twinLine = d3Shape.line<{ min: number; twin: number }>().x(r => x(r.min)).y(r => y(r.twin));
  const gap = d3Shape.area<{ min: number; final: number; twin: number }>().x(r => x(r.min)).y0(r => y(r.twin)).y1(r => y(r.final));
  const blip = learnedBlip(series);
  const lastFinal = series[series.length - 1];
  const lastTwin = twinRows[twinRows.length - 1];
  const finalMax = rows.reduce<typeof rows[number] | null>((b, r) => (!b || Math.abs(r.final) > Math.abs(b.final) ? r : b), null);
  const twinMax = rows.filter(r => r.twin != null).reduce<typeof rows[number] | null>((b, r) => (!b || Math.abs(r.twin as number) > Math.abs(b.twin as number) ? r : b), null);
  const label = `Change from the plan at each time.${blip ? ` A single 5-min blip in the learned adjustment at +${blip.min} min.` : ''} Final forecast: largest ${finalMax ? signed(finalMax.final, 1, ' mg/dL') + ' at +' + finalMax.min + ' min' : 'unavailable'}.` +
    (twinMax ? ` Physiology twin alone: largest ${signed(twinMax.twin as number, 1, ' mg/dL')} at +${twinMax.min} min.` : '');
  return (
    <div ref={ref} className="whatif-change-chart" data-testid="whatif-change-chart">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        {y.ticks(4).map(t => <g key={t}>
          <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--color-line-control)' : 'var(--color-line)'} />
          <text x={m.left - 6} y={y(t) + 4} textAnchor="end" className="chart-axis">{t > 0 ? '+' + t : t === 0 ? '0' : '−' + Math.abs(t)}</text>
        </g>)}
        {change && <g aria-hidden="true">
          {change.end != null && <rect x={x(change.start)} y={m.top} width={Math.max(2, x(change.end) - x(change.start))} height={height - m.bottom - m.top} className="wf-change-window" />}
          <line x1={x(change.start)} x2={x(change.start)} y1={m.top} y2={height - m.bottom} className="wf-change-line" />
        </g>}
        <HatchDefs id="change-hatch" />
        {twinRows.length > 1 && <path data-testid="change-gap" d={gap(twinRows) ?? ''} fill="url(#change-hatch)" className="fig-wedge" />}
        {twinRows.length > 1 && <path data-testid="change-twin-line" d={twinLine(twinRows) ?? ''} className={'fig-twin' + (twinFirst ? ' wf-emphasis' : '')} />}
        <path data-testid="change-final-line" d={finalLine(series) ?? ''} className="fig-median" />
        {step && (() => {
          const r = series.find(q => q.min === step.offset);
          return r ? <circle cx={x(r.min)} cy={y(r.final)} r={5} fill="none" stroke="var(--color-amber)" strokeWidth={1.5} aria-hidden="true" /> : null;
        })()}
        {blip && <g data-testid="change-blip" aria-hidden="true">
          <circle cx={x(blip.min)} cy={y(blip.final)} r={6} fill="none" stroke="var(--color-amber)" strokeWidth={1.5} />
          <line x1={x(blip.min)} x2={x(blip.min)} y1={y(blip.final) - 7} y2={m.top + 14} stroke="var(--color-amber)" strokeWidth={1} />
          <text x={x(blip.min) + (blip.min > 60 ? -6 : 6)} y={m.top + 10} textAnchor={blip.min > 60 ? 'end' : 'start'} className="chart-axis blip-label">{width < 420 ? '1-step blip' : 'single 5-min blip in the learned adjustment'}</text>
        </g>}
        {labelled && <g aria-hidden="true">{spreadLabels([
          { key: 'f', y: y(lastFinal.final), text: 'Final forecast', cls: 'lbl-scen' },
          ...(lastTwin ? [{ key: 't', y: y(lastTwin.twin), text: 'Twin alone', cls: 'lbl-twin' }] : []),
        ], 17, m.top + 6, height - m.bottom).map(l => <text key={l.key} x={width - m.right + 8} y={l.y + 4} className={'chart-axis end-label ' + l.cls}>{l.text}</text>)}</g>}
        {(width < 420 ? [0, 60, 120] : [0, 30, 60, 90, 120]).map(t => <text key={t} x={x(t)} y={height - 8} textAnchor={t === 0 ? 'start' : t === 120 ? 'end' : 'middle'} className={t === 0 ? 'chart-axis fig-axis-now' : 'chart-axis'}>{t === 0 ? formatTime(result.pinned_as_of) : `+${t / 60} h`}</text>)}
      </svg>
      <div className="whatif-legend fig-legend" aria-hidden="true">
        <span><Glyph kind="median" />Final forecast: with change minus unchanged</span>
        {twinRows.length > 1 && <span><Glyph kind="twin" />Physiology twin alone: same difference{twinFirst ? ' (read this first: the input is outside the network\u2019s training range)' : ''}</span>}
        {twinRows.length > 1 && <span><Glyph kind="wedge" />Gap: what the learned adjustment adds or removes</span>}
      </div>
    </div>
  );
}

/**
 * A single 5-min departure in the learned adjustment's part of the change (final change minus the
 * twin's change) that its neighbours do not share: a known behaviour of the shipped network
 * (docs/evidence/model_audit/MODEL_AUDIT_20261020.md). Flagged, never smoothed.
 */
export function learnedBlip(series: Array<{ min: number; final: number; twin: number | null }>, minSize = 4) {
  let best: { min: number; final: number; size: number } | null = null;
  for (let i = 1; i < series.length - 1; i++) {
    const [a, b, c] = [series[i - 1], series[i], series[i + 1]];
    if (a.twin == null || b.twin == null || c.twin == null) continue;
    const la = a.final - a.twin, lb = b.final - b.twin, lc = c.final - c.twin;
    const size = Math.abs(lb - (la + lc) / 2);
    const reverts = Math.sign(lb - la) !== 0 && Math.sign(lb - la) === -Math.sign(lc - lb);
    if (reverts && size > minSize && (!best || size > best.size)) best = { min: b.min, final: b.final, size };
  }
  return best;
}

/** Every returned value at 15-minute steps, for reading without the charts. */
function ChangeTable({ result }: { result: ScenarioComparison }) {
  const rows = changeSeries(result).filter(r => r.min % 15 === 0);
  return (
    <details className="whatif-table" data-testid="whatif-table">
      <summary>Values every 15 minutes</summary>
      <table>
        <caption className="sr-only">Forecast median under each plan and the difference, in mg/dL</caption>
        <thead><tr><th scope="col">Time</th><th scope="col">Unchanged</th><th scope="col">With change</th><th scope="col">Change</th><th scope="col">Twin-alone change</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.min}><th scope="row">+{r.min} min</th><td>{r.unchanged.toFixed(1)}</td><td>{r.withChange.toFixed(1)}</td><td>{signed(r.final, 1)}</td><td>{r.twin == null ? '—' : signed(r.twin, 1)}</td></tr>)}</tbody>
      </table>
    </details>
  );
}

function Readout({ state, liveAsOf }: { state: Extract<ScenarioState, { status: 'result' }>; liveAsOf?: string | null }) {
  const resultRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const el = resultRef.current;
    if (!el || typeof el.scrollIntoView !== 'function') return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const rect = el.getBoundingClientRect();
    // Only scroll when the new result is mostly off-screen (typically on phones).
    if (rect.top > window.innerHeight * 0.6) el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    titleRef.current?.focus({ preventScroll: true });
  }, [state.asOf, state.result]);
  const { metrics, warnings, fallback_used } = state.result;
  const riskAvailable = metrics.baseline_probability != null && metrics.new_probability != null;
  const sum = summarizeComparison(state.result);
  const outOfRange = warnings.find(w => w.code === 'SCENARIO_OUT_OF_RANGE');
  const moved = liveAsOf != null && Date.parse(liveAsOf) !== Date.parse(state.asOf);
  const change = changeWindow(state.input);
  const gapPoint = state.result.scenario_forecast.find(p => Math.round((Date.parse(p.timestamp) - Date.parse(state.asOf)) / 60000) === sum.largestDiffMin) ?? null;
  return (
    <div ref={resultRef} className="whatif-result stage" data-testid="scenario-result">
      <h3 ref={titleRef} tabIndex={-1} className="whatif-result-title">Result: {describeInput(state.input)} · from <time dateTime={state.asOf}>{formatTime(state.asOf)} UTC</time></h3>
      {outOfRange && <div className="whatif-caution" role="note" data-testid="scenario-out-of-range">
        <strong>{outOfRange.title}.</strong> The network was not trained on inputs like this, so compare its curve with the physiology twin&apos;s.
        <details><summary>Why</summary><p>{outOfRange.detail}{sum.learnedLargest != null && <> On this scenario the learned adjustment reaches {signed(sum.learnedLargest, 1, ' mg/dL')} at +{sum.learnedLargestMin} min.</>}</p></details>
      </div>}
      {sum.noChange ? <div className="whatif-nochange" data-testid="scenario-no-change">
        <strong>Nothing changes in the next 2 hours.</strong>
        <p>{state.input.kind === 'skip_habitual_meal' ? `No usual ${state.input.meal_slot} is expected between ${formatTime(state.asOf)} and ${formatTime(new Date(Date.parse(state.asOf) + 7200000).toISOString())} UTC, so skipping it leaves the forecast as it is.` : 'The backend returned the same forecast for this change at every time point.'} Try a meal or some activity instead.</p>
      </div> : <>
      <figure className="whatif-figure">
        <figcaption><strong>Figure 2. Glucose under each plan</strong><span>Forecast median with its 80% band, next 2 h from {formatTime(state.asOf)} UTC. Grey: unchanged plan. Colour: with this change.</span></figcaption>
        <ScenarioComparisonChart result={state.result} step={sum.isolatedStep} change={change} twinFirst={!!outOfRange} />
      </figure>
      <figure className="whatif-figure">
        <figcaption><strong>Figure 3. What the change does, and when</strong><span>With the change minus the unchanged plan, at each time. Blue: final forecast; rust dashed: physiology twin alone; hatched: the learned adjustment&apos;s share.</span></figcaption>
        <ScenarioChangeChart result={state.result} step={sum.isolatedStep} change={change} twinFirst={!!outOfRange} />
      </figure>
      <dl className="whatif-metrics">
        <div className="lead">
          <dt>Biggest gap between the two forecast curves</dt>
          <dd data-testid="scenario-largest-diff"><span className="num t-final">{signed(sum.largestDiff, 1, ' mg/dL')}</span> <small>at +{sum.largestDiffMin} min{gapPoint ? ` · with the change, 80% interval ${gapPoint.p10.toFixed(1)}–${gapPoint.p90.toFixed(1)} mg/dL then` : ''}</small>
            {sum.isolatedStep && sum.isolatedStep.offset === sum.largestDiffMin && <small className="step-flag" data-testid="scenario-diff-on-step">Falls on the same single 5-min step.</small>}</dd>
        </div>
        {sum.twinLargestDiff != null && <div>
          <dt>Same gap, physiology twin alone</dt>
          <dd data-testid="scenario-twin-diff"><span className="num t-twin">{signed(sum.twinLargestDiff, 1, ' mg/dL')}</span> <small>at +{sum.twinLargestDiffMin} min · mechanistic rollout, no learned adjustment</small></dd>
        </div>}
        <div>
          <dt>New-spike onset risk, 2 h (calibrated on the validation split)</dt>
          <dd data-testid="scenario-risk">
            {riskAvailable
              ? <><span className="num">{pct(metrics.baseline_probability)} → {pct(metrics.new_probability)}</span> <strong>({signed(sum.deltaPoints ?? 0, 1, ' pts')})</strong></>
              : <>Unavailable{fallback_used === 'twin_only' ? ' (physics-only fallback; no calibrated risk)' : ''}</>}
          </dd>
        </div>
      </dl>
      {sum.twinLargestDiff != null && Math.abs(sum.largestDiff) < 0.8 * Math.abs(sum.twinLargestDiff) && <p className="whatif-gap" data-testid="scenario-twin-gap"><strong>Why the numbers differ.</strong> The final forecast moves by {signed(sum.largestDiff, 1, ' mg/dL')} at most, smaller than the physiology twin alone ({signed(sum.twinLargestDiff, 1, ' mg/dL')}): the learned adjustment offsets part of the twin&apos;s response to this change (the hatched wedge).{outOfRange ? ' Because this input is outside the training range, the size of that offset is not reliable.' : ''} Neither size is validated.</p>}
      <details className="whatif-more">
        <summary>Highest values under each plan</summary>
        <dl className="whatif-metrics secondary-metrics"><div className="secondary">
          <dt>Highest median glucose in the next 2 h</dt>
          <dd data-testid="scenario-peak">{sum.baselinePeak.toFixed(1)} → {sum.scenarioPeak.toFixed(1)} mg/dL <strong>({signed(sum.deltaPeak, 1)})</strong>
            <small data-testid="scenario-peak-timing">at +{sum.baselinePeakMin} min → at +{sum.scenarioPeakMin} min</small>
            {sum.isolatedStep && sum.isolatedStep.offset === sum.scenarioPeakMin && <small className="step-flag" data-testid="scenario-peak-on-step">This highest value is a single 5-min step, not a sustained level.</small>}</dd>
        </div></dl>
        <p className="fine-print">The highest values are compared whenever they occur, so their difference ({signed(sum.deltaPeak, 1)}) is not the same as the largest difference at the same time ({signed(sum.largestDiff, 1)} at +{sum.largestDiffMin} min). Read the curves, not one extreme point.</p>
      </details>
      <p className="fine-print" data-testid="scenario-definitions">Both curves come from one backend response at the same anchor. Synthetic-model outputs, not a measured or validated treatment effect.</p>
      <ChangeTable result={state.result} />
      </>}
      {warnings.filter(w => w.code !== 'SCENARIO_OUT_OF_RANGE').map(w => <p key={w.code + w.title} className="fine-print" data-testid="scenario-warning"><strong>{w.title}.</strong> {w.detail}</p>)}
      {moved && <p className="fine-print" data-testid="scenario-pinned-note">Pinned to the {formatTime(state.asOf)} UTC forecast; the live view has since advanced. Run again to simulate from the latest reading.</p>}
    </div>
  );
}

function ErrorPanel({ state }: { state: Extract<ScenarioState, { status: 'error' }> }) {
  const { error } = state;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, [error]);
  const body = {
    unsupported: 'The twin served here has no drug terms, so medication changes are refused rather than guessed. Meal, activity and skipped-meal scenarios are supported.',
    insufficient: 'The service will not simulate without a valid baseline forecast at this time point. No values have been substituted.',
    invalid: 'Adjust the inputs and try again.',
    contract: 'The response was discarded and nothing from it is shown.',
    unavailable: 'Check that the inference backend is running, then try again. Nothing has been simulated locally.',
  }[error.kind];
  return (
    <div ref={ref} tabIndex={-1} className={`whatif-error ${error.kind === 'unsupported' ? 'neutral' : ''}`} data-testid="scenario-error" data-kind={error.kind}>
      <strong>{error.title}</strong>
      <p>{body}</p>
      {error.detail && <p className="fine-print">Service detail ({error.code}): {error.detail}</p>}
    </div>
  );
}

/**
 * True while forecasts arrive much faster than the live pace (the stream's catch-up burst), so a
 * scenario is not pinned to an anchor that is about to be superseded. Live pace is one per 5 s.
 */
export function useSettlingAnchor(asOf: string | null, quietMs = 1500) {
  const [settling, setSettling] = useState(false);
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!asOf) return;
    const now = Date.now();
    const rapid = last.current != null && now - last.current < quietMs;
    last.current = now;
    if (!rapid) return;
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), quietMs);
    return () => clearTimeout(timer);
  }, [asOf, quietMs]);
  return settling;
}

/** One sentence for screen readers when the scenario state changes. */
export function announce(state: ScenarioState): string {
  if (state.status === 'loading') return `Simulating ${describeInput(state.input)}.`;
  if (state.status === 'error') return `${state.error.title}.`;
  if (state.status !== 'result') return '';
  const sum = summarizeComparison(state.result);
  const m = state.result.metrics;
  const risk = m.baseline_probability != null && m.new_probability != null ? ` Spike onset risk ${pct(m.baseline_probability)} to ${pct(m.new_probability)}.` : '';
  const warn = state.result.warnings.some(w => w.code === 'SCENARIO_OUT_OF_RANGE') ? ' Inputs are outside the training range.' : '';
  if (sum.noChange) return `Result ready: ${describeInput(state.input)}. Nothing changes in the next 2 hours.`;
  return `Result ready: ${describeInput(state.input)}. Largest change at the same time ${signed(sum.largestDiff, 1, ' mg/dL')} at +${sum.largestDiffMin} min.${risk}${warn}`;
}

export function ScenarioEditor({ patientId, currentForecast }: { patientId: string; currentForecast?: ForecastResponse | null }) {
  const liveAsOf = currentForecast?.as_of ?? null;
  const settling = useSettlingAnchor(liveAsOf);
  const asOf = settling ? null : liveAsOf;
  const { state, run, clear } = useScenario(patientId, asOf);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const medClass: MedClass = currentForecast?.ehr_context?.med_classes?.[0] ?? 'metformin';
  const built = buildScenarioInput(form, medClass);
  const loading = state.status === 'loading';
  const insufficient = currentForecast?.data_quality?.status === 'insufficient' || (currentForecast != null && !currentForecast.forecast);
  const canRun = !!asOf && !loading && 'input' in built;
  const set = (patch: Partial<FormState>) => setForm(f => ({ ...f, ...patch }));
  const submit = (f: FormState) => {
    const b = buildScenarioInput(f, medClass);
    if ('input' in b && asOf && !loading) void run(b.input);
  };

  return (
    <section className="whatif-panel" aria-labelledby="simulation-heading">
      <div className="section-heading">
        <h2 id="simulation-heading"><FlaskConical size={16} aria-hidden="true" /> What-if simulation</h2>
        <span className="status-badge">Live backend model</span>
      </div>
      <p className="whatif-intro">Change this patient&apos;s plan and the twin re-forecasts the next 2 hours from {liveAsOf ? <><time dateTime={liveAsOf}>{formatTime(liveAsOf)} UTC</time>, the moment of the current forecast</> : 'the moment of the current forecast'}.</p>
      <p className="whatif-disclaimer" data-testid="scenario-disclaimer"><strong>{SCENARIO_DISCLAIMER}</strong> The size of the change has not been validated against human data.</p>

      <ol className="whatif-sequence" aria-label="How a what-if works">
        <li><b>1</b>Start from Figure 1&apos;s forecast at {liveAsOf ? `${formatTime(liveAsOf)} UTC` : 'the current moment'}</li>
        <li><b>2</b>Choose a meal, activity or skipped meal</li>
        <li><b>3</b>The backend re-runs the twin and the network</li>
        <li><b>4</b>Compare the whole curve, the twin&apos;s response and the risk</li>
      </ol>
      <p className="whatif-step-label" id="whatif-presets-label">Try a common change</p>
      <div className="whatif-presets" role="group" aria-labelledby="whatif-presets-label">
        {PRESETS.map(p => {
          const Icon = PRESET_ICONS[p.id];
          const refused = p.id === 'medication';
          return (
            <button key={p.id} type="button" className={refused ? 'secondary-button preset preset-refused' : 'secondary-button preset'} disabled={!asOf || loading}
              aria-label={refused ? p.label : undefined}
              aria-pressed={activePreset === p.id}
              title={refused ? 'Not modelled: the backend refuses medication changes rather than guessing' : undefined}
              onClick={() => { const next = { ...form, ...p.form }; setForm(next); setActivePreset(p.id); submit(next); }}>
              {Icon && <Icon size={16} aria-hidden={true} />}<span>{p.label}</span>{refused && <small aria-hidden="true">not modelled</small>}
            </button>
          );
        })}
      </div>
      <p className="whatif-preset-note" data-testid="whatif-preset-note">Any added meal is outside the network&apos;s training range, so meal results come with a warning: read them against the physiology twin&apos;s response.</p>
      <p className="whatif-step-label">Or set your own</p>

      <form className="whatif-form" onSubmit={e => { e.preventDefault(); setActivePreset(null); submit(form); }}>
        <label>Change
          <select value={form.kind} disabled={loading} onChange={e => set({ kind: e.target.value as Kind })}>
            <option value="meal">Add a meal</option>
            <option value="activity">Add activity</option>
            <option value="skip_habitual_meal">Skip a usual meal (if one falls in the next 2 h)</option>
            <option value="medication">Medication change (not modelled)</option>
          </select>
        </label>
        {form.kind === 'meal' && <label>Carbohydrate (g)
          <input type="number" inputMode="decimal" min={0} max={250} value={form.carbs} disabled={loading} onChange={e => set({ carbs: e.target.value })} />
        </label>}
        {form.kind === 'activity' && <>
          <label>Duration (min)
            <input type="number" min={5} max={120} step={5} value={form.duration} disabled={loading} onChange={e => set({ duration: e.target.value })} />
          </label>
          <label>Intensity
            <select value={form.intensity} disabled={loading} onChange={e => set({ intensity: e.target.value as Intensity })}>
              <option value="light">Light</option>
              <option value="moderate">Moderate</option>
              <option value="vigorous">Vigorous</option>
            </select>
          </label>
        </>}
        {(form.kind === 'meal' || form.kind === 'activity') && <label>Starts in (min)
          <input type="number" min={0} max={120} step={5} value={form.offset} disabled={loading} onChange={e => set({ offset: e.target.value })} />
        </label>}
        {form.kind === 'skip_habitual_meal' && <label>Meal
          <select value={form.slot} disabled={loading} onChange={e => set({ slot: e.target.value as Slot })}>
            <option value="breakfast">Breakfast</option>
            <option value="lunch">Lunch</option>
            <option value="dinner">Dinner</option>
            <option value="snack">Snack</option>
          </select>
        </label>}
        <div className="whatif-actions">
          <button type="submit" className="primary-button" disabled={!canRun}>{loading ? 'Simulating…' : 'Run simulation'}</button>
          {state.status !== 'idle' && <button type="button" className="secondary-button" onClick={() => { setActivePreset(null); clear(); }}>{loading ? 'Cancel' : 'Clear'}</button>}
        </div>
        {'error' in built && <p role="alert" className="whatif-invalid">{built.error}</p>}
      </form>

      <p className="sr-only" aria-live="polite" data-testid="scenario-announcement">{announce(state)}</p>
      <div aria-busy={loading} className="whatif-output">
        {!asOf && !settling && <p className="fine-print" data-testid="scenario-waiting">Waiting for the first forecast before a scenario can run.</p>}
        {settling && <p className="fine-print" data-testid="scenario-settling">Loading recent history; simulation is available once the stream reaches the latest reading.</p>}
        {asOf && insufficient && state.status === 'idle' && <p className="fine-print" data-testid="scenario-insufficient-hint">Current data quality is insufficient; the service is expected to refuse a simulation at this point.</p>}
        {loading && <p className="fine-print" data-testid="scenario-loading">Running the twin and network for: {describeInput(state.input)}…</p>}
        {state.status === 'error' && <ErrorPanel state={state} />}
        {state.status === 'result' && <Readout state={state} liveAsOf={liveAsOf} />}
      </div>
    </section>
  );
}

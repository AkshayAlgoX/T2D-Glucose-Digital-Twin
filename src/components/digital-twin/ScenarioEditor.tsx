import React, { useEffect, useRef, useState } from 'react';
import * as d3Scale from 'd3-scale';
import * as d3Shape from 'd3-shape';
import { FlaskConical } from 'lucide-react';
import { formatTime } from '@/lib/formatters/date';
import { useScenario, type ScenarioComparison, type ScenarioCurvePoint, type ScenarioState } from '@/hooks/useScenario';
import type { ForecastResponse, MedClass, ScenarioInput } from '@/types/forecast-response';

export const SCENARIO_DISCLAIMER = 'Simulated model response — not a validated causal treatment effect.';

type Kind = 'meal' | 'activity' | 'skip_habitual_meal' | 'medication';
type Intensity = 'light' | 'moderate' | 'vigorous';
type Slot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

interface FormState { kind: Kind; carbs: string; offset: string; duration: string; intensity: Intensity; slot: Slot }

const DEFAULT_FORM: FormState = { kind: 'meal', carbs: '60', offset: '30', duration: '30', intensity: 'moderate', slot: 'dinner' };

const PRESETS: Array<{ id: string; label: string; form: Partial<FormState> }> = [
  { id: 'meal', label: '60 g carb meal in 30 min', form: { kind: 'meal', carbs: '60', offset: '30' } },
  { id: 'walk', label: '30 min brisk walk now', form: { kind: 'activity', duration: '30', intensity: 'moderate', offset: '0' } },
  { id: 'skip', label: 'Skip usual dinner', form: { kind: 'skip_habitual_meal', slot: 'dinner' } },
  { id: 'med', label: 'Medication change', form: { kind: 'medication', offset: '0' } },
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
  return {
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

export function ScenarioComparisonChart({ result }: { result: ScenarioComparison }) {
  const [ref, width] = useWidth<HTMLDivElement>(560);
  const height = width < 420 ? 190 : 220;
  const anchor = Date.parse(result.pinned_as_of);
  const toPoint = (p: ScenarioCurvePoint) => ({ ...p, min: (Date.parse(p.timestamp) - anchor) / 60000 });
  const base = result.baseline_forecast.map(toPoint);
  const scen = result.scenario_forecast.map(toPoint);
  const start = result.current_mg_dl != null ? [{ min: 0, p10: result.current_mg_dl, p50: result.current_mg_dl, p90: result.current_mg_dl }] : [];
  const values = [...base, ...scen].flatMap(p => [p.p10, p.p90]).concat(result.current_mg_dl ?? []);
  const yMin = Math.max(0, Math.floor((Math.min(...values) - 10) / 20) * 20);
  const yMax = Math.ceil((Math.max(200, ...values) + 10) / 20) * 20;
  const m = { left: 40, right: 12, top: 12, bottom: 30 };
  const x = d3Scale.scaleLinear().domain([0, 120]).range([m.left, width - m.right]);
  const y = d3Scale.scaleLinear().domain([yMin, yMax]).range([height - m.bottom, m.top]);
  type P = { min: number; p10: number; p50: number; p90: number };
  const line = d3Shape.line<P>().x(p => x(p.min)).y(p => y(p.p50));
  const band = d3Shape.area<P>().x(p => x(p.min)).y0(p => y(p.p10)).y1(p => y(p.p90));
  const yTicks = Array.from(new Set([...y.ticks(4), 180])).filter(t => t >= yMin && t <= yMax).sort((a, b) => a - b);
  return (
    <div ref={ref} className="whatif-chart">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="whatif-chart-title">
        <title id="whatif-chart-title">Baseline forecast compared with the simulated scenario over the next 120 minutes</title>
        {yTicks.map(t => <g key={t}>
          <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} stroke={t === 180 ? 'var(--color-line-control)' : 'var(--color-line)'} strokeDasharray={t === 180 ? '5 4' : undefined} />
          <text x={m.left - 6} y={y(t) + 4} textAnchor="end" className="chart-axis">{t}</text>
          {t === 180 && <text x={width - m.right} y={y(t) - 5} textAnchor="end" className="chart-axis">spike level</text>}
        </g>)}
        {(width < 420 ? [0, 60, 120] : [0, 30, 60, 90, 120]).map(t => <text key={t} x={x(t)} y={height - 10} textAnchor={t === 0 ? 'start' : t === 120 ? 'end' : 'middle'} className="chart-axis">{t === 0 ? 'now' : `+${t}m`}</text>)}
        <path d={band(base) ?? ''} fill="var(--color-forecast)" fillOpacity={0.12} />
        <path d={band(scen) ?? ''} fill="var(--color-projection)" fillOpacity={0.14} />
        <path data-testid="whatif-baseline-line" d={line([...start, ...base]) ?? ''} fill="none" stroke="var(--color-forecast)" strokeWidth={2.5} />
        <path data-testid="whatif-scenario-line" d={line([...start, ...scen]) ?? ''} fill="none" stroke="var(--color-projection)" strokeWidth={2.5} strokeDasharray="6 4" />
      </svg>
      <div className="whatif-legend" aria-hidden="true">
        <span><i className="whatif-swatch baseline" />Unchanged plan</span>
        <span><i className="whatif-swatch scenario" />With this change</span>
        <span>Shaded: P10–P90 · mg/dL</span>
      </div>
    </div>
  );
}

function Readout({ state, liveAsOf }: { state: Extract<ScenarioState, { status: 'result' }>; liveAsOf?: string | null }) {
  const { metrics, warnings, fallback_used } = state.result;
  const riskAvailable = metrics.baseline_probability != null && metrics.new_probability != null;
  const sum = summarizeComparison(state.result);
  const moved = liveAsOf != null && Date.parse(liveAsOf) !== Date.parse(state.asOf);
  return (
    <div className="whatif-result" data-testid="scenario-result">
      <p className="whatif-result-title">{describeInput(state.input)} · from <time dateTime={state.asOf}>{formatTime(state.asOf)} UTC</time></p>
      <dl className="whatif-metrics">
        <div>
          <dt>Highest median glucose in the next 2 h</dt>
          <dd data-testid="scenario-peak">{sum.baselinePeak.toFixed(1)} → {sum.scenarioPeak.toFixed(1)} mg/dL <strong>({signed(sum.deltaPeak, 1)})</strong>
            <small data-testid="scenario-peak-timing">at +{sum.baselinePeakMin} min → at +{sum.scenarioPeakMin} min</small></dd>
        </div>
        <div>
          <dt>Largest difference at the same time</dt>
          <dd data-testid="scenario-largest-diff">{signed(sum.largestDiff, 1, ' mg/dL')} <small>at +{sum.largestDiffMin} min</small></dd>
        </div>
        <div>
          <dt>Spike risk within 2 h (calibrated)</dt>
          <dd data-testid="scenario-risk">
            {riskAvailable
              ? <>{pct(metrics.baseline_probability)} → {pct(metrics.new_probability)} <strong>({signed(sum.deltaPoints ?? 0, 1, ' pts')})</strong></>
              : <>Unavailable{fallback_used === 'twin_only' ? ' (physics-only fallback; no calibrated risk)' : ''}</>}
          </dd>
        </div>
      </dl>
      <p className="fine-print" data-testid="scenario-definitions">Both curves come from one backend response at the same anchor. The highest values can fall at different times, so the largest same-time difference is shown too. Synthetic-model outputs, not a measured or validated treatment effect.</p>
      {sum.noChange && <p className="fine-print" data-testid="scenario-no-change">No change within the 2-hour horizon from this time point; for example, the skipped meal may fall outside this window.</p>}
      <ScenarioComparisonChart result={state.result} />
      {warnings.map(w => <p key={w.code + w.title} className="fine-print" data-testid="scenario-warning"><strong>{w.title}.</strong> {w.detail}</p>)}
      {moved && <p className="fine-print" data-testid="scenario-pinned-note">Pinned to the {formatTime(state.asOf)} UTC forecast; the live view has since advanced. Run again to simulate from the latest reading.</p>}
    </div>
  );
}

function ErrorPanel({ state }: { state: Extract<ScenarioState, { status: 'error' }> }) {
  const { error } = state;
  const body = {
    unsupported: 'The twin served here has no drug terms, so medication changes are refused rather than guessed. Meal, activity and skipped-meal scenarios are supported.',
    insufficient: 'The service will not simulate without a valid baseline forecast at this time point. No values have been substituted.',
    invalid: 'Adjust the inputs and try again.',
    contract: 'The response was discarded and nothing from it is shown.',
    unavailable: 'Check that the inference backend is running, then try again. Nothing has been simulated locally.',
  }[error.kind];
  return (
    <div className={`whatif-error ${error.kind === 'unsupported' ? 'neutral' : ''}`} data-testid="scenario-error" data-kind={error.kind}>
      <strong>{error.title}</strong>
      <p>{body}</p>
      {error.detail && <p className="fine-print">Service detail ({error.code}): {error.detail}</p>}
    </div>
  );
}

export function ScenarioEditor({ patientId, currentForecast }: { patientId: string; currentForecast?: ForecastResponse | null }) {
  const asOf = currentForecast?.as_of ?? null;
  const { state, run, clear } = useScenario(patientId, asOf);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
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
      <p className="whatif-intro">Change this patient&apos;s plan and the twin re-forecasts the next 2 hours from the same moment.</p>
      <p className="whatif-disclaimer" data-testid="scenario-disclaimer"><strong>{SCENARIO_DISCLAIMER}</strong> The size of the change has not been validated against human data.</p>

      <div className="whatif-presets" role="group" aria-label="Quick scenarios">
        {PRESETS.map(p => (
          <button key={p.id} type="button" className="secondary-button" disabled={!asOf || loading}
            onClick={() => { const next = { ...form, ...p.form }; setForm(next); submit(next); }}>
            {p.label}
          </button>
        ))}
      </div>

      <form className="whatif-form" onSubmit={e => { e.preventDefault(); submit(form); }}>
        <label>Change
          <select value={form.kind} disabled={loading} onChange={e => set({ kind: e.target.value as Kind })}>
            <option value="meal">Add a meal</option>
            <option value="activity">Add activity</option>
            <option value="skip_habitual_meal">Skip a usual meal</option>
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
          {state.status !== 'idle' && <button type="button" className="secondary-button" onClick={clear}>{loading ? 'Cancel' : 'Clear'}</button>}
        </div>
        {'error' in built && <p role="alert" className="whatif-invalid">{built.error}</p>}
      </form>

      <div aria-live="polite" aria-busy={loading} className="whatif-output">
        {!asOf && <p className="fine-print" data-testid="scenario-waiting">Waiting for the first forecast before a scenario can run.</p>}
        {asOf && insufficient && state.status === 'idle' && <p className="fine-print" data-testid="scenario-insufficient-hint">Current data quality is insufficient; the service is expected to refuse a simulation at this point.</p>}
        {loading && <p className="fine-print" data-testid="scenario-loading">Running the twin and network for: {describeInput(state.input)}…</p>}
        {state.status === 'error' && <ErrorPanel state={state} />}
        {state.status === 'result' && <Readout state={state} liveAsOf={asOf} />}
      </div>
    </section>
  );
}

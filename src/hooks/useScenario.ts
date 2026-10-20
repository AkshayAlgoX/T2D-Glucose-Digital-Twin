import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScenarioInput } from '@/types/forecast-response';

export interface ScenarioCurvePoint {
  timestamp: string;
  p10: number;
  p50: number;
  p90: number;
  twin_p50?: number | null;
}

export interface ScenarioMetrics {
  delta_peak_mg_dl: number;
  new_peak_mg_dl: number;
  baseline_peak_mg_dl: number;
  delta_probability: number | null;
  new_probability: number | null;
  baseline_probability: number | null;
}

export interface ScenarioWarning {
  code: string;
  title: string;
  detail?: string;
}

export interface ScenarioComparison {
  pinned_as_of: string;
  fallback_used: string | null;
  current_mg_dl: number | null;
  baseline_forecast: ScenarioCurvePoint[];
  scenario_forecast: ScenarioCurvePoint[];
  warnings: ScenarioWarning[];
  metrics: ScenarioMetrics;
}

export type ScenarioErrorKind = 'unsupported' | 'insufficient' | 'invalid' | 'contract' | 'unavailable';

export interface ScenarioError {
  kind: ScenarioErrorKind;
  code: string;
  title: string;
  detail?: string;
}

// Every non-idle state carries the patient and anchor it was requested for.
export type ScenarioState =
  | { status: 'idle' }
  | { status: 'loading'; patientId: string; asOf: string; input: ScenarioInput }
  | { status: 'result'; patientId: string; asOf: string; input: ScenarioInput; result: ScenarioComparison }
  | { status: 'error'; patientId: string; asOf: string; input: ScenarioInput; error: ScenarioError };

const IDLE: ScenarioState = { status: 'idle' };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isProbOrNull = (v: unknown) => v === null || (isNum(v) && v >= 0 && v <= 1);

function isCurve(v: unknown): v is ScenarioCurvePoint[] {
  return Array.isArray(v) && v.length === 24 && v.every(p =>
    p && typeof p.timestamp === 'string' && !Number.isNaN(Date.parse(p.timestamp))
    && isNum(p.p10) && isNum(p.p50) && isNum(p.p90));
}

/** Browser-side guard: the BFF validated the full contract; this only refuses shapes the view cannot draw honestly. */
export function parseScenarioComparison(body: unknown, asOf: string): ScenarioComparison | null {
  const b = body as Partial<ScenarioComparison> | null;
  if (!b || typeof b !== 'object' || typeof b.pinned_as_of !== 'string') return null;
  if (Date.parse(b.pinned_as_of) !== Date.parse(asOf)) return null;
  if (!isCurve(b.baseline_forecast) || !isCurve(b.scenario_forecast)) return null;
  const m = b.metrics;
  if (!m || !isNum(m.delta_peak_mg_dl) || !isNum(m.new_peak_mg_dl) || !isNum(m.baseline_peak_mg_dl)) return null;
  if (!isProbOrNull(m.baseline_probability) || !isProbOrNull(m.new_probability)) return null;
  if (m.delta_probability !== null && !(isNum(m.delta_probability) && Math.abs(m.delta_probability) <= 1)) return null;
  return {
    pinned_as_of: b.pinned_as_of,
    fallback_used: typeof b.fallback_used === 'string' ? b.fallback_used : null,
    current_mg_dl: isNum(b.current_mg_dl) ? b.current_mg_dl : null,
    baseline_forecast: b.baseline_forecast,
    scenario_forecast: b.scenario_forecast,
    warnings: Array.isArray(b.warnings) ? b.warnings.filter(w => w && typeof w.code === 'string' && typeof w.title === 'string') : [],
    metrics: m as ScenarioMetrics,
  };
}

export function classifyScenarioError(status: number, body: unknown): ScenarioError {
  const b = (body ?? {}) as { code?: unknown; title?: unknown; detail?: unknown; error?: unknown };
  const code = typeof b.code === 'string' ? b.code : '';
  const detail = typeof b.detail === 'string' ? b.detail : typeof b.error === 'string' ? b.error : undefined;
  if (code === 'SCENARIO_UNSUPPORTED') {
    return { kind: 'unsupported', code, title: 'Medication changes are not supported', detail };
  }
  if (code === 'REQUEST_INVALID' || status === 400) {
    return { kind: 'invalid', code: code || 'REQUEST_INVALID', title: 'The scenario was rejected as invalid', detail };
  }
  if (status === 422 && (!code || /INSUFFICIENT/.test(code))) {
    return { kind: 'insufficient', code: code || 'INSUFFICIENT_DATA', title: 'Not enough recent data to simulate from this point', detail };
  }
  if (status === 422) {
    return { kind: 'invalid', code, title: typeof b.title === 'string' ? b.title : 'The scenario was rejected', detail };
  }
  if (status === 502 && /contract/i.test(detail ?? '')) {
    return { kind: 'contract', code: 'CONTRACT_INVALID', title: 'The simulation response failed contract validation', detail };
  }
  return { kind: 'unavailable', code: code || `HTTP_${status}`, title: 'Simulation service unavailable', detail };
}

export function useScenario(patientId: string, asOf: string | null | undefined) {
  const [state, setState] = useState<ScenarioState>(IDLE);
  const seqRef = useRef(0);
  const ctlRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    seqRef.current++;
    ctlRef.current?.abort();
    ctlRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  // A different patient drops everything; a moving live anchor does not (results stay pinned to theirs).
  useEffect(() => {
    cancel();
    setState(IDLE);
  }, [patientId, cancel]);

  const run = useCallback(async (input: ScenarioInput) => {
    if (!patientId || !asOf) return;
    cancel();
    const seq = ++seqRef.current;
    const ctl = new AbortController();
    ctlRef.current = ctl;
    const pinned = asOf;
    const current = () => seq === seqRef.current && !ctl.signal.aborted;
    setState({ status: 'loading', patientId, asOf: pinned, input });
    try {
      const res = await fetch('/api/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId,
          pinned_as_of: pinned,
          scenarios: [{ scenario_id: 'what-if', label: 'Clinician what-if', inputs: [input] }],
        }),
        signal: ctl.signal,
      });
      const body: unknown = await res.json().catch(() => null);
      if (!current()) return;
      if (!res.ok) {
        setState({ status: 'error', patientId, asOf: pinned, input, error: classifyScenarioError(res.status, body) });
        return;
      }
      const result = parseScenarioComparison(body, pinned);
      if (!result) {
        setState({ status: 'error', patientId, asOf: pinned, input,
          error: { kind: 'contract', code: 'CONTRACT_INVALID', title: 'The simulation response failed validation' } });
        return;
      }
      setState({ status: 'result', patientId, asOf: pinned, input, result });
    } catch {
      if (!current()) return;
      setState({ status: 'error', patientId, asOf: pinned, input,
        error: { kind: 'unavailable', code: 'NETWORK_ERROR', title: 'Could not reach the dashboard server' } });
    } finally {
      if (ctlRef.current === ctl) ctlRef.current = null;
    }
  }, [patientId, asOf, cancel]);

  const clear = useCallback(() => {
    cancel();
    setState(IDLE);
  }, [cancel]);

  return { state, run, clear };
}

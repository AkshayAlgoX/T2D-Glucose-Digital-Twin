import { DEMO_SUBJECT_ID } from './landing';
import { HERO_AS_OF, parseForecastEvents } from './hero';

/** Art-direction prototypes only: one genuine replay of P0017 to 08:00 UTC, six hours of history. */
export interface LabPoint { offset_min: number; p05: number; p10: number; p25: number; p50: number; p75: number; p90: number; p95: number; twin: number | null }
export interface LabInput { t: string; hr: number | null; hrv: number | null; steps: number | null; asleep: boolean | null; carbs: number | null }
export interface LabData {
  asOf: string;
  patient: string;
  group: string;
  split: string;
  ehr: { age_years: number; sex: string; bmi: number; hba1c_pct: number; on_medication: boolean } | null;
  observed: Array<{ t: string; v: number }>;
  inputs: LabInput[];
  current: number;
  trend: number | null;
  points: LabPoint[];
  onset: number | null;
  cumulative: Array<{ offset_min: number; p: number }>;
  insulinSensitivity: number | null;
  fitRmse: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function readLabData(): Promise<LabData | null> {
  const base = process.env.BACKEND_URL;
  if (!base) return null;
  const start = new Date(Date.parse(HERO_AS_OF) - 360 * 60000).toISOString().replace('.000Z', 'Z');
  try {
    const [stream, subjects, twin] = await Promise.all([
      fetch(`${base}/v1/subjects/${DEMO_SUBJECT_ID}/stream?as_of=${start}&speed=0&max_events=110&catch_up=110&include=twin_overlay`, { headers: { Accept: 'text/event-stream' }, cache: 'no-store' }).then(r => r.text()),
      fetch(`${base}/v1/subjects`, { cache: 'no-store' }).then(r => r.json()),
      fetch(`${base}/v1/subjects/${DEMO_SUBJECT_ID}/twin`, { cache: 'no-store' }).then(r => r.json()),
    ]);
    const target = Date.parse(HERO_AS_OF);
    const fc = parseForecastEvents(stream).filter(f => Date.parse(f.as_of) <= target).sort((a, b) => Date.parse(a.as_of) - Date.parse(b.as_of));
    const anchor = fc.find(f => Date.parse(f.as_of) === target);
    if (!anchor) return null;
    const subject = (subjects as any[]).find(s => s.subject_id === DEMO_SUBJECT_ID);
    const isf = (twin?.parameters ?? []).find((p: any) => p.key === 'insulin_sensitivity_rel');
    return {
      asOf: anchor.as_of,
      patient: subject?.patient_id ?? 'P0017',
      group: subject?.group ?? '',
      split: subject?.split ?? '',
      ehr: subject?.ehr ?? null,
      observed: fc.filter(f => num(f.current?.value_mg_dl) != null).map(f => ({ t: f.as_of, v: f.current.value_mg_dl })),
      inputs: fc.map(f => ({
        t: f.as_of,
        hr: num(f.observed_inputs?.heart_rate_bpm),
        hrv: num(f.observed_inputs?.hrv_rmssd_ms),
        steps: num(f.observed_inputs?.steps_5min),
        asleep: typeof f.observed_inputs?.asleep === 'boolean' ? f.observed_inputs.asleep : null,
        carbs: num(f.observed_inputs?.carbs_logged_g),
      })),
      current: anchor.current.value_mg_dl,
      trend: num(anchor.current?.trend_mg_dl_per_min),
      points: anchor.forecast.points.map((p: any) => ({ offset_min: p.offset_min, p05: p.p05, p10: p.p10, p25: p.p25, p50: p.p50, p75: p.p75, p90: p.p90, p95: p.p95, twin: num(p.twin_p50) })),
      onset: num(anchor.spike_risk?.probability_120m),
      cumulative: anchor.spike_risk?.cumulative ?? [],
      insulinSensitivity: num(isf?.value),
      fitRmse: num(twin?.fit_quality?.rmse_60m_14d_mg_dl),
    };
  } catch {
    return null;
  }
}

/** First and last forecast offsets where a series is above the spike level, or null. */
export function aboveWindow(points: LabPoint[], key: 'p10' | 'p50' | 'p90', level = 180): [number, number] | null {
  const hits = points.filter(p => p[key] > level).map(p => p.offset_min);
  return hits.length ? [hits[0], hits[hits.length - 1]] : null;
}

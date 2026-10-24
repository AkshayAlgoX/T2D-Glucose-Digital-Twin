import { DEMO_SUBJECT_ID } from './landing';

/** The moment the workspace replay opens on for every subject: 08:00 UTC on the cohort's first morning. */
export const HERO_AS_OF = '2026-09-29T08:00:00Z';
const HISTORY_MIN = 120;

export interface HeroPoint { offset_min: number; p05?: number | null; p10: number; p25?: number | null; p50: number; p75?: number | null; p90: number; p95?: number | null; twin_p50: number | null }
/** Wearable and log readings received with each replayed forecast; null where none was received. */
export interface HeroInput { t: string; hr: number | null; hrv: number | null; steps: number | null; asleep: boolean | null; carbs: number | null }
export interface HeroForecast {
  asOf: string;
  patientId: string;
  observed: Array<{ t: string; v: number }>;
  current: number;
  points: HeroPoint[];
  inputs?: HeroInput[];
  /** The subject's served EHR summary and partition, from /v1/subjects; absent if it could not be read. */
  subject?: { group: string | null; split: string | null; age_years: number | null; sex: string | null; bmi: number | null; hba1c_pct: number | null } | null;
  probability: number | null;
  calibrated: boolean;
  modelName: string | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parses the backend replay stream (Server-Sent Events) into the forecasts it carried. */
export function parseForecastEvents(text: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const event = JSON.parse(line.slice(5));
      if (event?.event === 'forecast.updated' && event.payload) out.push(event.payload);
    } catch { /* a malformed event is skipped, never repaired */ }
  }
  return out;
}

/** Builds the hero figure from genuine replayed forecasts; null unless every value it needs is present. */
export function heroFromForecasts(forecasts: Array<Record<string, any>>, asOf = HERO_AS_OF): HeroForecast | null {
  const target = Date.parse(asOf);
  const inWindow = forecasts.filter(f => {
    const t = Date.parse(f?.as_of);
    return Number.isFinite(t) && t <= target && t >= target - HISTORY_MIN * 60000;
  });
  const anchor = inWindow.find(f => Date.parse(f.as_of) === target);
  if (!anchor || !finite(anchor.current?.value_mg_dl) || !Array.isArray(anchor.forecast?.points)) return null;
  const observed = inWindow
    .filter(f => finite(f.current?.value_mg_dl))
    .map(f => ({ t: f.as_of as string, v: f.current.value_mg_dl as number }))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const points: HeroPoint[] = anchor.forecast.points
    .filter((p: any) => finite(p?.offset_min) && finite(p.p10) && finite(p.p50) && finite(p.p90))
    .map((p: any) => ({
      offset_min: p.offset_min, p10: p.p10, p50: p.p50, p90: p.p90, twin_p50: finite(p.twin_p50) ? p.twin_p50 : null,
      p05: finite(p.p05) ? p.p05 : null, p25: finite(p.p25) ? p.p25 : null, p75: finite(p.p75) ? p.p75 : null, p95: finite(p.p95) ? p.p95 : null,
    }));
  const inputs: HeroInput[] = inWindow
    .filter(f => f.observed_inputs && typeof f.observed_inputs === 'object')
    .map(f => {
      const o = f.observed_inputs;
      return { t: f.as_of as string, hr: finite(o.heart_rate_bpm) ? o.heart_rate_bpm : null, hrv: finite(o.hrv_rmssd_ms) ? o.hrv_rmssd_ms : null,
        steps: finite(o.steps_5min) ? o.steps_5min : null, asleep: typeof o.asleep === 'boolean' ? o.asleep : null, carbs: finite(o.carbs_logged_g) ? o.carbs_logged_g : null };
    })
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  if (points.length < 2 || observed.length < 2) return null;
  const risk = anchor.spike_risk;
  return {
    asOf: anchor.as_of,
    patientId: anchor.subject?.simulator?.param_set_id ?? 'P0017',
    observed,
    current: anchor.current.value_mg_dl,
    points,
    inputs,
    probability: finite(risk?.probability_120m) ? risk.probability_120m : null,
    calibrated: risk?.calibrated === true,
    modelName: typeof anchor.model?.name === 'string' ? anchor.model.name : null,
  };
}

let cache: { at: number; value: HeroForecast } | null = null;
let inFlight: Promise<HeroForecast | null> | null = null;
const CACHE_MS = 10 * 60 * 1000;

async function fetchHeroForecast(): Promise<HeroForecast | null> {
  const backendUrl = process.env.BACKEND_URL;
  if (!backendUrl) return null;
  const start = new Date(Date.parse(HERO_AS_OF) - HISTORY_MIN * 60000).toISOString().replace('.000Z', 'Z');
  const url = `${backendUrl}/v1/subjects/${DEMO_SUBJECT_ID}/stream?as_of=${start}&speed=0&max_events=40&catch_up=40&include=twin_overlay`;
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (process.env.PR_TFT_SERVICE_TOKEN) headers.Authorization = `Bearer ${process.env.PR_TFT_SERVICE_TOKEN}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const value = heroFromForecasts(parseForecastEvents(await res.text()));
    if (value) {
      value.subject = await fetch(`${backendUrl}/v1/subjects`, { headers: { ...headers, Accept: 'application/json' }, signal: controller.signal, cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .then((list: any) => {
          const s = Array.isArray(list) ? list.find((x: any) => x?.subject_id === DEMO_SUBJECT_ID) : null;
          if (!s) return null;
          const n = (v: unknown) => (finite(v) ? v : null);
          return { group: typeof s.group === 'string' ? s.group : null, split: typeof s.split === 'string' ? s.split : null,
            age_years: n(s.ehr?.age_years), sex: typeof s.ehr?.sex === 'string' ? s.ehr.sex : null, bmi: n(s.ehr?.bmi), hba1c_pct: n(s.ehr?.hba1c_pct) };
        })
        .catch(() => null);
      cache = { at: Date.now(), value };
    }
    return value;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Replays the demonstration subject's last two hours up to HERO_AS_OF from the running backend. */
export async function readHeroForecast(): Promise<HeroForecast | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (inFlight) return inFlight;
  inFlight = fetchHeroForecast().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

import { HERO_AS_OF } from './hero';

/**
 * The ward view: every validation subject's served forecast at the replay hold, ranked by the
 * backend's calibrated 2-hour onset risk. Training subjects are in-sample and are not shown.
 * Every value comes from /v1/forecasts; a subject whose forecast cannot be read is counted, never filled in.
 */
export interface WardRow {
  subjectId: string;
  patientId: string;
  group: string;
  current: number;
  trend: string | null;
  probability: number;
  alert: string;
  /** First and last forecast offsets (min) at which the median is above 180 mg/dL; null if never. */
  medianAbove: [number, number] | null;
  peak: number;
  peakMin: number;
}
/** Patients the service declined to forecast at the hold (data-quality status), shown by name, never ranked. */
export interface WardWithheld { patientId: string; subjectId: string; reason: string }
export interface Ward { asOf: string; rows: WardRow[]; requested: number; withheld: WardWithheld[]; failed: number }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const LEVEL = 180;

/** One ward row from a subject summary and its served forecast; null unless every shown value is present. */
export function wardRow(subject: Record<string, any>, f: Record<string, any> | null): WardRow | null {
  if (!f || f.subject?.subject_id !== subject.subject_id) return null;
  const p = f.spike_risk?.probability_120m;
  const cur = f.current?.value_mg_dl;
  const pts = Array.isArray(f.forecast?.points) ? f.forecast.points.filter((q: any) => finite(q?.offset_min) && finite(q?.p50)) : [];
  if (!finite(p) || !finite(cur) || pts.length === 0 || typeof subject.patient_id !== 'string') return null;
  const above = pts.filter((q: any) => q.p50 > LEVEL).map((q: any) => q.offset_min as number);
  const top = pts.reduce((a: any, b: any) => (b.p50 > a.p50 ? b : a));
  return {
    subjectId: subject.subject_id, patientId: subject.patient_id, group: String(subject.group ?? '—'),
    current: cur, trend: typeof f.current?.trend_arrow === 'string' ? f.current.trend_arrow : null,
    probability: p, alert: typeof f.alert?.state === 'string' ? f.alert.state : 'none',
    medianAbove: above.length ? [Math.min(...above), Math.max(...above)] : null,
    peak: top.p50, peakMin: top.offset_min,
  };
}

/** Highest onset risk first; ties broken by how soon the median crosses 180, then by current glucose. */
export function rankWard(rows: WardRow[]): WardRow[] {
  return [...rows].sort((a, b) => b.probability - a.probability
    || (a.medianAbove?.[0] ?? Infinity) - (b.medianAbove?.[0] ?? Infinity)
    || b.current - a.current);
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/** Reads the ward from the backend: subjects, then one forecast per validation subject at the replay hold. */
export async function readWard(backendUrl: string, token?: string, fetchImpl: typeof fetch = fetch, asOf = HERO_AS_OF): Promise<Ward> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(`${backendUrl}/v1/subjects`, { headers, cache: 'no-store' });
  if (!res.ok) throw new Error(`subjects ${res.status}`);
  const subjects = (await res.json() as Array<Record<string, any>>).filter(s => s?.split === 'val' && typeof s.subject_id === 'string');
  const forecasts = await pool(subjects, 6, async s => {
    try {
      const r = await fetchImpl(`${backendUrl}/v1/forecasts`, {
        method: 'POST', headers, cache: 'no-store',
        body: JSON.stringify({ schema_version: '1.0.0', request_id: crypto.randomUUID(), subject_id: s.subject_id, as_of: asOf, include: [] }),
      });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  });
  const rows: WardRow[] = [];
  const withheld: WardWithheld[] = [];
  let failed = 0;
  subjects.forEach((s, i) => {
    const row = wardRow(s, forecasts[i]);
    const dq = forecasts[i]?.data_quality;
    if (row) rows.push(row);
    else if (forecasts[i] && dq?.status === 'insufficient') {
      withheld.push({ patientId: String(s.patient_id), subjectId: s.subject_id, reason: Array.isArray(dq.reasons) && dq.reasons.length ? dq.reasons.join(', ').replace(/_/g, ' ') : 'insufficient data' });
    } else failed += 1;
  });
  return { asOf, rows: rankWard(rows), requested: subjects.length, withheld, failed };
}

// The forecast at a fixed hold is deterministic for a given backend, so a short-lived cache is safe.
let cached: { at: number; ward: Promise<Ward> } | null = null;
const TTL_MS = 10 * 60 * 1000;
export function readWardCached(backendUrl: string, token?: string): Promise<Ward> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.ward;
  const ward = readWard(backendUrl, token).then(w => {
    if (w.rows.length === 0) cached = null;
    return w;
  }, err => { cached = null; throw err; });
  cached = { at: Date.now(), ward };
  return ward;
}

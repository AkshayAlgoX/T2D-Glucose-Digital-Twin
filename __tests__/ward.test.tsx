import React from 'react';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import { wardRow, rankWard, readWard, type Ward } from '../src/lib/ward';
import { WardTriage } from '../src/components/digital-twin/WardTriage';
import { HERO_AS_OF } from '../src/lib/hero';

const subj = (n: number, split = 'val', group = 'Type 2') => ({ subject_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, patient_id: `P${String(n).padStart(4, '0')}`, split, group });
const forecast = (s: { subject_id: string }, p: number, cur = 150, peak = 200) => ({
  subject: { subject_id: s.subject_id },
  spike_risk: { probability_120m: p },
  current: { value_mg_dl: cur, trend_arrow: 'rising' },
  alert: { state: p >= 0.6 ? 'warning' : p >= 0.35 ? 'watch' : 'none' },
  data_quality: { status: 'ok' },
  forecast: { points: [5, 30, 60, 90, 120].map((m, i) => ({ offset_min: m, p50: [cur + 5, 185, peak, 182, 170][i] })) },
});

describe('ward rows', () => {
  it('builds a row only when every shown value is present and belongs to the subject', () => {
    const s = subj(1);
    const row = wardRow(s, forecast(s, 0.53, 148, 217));
    expect(row).toMatchObject({ patientId: 'P0001', probability: 0.53, current: 148, alert: 'watch', medianAbove: [30, 90], peak: 217, peakMin: 60, trend: 'rising' });
    expect(wardRow(s, { ...forecast(s, 0.5), spike_risk: null })).toBeNull();
    expect(wardRow(s, { ...forecast(s, 0.5), current: { value_mg_dl: null } })).toBeNull();
    expect(wardRow(s, forecast(subj(2), 0.5))).toBeNull();
    expect(wardRow(s, null)).toBeNull();
  });

  it('ranks by risk, then by how soon the median crosses 180, then by current glucose', () => {
    const a = wardRow(subj(1), forecast(subj(1), 0.4))!;
    const b = wardRow(subj(2), forecast(subj(2), 0.7))!;
    const c = { ...wardRow(subj(3), forecast(subj(3), 0.4))!, medianAbove: [10, 40] as [number, number] };
    expect(rankWard([a, b, c]).map(r => r.patientId)).toEqual(['P0002', 'P0003', 'P0001']);
  });
});

describe('readWard', () => {
  it('requests forecasts at the replay hold for validation subjects only, and separates withheld from failed', async () => {
    const subjects = [subj(1), subj(2), subj(3, 'train'), subj(4), subj(5)];
    const requested: string[] = [];
    const fetchImpl = jest.fn(async (url: string, init?: any) => {
      if (url.endsWith('/v1/subjects')) return { ok: true, json: async () => subjects } as any;
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({ schema_version: '1.0.0', as_of: HERO_AS_OF, include: [] });
      requested.push(body.subject_id);
      const s = subjects.find(x => x.subject_id === body.subject_id)!;
      if (s.patient_id === 'P0004') return { ok: true, json: async () => ({ subject: { subject_id: s.subject_id }, spike_risk: null, current: { value_mg_dl: null }, data_quality: { status: 'insufficient', reasons: ['stale_data'] }, forecast: { points: [] } }) } as any;
      if (s.patient_id === 'P0005') return { ok: false, status: 500, json: async () => ({}) } as any;
      return { ok: true, json: async () => forecast(s, s.patient_id === 'P0002' ? 0.8 : 0.2) } as any;
    });
    const w = await readWard('http://backend', undefined, fetchImpl as any);
    expect(requested).not.toContain(subj(3, 'train').subject_id);
    expect(requested).toHaveLength(4);
    expect(w.rows.map(r => r.patientId)).toEqual(['P0002', 'P0001']);
    expect(w.withheld).toEqual([{ patientId: 'P0004', subjectId: subj(4).subject_id, reason: 'stale data' }]);
    expect(w.failed).toBe(1);
    expect(w.requested).toBe(4);
  });
});

describe('WardTriage', () => {
  const ward = (n: number): Ward => ({
    asOf: HERO_AS_OF, requested: n + 1, failed: 0,
    withheld: [{ patientId: 'P0051', subjectId: subj(51).subject_id, reason: 'stale data' }],
    rows: rankWard(Array.from({ length: n }, (_, i) => wardRow(subj(i + 1), forecast(subj(i + 1), 0.9 - i * 0.07))!)),
  });
  afterEach(() => { (global.fetch as any) = undefined; });

  it('ranks patients with links, risk, alert tier and the median window; expands to all', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ward(10) }) as any;
    render(<WardTriage />);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(8);
    expect(within(rows[0]).getByRole('link', { name: 'P0001' })).toHaveAttribute('href', `/patients/${subj(1).subject_id}`);
    expect(rows[0]).toHaveTextContent('90%');
    expect(rows[0]).toHaveTextContent('Warning');
    expect(rows[0]).toHaveTextContent('+30 to +90 min');
    expect(screen.getByTestId('ward-count')).toHaveTextContent('8 of 10 at or above the 35% watch line');
    expect(screen.getByTestId('ward-withheld')).toHaveTextContent('No forecast at this hold for P0051 (stale data).');
    fireEvent.click(screen.getByRole('button', { name: 'Show all 10' }));
    expect(within(table).getAllByRole('row')).toHaveLength(11);
  });

  it('shows nothing ranked when the service cannot be read', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }) as any;
    render(<WardTriage />);
    await waitFor(() => expect(screen.getByTestId('ward-error')).toBeInTheDocument());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

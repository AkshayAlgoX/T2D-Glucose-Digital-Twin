import React from 'react';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { render, screen, within } from '@testing-library/react';
import { readEventEvaluation, EVENT_ROWS } from '../src/lib/landing';
import { EventWarning } from '../src/components/figure/EvidenceFigures';

const c = (e: number, lo: number, hi: number) => ({ estimate: e, ci_low: lo, ci_high: hi });
const model = (s: number) => ({
  event_sensitivity: c(s, s - 0.1, s + 0.05), alert_precision: c(0.6, 0.5, 0.7),
  false_alerts_per_patient_day: c(0.8, 0.6, 1.0), lead_time_median_min: c(45, 35, 55),
  counts: { monitored_onsets: 100, detected_onsets: Math.round(s * 100), missed_onsets: 100 - Math.round(s * 100), alerts_raised: 150, true_alerts: 90, false_alerts: 60 },
  patient_days: 290.5, lead_time_distribution_min: { n: 80, share_ge_30_min: 0.7 },
});
const report = () => ({
  schema: 'pr_tft_validation_event_evaluation/v1', provenance: { limited_to_patients: null },
  populations: { primary: { patients: 29, groups: { Prediabetes: 19, 'Type 2': 10 }, models: Object.fromEntries(EVENT_ROWS.map((k, i) => [k, model(0.9 - i * 0.1)])) } },
});
const write = (obj: unknown) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), 'r.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f; };

describe('Early-warning evidence', () => {
  it('reads every row and renders counts, intervals and the development-evidence boundary', async () => {
    const data = await readEventEvaluation(write(report()));
    expect(data?.rows.map(r => r.key)).toEqual([...EVENT_ROWS]);
    render(<EventWarning data={data!} />);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(EVENT_ROWS.length + 1);
    expect(within(table).getByRole('row', { name: /Hybrid onset risk ≥ 0.35/ })).toHaveTextContent('Hybrid onset risk ≥ 0.3590% (80%–95%)10 of 1000.80 (0.60–1.00)45 min (35–55)60% (50%–70%)');
    expect(screen.getByText(/Development evidence on synthetic data/)).toBeInTheDocument();
    expect(screen.getByText(/test split was not opened/)).toBeInTheDocument();
  });

  it('fails closed on a smoke run, a missing row, a wrong schema or an unreadable file', async () => {
    const smoke = report(); smoke.provenance.limited_to_patients = 2 as unknown as null;
    expect(await readEventEvaluation(write(smoke))).toBeNull();
    const missing = report(); delete (missing.populations.primary.models as Record<string, unknown>)['twin_only'];
    expect(await readEventEvaluation(write(missing))).toBeNull();
    expect(await readEventEvaluation(write({ ...report(), schema: 'other' }))).toBeNull();
    expect(await readEventEvaluation('/nonexistent/report.json')).toBeNull();
  });
});

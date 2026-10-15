import React from 'react';
import { renderToString } from 'react-dom/server';
import { ForecastCanvas } from '../src/components/digital-twin/ForecastCanvas';
import { RiskStrip } from '../src/components/digital-twin/RiskStrip';
import type { ForecastResponse } from '../src/types/forecast-response';
import type { SubjectStore } from '../src/lib/types';

// Existing-contract presentation fixtures; no inference or scientific dataset.
const cache: SubjectStore = { patientId: 'unit-subject', cgm: [], risk: [], alerts: [], dataQuality: [] };

it('server-renders a single forecast SVG title string without a React title warning', () => {
  const forecast = { as_of: '2026-10-04T12:00:00Z', current: { value_mg_dl: 110 }, forecast: { points: [] }, spike_risk: { peak_mg_dl: { p50: 130 }, time_to_peak_min: 60 } } as ForecastResponse;
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const html = renderToString(<ForecastCanvas forecast={forecast} cache={cache} />);
    expect(html).toMatch(/<title[^>]*>Glucose forecast chart: current 110 mg\/dL<\/title>/);
    expect(html).toContain('<title>Reported peak estimate: 130 mg/dL</title>');
    expect(error).not.toHaveBeenCalled();
  } finally { error.mockRestore(); }
});

it('server-renders exact received risk marker titles without a React title warning', () => {
  const risk = [{ t: '2026-10-04T11:55:00Z', p: 0.123456 }, { t: '2026-10-04T12:00:00Z', p: 0.234567 }];
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const html = renderToString(<RiskStrip forecast={null} cache={{ ...cache, risk }} />);
    risk.forEach(point => expect(html).toContain(`<title>${point.t} · onset probability ${point.p}</title>`));
    expect(error).not.toHaveBeenCalled();
  } finally { error.mockRestore(); }
});

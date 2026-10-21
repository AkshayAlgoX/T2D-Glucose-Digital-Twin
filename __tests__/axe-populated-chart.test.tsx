import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { PatientWorkspace } from '../src/components/digital-twin/PatientWorkspace';
import { ForecastResponseSchema } from '../src/lib/zod-schemas';
import type { ForecastResponse } from '../src/types/forecast-response';
import source from './fixtures/risk-audit-forecast.json';

expect.extend(toHaveNoViolations);

// Presentation fixture: the committed forecast plus a twin line and two hours of CGM,
// so axe sees the chart as a viewer does (bands, wedge, dots, markers, tooltip).
function populated() {
  const forecast = ForecastResponseSchema.parse({
    ...source,
    forecast: { ...source.forecast, points: source.forecast.points.map(p => ({ ...p, twin_p50: p.p50 + 12 })) },
  }) as ForecastResponse;
  const anchor = Date.parse(forecast.as_of);
  const cgm = Array.from({ length: 24 }, (_, i) => ({ t: new Date(anchor - (23 - i) * 300000).toISOString(), value: 104 + i * 0.6, trend: 'flat' }));
  return { forecast, cgm };
}

describe('Axe on a populated forecast chart', () => {
  it('has no violations, names the chart, and announces a keyboard selection', async () => {
    const { forecast, cgm } = populated();
    const { container } = render(<PatientWorkspace patientId={forecast.subject.subject_id} forecast={forecast}
      cache={{ patientId: forecast.subject.subject_id, cgm, risk: [], alerts: [], dataQuality: [] }} isConnected isStale={false} />);

    expect(screen.getAllByTestId('observed-segment').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('adjustment-wedge').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('quantile-band').length).toBeGreaterThan(0);

    const chart = screen.getByRole('img', { name: /Glucose forecast chart: current 117 mg\/dL/ });
    const desc = document.getElementById(chart.getAttribute('aria-describedby')!.split(' ')[0]);
    expect(desc?.tagName.toLowerCase()).toBe('desc');
    expect(desc?.textContent).toMatch(/median line with 50, 80 and 90% bands/);

    act(() => { chart.focus(); });
    fireEvent.keyDown(chart, { key: 'End' });
    const live = container.querySelector('.chart-readout [aria-live]')!;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toMatch(/Median \d+(\.\d)? mg\/dL · P10–P90 .* \+120 min of 120 min forecast horizon/);

    expect(await axe(container)).toHaveNoViolations();
  });
});

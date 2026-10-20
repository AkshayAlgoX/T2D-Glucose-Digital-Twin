import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { ForecastCanvas } from '../src/components/digital-twin/ForecastCanvas';
import type { ForecastResponse } from '../src/types/forecast-response';
import type { SubjectStore, WearableView } from '../src/lib/types';

// Unit-test fixture shaped like the served contract; not application data or evidence.
const anchor = '2026-09-29T05:55:00Z';
const at = (minutesBefore: number) => new Date(Date.parse(anchor) - minutesBefore * 60000).toISOString();
const forecast = {
  as_of: anchor, subject: { subject_id: 'unit', synthetic: true }, current: { value_mg_dl: 92 },
  forecast: { units: 'mg/dL', step_min: 5, horizon_min: 120, points: Array.from({ length: 24 }, (_, i) => ({
    offset_min: (i + 1) * 5, p05: 80, p10: 85, p25: 90, p50: 95, p75: 100, p90: 105, p95: 110, twin_p50: 94 })) },
} as unknown as ForecastResponse;

function store(wearables: WearableView[]): SubjectStore {
  return { patientId: 'unit', cgm: wearables.map(w => ({ t: w.t, value: 92, trend: 'flat' })), risk: [], alerts: [], dataQuality: [], wearables };
}

it('draws the wearable and meal-log inputs on the chart time axis with the latest readings', () => {
  const wearables: WearableView[] = [
    { t: at(10), heartRate: 61, hrv: 30, steps: 0, asleep: true, carbs: 0 },
    { t: at(5), heartRate: 64, hrv: 28, steps: 120, asleep: false, carbs: 45 },
    { t: at(0), heartRate: 66.4, hrv: 29.2, steps: 40, asleep: false, carbs: 0 },
  ];
  render(<ForecastCanvas forecast={forecast} cache={store(wearables)} />);
  const lanes = screen.getByRole('region', { name: 'Wearable and log inputs the model used' });
  expect(within(screen.getByTestId('lane-hr')).getByText(/66 bpm/)).toBeInTheDocument();
  expect(within(screen.getByTestId('lane-hrv')).getByText(/29 ms/)).toBeInTheDocument();
  expect(within(screen.getByTestId('lane-steps')).getByText(/40 per 5 min/)).toBeInTheDocument();
  expect(within(screen.getByTestId('lane-sleep')).getByText('Awake')).toBeInTheDocument();
  expect(within(screen.getByTestId('lane-meals')).getByText('45 g')).toBeInTheDocument();
  expect(lanes).toHaveTextContent('Observed only');
});

it('shows no input lanes until at least two readings have been received', () => {
  render(<ForecastCanvas forecast={forecast} cache={store([{ t: at(0), heartRate: 66, hrv: 29, steps: 0, asleep: false, carbs: 0 }])} />);
  expect(screen.queryByTestId('input-lanes')).not.toBeInTheDocument();
});

it('states the hybrid relationship with returned and calculated values distinguished', () => {
  render(<ForecastCanvas forecast={forecast} cache={store([])} />);
  expect(screen.getByTestId('physics-prior-value')).toHaveTextContent('94 mg/dL');
  expect(screen.getByTestId('forecast-adjustment-value')).toHaveTextContent('+1.0 mg/dL');
  expect(screen.getByTestId('hybrid-forecast-value')).toHaveTextContent('95 mg/dL');
  expect(screen.getByTestId('hybrid-interval')).toHaveTextContent('80% interval 85–105 mg/dL · returned');
  expect(screen.getByTestId('forecast-adjustment-card')).toHaveTextContent('Calculated here as ③ − ①');
});

it('calls out an isolated one-step jump in the returned forecast median, and stays quiet for a smooth curve', () => {
  const jagged = { ...forecast, forecast: { ...forecast.forecast!, points: forecast.forecast!.points.map((p, i) => (i === 14 ? { ...p, p50: 140, p90: 150, p95: 155 } : p)) } } as ForecastResponse;
  const { rerender } = render(<ForecastCanvas forecast={jagged} cache={store([])} />);
  expect(screen.getByTestId('isolated-step-note')).toHaveTextContent('jumps by 45 mg/dL in a single 5-min step at +75 min');
  rerender(<ForecastCanvas forecast={forecast} cache={store([])} />);
  expect(screen.queryByTestId('isolated-step-note')).not.toBeInTheDocument();
});

it('distinguishes genuinely empty lanes: no meals logged, recorded zero steps, missing readings, awake throughout', () => {
  const wearables: WearableView[] = [
    { t: at(10), heartRate: null, hrv: null, steps: 0, asleep: false, carbs: 0 },
    { t: at(5), heartRate: null, hrv: null, steps: 0, asleep: false, carbs: 0 },
    { t: at(0), heartRate: null, hrv: null, steps: 0, asleep: false, carbs: 0 },
  ];
  render(<ForecastCanvas forecast={forecast} cache={store(wearables)} />);
  expect(within(screen.getByTestId('lane-meals')).getByText('No meals logged in this window')).toBeInTheDocument();
  expect(within(screen.getByTestId('lane-steps')).getByText('0 steps recorded in this window')).toBeInTheDocument();
  expect(within(screen.getByTestId('lane-hr')).getByText('No heart-rate readings received')).toBeInTheDocument();
  expect(within(screen.getByTestId('lane-hrv')).getByText('No HRV readings received')).toBeInTheDocument();
  expect(within(screen.getByTestId('lane-sleep')).getByText('Awake throughout this window')).toBeInTheDocument();
  // Nothing is drawn as if it were data.
  expect(screen.getByTestId('lane-steps').querySelectorAll('rect[fill="var(--color-ink-3)"]')).toHaveLength(0);
});

import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { changeSeries, changeWindow, ScenarioEditor } from '../src/components/digital-twin/ScenarioEditor';
import { heroFromForecasts, parseForecastEvents, HERO_AS_OF } from '../src/lib/hero';
import { HeroForecast } from '../src/components/landing/HeroForecast';

// Test fixtures only: shaped like backend responses, never shown as live output.
const anchor = '2026-09-28T11:55:00Z';
const curve = (base: number, slope: number, twin?: (i: number) => number) => Array.from({ length: 24 }, (_, i) => ({
  timestamp: new Date(Date.parse(anchor) + (i + 1) * 300000).toISOString(),
  p10: base + slope * i - 15, p50: base + slope * i, p90: base + slope * i + 15,
  twin_p50: twin ? twin(i) : null,
}));

describe('What-If change over time', () => {
  const result = {
    pinned_as_of: anchor, subject_id: 's', fallback_used: null, current_mg_dl: 150,
    baseline_forecast: curve(150, 0, () => 150), scenario_forecast: curve(150, 0.5, i => 150 + 2 * i),
    warnings: [], metrics: { delta_peak_mg_dl: 11.5, new_peak_mg_dl: 161.5, baseline_peak_mg_dl: 150, delta_probability: 0, new_probability: 0.1, baseline_probability: 0.1 },
  };

  it('is the scenario minus the unchanged plan at each returned time, for the forecast and the twin alone', () => {
    const rows = changeSeries(result);
    expect(rows).toHaveLength(24);
    expect(rows[0]).toEqual({ min: 5, unchanged: 150, withChange: 150, final: 0, twin: 0 });
    expect(rows[23]).toEqual({ min: 120, unchanged: 150, withChange: 161.5, final: 11.5, twin: 46 });
  });

  it('marks when the change happens, and only for changes with a time', () => {
    expect(changeWindow({ kind: 'meal', offset_min: 30, carbs_g: 60 })).toEqual({ start: 30, end: null, label: '60 g meal' });
    expect(changeWindow({ kind: 'activity', offset_min: 100, duration_min: 45, intensity: 'moderate' })).toEqual({ start: 100, end: 120, label: 'moderate activity' });
    expect(changeWindow({ kind: 'skip_habitual_meal', meal_slot: 'dinner' })).toBeNull();
  });

  it('renders the change chart and a value table from the backend curves', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => result });
    render(<ScenarioEditor patientId="s" currentForecast={{ as_of: anchor, data_quality: { status: 'ok' }, forecast: { points: [] }, ehr_context: { med_classes: ['metformin'] } } as never} />);
    fireEvent.click(screen.getByRole('button', { name: '60 g carb meal in 30 min' }));
    await screen.findByTestId('scenario-result');
    expect(screen.getByTestId('whatif-change-chart').querySelector('svg')).toHaveAttribute('aria-label', expect.stringContaining('Final forecast: largest +11.5 mg/dL at +120 min'));
    expect(screen.getByTestId('change-final-line').getAttribute('d')).toBeTruthy();
    expect(screen.getByTestId('change-twin-line').getAttribute('d')).toBeTruthy();
    expect(screen.getByTestId('whatif-change-marker')).toBeInTheDocument();
    const table = within(screen.getByTestId('whatif-table')).getByRole('table');
    const last = within(table).getByRole('row', { name: /\+120 min/ });
    expect(last).toHaveTextContent('+120 min150.0161.5+11.5+46.0');
  });

  it('keeps the medication preset as a one-click refusal with a plain accessible name', () => {
    render(<ScenarioEditor patientId="s" currentForecast={null} />);
    const med = screen.getByRole('button', { name: /^Medication change/ });
    expect(med).toHaveTextContent('not modelled');
  });
});

describe('Home hero: genuine replayed forecasts only', () => {
  const t = (min: number) => new Date(Date.parse(HERO_AS_OF) + min * 60000).toISOString().replace('.000Z', 'Z');
  const forecastAt = (min: number, value: number, points = true) => ({
    as_of: t(min), subject: { simulator: { param_set_id: 'P0017' } }, model: { name: 'pr_tft' },
    current: { value_mg_dl: value },
    forecast: { points: points ? [{ offset_min: 60, p10: 200, p50: 217.1, p90: 240, twin_p50: 232.5 }, { offset_min: 120, p10: 150, p50: 170, p90: 200, twin_p50: 180 }] : [] },
    spike_risk: { probability_120m: 0.533, calibrated: true },
  });
  const sse = (events: object[]) => events.map((p, i) => `id: ${i}\nevent: forecast.updated\ndata: ${JSON.stringify({ event: 'forecast.updated', payload: p })}\n\n`).join('')
    + 'event: alert.raised\ndata: {"event":"alert.raised"}\n\ndata: {not json}\n\n';

  it('parses forecast events, skipping alerts and malformed lines', () => {
    expect(parseForecastEvents(sse([forecastAt(-10, 120), forecastAt(-5, 130)]))).toHaveLength(2);
  });

  it('is null unless the anchor forecast and history are present', () => {
    expect(heroFromForecasts([forecastAt(-5, 130)])).toBeNull();
    expect(heroFromForecasts([forecastAt(0, 148)])).toBeNull();
    expect(heroFromForecasts([forecastAt(-5, 130), forecastAt(0, 148, false)])).toBeNull();
  });

  it('draws only the two hours before the anchor and the returned forecast, with the equation from the same point', () => {
    const hero = heroFromForecasts([forecastAt(-200, 90), forecastAt(-5, 130), forecastAt(0, 148), forecastAt(5, 160)])!;
    expect(hero.observed.map(o => o.v)).toEqual([130, 148]);
    expect(hero.current).toBe(148);
    render(<HeroForecast data={hero} />);
    const eq = screen.getByText(/physiology twin \+ learned adjustment = forecast/).closest('div')!;
    expect(eq).toHaveTextContent('232.5 + (−15.4) = 217.1 mg/dL');
    expect(screen.getByTestId('hero-onset')).toHaveTextContent('New-spike onset risk, next 2 h: 53.3%');
    expect(screen.getByTestId('hero-high-window')).toHaveTextContent('Median above 180 at +60 min');
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining('median peaking at 217.1 mg/dL at +60 min'));
  });
});

import { act, renderHook } from '@testing-library/react';
import { aboveLevel, RiskPanel } from '../src/components/digital-twin/RiskPanel';
import { announce, learnedBlip } from '../src/components/digital-twin/ScenarioEditor';
import { useReplayHold } from '../src/hooks/useReplayHold';

describe('Risk card: the forecast window above 180 is read from the bands only', () => {
  const pts = [5, 10, 15, 20, 25].map((m, i) => ({ offset_min: m, p10: [150, 175, 185, 182, 170][i], p50: [170, 185, 200, 190, 175][i], p90: [190, 200, 220, 210, 195][i] }));
  it('reports median, lower-bound and upper-bound windows', () => {
    expect(aboveLevel(pts)).toEqual({ median: [10, 20], medianContiguous: true, lower: [15, 20], upper: [5, 25] });
    expect(aboveLevel(pts.map(p => ({ ...p, p50: 100, p10: 90 }))).median).toBeNull();
  });
  it('shows the window first and names the onset probability as a separate output', () => {
    render(<RiskPanel forecast={{ as_of: '2026-09-29T08:00:00Z', forecast: { points: pts }, spike_risk: { probability_120m: 0.3, calibrated: true, spike_in_progress: true }, alert: { state: 'none' } } as never} />);
    expect(screen.getByTestId('risk-high-window')).toHaveTextContent('Median above 180 mg/dL from +10 to +20 min');
    expect(screen.getByTestId('risk-high-window')).toHaveTextContent('Even the lower 10% bound is above 180 from +15 to +20 min.');
    expect(screen.getByText('New-spike onset risk')).toBeInTheDocument();
    expect(screen.getByText(/calibrated on the validation split; not independently tested/)).toBeInTheDocument();
    expect(screen.getByTestId('spike-in-progress')).toBeInTheDocument();
  });
});

describe('What-If: single-step blips are flagged, never smoothed', () => {
  it('finds a one-step departure in the learned part that its neighbours do not share', () => {
    const series = [0, 0, 0, 7, 0.5, 1, 2].map((f, i) => ({ min: i * 5, final: f, twin: 0 }));
    expect(learnedBlip(series)).toEqual({ min: 15, final: 7, size: 6.75 });
    expect(learnedBlip(series.map((r, i) => ({ ...r, final: i * 2 })))).toBeNull();
  });
  it('announces one sentence, not the whole result', () => {
    const result = {
      pinned_as_of: anchor, subject_id: 's', fallback_used: null, current_mg_dl: 150,
      baseline_forecast: curve(150, 0, () => 150), scenario_forecast: curve(150, 0.5, i => 150 + 2 * i),
      warnings: [{ code: 'SCENARIO_OUT_OF_RANGE', title: 'x' }], metrics: { delta_peak_mg_dl: 0, new_peak_mg_dl: 0, baseline_peak_mg_dl: 0, delta_probability: 0.1, new_probability: 0.5, baseline_probability: 0.4 },
    };
    expect(announce({ status: 'result', patientId: 's', asOf: anchor, input: { kind: 'meal', offset_min: 30, carbs_g: 60 }, result } as never))
      .toBe('Result ready: 60 g carbohydrate meal in 30 min. Biggest gap between the two forecast curves +11.5 mg/dL at +120 min. Spike onset risk 40.0% to 50.0%. Inputs are outside the training range.');
  });
});

describe('Replay hold', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it('follows the catch-up burst, freezes on its last forecast, and resumes the live replay on request', () => {
    const f = (t: string) => ({ as_of: t });
    const { result, rerender } = renderHook(({ fc }) => useReplayHold(fc, { n: fc?.as_of }, 'p1'), { initialProps: { fc: f('07:55') as { as_of: string } | null } });
    expect(result.current.settling).toBe(true);
    rerender({ fc: f('08:00') });
    act(() => { jest.advanceTimersByTime(1600); });
    expect(result.current.paused).toBe(true);
    rerender({ fc: f('08:05') });
    expect(result.current.forecast).toEqual(f('08:00'));
    expect(result.current.cache).toEqual({ n: '08:00' });
    act(() => result.current.resume());
    expect(result.current.forecast).toEqual(f('08:05'));
    expect(result.current.paused).toBe(false);
    act(() => result.current.pause());
    rerender({ fc: f('08:10') });
    expect(result.current.forecast).toEqual(f('08:05'));
  });
});

describe('What-If compares each model with itself, and says plainly when nothing changes', () => {
  const base = {
    pinned_as_of: anchor, subject_id: 's', fallback_used: null, current_mg_dl: 150, warnings: [],
    metrics: { delta_peak_mg_dl: 0, new_peak_mg_dl: 0, baseline_peak_mg_dl: 0, delta_probability: 0, new_probability: 0.1, baseline_probability: 0.1 },
  };
  const run = async (result: object, name: string) => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => result });
    render(<ScenarioEditor patientId="s" currentForecast={{ as_of: anchor, data_quality: { status: 'ok' }, forecast: { points: [] }, ehr_context: { med_classes: ['metformin'] } } as never} />);
    if (name === 'skip') {
      fireEvent.change(screen.getByRole('combobox', { name: 'Change' }), { target: { value: 'skip_habitual_meal' } });
      fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    } else fireEvent.click(screen.getByRole('button', { name: name }));
    return screen.findByTestId('scenario-result');
  };
  it('draws the twin unchanged beside the twin with the change', async () => {
    await run({ ...base, baseline_forecast: curve(150, 0, () => 150), scenario_forecast: curve(150, 0.5, i => 150 + 2 * i) }, '60 g carb meal in 30 min');
    expect(screen.getByTestId('whatif-twin-base-line').getAttribute('d')).toBeTruthy();
    expect(screen.getByTestId('whatif-twin-line').getAttribute('d')).toBeTruthy();
  });
  it('replaces charts with one explanation when the backend returns no change', async () => {
    const flat = curve(150, 0, () => 150);
    await run({ ...base, baseline_forecast: flat, scenario_forecast: flat }, 'skip');
    expect(screen.getByTestId('scenario-no-change')).toHaveTextContent('Nothing changes in the next 2 hours.');
    expect(screen.getByTestId('scenario-no-change')).toHaveTextContent('No usual dinner is expected between 11:55 and 13:55 UTC');
    expect(screen.queryByTestId('whatif-change-chart')).not.toBeInTheDocument();
    expect(screen.getByTestId('scenario-announcement')).toHaveTextContent('Nothing changes in the next 2 hours.');
  });
});

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ScenarioEditor, buildScenarioInput, SCENARIO_DISCLAIMER } from '../src/components/digital-twin/ScenarioEditor';
import { classifyScenarioError, parseScenarioComparison } from '../src/hooks/useScenario';
import type { ForecastResponse } from '../src/types/forecast-response';

const anchor = '2026-09-28T11:55:00Z';
const curve = (base: number, slope: number) => Array.from({ length: 24 }, (_, i) => ({
  timestamp: new Date(Date.parse(anchor) + (i + 1) * 300000).toISOString(),
  p10: base + slope * i - 15, p50: base + slope * i, p90: base + slope * i + 15,
}));

function forecast(overrides: Partial<ForecastResponse> = {}): ForecastResponse {
  return {
    as_of: anchor,
    subject: { synthetic: true, subject_id: 'subject-1' },
    data_quality: { status: 'ok' },
    forecast: { units: 'mg/dL', step_min: 5, horizon_min: 120, points: [] },
    ehr_context: { med_classes: ['metformin'] },
    ...overrides,
  } as unknown as ForecastResponse;
}

function okBody(overrides: Record<string, unknown> = {}) {
  return {
    pinned_as_of: anchor, subject_id: 'subject-1', fallback_used: null, current_mg_dl: 120,
    baseline_forecast: curve(120, 1), scenario_forecast: curve(120, 3),
    warnings: [],
    metrics: { delta_peak_mg_dl: 46, new_peak_mg_dl: 189, baseline_peak_mg_dl: 143,
      delta_probability: 0.31, new_probability: 0.42, baseline_probability: 0.11 },
    ...overrides,
  };
}

function respond(status: number, body: unknown) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => { global.fetch = jest.fn(); });

describe('ScenarioEditor — backend-driven what-if', () => {
  it('always shows the causal disclaimer', () => {
    render(<ScenarioEditor patientId="subject-1" currentForecast={forecast()} />);
    expect(screen.getByTestId('scenario-disclaimer')).toHaveTextContent(SCENARIO_DISCLAIMER);
    expect(SCENARIO_DISCLAIMER).toBe('Simulated model response — not a validated causal treatment effect.');
  });

  it('sends the meal scenario to /api/forecast pinned to the current anchor and renders the backend comparison', async () => {
    respond(200, okBody());
    render(<ScenarioEditor patientId="subject-1" currentForecast={forecast()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    expect(screen.getByTestId('scenario-loading')).toBeInTheDocument();
    await screen.findByTestId('scenario-result');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('/api/forecast');
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ patientId: 'subject-1', pinned_as_of: anchor });
    expect(sent.scenarios[0].scenario_id).toMatch(/^[a-z0-9_-]{1,32}$/);
    expect(sent.scenarios[0].inputs).toEqual([{ kind: 'meal', offset_min: 30, carbs_g: 60 }]);

    expect(screen.getByTestId('scenario-peak')).toHaveTextContent('143.0 → 189.0 mg/dL (+46.0)');
    expect(screen.getByTestId('scenario-peak-timing')).toHaveTextContent('at +120 min → at +120 min');
    expect(screen.getByTestId('scenario-largest-diff')).toHaveTextContent('+46.0 mg/dL at +120 min');
    expect(screen.getByTestId('scenario-risk')).toHaveTextContent('11.0% → 42.0% (+31.0 pts)');
    expect(screen.getByTestId('scenario-definitions')).toHaveTextContent('not a measured or validated treatment effect');
    expect(screen.getByTestId('whatif-baseline-line').getAttribute('d')).toBeTruthy();
    expect(screen.getByTestId('whatif-scenario-line').getAttribute('d')).toBeTruthy();
  });

  it('runs a preset activity scenario and shows backend approximation warnings', async () => {
    respond(200, okBody({ scenario_forecast: curve(120, 0.5), warnings: [{ code: 'SCENARIO_APPROXIMATION', title: 'Activity modelled as immediate uptake', detail: 'delayed sensitivity boost is not modelled.' }],
      metrics: { delta_peak_mg_dl: -12, new_peak_mg_dl: 131, baseline_peak_mg_dl: 143, delta_probability: -0.05, new_probability: 0.06, baseline_probability: 0.11 } }));
    render(<ScenarioEditor patientId="subject-1" currentForecast={forecast()} />);
    fireEvent.click(screen.getByRole('button', { name: '30 min brisk walk now' }));
    await screen.findByTestId('scenario-result');
    const sent = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(sent.scenarios[0].inputs).toEqual([{ kind: 'activity', offset_min: 0, duration_min: 30, intensity: 'moderate' }]);
    expect(screen.getByTestId('scenario-peak')).toHaveTextContent('143.0 → 131.5 mg/dL (−11.5)');
    expect(screen.getByTestId('scenario-warning')).toHaveTextContent('Activity modelled as immediate uptake');
  });

  it('derives every readout number from the two same-anchor curves (peaks at different times, as in the live P0017 07:30 response)', async () => {
    // Shape of the real backend response: unchanged plan peaks 185.0 at +60 min; the meal moves the peak to 197.7 at +100 min.
    const at = (i: number) => new Date(Date.parse(anchor) + (i + 1) * 300000).toISOString();
    const baseline = Array.from({ length: 24 }, (_, i) => { const v = i === 11 ? 185.04 : 150 + i; return { timestamp: at(i), p10: v - 10, p50: v, p90: v + 10 }; });
    const scenario = baseline.map((p, i) => { const v = i === 19 ? 197.66 : i === 5 ? p.p50 + 33.6 : p.p50; return { ...p, p10: v - 10, p50: v, p90: v + 10 }; });
    respond(200, okBody({ baseline_forecast: baseline, scenario_forecast: scenario,
      metrics: { delta_peak_mg_dl: 12.6, new_peak_mg_dl: 197.66, baseline_peak_mg_dl: 185.04, delta_probability: 0.058, new_probability: 0.164, baseline_probability: 0.106 } }));
    render(<ScenarioEditor patientId="subject-1" currentForecast={forecast()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await screen.findByTestId('scenario-result');
    // Delta is the difference of the displayed values, so the arithmetic on screen always adds up.
    expect(screen.getByTestId('scenario-peak')).toHaveTextContent('185.0 → 197.7 mg/dL (+12.7)');
    expect(screen.getByTestId('scenario-peak-timing')).toHaveTextContent('at +60 min → at +100 min');
    expect(screen.getByTestId('scenario-largest-diff')).toHaveTextContent('+33.6 mg/dL at +30 min');
    expect(screen.getByTestId('scenario-risk')).toHaveTextContent('10.6% → 16.4% (+5.8 pts)');
    expect(screen.queryByTestId('scenario-no-change')).not.toBeInTheDocument();
  });

  it('reports unavailable risk honestly on a physics-only fallback', async () => {
    respond(200, okBody({ fallback_used: 'twin_only',
      metrics: { delta_peak_mg_dl: 10, new_peak_mg_dl: 150, baseline_peak_mg_dl: 140, delta_probability: null, new_probability: null, baseline_probability: null } }));
    render(<ScenarioEditor patientId="subject-1" currentForecast={forecast()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    expect(await screen.findByTestId('scenario-risk')).toHaveTextContent('Unavailable (physics-only fallback; no calibrated risk)');
  });

  it('keeps medication changes explicitly unsupported (SCENARIO_UNSUPPORTED from the backend)', async () => {
    respond(422, { type: 'x', title: 'Scenario input not supported', status: 422, code: 'SCENARIO_UNSUPPORTED', detail: 'medication changes need the full twin' });
    render(<ScenarioEditor patientId="subject-1" currentForecast={forecast()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Medication change' }));
    const error = await screen.findByTestId('scenario-error');
    expect(error).toHaveAttribute('data-kind', 'unsupported');
    expect(error).toHaveTextContent('Medication changes are not supported');
    expect(error).toHaveTextContent('SCENARIO_UNSUPPORTED');
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).scenarios[0].inputs[0]).toMatchObject({ kind: 'medication', med_class: 'metformin' });
    expect(screen.queryByTestId('scenario-result')).not.toBeInTheDocument();
  });

  it('shows the insufficient-data state when the service has no baseline', async () => {
    respond(422, { error: 'No baseline forecast available for scenario comparison' });
    render(<ScenarioEditor patientId="subject-1" currentForecast={forecast()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    expect(await screen.findByTestId('scenario-error')).toHaveAttribute('data-kind', 'insufficient');
  });

  it('shows the backend-unavailable state on a network failure and fabricates nothing', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('fetch failed'));
    render(<ScenarioEditor patientId="subject-1" currentForecast={forecast()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    const error = await screen.findByTestId('scenario-error');
    expect(error).toHaveAttribute('data-kind', 'unavailable');
    expect(error).toHaveTextContent('Nothing has been simulated locally');
    expect(screen.queryByTestId('scenario-result')).not.toBeInTheDocument();
  });

  it('rejects a response pinned to a different anchor as a contract failure', async () => {
    respond(200, okBody({ pinned_as_of: '2026-09-28T12:00:00Z' }));
    render(<ScenarioEditor patientId="subject-1" currentForecast={forecast()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    expect(await screen.findByTestId('scenario-error')).toHaveAttribute('data-kind', 'contract');
  });

  it('keeps the result pinned to its anchor when the live stream advances', async () => {
    respond(200, okBody());
    const { rerender } = render(<ScenarioEditor patientId="subject-1" currentForecast={forecast()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await screen.findByTestId('scenario-result');
    rerender(<ScenarioEditor patientId="subject-1" currentForecast={forecast({ as_of: '2026-09-28T12:00:00Z' } as Partial<ForecastResponse>)} />);
    expect(screen.getByTestId('scenario-result')).toBeInTheDocument();
    expect(screen.getByTestId('scenario-pinned-note')).toBeInTheDocument();
  });

  it('drops the result when the patient changes', async () => {
    respond(200, okBody());
    const { rerender } = render(<ScenarioEditor patientId="subject-1" currentForecast={forecast()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await screen.findByTestId('scenario-result');
    rerender(<ScenarioEditor patientId="subject-2" currentForecast={forecast()} />);
    await waitFor(() => expect(screen.queryByTestId('scenario-result')).not.toBeInTheDocument());
  });

  it('ignores a late response after the user clears', async () => {
    let resolve!: (v: unknown) => void;
    (global.fetch as jest.Mock).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    render(<ScenarioEditor patientId="subject-1" currentForecast={forecast()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => { resolve({ ok: true, status: 200, json: async () => okBody() }); });
    expect(screen.queryByTestId('scenario-result')).not.toBeInTheDocument();
  });

  it('blocks out-of-range input before any request is sent', () => {
    render(<ScenarioEditor patientId="subject-1" currentForecast={forecast()} />);
    fireEvent.change(screen.getByLabelText('Carbohydrate (g)'), { target: { value: '400' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Carbohydrate must be 0–250 g');
    expect(screen.getByRole('button', { name: 'Run simulation' })).toBeDisabled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('ScenarioEditor — catch-up burst', () => {
  it('holds the simulation while forecasts arrive faster than live pace, then enables it on the latest anchor', () => {
    jest.useFakeTimers();
    try {
      const { rerender } = render(<ScenarioEditor patientId="subject-1" currentForecast={forecast()} />);
      rerender(<ScenarioEditor patientId="subject-1" currentForecast={forecast({ as_of: '2026-09-28T12:00:00Z' } as Partial<ForecastResponse>)} />);
      expect(screen.getByTestId('scenario-settling')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Run simulation' })).toBeDisabled();
      act(() => { jest.advanceTimersByTime(1600); });
      expect(screen.queryByTestId('scenario-settling')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('scenario helpers', () => {
  const form = { kind: 'meal' as const, carbs: '60', offset: '30', duration: '30', intensity: 'moderate' as const, slot: 'dinner' as const };
  it('builds backend-valid inputs and rejects empty/out-of-range values', () => {
    expect(buildScenarioInput(form, 'metformin')).toEqual({ input: { kind: 'meal', offset_min: 30, carbs_g: 60 } });
    expect(buildScenarioInput({ ...form, carbs: '' }, 'metformin')).toHaveProperty('error');
    expect(buildScenarioInput({ ...form, offset: '121' }, 'metformin')).toHaveProperty('error');
    expect(buildScenarioInput({ ...form, kind: 'activity', duration: '4' }, 'metformin')).toHaveProperty('error');
    expect(buildScenarioInput({ ...form, kind: 'skip_habitual_meal' }, 'metformin')).toEqual({ input: { kind: 'skip_habitual_meal', meal_slot: 'dinner' } });
  });
  it('classifies service errors', () => {
    expect(classifyScenarioError(422, { code: 'SCENARIO_UNSUPPORTED' }).kind).toBe('unsupported');
    expect(classifyScenarioError(422, { code: 'REQUEST_INVALID' }).kind).toBe('invalid');
    expect(classifyScenarioError(422, { error: 'No baseline forecast' }).kind).toBe('insufficient');
    expect(classifyScenarioError(502, { error: 'Invalid upstream contract' }).kind).toBe('contract');
    expect(classifyScenarioError(503, null).kind).toBe('unavailable');
  });
  it('refuses malformed comparison payloads', () => {
    expect(parseScenarioComparison(okBody(), anchor)).not.toBeNull();
    expect(parseScenarioComparison(okBody({ scenario_forecast: curve(1, 1).slice(0, 10) }), anchor)).toBeNull();
    expect(parseScenarioComparison(okBody({ metrics: { ...okBody().metrics, new_probability: 1.4 } }), anchor)).toBeNull();
    expect(parseScenarioComparison(null, anchor)).toBeNull();
  });
});

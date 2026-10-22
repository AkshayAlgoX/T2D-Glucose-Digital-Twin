import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ForecastCanvas } from '../src/components/digital-twin/ForecastCanvas';
import { PatientWorkspace } from '../src/components/digital-twin/PatientWorkspace';
import { RiskPanel } from '../src/components/digital-twin/RiskPanel';
import { RiskStrip } from '../src/components/digital-twin/RiskStrip';
import { ScenarioEditor } from '../src/components/digital-twin/ScenarioEditor';
import type { ForecastResponse } from '../src/types/forecast-response';
import type { SubjectStore } from '../src/lib/types';

// Unit-test data only; never used by the application or as scientific evidence.
const anchor = '2026-10-04T12:00:00Z';
const cache: SubjectStore = { patientId: 'test-subject', cgm: [], risk: [], alerts: [], dataQuality: [] };
function forecastFixture(): ForecastResponse {
  return {
    as_of: anchor, subject: { synthetic: true, subject_id: 'test-subject' },
    current: { value_mg_dl: 225 }, alert: { state: 'none' },
    data_quality: { status: 'ok', cgm_coverage_6h_pct: 96.5, staleness_min: 0 },
    ehr_context: { age_years: 42, sex: 'female', bmi: 26.2, hba1c_pct: 6.8, hba1c_date: '2026-10-01', egfr: null },
    forecast: { units: 'mg/dL', step_min: 5, horizon_min: 120,
      points: Array.from({ length: 24 }, (_, index) => ({
        offset_min: (index + 1) * 5,
        t: new Date(Date.parse(anchor) + (index + 1) * 300000).toISOString(),
        p05: 480, p10: 500, p25: 520, p50: 540, p75: 560, p90: 580, p95: 590,
      })),
    },
    spike_risk: { probability_120m: 0.1, calibrated: true, cumulative: [] },
    intended_use: 'research_only_not_for_clinical_decisions',
  } as ForecastResponse;
}

describe('Trajectory sizing and numerical fidelity', () => {
  const originalObserver = global.ResizeObserver;
  let callback: ResizeObserverCallback;
  const observe = jest.fn();
  beforeEach(() => {
    observe.mockClear();
    global.ResizeObserver = class {
      constructor(handler: ResizeObserverCallback) { callback = handler; }
      observe = observe;
      disconnect = jest.fn();
      unobserve = jest.fn();
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => { global.ResizeObserver = originalObserver; });

  it('observes the persistent plot while waiting, then resizes the first forecast', () => {
    const { rerender } = render(<ForecastCanvas forecast={null} cache={cache} />);
    expect(observe).toHaveBeenCalledTimes(1);
    const observedElement = observe.mock.calls[0][0];
    rerender(<ForecastCanvas forecast={forecastFixture()} cache={cache} />);
    expect(observedElement.isConnected).toBe(true);
    act(() => callback([{ contentRect: { width: 480, height: 320 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(screen.getByRole('img')).toHaveAttribute('width', '480');
    expect(screen.getByRole('img')).toHaveAttribute('height', '320');
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('keeps original forecasts intact and includes high quantiles in the visible axis', () => {
    const fixture = forecastFixture();
    const original = JSON.stringify(fixture);
    fixture.forecast!.points.forEach(Object.freeze);
    Object.freeze(fixture.forecast!.points);
    render(<ForecastCanvas forecast={fixture} cache={cache} />);
    expect(screen.getByText('600')).toBeInTheDocument();
    expect(screen.getByTestId('outer-quantile-band').getAttribute('d')).not.toMatch(/NaN|Infinity/);
    expect(screen.getByTestId('quantile-band').getAttribute('d')).not.toMatch(/NaN|Infinity/);
    fireEvent.keyDown(screen.getByRole('img'), { key: 'ArrowRight' });
    expect(screen.getByText(/Median 540 mg\/dL · P10–P90 500–580 mg\/dL/)).toBeInTheDocument();
    expect(JSON.stringify(fixture)).toBe(original);
  });

  it('never fabricates a current observation when current glucose is missing', () => {
    const fixture = forecastFixture();
    fixture.current.value_mg_dl = null;
    render(<ForecastCanvas forecast={fixture} cache={cache} />);
    expect(screen.queryByTestId('current-observation')).not.toBeInTheDocument();
  });

  it('does not draw a continuous observed line across missing five-minute readings', () => {
    const history = { ...cache, cgm: [{ t: '2026-10-04T11:40:00Z', value: 190, trend: 'flat' }, { t: '2026-10-04T11:55:00Z', value: 200, trend: 'flat' }] };
    render(<ForecastCanvas forecast={forecastFixture()} cache={history} />);
    expect(screen.getAllByTestId('observed-segment')).toHaveLength(2);
  });

  it('changes only the observed window and preserves source observations and forecast quantiles', () => {
    const fixture = forecastFixture();
    const history = { ...cache, cgm: [{ t: '2026-10-04T08:00:00Z', value: 190, trend: 'flat' }, { t: '2026-10-04T11:55:00Z', value: 200, trend: 'flat' }] };
    const original = JSON.stringify({ fixture, history });
    render(<ForecastCanvas forecast={fixture} cache={history} />);
    // Two hours of history by default, so the two-hour forecast gets half the chart.
    expect(screen.getByRole('button', { name: 'Past 2h' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Past 6h' }));
    expect(screen.getAllByTestId('observed-segment')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Past 2h' }));
    expect(screen.getAllByTestId('observed-segment')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Past 2h' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(screen.getByRole('img'), { key: 'End' });
    expect(screen.getByText(/Median 540 mg\/dL · P10–P90 500–580 mg\/dL/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Past 6h' }));
    expect(screen.getAllByTestId('observed-segment')).toHaveLength(2);
    expect(JSON.stringify({ fixture, history })).toBe(original);
  });
});

describe('Honest data and risk presentation', () => {
  it('shows received cache.risk snapshots rather than an empty legacy field', () => {
    const populated = { ...cache, risk: [{ t: '2026-10-04T11:55:00Z', p: 0.1 }, { t: anchor, p: 0.2 }] };
    render(<RiskStrip forecast={forecastFixture()} cache={populated} />);
    expect(screen.getByText('2 received snapshots')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Received risk snapshots/ })).toBeInTheDocument();
    expect(screen.queryByText(/No risk snapshots received/)).not.toBeInTheDocument();
  });

  it('uses the served alert state rather than deriving a warning from probability', () => {
    const fixture = forecastFixture();
    fixture.spike_risk!.probability_120m = 0.95;
    render(<RiskPanel forecast={fixture} />);
    expect(screen.getByText('No active alert')).toBeInTheDocument();
    expect(screen.queryByText('Spike Warning')).not.toBeInTheDocument();
    const meter = screen.getByLabelText('Spike onset probability');
    expect(meter.tagName).toBe('METER');
    expect(meter).toHaveAttribute('value', '95');
    expect(meter).toHaveAttribute('min', '0');
    expect(meter).toHaveAttribute('max', '100');
  });

  it('does not substitute zero for missing glucose or risk', () => {
    const fixture = forecastFixture();
    fixture.current.value_mg_dl = null;
    fixture.spike_risk = null;
    render(<RiskPanel forecast={fixture} />);
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('keeps EHR context and the disclaimer visible with compact missing streams', () => {
    render(<PatientWorkspace patientId="test-subject" forecast={forecastFixture()} cache={cache} isConnected isStale={false} />);
    expect(screen.getByRole('heading', { name: 'Clinical context' })).toBeInTheDocument();
    expect(screen.getByText('42 years')).toBeInTheDocument();
    expect(screen.getByText('01 Oct 2026')).toHaveAttribute('datetime', '2026-10-01');
    expect(screen.getByText('Not received in this forecast')).toBeInTheDocument();
    expect(screen.getByText('Research Only (Not for clinical decisions)')).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByText('Pinned-time replay unavailable')).not.toBeInTheDocument();
  });

  it('shows the what-if controls with the causal disclaimer and no result until the backend answers', () => {
    render(<ScenarioEditor patientId="test-subject" currentForecast={forecastFixture()} />);
    expect(screen.getByTestId('scenario-disclaimer')).toHaveTextContent('Simulated model response — not a validated causal treatment effect.');
    expect(screen.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
    expect(screen.queryByTestId('scenario-result')).not.toBeInTheDocument();
  });
});

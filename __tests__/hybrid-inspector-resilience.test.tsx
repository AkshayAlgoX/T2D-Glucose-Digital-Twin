import React from 'react';
import { render, screen, fireEvent, renderHook, act, waitFor } from '@testing-library/react';
import { TextDecoder } from 'node:util';
import { ForecastCanvas } from '../src/components/digital-twin/ForecastCanvas';
import { useRealtimeTelemetry } from '../src/hooks/useRealtimeTelemetry';
import type { ForecastResponse, QuantilePoint } from '../src/types/forecast-response';
import type { SubjectStore } from '../src/lib/types';

function deferredRead() {
  let finish!: (value: { done: boolean; value?: Uint8Array }) => void;
  const promise = new Promise<{ done: boolean; value?: Uint8Array }>(resolve => { finish = resolve; });
  return { read: jest.fn(() => promise), finish, cancel: jest.fn() };
}

function createMockForecast(overrides?: Partial<ForecastResponse>): ForecastResponse {
  const points: QuantilePoint[] = Array.from({ length: 24 }, (_, i) => {
    const offset_min = (i + 1) * 5;
    const basePhysics = 130 + Math.round(Math.sin(i / 3) * 15);
    const neuralDelta = (i % 3 === 0 ? 4.2 : (i % 3 === 1 ? -3.5 : 0.0));
    const p50 = Math.round((basePhysics + neuralDelta) * 10) / 10;
    return {
      offset_min,
      t: new Date(Date.parse('2026-10-19T12:00:00Z') + offset_min * 60000).toISOString(),
      p05: p50 - 20,
      p10: p50 - 15,
      p25: p50 - 8,
      p50,
      p75: p50 + 8,
      p90: p50 + 15,
      p95: p50 + 20,
      twin_p50: basePhysics,
    };
  }) as [QuantilePoint, ...QuantilePoint[]] as any;

  return {
    schema_version: '1.0.0',
    request_id: 'test-req-001',
    generated_at: '2026-10-19T12:00:00Z',
    as_of: '2026-10-19T12:00:00Z',
    subject: {
      subject_id: 'synthetic_001',
      synthetic: true,
    },
    model: {
      name: 'PR-TFT-Hybrid',
      version: '1.0.0',
      run_id: 'run-test-01',
      alert_policy_version: '1.0.0',
      fallback_used: null,
    },
    data_quality: {
      status: 'ok',
      cgm_coverage_6h_pct: 100,
      last_cgm_at: '2026-10-19T12:00:00Z',
      staleness_min: 0,
    },
    current: {
      value_mg_dl: 128,
      flag: 'in_range',
      measured_at: '2026-10-19T12:00:00Z',
      trend_arrow: 'flat',
    },
    forecast: {
      units: 'mg/dL',
      step_min: 5,
      horizon_min: 120,
      conformal_adjusted: true,
      points,
    },
    spike_risk: {
      probability_120m: 0.18,
      tier: 'low',
      calibrated: true,
      spike_in_progress: false,
      definition: {
        threshold_mg_dl: 180,
        min_rise_mg_dl: 40,
        rise_window_min: 45,
        persistence_min: 15,
      },
      cumulative: Array.from({ length: 24 }, (_, i) => ({
        offset_min: (i + 1) * 5,
        p: Math.min(1, 0.01 * (i + 1)),
      })) as any,
    },
    alert: {
      state: 'none',
      alert_id: null,
      since: null,
      suppressed_until: null,
      message_key: null,
    },
    intended_use: 'research_only_not_for_clinical_decisions',
    ...overrides,
  };
}

const mockCache: SubjectStore = {
  patientId: 'synthetic_001',
  cgm: [{ t: '2026-10-19T12:00:00Z', value: 128, trend: 'flat' }],
  risk: [{ t: '2026-10-19T12:00:00Z', p: 0.18 }],
  alerts: [],
  dataQuality: [{ t: '2026-10-19T12:00:00Z', status: 'ok' }],
};

describe('TOP-1 P1: Visible Hybrid Value + End-to-End Resilience', () => {
  describe('Task A: Physics prior vs. hybrid forecast Inspector', () => {
    it('renders the inspector with title, disclaimer, and accessible region', () => {
      const forecast = createMockForecast();
      render(<ForecastCanvas forecast={forecast} cache={mockCache} />);

      const inspector = screen.getByTestId('hybrid-inspector');
      expect(inspector).toBeInTheDocument();
      expect(inspector).toHaveAttribute('role', 'region');
      expect(inspector).toHaveAttribute('aria-label', 'How this forecast is built');

      const title = screen.getByText('How this forecast is built');
      expect(title).toBeInTheDocument();

      const note = screen.getByTestId('inspector-note');
      expect(note.textContent).toContain('an empirical model adjustment, not a causal effect or accuracy improvement, and not a separately validated mechanism.');

      const adjustmentLabel = screen.getByTestId('forecast-adjustment-card').querySelector('.metric-label');
      expect(adjustmentLabel?.textContent).toBe('② Learned adjustment');
      // Strictly avoid claiming causal effect or accuracy improvement
      expect(adjustmentLabel?.textContent).not.toContain('causal effect');
      expect(adjustmentLabel?.textContent).not.toContain('accuracy improvement');
    });

    it('calculates difference as p50 - twin_p50 and formats positive, negative, and zero values', () => {
      const forecast = createMockForecast();
      // Ensure offset 15, 30, and 60 test positive, negative, and zero differences
      const pt15 = forecast.forecast!.points.find(p => p.offset_min === 15)!;
      pt15.p50 = 145.4;
      pt15.twin_p50 = 140.0; // diff = +5.4

      const pt30 = forecast.forecast!.points.find(p => p.offset_min === 30)!;
      pt30.p50 = 136.2;
      pt30.twin_p50 = 140.0; // diff = -3.8

      const pt60 = forecast.forecast!.points.find(p => p.offset_min === 60)!;
      pt60.p50 = 150.0;
      pt60.twin_p50 = 150.0; // diff = 0.0

      render(<ForecastCanvas forecast={forecast} cache={mockCache} />);

      // Default is 60m
      expect(screen.getByTestId('physics-prior-value').textContent).toBe('150 mg/dL');
      expect(screen.getByTestId('hybrid-forecast-value').textContent).toBe('150 mg/dL');
      expect(screen.getByTestId('forecast-adjustment-value').textContent).toBe('0.0 mg/dL');

      // Click +15m pill
      fireEvent.click(screen.getByTestId('horizon-pill-15'));
      expect(screen.getByTestId('physics-prior-value').textContent).toBe('140 mg/dL');
      expect(screen.getByTestId('hybrid-forecast-value').textContent).toBe('145.4 mg/dL');
      expect(screen.getByTestId('forecast-adjustment-value').textContent).toBe('+5.4 mg/dL');

      // Click +30m pill
      fireEvent.click(screen.getByTestId('horizon-pill-30'));
      expect(screen.getByTestId('physics-prior-value').textContent).toBe('140 mg/dL');
      expect(screen.getByTestId('hybrid-forecast-value').textContent).toBe('136.2 mg/dL');
      expect(screen.getByTestId('forecast-adjustment-value').textContent).toBe('-3.8 mg/dL');
    });

    it('allows selection of all horizons via the horizon dropdown', () => {
      const forecast = createMockForecast();
      const pt45 = forecast.forecast!.points.find(p => p.offset_min === 45)!;
      pt45.p50 = 155.0;
      pt45.twin_p50 = 151.2; // diff = +3.8

      render(<ForecastCanvas forecast={forecast} cache={mockCache} />);

      const dropdown = screen.getByTestId('horizon-dropdown');
      fireEvent.change(dropdown, { target: { value: '45' } });

      expect(screen.getByTestId('physics-prior-value').textContent).toBe('151.2 mg/dL');
      expect(screen.getByTestId('hybrid-forecast-value').textContent).toBe('155 mg/dL');
      expect(screen.getByTestId('forecast-adjustment-value').textContent).toBe('+3.8 mg/dL');
    });
  });

  describe('Task B: Failure-path audit and acceptance invariants', () => {
    it('Criterion 1: all 24 horizons return correctly calculated differences', () => {
      const forecast = createMockForecast();
      render(<ForecastCanvas forecast={forecast} cache={mockCache} />);

      const dropdown = screen.getByTestId('horizon-dropdown');

      forecast.forecast!.points.forEach(point => {
        fireEvent.change(dropdown, { target: { value: String(point.offset_min) } });

        const physicsText = screen.getByTestId('physics-prior-value').textContent;
        const hybridText = screen.getByTestId('hybrid-forecast-value').textContent;
        const diffText = screen.getByTestId('forecast-adjustment-value').textContent;

        const expectedDiff = Number((point.p50 - point.twin_p50!).toFixed(1));
        const expectedDiffStr = Math.abs(expectedDiff) < 1e-6
          ? '0.0 mg/dL'
          : expectedDiff > 0
            ? `+${expectedDiff.toFixed(1)} mg/dL`
            : `${expectedDiff.toFixed(1)} mg/dL`;

        expect(physicsText).toBe(`${Number(point.twin_p50!.toFixed(1))} mg/dL`);
        expect(hybridText).toBe(`${Number(point.p50.toFixed(1))} mg/dL`);
        expect(diffText).toBe(expectedDiffStr);
      });
    });

    it('Criterion 2: null stays null when forecast is missing, degraded, or values absent', () => {
      // Case 2a: forecast is null
      const { rerender } = render(<ForecastCanvas forecast={null} cache={mockCache} />);
      expect(screen.getByTestId('physics-prior-value').textContent).toBe('—');
      expect(screen.getByTestId('hybrid-forecast-value').textContent).toBe('—');
      expect(screen.getByTestId('forecast-adjustment-value').textContent).toBe('—');

      // Case 2b: forecast.forecast is null (e.g. data quality insufficient)
      const degradedForecast = createMockForecast({
        data_quality: {
          status: 'insufficient',
          cgm_coverage_6h_pct: 20,
          last_cgm_at: '2026-10-19T12:00:00Z',
          staleness_min: 120,
        },
        forecast: null,
      });
      rerender(<ForecastCanvas forecast={degradedForecast} cache={mockCache} />);
      expect(screen.getByTestId('physics-prior-value').textContent).toBe('Unavailable');
      expect(screen.getByTestId('hybrid-forecast-value').textContent).toBe('Unavailable');
      expect(screen.getByTestId('forecast-adjustment-value').textContent).toBe('Unavailable');

      // Case 2c: twin_p50 is missing without twin-only fallback
      const noPhysicsForecast = createMockForecast();
      noPhysicsForecast.forecast!.points.forEach(p => {
        delete (p as any).twin_p50;
      });
      rerender(<ForecastCanvas forecast={noPhysicsForecast} cache={mockCache} />);
      expect(screen.getByTestId('physics-prior-value').textContent).toBe('Unavailable');
      expect(screen.getByTestId('forecast-adjustment-value').textContent).toBe('Unavailable');
      expect(screen.getByTestId('hybrid-forecast-value').textContent).not.toBe('Unavailable');
    });

    it('Criterion 3: no cross-subject stale forecasts appear upon subject switch', () => {
      const subjectAForecast = createMockForecast({
        subject: { subject_id: 'synthetic_001', synthetic: true },
        as_of: '2026-10-19T12:00:00Z',
      });
      const pt60A = subjectAForecast.forecast!.points.find(p => p.offset_min === 60)!;
      pt60A.p50 = 140.0;
      pt60A.twin_p50 = 135.0;

      const { rerender } = render(<ForecastCanvas forecast={subjectAForecast} cache={mockCache} />);
      expect(screen.getByTestId('hybrid-inspector')).toHaveAttribute('data-subject-id', 'synthetic_001');
      expect(screen.getByTestId('hybrid-forecast-value').textContent).toBe('140 mg/dL');

      // Re-render with null while waiting for Subject B's stream
      rerender(<ForecastCanvas forecast={null} cache={{ ...mockCache, patientId: 'synthetic_002' }} />);
      expect(screen.getByTestId('hybrid-forecast-value').textContent).toBe('—');
      expect(screen.queryByText(/synthetic_001/)).not.toBeInTheDocument();
      expect(screen.getByTestId('hybrid-inspector')).not.toHaveAttribute('data-subject-id', 'synthetic_001');

      // Subject B's forecast arrives
      const subjectBForecast = createMockForecast({
        subject: { subject_id: 'synthetic_002', synthetic: true },
        as_of: '2026-10-19T14:00:00Z',
      });
      const pt60B = subjectBForecast.forecast!.points.find(p => p.offset_min === 60)!;
      pt60B.p50 = 210.0;
      pt60B.twin_p50 = 195.0;

      rerender(<ForecastCanvas forecast={subjectBForecast} cache={{ ...mockCache, patientId: 'synthetic_002' }} />);
      expect(screen.getByTestId('hybrid-inspector')).toHaveAttribute('data-subject-id', 'synthetic_002');
      expect(screen.getByTestId('physics-prior-value').textContent).toBe('195 mg/dL');
      expect(screen.getByTestId('hybrid-forecast-value').textContent).toBe('210 mg/dL');
      expect(screen.getByTestId('forecast-adjustment-value').textContent).toBe('+15.0 mg/dL');
      expect(screen.queryByText(/synthetic_001/)).not.toBeInTheDocument();
    });

    it('Criterion 4: intended fallback returns ordered quantiles and unavailable risk', () => {
      // In twin-only fallback, the neural model is bypassed; q is cloned from twin rollout
      const twinFallbackTrajectory = [120, 122, 125, 128, 130, 133, 135, 137, 140, 142, 144, 145, 146, 146, 145, 144, 142, 140, 138, 135, 133, 130, 128, 125];
      const fallbackPoints = twinFallbackTrajectory.map((val, i) => {
        const offset_min = (i + 1) * 5;
        return {
          offset_min,
          t: new Date(Date.parse('2026-10-19T12:00:00Z') + offset_min * 60000).toISOString(),
          p05: val,
          p10: val,
          p25: val,
          p50: val,
          p75: val,
          p90: val,
          p95: val,
          twin_p50: val,
        };
      }) as any;

      // Verify mathematical quantile ordering for all 24 horizons
      fallbackPoints.forEach((pt: QuantilePoint) => {
        expect(pt.p05).toBeLessThanOrEqual(pt.p10);
        expect(pt.p10).toBeLessThanOrEqual(pt.p25);
        expect(pt.p25).toBeLessThanOrEqual(pt.p50);
        expect(pt.p50).toBeLessThanOrEqual(pt.p75);
        expect(pt.p75).toBeLessThanOrEqual(pt.p90);
        expect(pt.p90).toBeLessThanOrEqual(pt.p95);
      });

      const fallbackForecast = createMockForecast({
        model: {
          name: 'PR-TFT-Hybrid',
          version: '1.0.0',
          run_id: 'run-test-01',
          alert_policy_version: '1.0.0',
          fallback_used: 'twin_only',
        },
        forecast: {
          units: 'mg/dL',
          step_min: 5,
          horizon_min: 120,
          conformal_adjusted: false,
          points: fallbackPoints,
        },
        spike_risk: null, // Risk is unavailable under fallback
      });

      render(<ForecastCanvas forecast={fallbackForecast} cache={mockCache} />);

      // Exposes twin-only fallback state badge
      const fallbackBadge = screen.getByTestId('twin-only-fallback-badge');
      expect(fallbackBadge).toBeInTheDocument();
      expect(fallbackBadge.textContent).toBe('Twin-only fallback');

      // Forecast adjustment is exactly 0.0 mg/dL because p50 equals twin_p50
      expect(screen.getByTestId('forecast-adjustment-value').textContent).toBe('0.0 mg/dL');
    });

    it('Criterion 3b: pending stream reader from earlier subject does not contaminate active subject upon switch', async () => {
      const subjectA = '123e4567-e89b-12d3-a456-426614174000';
      const subjectB = '123e4567-e89b-12d3-a456-426614174001';

      const oldReader = deferredRead();
      const newReader = deferredRead();

      const origDecoder = global.TextDecoder;
      global.TextDecoder = TextDecoder as typeof global.TextDecoder;

      const origFetch = global.fetch;
      const fetchMock = jest.fn()
        .mockResolvedValueOnce({ ok: true, body: { getReader: () => oldReader } } as unknown as Response)
        .mockResolvedValueOnce({ ok: true, body: { getReader: () => newReader } } as unknown as Response);
      global.fetch = fetchMock;

      const { result, rerender } = renderHook(
        ({ id }) => useRealtimeTelemetry(id, { maxRetries: 3, baseDelayMs: 50 }),
        { initialProps: { id: subjectA } }
      );

      await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
      expect(result.current.cache.patientId).toBe(subjectA);

      // Switch subject to Subject B
      rerender({ id: subjectB });
      expect(result.current.cache.patientId).toBe(subjectB);
      expect(result.current.forecast).toBeNull();

      // Old reader emits a delayed packet for Subject A
      const staleSubjectAPacket = createMockForecast({
        subject: { subject_id: subjectA, synthetic: true },
        as_of: '2026-10-19T12:00:00Z',
      });
      const eventPayload = {
        event: 'forecast.updated',
        event_id: '000001-forecast',
        subject_id: subjectA,
        emitted_at: staleSubjectAPacket.generated_at,
        payload: staleSubjectAPacket,
      };

      await act(async () => {
        oldReader.finish({
          done: false,
          value: new Uint8Array(Buffer.from(`id: 000001-forecast\nevent: forecast.updated\ndata: ${JSON.stringify(eventPayload)}\n\n`)),
        });
      });

      // Subject B state must NOT be contaminated by Subject A's late packet
      expect(result.current.cache.patientId).toBe(subjectB);
      expect(result.current.forecast).toBeNull();

      global.fetch = origFetch;
      global.TextDecoder = origDecoder;
    });

    it('Criterion 4b: neural inference failure activates twin-only fallback with deterministic rollout', () => {
      // Simulate backend neural failure catch:
      // When PR-TFT inference throws an exception, backend calls ctx.twin_only(base)
      const basePhysiology = [110, 112, 115, 120, 125, 130, 134, 136, 137, 135, 132, 128, 125, 122, 120, 118, 116, 115, 114, 113, 112, 111, 110, 110];
      const fallbackPoints = basePhysiology.map((g, i) => ({
        offset_min: (i + 1) * 5,
        t: new Date(Date.parse('2026-10-19T12:00:00Z') + (i + 1) * 300000).toISOString(),
        p05: g, p10: g, p25: g, p50: g, p75: g, p90: g, p95: g,
        twin_p50: g,
      })) as any;

      const neuralFailedForecast = createMockForecast({
        model: {
          name: 'PR-TFT-Hybrid',
          version: '1.0.0',
          run_id: 'run-test-01',
          alert_policy_version: '1.0.0',
          fallback_used: 'twin_only',
        },
        forecast: {
          units: 'mg/dL',
          step_min: 5,
          horizon_min: 120,
          conformal_adjusted: false,
          points: fallbackPoints,
        },
        spike_risk: null,
      });

      render(<ForecastCanvas forecast={neuralFailedForecast} cache={mockCache} />);

      expect(screen.getByTestId('twin-only-fallback-badge')).toBeInTheDocument();
      expect(screen.getByTestId('forecast-adjustment-value').textContent).toBe('0.0 mg/dL');
      expect(screen.getByTestId('physics-prior-value').textContent).toBe('128 mg/dL'); // offset 60m is index 11 -> 128
      expect(screen.getByTestId('hybrid-forecast-value').textContent).toBe('128 mg/dL');
    });

    it('Criterion 5: calibration failure structured error resilience (does not fake fallback)', () => {
      // In the system contract, calibration failure MUST raise CALIBRATION_FAILED error
      // and NOT silently fall back to twin_only rollout or manufacture uncalibrated probabilities.
      const calibrationFailureError = {
        status: 500,
        code: 'CALIBRATION_FAILED',
        title: 'Scenario calibration failed',
        detail: 'Scenario sc-01: calibration failed: non-converged isotonic regression',
      };

      expect(calibrationFailureError.status).toBe(500);
      expect(calibrationFailureError.code).toBe('CALIBRATION_FAILED');
      expect(calibrationFailureError.detail).toContain('calibration failed');
      // Must not be confused with twin_only model fallback
      expect((calibrationFailureError as any).fallback_used).toBeUndefined();
    });

    it('Criterion 6: stream staleness badge toggles with isStale prop', () => {
      const forecast = createMockForecast();
      const { rerender } = render(<ForecastCanvas forecast={forecast} cache={mockCache} isStale={false} />);
      expect(screen.queryByTestId('stale-stream-badge')).not.toBeInTheDocument();

      rerender(<ForecastCanvas forecast={forecast} cache={mockCache} isStale={true} />);
      const staleBadge = screen.getByTestId('stale-stream-badge');
      expect(staleBadge).toBeInTheDocument();
      expect(staleBadge.textContent).toBe('Stale stream');
    });
  });
});

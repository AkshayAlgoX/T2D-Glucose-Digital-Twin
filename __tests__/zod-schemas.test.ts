import { ForecastResponseSchema, StreamEventSchema, QuantilePointSchema } from '../src/lib/zod-schemas';

describe('Zod Validation', () => {
  const validForecastResponse = {
    schema_version: '1.0.0',
    request_id: '123e4567-e89b-12d3-a456-426614174000',
    generated_at: '2026-10-04T12:00:00Z',
    as_of: '2026-10-04T12:00:00Z',
    subject: { subject_id: '123e4567-e89b-12d3-a456-426614174000', synthetic: true },
    model: { name: 'tft', version: '1.0.0', run_id: 'run-1', alert_policy_version: '1.0' },
    data_quality: { status: 'ok', cgm_coverage_6h_pct: 100, last_cgm_at: '2026-10-04T12:00:00Z', staleness_min: 0 },
    current: { value_mg_dl: 110, flag: 'in_range', measured_at: '2026-10-04T12:00:00Z', trend_arrow: 'flat' },
    forecast: {
      units: 'mg/dL', step_min: 5, horizon_min: 120,
      points: Array.from({length: 24}, (_, i) => ({
        offset_min: (i+1)*5, t: '2026-10-04T12:05:00Z',
        p05: 90, p10: 95, p25: 100, p50: 110, p75: 120, p90: 125, p95: 130
      }))
    },
    spike_risk: null,
    alert: { state: 'none' },
    intended_use: 'research_only_not_for_clinical_decisions'
  };

  it('validates a valid payload', () => {
    expect(() => ForecastResponseSchema.parse(validForecastResponse)).not.toThrow();
  });

  it('rejects malformed payload', () => {
    expect(() => ForecastResponseSchema.parse({ ...validForecastResponse, data_quality: {} })).toThrow();
  });

  it('rejects missing nested fields', () => {
    const payload = JSON.parse(JSON.stringify(validForecastResponse));
    delete payload.current.trend_arrow;
    expect(() => ForecastResponseSchema.parse(payload)).toThrow();
  });

  it('rejects null/NaN/Infinity where not allowed', () => {
    const payload = JSON.parse(JSON.stringify(validForecastResponse));
    payload.current.value_mg_dl = Infinity; // not allowed by z.number
    expect(() => ForecastResponseSchema.parse(payload)).toThrow();
  });

  it('rejects quantile ordering violations', () => {
    const pt = {
      offset_min: 5, t: '2026-10-04T12:05:00Z',
      p05: 100, p10: 90, // p05 > p10 (violation)
      p25: 100, p50: 110, p75: 120, p90: 125, p95: 130
    };
    expect(() => QuantilePointSchema.parse(pt)).toThrow("Quantiles must be monotonically increasing");
  });

  it('rejects wrong schema version', () => {
    expect(() => ForecastResponseSchema.parse({ ...validForecastResponse, schema_version: '2.0.0' })).toThrow();
  });
  
  it('rejects invalid SSE events', () => {
    expect(() => StreamEventSchema.parse({
      event: 'unknown.event',
      event_id: '1',
      subject_id: '123e4567-e89b-12d3-a456-426614174000',
      emitted_at: '2026-10-04T12:00:00Z',
      payload: {}
    })).toThrow();
  });
});

import { validateForecastResponse, validateStreamEvent } from '../src/lib/schema-validator';

describe('API Contract Validation Gates', () => {
  const mockUUID = '123e4567-e89b-12d3-a456-426614174000';

  it('rejects malformed quantile / missing p10', () => {
    const invalidPayload = {
      event_id: mockUUID,
      subject_id: mockUUID,
      emitted_at: "2026-09-30T15:14:28Z",
      event: "forecast.updated",
      payload: {
        schema_version: "1.0.0",
        request_id: mockUUID,
        generated_at: "2026-09-30T15:14:28Z",
        as_of: "2026-09-28T11:55:00Z",
        subject: { subject_id: mockUUID, synthetic: true },
        model: { name: "test", version: "1.0.0", run_id: mockUUID, alert_policy_version: "1.0", fallback_used: null },
        intended_use: "research_only_not_for_clinical_decisions",
        data_quality: { status: "ok", cgm_coverage_6h_pct: 100, last_cgm_at: "2026-09-28T11:55:00Z", staleness_min: 0 },
        current: { value_mg_dl: 125.0, measured_at: "2026-09-28T11:55:00Z", flag: "in_range", trend_arrow: "flat" },
        forecast: {
          units: "mg/dL",
          step_min: 5,
          horizon_min: 120,
          points: [
            // missing p10 and p90
            { offset_min: 5, t: "2026-09-28T12:00:00Z", p05: 100, p25: 110, p50: 120, p75: 130, p95: 140 }
          ]
        },
        spike_risk: { 
          probability_120m: 0.1, 
          tier: "low",
          calibrated: true,
          spike_in_progress: false,
          definition: { threshold_mg_dl: 180, min_rise_mg_dl: 30, rise_window_min: 30, persistence_min: 15 },
          cumulative: []
        },
        alert: { state: "none" }
      }
    };
    const isValidEnvelope = validateStreamEvent(invalidPayload);
    const isPayloadValid = invalidPayload.event !== 'forecast.updated' || validateForecastResponse(invalidPayload.payload);
    expect(isValidEnvelope && isPayloadValid).toBe(false);
  });

  it('accepts valid full payload', () => {
    const validPayload = {
      event_id: mockUUID,
      subject_id: mockUUID,
      emitted_at: "2026-09-30T15:14:28Z",
      event: "forecast.updated",
      payload: {
        schema_version: "1.0.0",
        request_id: mockUUID,
        generated_at: "2026-09-30T15:14:28Z",
        as_of: "2026-09-28T11:55:00Z",
        subject: { subject_id: mockUUID, synthetic: true },
        model: { name: "test", version: "1.0.0", run_id: mockUUID, alert_policy_version: "1.0", fallback_used: null },
        intended_use: "research_only_not_for_clinical_decisions",
        data_quality: { status: "ok", cgm_coverage_6h_pct: 100, last_cgm_at: "2026-09-28T11:55:00Z", staleness_min: 0 },
        current: { value_mg_dl: 125.0, measured_at: "2026-09-28T11:55:00Z", flag: "in_range", trend_arrow: "flat" },
        forecast: {
          units: "mg/dL",
          step_min: 5,
          horizon_min: 120,
          points: Array.from({length: 24}, (_, i) => ({
             offset_min: (i+1)*5, t: "2026-09-28T12:00:00Z", 
             p05: 100, p10: 105, p25: 110, p50: 120, p75: 130, p90: 135, p95: 140 
          }))
        },
        spike_risk: { 
          probability_120m: 0.1, 
          tier: "low",
          calibrated: true,
          spike_in_progress: false,
          definition: { threshold_mg_dl: 180, min_rise_mg_dl: 30, rise_window_min: 30, persistence_min: 15 },
          cumulative: Array.from({length: 24}, (_, i) => ({ offset_min: (i+1)*5, p: 0.1 }))
        },
        alert: { state: "none" }
      }
    };
    const isValidEnvelope = validateStreamEvent(validPayload);
    const isPayloadValid = validPayload.event !== 'forecast.updated' || validateForecastResponse(validPayload.payload);
    
    if (!isValidEnvelope) console.error("Envelope:", validateStreamEvent.errors);
    if (!isPayloadValid) console.error("Payload:", validateForecastResponse.errors);
    
    expect(isValidEnvelope && isPayloadValid).toBe(true);
  });
});

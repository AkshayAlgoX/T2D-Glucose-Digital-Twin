import { ForecastResponse as FrontendForecastResponse, TelemetryDataPoint } from '@/types/digital-twin';

export function mapBackendForecast(payload: any): FrontendForecastResponse {
  const data: TelemetryDataPoint[] = [];

  // 1. Current / Historical point
  if (payload.current && payload.current.measured_at) {
    data.push({
      timestamp: payload.current.measured_at,
      historicalGlucose: payload.current.value_mg_dl ?? null,
      forecastGlucose: null,
      quantileLower: null,
      quantileUpper: null,
      isSpikePredicted: false
    });
  }

  // 2. Forecast points
  if (payload.forecast && payload.forecast.points) {
    for (const p of payload.forecast.points) {
      data.push({
        timestamp: p.t,
        historicalGlucose: null,
        forecastGlucose: p.p50 ?? null,
        ukfBaseline: p.twin_p50 ?? null,
        learnedCorrection: (p.p50 != null && p.twin_p50 != null) ? Number((p.p50 - p.twin_p50).toFixed(1)) : null,
        quantileLower: p.p10 ?? null,
        quantileUpper: p.p90 ?? null,
        isSpikePredicted: false
      });
    }
  }

  // 3. Scenario points (if any)
  // Scenario data is mapped separately in POST /api/forecast

  return {
    patientId: payload.subject?.subject_id || "unknown",
    generatedAt: payload.generated_at || new Date().toISOString(),
    spike_risk: {
      tier: payload.spike_risk?.tier || 'low'
    },
    spikeProbability120m: payload.spike_risk?.probability_120m,
    predictedEvent: 'hyperglycemia_spike',
    drivers: (payload.drivers || []).map((d: any) => ({
      feature_key: d.feature_key || d.label_key,
      direction: d.direction,
      impact_mg_dl: d.impact_mg_dl,
      source: d.source
    })),
    data,
    _raw_data_quality: payload.data_quality
  } as any;
}

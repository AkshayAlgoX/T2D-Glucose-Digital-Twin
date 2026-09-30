import { mapBackendForecast } from '../src/lib/api-mapper';
import fixture from './fixtures/backend-fixture.json';

describe('API Mapper Contract', () => {
  it('maps p50/p05/p95 correctly', () => {
    const result = mapBackendForecast(fixture.payload);
    const forecastPoints = result.data.filter(d => d.forecastGlucose !== null);
    
    expect(forecastPoints.length).toBe(2);
    expect(forecastPoints[0].forecastGlucose).toBe(126.5);
    expect(forecastPoints[0].quantileLower).toBe(111.2);
    expect(forecastPoints[0].quantileUpper).toBe(141.7);
  });

  it('maps probability_120m to spikeProbability120m', () => {
    const result = mapBackendForecast(fixture.payload);
    expect(result.spikeProbability120m).toBe(0.443);
    expect(result.spike_risk.tier).toBe('elevated');
  });

  it('maps drivers correctly', () => {
    const result = mapBackendForecast(fixture.payload);
    expect(result.drivers).toBeDefined();
    expect(result.drivers?.[0].feature_key).toBe('return_to_personal_baseline');
    expect(result.drivers?.[0].importance).toBe(32.5 / 50); // Normalized
  });
  
  it('maps current glucose', () => {
    const result = mapBackendForecast(fixture.payload);
    const currentPoints = result.data.filter(d => d.historicalGlucose !== null);
    expect(currentPoints.length).toBe(1);
    expect(currentPoints[0].historicalGlucose).toBe(125.0);
    expect(currentPoints[0].timestamp).toBe('2026-09-28T11:55:00Z');
  });
});

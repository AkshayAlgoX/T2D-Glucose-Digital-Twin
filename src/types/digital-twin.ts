export interface TelemetryDataPoint {
  timestamp: string;
  historicalGlucose: number | null;
  forecastGlucose: number | null;
  quantileLower: number | null;
  quantileUpper: number | null;
  isSpikePredicted?: boolean;
}

export interface MLDriver {
  feature_key: string;
  direction: 'raises' | 'lowers';
  importance: number;
  raw_value?: string | number;
}

export interface ForecastResponse {
  patientId: string;
  generatedAt: string;
  data: TelemetryDataPoint[];
  spike_risk: { tier: 'low' | 'elevated' | 'high' };
  spikeProbability120m?: number;
  predictedEvent?: string;
  drivers?: MLDriver[];
  _raw_data_quality?: any;
}

import type { ForecastResponse } from '@/types/forecast-response';
import type { StreamEvent } from '@/types/stream-event';

export type ModelMode = 'full' | 'twin_only' | 'xgboost' | 'persistence' | 'unavailable';

export interface Snapshot {
  forecastResponse: ForecastResponse | null;
  patientId: string;
  epoch: number;
}

export interface RiskView {
  t: string;
  p: number;
}

export interface AlertView {
  t: string;
  state: string;
}

export interface DataQualityView {
  t: string;
  status: string;
}

export interface CgmView {
  t: string;
  value: number;
  trend: string;
}

/** Wearable and log readings at one anchor, exactly as the network consumed them. */
export interface WearableView {
  t: string;
  heartRate: number | null;
  hrv: number | null;
  steps: number;
  asleep: boolean;
  carbs: number;
}

export interface SubjectStore {
  patientId: string;
  cgm: CgmView[];
  wearables?: WearableView[];
  risk: RiskView[];
  alerts: AlertView[];
  dataQuality: DataQualityView[];
  onsets?: { t: string }[];
  risk_history?: { t: string; p: number }[];
}

import type { ForecastResponse, QuantilePoint } from '@/types/forecast-response';
import type { SubjectStore } from '@/lib/types';

/**
 * A FHIR R4 collection Bundle of what the workspace shows: received CGM readings as final
 * Observations, the forecast median as preliminary Observations marked as model output, and the
 * spike risk as a RiskAssessment. Synthetic subject; nothing is added that the backend did not serve.
 */
const LOINC_CGM = { system: 'http://loinc.org', code: '99504-3', display: 'Glucose [Mass/volume] in Interstitial fluid' };
const MG_DL = { unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' };
// HL7 v3 ActReason HTEST: test health data, the standard security label for non-real records.
const SYNTHETIC_TAG = { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST', display: 'test health data' };
const LABORATORY = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory', display: 'Laboratory' }] }];

export function fhirBundle(forecast: ForecastResponse, cache: SubjectStore, generatedAt: string) {
  const patientRef = `Patient/${forecast.subject.subject_id}`;
  const asOf = Date.parse(forecast.as_of);
  const observed = (cache?.cgm ?? []).filter(p => Number.isFinite(p.value) && Date.parse(p.t) <= asOf);
  const entries: Array<{ resource: Record<string, unknown> }> = [{
    resource: { resourceType: 'Patient', id: forecast.subject.subject_id, meta: { security: [SYNTHETIC_TAG] } },
  }];
  observed.forEach((p, i) => entries.push({
    resource: { resourceType: 'Observation', id: `cgm-${i}`, meta: { security: [SYNTHETIC_TAG] }, status: 'final', category: LABORATORY, code: { coding: [LOINC_CGM] }, subject: { reference: patientRef },
      effectiveDateTime: p.t, valueQuantity: { value: p.value, ...MG_DL } },
  }));
  const points: QuantilePoint[] = forecast.forecast?.points ?? [];
  points.forEach(p => entries.push({
    resource: { resourceType: 'Observation', id: `forecast-${p.offset_min}`, meta: { security: [SYNTHETIC_TAG] }, status: 'preliminary', category: LABORATORY, code: { coding: [LOINC_CGM], text: 'Forecast interstitial glucose (model output, not measured)' },
      method: { text: `${forecast.model.name} ${forecast.model.version}, median of the predictive distribution` },
      subject: { reference: patientRef }, effectiveDateTime: p.t, issued: forecast.as_of, valueQuantity: { value: p.p50, ...MG_DL },
      referenceRange: [{ low: { value: p.p10, ...MG_DL }, high: { value: p.p90, ...MG_DL }, text: '10th–90th percentile' }] },
  }));
  const risk = forecast.spike_risk;
  if (risk) entries.push({
    resource: { resourceType: 'RiskAssessment', id: 'spike-risk', meta: { security: [SYNTHETIC_TAG] }, status: 'preliminary', subject: { reference: patientRef }, occurrenceDateTime: forecast.as_of,
      method: { text: `${forecast.model.name} ${forecast.model.version}; ${risk.calibrated ? 'calibrated' : 'uncalibrated'}; alert policy ${forecast.model.alert_policy_version}` },
      prediction: [{ outcome: { text: `Glucose above ${risk.definition.threshold_mg_dl} mg/dL (spike onset) within 120 min` },
        probabilityDecimal: risk.probability_120m, whenRange: { low: { value: 0, unit: 'min' }, high: { value: 120, unit: 'min' } } }],
      note: [{ text: 'Research use only; not for clinical decisions. Synthetic data.' }] },
  });
  return { resourceType: 'Bundle', type: 'collection', timestamp: generatedAt, entry: entries };
}

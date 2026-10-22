import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import catalog from '../src/data/indian-meals.json';
import { MEAL_FOODS, MEAL_SOURCE, plateCarbs, searchFoods } from '../src/lib/meals';
import { fhirBundle } from '../src/lib/fhir';
import { ScenarioEditor } from '../src/components/digital-twin/ScenarioEditor';
import { ClinicianReport } from '../src/components/digital-twin/ClinicianReport';
import { PatientWorkspace } from '../src/components/digital-twin/PatientWorkspace';
import type { ScenarioState } from '../src/hooks/useScenario';
import type { ForecastResponse } from '../src/types/forecast-response';
import type { SubjectStore } from '../src/lib/types';

// Unit-test data only; never used by the application or as scientific evidence.
const anchor = '2026-10-04T12:00:00Z';
const at = (min: number) => new Date(Date.parse(anchor) + min * 60000).toISOString();
const cache: SubjectStore = { patientId: 'test-subject', cgm: [{ t: at(-10), value: 150 }, { t: at(-5), value: 155 }, { t: at(0), value: 160 }], risk: [], alerts: [], dataQuality: [] } as SubjectStore;

function forecastFixture(): ForecastResponse {
  return {
    request_id: 'req-1', as_of: anchor, subject: { synthetic: true, subject_id: 'test-subject', cohort: 'unit/val', simulator: { param_set_id: 'UNIT-7' } },
    model: { name: 'unit-model', version: '0.0', run_id: 'run-1', alert_policy_version: 'ap-1', fallback_used: null },
    current: { value_mg_dl: 160, flag: 'in_range', measured_at: anchor, trend_arrow: 'rising' }, alert: { state: 'watch', since: anchor },
    data_quality: { status: 'degraded', cgm_coverage_6h_pct: 81.5, staleness_min: 4, last_cgm_at: anchor, reasons: ['cgm_gap'] },
    ehr_context: { age_years: 42, sex: 'female', bmi: 26.2, hba1c_pct: 6.8, hba1c_date: '2026-10-01', egfr: null },
    forecast: { units: 'mg/dL', step_min: 5, horizon_min: 120,
      points: Array.from({ length: 24 }, (_, i) => ({ offset_min: (i + 1) * 5, t: at((i + 1) * 5), p05: 150, p10: 155, p25: 160, p50: 170 + i, p75: 180, p90: 190 + i, p95: 200, twin_p50: 168 + i })) },
    spike_risk: { probability_120m: 0.42, tier: 'elevated', calibrated: true, spike_in_progress: false,
      definition: { threshold_mg_dl: 180, min_rise_mg_dl: 30, rise_window_min: 60, persistence_min: 15 },
      cumulative: Array.from({ length: 24 }, (_, i) => ({ offset_min: (i + 1) * 5, p: (i + 1) / 60 })) },
    intended_use: 'research_only_not_for_clinical_decisions',
  } as unknown as ForecastResponse;
}

describe('Indian meal catalog (USDA FNDDS)', () => {
  it('keeps source, licence and per-dish provenance, with no hand-filled values', () => {
    expect(MEAL_SOURCE.source).toMatch(/USDA FoodData Central.*FNDDS/);
    expect(MEAL_SOURCE.license).toMatch(/CC0/);
    expect(MEAL_FOODS.length).toBe(catalog.foods.length);
    for (const f of MEAL_FOODS) {
      expect(Number.isInteger(f.fdcId)).toBe(true);
      expect(f.carbsPer100g).toBeGreaterThanOrEqual(0);
      expect(f.portions.length).toBeGreaterThan(0);
      f.portions.forEach(p => expect(p.grams).toBeGreaterThan(0));
    }
  });

  it('searches on every word and totals a plate to one decimal', () => {
    expect(searchFoods('dosa').map(f => f.name)).toEqual(['Dosa, plain', 'Dosa, with filling']);
    expect(searchFoods('dosa fill').map(f => f.name)).toEqual(['Dosa, with filling']);
    const idli = searchFoods('idli')[0];
    expect(plateCarbs([{ food: idli, portion: idli.portions[0], count: 2 }])).toBe(Math.round(idli.carbsPer100g * idli.portions[0].grams * 2 / 10) / 10);
  });
});

describe('What-if meal builder', () => {
  beforeEach(() => { global.fetch = jest.fn(); });

  it('builds a plate, sends its carbohydrate as the scenario meal and reports the plate upward', async () => {
    const idli = searchFoods('idli')[0];
    const expected = plateCarbs([{ food: idli, portion: idli.portions[0], count: 2 }]);
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      pinned_as_of: anchor, subject_id: 'test-subject', fallback_used: null, current_mg_dl: 160, warnings: [],
      baseline_forecast: Array.from({ length: 24 }, (_, i) => ({ timestamp: at((i + 1) * 5), p10: 150, p50: 160 + i, p90: 170 })),
      scenario_forecast: Array.from({ length: 24 }, (_, i) => ({ timestamp: at((i + 1) * 5), p10: 150, p50: 160 + 2 * i, p90: 190 })),
      metrics: { delta_peak_mg_dl: 23, new_peak_mg_dl: 206, baseline_peak_mg_dl: 183, delta_probability: 0.1, new_probability: 0.5, baseline_probability: 0.4 },
    }) });
    const onStateChange = jest.fn();
    render(<ScenarioEditor patientId="test-subject" currentForecast={forecastFixture()} onStateChange={onStateChange} />);
    const builder = screen.getByTestId('meal-builder');
    fireEvent.change(within(builder).getByLabelText('Find a dish'), { target: { value: 'idli' } });
    fireEvent.click(within(builder).getByRole('button', { name: /^Idli/ }));
    fireEvent.change(within(builder).getByLabelText('Count'), { target: { value: '2' } });
    fireEvent.click(within(builder).getByRole('button', { name: /Add to plate/ }));
    expect(screen.getByTestId('plate-total')).toHaveTextContent(`${expected.toFixed(1)} g`);
    fireEvent.click(within(builder).getByRole('button', { name: `Use ${expected.toFixed(1)} g carbohydrate` }));
    expect(screen.getByLabelText('Carbohydrate (g)')).toHaveValue(expected);
    // A plate total has one decimal; the native field must accept it or the browser blocks the submit.
    expect((screen.getByLabelText('Carbohydrate (g)') as HTMLInputElement).validity.valid).toBe(true);
    expect(screen.getByLabelText('Carbohydrate (g)')).toHaveAttribute('step', '0.1');
    expect(screen.getByTestId('meal-applied')).toHaveTextContent('2 × Idli');

    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await screen.findByTestId('scenario-result');
    const sent = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(sent.scenarios[0].inputs).toEqual([{ kind: 'meal', offset_min: 30, carbs_g: expected }]);
    await waitFor(() => expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'result' }), expect.stringContaining('Idli')));
  });

  it('rejects a count outside 1–10 and forgets the plate once grams are typed by hand', () => {
    render(<ScenarioEditor patientId="test-subject" currentForecast={forecastFixture()} />);
    const builder = screen.getByTestId('meal-builder');
    fireEvent.change(within(builder).getByLabelText('Find a dish'), { target: { value: 'dal' } });
    fireEvent.click(within(builder).getByRole('button', { name: /^Dal/ }));
    fireEvent.change(within(builder).getByLabelText('Count'), { target: { value: '11' } });
    expect(within(builder).getByRole('alert')).toHaveTextContent('1 to 10');
    expect(within(builder).getByRole('button', { name: /Add to plate/ })).toBeDisabled();
    fireEvent.change(within(builder).getByLabelText('Count'), { target: { value: '1' } });
    fireEvent.click(within(builder).getByRole('button', { name: /Add to plate/ }));
    fireEvent.click(within(builder).getByRole('button', { name: /^Use / }));
    expect(screen.getByTestId('meal-applied')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Carbohydrate (g)'), { target: { value: '45' } });
    expect(screen.queryByTestId('meal-applied')).not.toBeInTheDocument();
  });

  it('says plainly when no catalogued dish matches', () => {
    render(<ScenarioEditor patientId="test-subject" currentForecast={forecastFixture()} />);
    fireEvent.change(screen.getByLabelText('Find a dish'), { target: { value: 'zzzz' } });
    expect(screen.getByText(/No catalogued dish matches/)).toBeInTheDocument();
  });
});

describe('Clinician summary', () => {
  it('opens from the workspace header, shows served values with their status, and closes on Escape', () => {
    render(<PatientWorkspace patientId="test-subject" forecast={forecastFixture()} cache={cache} isConnected isStale={false} />);
    fireEvent.click(screen.getByTestId('open-report'));
    const dialog = screen.getByRole('dialog', { name: /UNIT-7: glucose forecast summary/ });
    expect(dialog).toHaveTextContent('160 mg/dL');
    expect(dialog).toHaveTextContent('42.0%');
    expect(dialog).toHaveTextContent('calibrated · above 180 mg/dL');
    expect(dialog).toHaveTextContent('model output, not measured');
    expect(dialog).toHaveTextContent('81.5%');
    expect(dialog).toHaveTextContent('cgm gap');
    expect(dialog).toHaveTextContent('No scenario was run in this session');
    expect(dialog).toHaveTextContent('not for clinical decisions');
    expect(within(dialog).getByRole('row', { name: /\+60 min/ })).toHaveTextContent('181 mg/dL');
    expect(document.body).toHaveClass('report-open');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body).not.toHaveClass('report-open');
  });

  it('includes the last scenario comparison with its plate and disclaimer', () => {
    const f = forecastFixture();
    const curve = (slope: number) => Array.from({ length: 24 }, (_, i) => ({ timestamp: at((i + 1) * 5), p10: 150, p50: 160 + slope * i, p90: 190 }));
    const scenario: ScenarioState = { status: 'result', patientId: 'test-subject', asOf: anchor, input: { kind: 'meal', offset_min: 30, carbs_g: 19 },
      result: { pinned_as_of: anchor, fallback_used: null, current_mg_dl: 160, warnings: [{ code: 'OOD', title: 'Meal outside training range' }],
        baseline_forecast: curve(1), scenario_forecast: curve(2),
        metrics: { delta_peak_mg_dl: 23, new_peak_mg_dl: 206, baseline_peak_mg_dl: 183, delta_probability: 0.1, new_probability: 0.5, baseline_probability: 0.4 } } };
    render(<ClinicianReport forecast={f} cache={cache} baseline={null} record={null} partition={null} scenario={scenario} plate="2 × Idli (1 item)" onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('2 × Idli (1 item)');
    expect(dialog).toHaveTextContent('183 → 206 mg/dL');
    expect(dialog).toHaveTextContent('40.0% → 50.0%');
    expect(dialog).toHaveTextContent('Meal outside training range');
    expect(dialog).toHaveTextContent('not a validated causal treatment effect');
  });
});

describe('FHIR R4 export', () => {
  it('marks measured readings final, forecasts preliminary, and carries the served risk unchanged', () => {
    const b = fhirBundle(forecastFixture(), cache, '2026-10-04T12:01:00Z');
    expect(b).toMatchObject({ resourceType: 'Bundle', type: 'collection' });
    const res = b.entry.map(e => e.resource as Record<string, any>);
    const obs = res.filter(r => r.resourceType === 'Observation');
    expect(obs.filter(o => o.status === 'final').map(o => o.valueQuantity.value)).toEqual([150, 155, 160]);
    const fc = obs.filter(o => o.status === 'preliminary');
    expect(fc).toHaveLength(24);
    expect(fc[0].code.text).toMatch(/model output, not measured/);
    expect(fc[11]).toMatchObject({ valueQuantity: { value: 181, unit: 'mg/dL' }, referenceRange: [{ low: { value: 155 }, high: { value: 201 } }] });
    const risk = res.find(r => r.resourceType === 'RiskAssessment');
    expect(risk.prediction[0].probabilityDecimal).toBe(0.42);
    expect(res.find(r => r.resourceType === 'Patient').meta.tag[0].code).toBe('synthetic');
  });
});

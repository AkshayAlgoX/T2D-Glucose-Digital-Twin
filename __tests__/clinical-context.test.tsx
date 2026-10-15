import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { PatientWorkspace } from '../src/components/digital-twin/PatientWorkspace';
import { ForecastResponseSchema } from '../src/lib/zod-schemas';
import type { EhrContext, ForecastResponse } from '../src/types/forecast-response';
import source from './fixtures/risk-audit-forecast.json';

expect.extend(toHaveNoViolations);

// Presentation fixtures only. No backend requests or scientific computation.
const ehr: EhrContext = {
  age_years: 58, sex: 'female', bmi: 27.4, hba1c_pct: 7.2,
  hba1c_date: '2026-09-28', egfr: 90, t2d_duration_years: 9.3,
  med_classes: ['metformin', 'sglt2i', 'basal_insulin'],
};
function fixture(): ForecastResponse {
  return ForecastResponseSchema.parse({ ...source, ehr_context: ehr }) as ForecastResponse;
}
function workspace(forecast: ForecastResponse | null) {
  return <PatientWorkspace patientId={source.subject.subject_id} forecast={forecast}
    cache={{ patientId: source.subject.subject_id, cgm: [], risk: [], alerts: [], dataQuality: [] }}
    isConnected={!!forecast} isStale={false} />;
}
function context() { return screen.getByRole('region', { name: 'Clinical Context' }); }
function value(label: string) {
  const term = within(context()).getByText(label, { selector: 'dt' });
  expect(term.nextElementSibling?.tagName).toBe('DD');
  return term.nextElementSibling!;
}

describe('Clinical context source fidelity', () => {
  it('renders validated duration and every supplied medication class under semantic labels', () => {
    const forecast = fixture();
    const before = JSON.stringify(forecast);
    render(workspace(forecast));
    expect(value('Diabetes duration')).toHaveTextContent(/^9\.3 years$/);
    expect(value('Medication classes (EHR)')).toHaveTextContent(/^Metformin, SGLT2 inhibitor, Basal insulin$/);
    expect(value('HbA1c')).toHaveTextContent('7.2%');
    expect(JSON.stringify(forecast)).toBe(before);
    expect(screen.getByText('Synthetic subject')).toBeInTheDocument();
    expect(screen.getByText('Research Only (Not for clinical decisions)')).toBeInTheDocument();
  });

  it.each([0, 1])('preserves duration %s including a valid zero', duration => {
    const forecast = fixture();
    forecast.ehr_context!.t2d_duration_years = duration;
    render(workspace(forecast));
    expect(value('Diabetes duration')).toHaveTextContent(duration === 1 ? /^1 year$/ : /^0 years$/);
  });

  it.each([-1, NaN, Infinity, -Infinity, '9.3', ''])('rejects invalid duration %p without retaining earlier context', duration => {
    const { rerender } = render(workspace(fixture()));
    expect(value('Diabetes duration')).toHaveTextContent(/^9\.3 years$/);
    const next = fixture();
    // Defensive presentation inputs; these are deliberately invalid wire values.
    next.ehr_context = { ...ehr, t2d_duration_years: duration } as unknown as EhrContext;
    rerender(workspace(next));
    expect(value('Diabetes duration')).toHaveTextContent(/^Unavailable$/);
    expect(value('Medication classes (EHR)')).toHaveTextContent('Metformin');
  });

  it.each([undefined, null, {}])('handles absent or empty EHR context (%p) without invented values', input => {
    const forecast = fixture();
    // Null and empty objects are defensive presentation cases, not valid wire contracts.
    forecast.ehr_context = input as unknown as EhrContext;
    render(workspace(forecast));
    expect(value('Diabetes duration')).toHaveTextContent(/^Unavailable$/);
    expect(value('Medication classes (EHR)')).toHaveTextContent(/^Unavailable$/);
    expect(value('Age')).toHaveTextContent('—');
    expect(value('HbA1c')).toHaveTextContent('—');
    expect(context()).not.toHaveTextContent(/undefined|null|NaN/);
    expect(context().querySelector('time')).toBeNull();
  });

  it.each([undefined, null])('distinguishes missing/null optional fields (%p) from zero and an empty list', input => {
    const forecast = fixture();
    forecast.ehr_context = { ...ehr, t2d_duration_years: input, med_classes: input } as unknown as EhrContext;
    render(workspace(forecast));
    expect(value('Diabetes duration')).toHaveTextContent(/^Unavailable$/);
    expect(value('Medication classes (EHR)')).toHaveTextContent(/^Unavailable$/);
  });

  it('replaces earlier values when updated context contains an empty medication list and no duration', () => {
    const { rerender } = render(workspace(fixture()));
    const next = fixture();
    delete next.ehr_context!.t2d_duration_years;
    next.ehr_context!.med_classes = [];
    rerender(workspace(next));
    expect(value('Diabetes duration')).toHaveTextContent(/^Unavailable$/);
    expect(value('Medication classes (EHR)')).toHaveTextContent(/^None listed$/);
    expect(context()).not.toHaveTextContent(/Metformin|9\.3 years/);
  });

  it('uses the supplied date as synthetic cohort provenance, never as a measurement date', () => {
    const forecast = fixture();
    const { rerender } = render(workspace(forecast));
    const provenance = within(context()).getByText('Context provenance').closest('details')!;
    fireEvent.click(provenance.querySelector('summary')!);
    expect(provenance).toHaveAttribute('open');
    expect(provenance).toHaveTextContent('HbA1c reference date: 28 Sept 2026');
    expect(provenance).toHaveTextContent('Date assigned to synthetic cohort start, not a clinical measurement date.');
    expect(provenance.querySelector('time')).toHaveAttribute('datetime', ehr.hba1c_date);
    forecast.ehr_context = { ...ehr, hba1c_date: '2026-10-02' };
    rerender(workspace(forecast));
    expect(provenance.querySelector('time')).toHaveAttribute('datetime', '2026-10-02');
    expect(provenance).toHaveTextContent('02 Oct 2026');
    expect(provenance).not.toHaveTextContent('HbA1c recorded');
  });

  it.each([undefined, null, '', 'not-a-date'])('does not fabricate a reference date for %p', date => {
    const forecast = fixture();
    forecast.ehr_context = { ...ehr, hba1c_date: date } as unknown as EhrContext;
    render(workspace(forecast));
    expect(context()).toHaveTextContent('HbA1c reference date: Unavailable');
    expect(context().querySelector('time')).toBeNull();
  });

  it('keeps both labels in loading state and replaces their placeholders with source values', () => {
    const { container, rerender } = render(workspace(null));
    for (const label of ['Diabetes duration', 'Medication classes (EHR)']) {
      expect(value(label).querySelector('.skeleton')).not.toBeNull();
    }
    rerender(workspace(fixture()));
    expect(value('Diabetes duration')).toHaveTextContent('9.3 years');
    expect(value('Medication classes (EHR)')).toHaveTextContent('Metformin');
    expect(container.querySelector('.clinical-context [aria-busy="true"]')).toBeNull();
  });

  it('retains narrow-screen disclosure behavior and complete medication content', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: jest.fn(query => ({
      matches: query === '(max-width: 640px)', media: query,
      addEventListener: jest.fn(), removeEventListener: jest.fn(),
    })) });
    try {
      const forecast = fixture();
      forecast.ehr_context!.med_classes = ['metformin', 'sglt2i', 'glp1_ra', 'dpp4i', 'sulfonylurea', 'tzd', 'basal_insulin', 'prandial_insulin', 'corticosteroid'];
      const { container, unmount } = render(workspace(forecast));
      const disclosure = container.querySelector('.patient-context')!;
      expect(disclosure).not.toHaveAttribute('open');
      fireEvent.click(disclosure.querySelector('summary')!);
      expect(disclosure).toHaveAttribute('open');
      expect(value('Medication classes (EHR)')).toHaveTextContent('Metformin, SGLT2 inhibitor, GLP-1 receptor agonist, DPP-4 inhibitor, Sulfonylurea, Thiazolidinedione (TZD), Basal insulin, Prandial insulin, Corticosteroid');
      expect(value('Diabetes duration')).toHaveTextContent('9.3 years');
      expect(await axe(context())).toHaveNoViolations();
      fireEvent.click(disclosure.querySelector('summary')!);
      expect(disclosure).not.toHaveAttribute('open');
      unmount();
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', original);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });
});

import React from 'react';
import { render, act } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import PatientDashboard from '../src/app/patients/[id]/page';
import CohortPage from '../src/app/cohort/page';

expect.extend(toHaveNoViolations);

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: '123' })
}));

import { useRealtimeTelemetry } from '../src/hooks/useRealtimeTelemetry';
jest.mock('../src/hooks/useRealtimeTelemetry', () => ({
  useRealtimeTelemetry: jest.fn().mockReturnValue({
    forecast: {
       as_of: '2026-09-28T11:55:00Z',
       current: { value_mg_dl: 125.0, measured_at: '2026-09-28T11:55:00Z' },
       data_quality: { status: 'ok' },
       forecast: { points: [] },
       spike_risk: { probability_120m: 0.1 }
    },
    cache: { cgm: [], risk: [], alerts: [], dataQuality: [] },
    isConnected: true,
    isStale: false,
    error: null
  })
}));

describe('Axe accessibility checks', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({ items: [] })
    });
  });

  it('has zero violations on PatientDashboard', async () => {
    const { container } = render(<PatientDashboard />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('has zero violations on CohortPage', async () => {
    let container: HTMLElement;
    await act(async () => {
      const result = render(<CohortPage />);
      container = result.container;
    });
    const results = await axe(container!);
    expect(results).toHaveNoViolations();
  });
});

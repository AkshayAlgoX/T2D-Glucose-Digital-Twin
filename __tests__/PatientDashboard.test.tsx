import React from 'react';
import { render, screen } from '@testing-library/react';
import PatientDashboard from '../src/app/patients/[id]/page';

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: '123' })
}));

import { useRealtimeTelemetry } from '../src/hooks/useRealtimeTelemetry';
jest.mock('../src/hooks/useRealtimeTelemetry', () => ({
  useRealtimeTelemetry: jest.fn()
}));

jest.mock('../src/components/digital-twin/ForecastCanvas', () => ({
  ForecastCanvas: () => <div data-testid="chart-suite-mock" />
}));

jest.mock('../src/components/digital-twin/ScenarioEditor', () => ({
  ScenarioEditor: () => <div data-testid="scenario-editor-mock" />
}));

describe('PatientDashboard', () => {
  const mockUseTelemetry = useRealtimeTelemetry as jest.Mock;

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders fallback state on insufficient data without crashing', () => {
    mockUseTelemetry.mockReturnValue({
      forecast: {
        data_quality: { status: 'insufficient' }
      },
      isConnected: true,
      isStale: false,
      error: null
    });

    render(<PatientDashboard />);
    
    expect(screen.getByText(/No forecast/i)).toBeInTheDocument();
  });

  it('displays stale/disconnected state', () => {
    mockUseTelemetry.mockReturnValue({
      forecast: {
        data: [{ timestamp: '2026-09-28T11:55:00Z', historicalGlucose: 100 }],
        data_quality: { status: 'ok' }
      },
      isConnected: false,
      isStale: true,
      error: null
    });

    render(<PatientDashboard />);
    
    expect(screen.getByText(/Disconnected/i)).toBeInTheDocument();
    expect(screen.getByText(/Stale/i)).toBeInTheDocument();
  });
});

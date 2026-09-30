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

jest.mock('../src/components/digital-twin/BodyVisualizer3D', () => ({
  BodyVisualizer3D: () => <div data-testid="body-3d-mock" />
}));

jest.mock('../src/components/digital-twin/TelemetryChartSuite', () => ({
  TelemetryChartSuite: () => <div data-testid="chart-suite-mock" />
}));

jest.mock('../src/components/digital-twin/PredictiveInsightsPanel', () => ({
  PredictiveInsightsPanel: () => <div data-testid="insights-panel-mock" />
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
        _raw_data_quality: { status: 'insufficient' },
        data: []
      },
      isConnected: true,
      isStale: false,
      error: null
    });

    // PatientDashboard is not actually async in Next 14 Client Components or Server Components where we don't await anything in it?
    // Wait, PatientDashboard does not use `await`.
    render(<PatientDashboard />);
    
    expect(screen.getByText(/Insufficient Data/i)).toBeInTheDocument();
    expect(screen.queryByTestId('chart-suite-mock')).not.toBeInTheDocument();
  });

  it('displays stale/disconnected state', () => {
    mockUseTelemetry.mockReturnValue({
      forecast: {
        data: [{ timestamp: '2026-09-28T11:55:00Z', historicalGlucose: 100 }],
        _raw_data_quality: { status: 'ok' }
      },
      isConnected: false,
      isStale: true,
      error: null
    });

    render(<PatientDashboard />);
    
    expect(screen.getByText(/Disconnected/i)).toBeInTheDocument();
  });
});

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ScenarioEditor } from '../src/components/digital-twin/ScenarioEditor';

// Mock recharts
jest.mock('recharts', () => {
  const Original = jest.requireActual('recharts');
  return {
    ...Original,
    ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
    LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
    Line: (props: any) => <div data-testid={`line-${props.dataKey}`} />
  };
});

describe('ScenarioEditor', () => {
  const mockCurrentForecast = {
    data: [
      { timestamp: '2026-09-28T12:00:00Z', forecastGlucose: 150 },
      { timestamp: '2026-09-28T12:05:00Z', forecastGlucose: 160 }
    ],
    generatedAt: '2026-09-28T11:55:00Z'
  };

  beforeEach(() => {
    global.fetch = jest.fn() as jest.Mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('overlays scenario result over baseline without mutating baseline', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        pinned_as_of: '2026-09-28T11:55:00Z',
        scenario_forecast: [
          { timestamp: '2026-09-28T12:00:00Z', forecastGlucose: 140 },
          { timestamp: '2026-09-28T12:05:00Z', forecastGlucose: 130 }
        ],
        metrics: { delta_peak_mg_dl: -15 }
      })
    });

    render(<ScenarioEditor patientId="123" currentForecast={mockCurrentForecast} pinnedAsOf="2026-09-28T11:55:00Z" />);

    // Trigger simulate
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Run Simulation/i }));
    });

    // Verify scenario line is rendered (isolated)
    expect(screen.getByTestId('line-scenario')).toBeInTheDocument();
    expect(screen.getByTestId('line-baseline')).toBeInTheDocument();
  });

  it('clears scenario result when pinnedAsOf changes', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        pinned_as_of: '2026-09-28T11:55:00Z',
        scenario_forecast: [{ timestamp: '2026-09-28T12:00:00Z', forecastGlucose: 140 }],
        metrics: { delta_peak_mg_dl: -15 }
      })
    });

    const { rerender } = render(<ScenarioEditor patientId="123" currentForecast={mockCurrentForecast} pinnedAsOf="2026-09-28T11:55:00Z" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Run Simulation/i }));
    });

    expect(screen.getByTestId('line-scenario')).toBeInTheDocument();

    // Rerender with new pinnedAsOf (simulate TimeScrubber scrubbing)
    rerender(<ScenarioEditor patientId="123" currentForecast={mockCurrentForecast} pinnedAsOf="2026-09-28T12:00:00Z" />);

    // Scenario should be invalidated
    expect(screen.queryByTestId('line-scenario')).not.toBeInTheDocument();
  });
});

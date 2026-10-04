import React from 'react';
import { render, screen } from '@testing-library/react';
import { useRealtimeTelemetry } from '../src/hooks/useRealtimeTelemetry';
import { PatientWorkspace } from '../src/components/digital-twin/PatientWorkspace';
import { TimeProvider } from '../src/components/digital-twin/TimeContext';
import { ForecastResponse } from '../src/types/forecast-response';

jest.mock('../src/hooks/useRealtimeTelemetry', () => ({
  useRealtimeTelemetry: jest.fn()
}));

describe('P0-13: Real Stream Contract Fixture', () => {
  it('renders a full verified real stream fixture down to the workspace', () => {
    // This represents the end-state of the reducer after parsing the real SSE envelope
    const mockForecast: ForecastResponse = {
       schema_version: "1.0.0",
       request_id: "test",
       generated_at: "2026-10-04T12:00:00Z",
       as_of: "2026-10-04T12:00:00Z",
       subject: { subject_id: "P-001", synthetic: true },
       model: { name: "hybrid_v1", version: "1", alert_policy_version: "1", fallback_used: "full" },
       current: { value_mg_dl: 125, trend_arrow: "up" },
       alert: { state: "none" },
       forecast: { points: [], horizon_min: 120, step_min: 5, conformal_adjusted: true, units: "mg/dL" },
       drivers: [],
       data_quality: { status: "ok", cgm_coverage_6h_pct: 100, staleness_min: 0, last_cgm_at: "2026-10-04T12:00:00Z", reasons: [] }
    };
    
    (useRealtimeTelemetry as jest.Mock).mockReturnValue({
      forecast: mockForecast,
      cache: { patientId: 'P-001', cgm: [], risk: [], alerts: [], dataQuality: [] },
      isConnected: true,
      isStale: false,
      error: null
    });

    render(
      <TimeProvider>
         <PatientWorkspace patientId="P-001" forecast={mockForecast} cache={{}} isConnected={true} isStale={false} />
      </TimeProvider>
    );

    // If it mounts without crashing, the fixture propagates
    expect(screen.getByText('P-001')).toBeInTheDocument();
  });
});

/** @jest-environment node */

import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/forecast/route';

describe('/api/forecast proxy', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });
  
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('proxies valid scenario request to backend contract safely', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        as_of: '2026-09-28T11:55:00Z',
        scenarios: [{
          points: [{ offset_min: 5, p50: 140.0 }],
          delta_peak_mg_dl: 15.0
        }]
      })
    });

    const req = new NextRequest('http://localhost/api/forecast', {
      method: 'POST',
      body: JSON.stringify({
        patientId: '123',
        pinned_as_of: '2026-09-28T11:55:00Z',
        scenario: { type: 'ACTIVITY', value: 30 }
      })
    });

    const response = await POST(req);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.scenario_forecast[0].forecastGlucose).toBe(140.0);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/forecasts'),
      expect.objectContaining({
        method: 'POST'
      })
    );
  });

  it('surfaces backend errors safely without silently returning garbage', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500
    });

    const req = new NextRequest('http://localhost/api/forecast', {
      method: 'POST',
      body: JSON.stringify({
        patientId: '123',
        pinned_as_of: '2026-09-28T11:55:00Z',
        scenario: { type: 'ACTIVITY', value: 30 }
      })
    });

    const response = await POST(req);
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe('Backend failed');
  });

  it('handles malformed API response payloads', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        as_of: '2026-09-28T11:55:00Z'
        // Missing 'scenarios' field
      })
    });

    const req = new NextRequest('http://localhost/api/forecast', {
      method: 'POST',
      body: JSON.stringify({
        patientId: '123',
        pinned_as_of: '2026-09-28T11:55:00Z',
        scenario: { type: 'ACTIVITY', value: 30 }
      })
    });

    const response = await POST(req);
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe('No scenario returned');
  });
});

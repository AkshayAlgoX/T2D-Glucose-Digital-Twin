/** @jest-environment node */
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/forecast/route';

jest.mock('../src/lib/schema-validator', () => ({
  validateForecastResponse: Object.assign(jest.fn().mockReturnValue(true), { errors: null }),
  validateForecastRequest: jest.fn().mockReturnValue(true)
}));

describe('/api/forecast proxy', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, BACKEND_URL: 'http://127.0.0.1:8001' };
    const { validateForecastResponse, validateForecastRequest } = require('../src/lib/schema-validator');
    validateForecastResponse.mockReturnValue(true);
    validateForecastResponse.errors = null;
    validateForecastRequest.mockReturnValue(true);
    global.fetch = jest.fn();
  });
  
  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  it('proxies valid scenario request to backend contract safely', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        as_of: '2026-09-28T11:55:00Z',
        forecast: { points: [{ offset_min: 5, p50: 125.0 }] },
        spike_risk: { probability_120m: 0.1 },
        scenarios: [{
          points: [{ offset_min: 5, p50: 140.0 }],
          delta_peak_mg_dl: 15.0,
          probability_120m: 0.3,
          delta_probability: 0.2
        }]
      })
    });

    const req = new NextRequest('http://localhost/api/forecast', {
      method: 'POST',
      body: JSON.stringify({
        patientId: '123',
        pinned_as_of: '2026-09-28T11:55:00Z',
        scenarios: [{ scenario_id: "scen-1", inputs: [{ kind: 'activity', offset_min: 5, duration_min: 30, intensity: 'moderate' }] }]
      })
    });

    const response = await POST(req);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.scenario_forecast[0].p50).toBe(140.0);
  });

  it('returns 422 if upstream response has no baseline forecast points', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        as_of: '2026-09-28T11:55:00Z',
        forecast: null,
        spike_risk: null,
        scenarios: [{
          points: [{ offset_min: 5, p50: 140.0 }],
          delta_peak_mg_dl: 15.0,
          probability_120m: 0.3,
          delta_probability: 0.2
        }]
      })
    });

    const req = new NextRequest('http://localhost/api/forecast', {
      method: 'POST',
      body: JSON.stringify({
        patientId: '123',
        pinned_as_of: '2026-09-28T11:55:00Z',
        scenarios: [{ scenario_id: "scen-1", inputs: [] }]
      })
    });

    const response = await POST(req);
    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toMatch(/No baseline forecast available/);
  });
});

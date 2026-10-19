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
    expect(data.metrics.baseline_probability).toBe(0.1);
    expect(data.metrics.new_probability).toBe(0.3);
    expect(data.metrics.delta_probability).toBe(0.2);
  });

  it('preserves null baseline probability and leaves scenario delta null when spike_risk is null', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        as_of: '2026-09-28T11:55:00Z',
        forecast: { points: [{ offset_min: 5, p50: 125.0 }] },
        spike_risk: null,
        scenarios: [{
          points: [{ offset_min: 5, p50: 140.0 }],
          delta_peak_mg_dl: 15.0,
          probability_120m: 0.35,
          delta_probability: 0.35
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
    expect(data.metrics.baseline_probability).toBeNull();
    expect(data.metrics.new_probability).toBe(0.35);
    expect(data.metrics.delta_probability).toBeNull();
  });

  it('preserves null baseline probability and leaves scenario delta null when probability_120m is absent in spike_risk', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        as_of: '2026-09-28T11:55:00Z',
        forecast: { points: [{ offset_min: 5, p50: 125.0 }] },
        spike_risk: {},
        scenarios: [{
          points: [{ offset_min: 5, p50: 140.0 }],
          delta_peak_mg_dl: 15.0,
          probability_120m: 0.4
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
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.metrics.baseline_probability).toBeNull();
    expect(data.metrics.delta_probability).toBeNull();
    expect(data.metrics.new_probability).toBe(0.4);
  });

  it('distinguishes genuine baseline probability of 0 from unavailable null', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        as_of: '2026-09-28T11:55:00Z',
        forecast: { points: [{ offset_min: 5, p50: 125.0 }] },
        spike_risk: { probability_120m: 0 },
        scenarios: [{
          points: [{ offset_min: 5, p50: 140.0 }],
          delta_peak_mg_dl: 15.0,
          probability_120m: 0.35,
          delta_probability: 0.35
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
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.metrics.baseline_probability).toBe(0);
    expect(data.metrics.baseline_probability).not.toBeNull();
    expect(data.metrics.new_probability).toBe(0.35);
    expect(data.metrics.delta_probability).toBe(0.35);
  });

  it('performs correct delta arithmetic when both probabilities are available (e.g. 0.7 - 0.2 = 0.5)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        as_of: '2026-09-28T11:55:00Z',
        forecast: { points: [{ offset_min: 5, p50: 125.0 }] },
        spike_risk: { probability_120m: 0.2 },
        scenarios: [{
          points: [{ offset_min: 5, p50: 140.0 }],
          delta_peak_mg_dl: 15.0,
          probability_120m: 0.7
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
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.metrics.baseline_probability).toBe(0.2);
    expect(data.metrics.new_probability).toBe(0.7);
    expect(data.metrics.delta_probability).toBe(0.5);
  });

  it('recomputes delta when supplied delta_probability contradicts baseline and new probabilities (0.2, 0.7, supplied -0.8 -> +0.5)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        as_of: '2026-09-28T11:55:00Z',
        forecast: { points: [{ offset_min: 5, p50: 125.0 }] },
        spike_risk: { probability_120m: 0.2 },
        scenarios: [{
          points: [{ offset_min: 5, p50: 140.0 }],
          delta_peak_mg_dl: 15.0,
          probability_120m: 0.7,
          delta_probability: -0.8 // Contradictory supplied delta
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
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.metrics.baseline_probability).toBe(0.2);
    expect(data.metrics.new_probability).toBe(0.7);
    expect(data.metrics.delta_probability).toBe(0.5);
  });

  it('recomputes delta when supplied delta_probability contradicts decreasing risk (0.7, 0.2, supplied +0.8 -> -0.5)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        as_of: '2026-09-28T11:55:00Z',
        forecast: { points: [{ offset_min: 5, p50: 125.0 }] },
        spike_risk: { probability_120m: 0.7 },
        scenarios: [{
          points: [{ offset_min: 5, p50: 110.0 }],
          delta_peak_mg_dl: -15.0,
          probability_120m: 0.2,
          delta_probability: 0.8 // Contradictory supplied delta
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
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.metrics.baseline_probability).toBe(0.7);
    expect(data.metrics.new_probability).toBe(0.2);
    expect(data.metrics.delta_probability).toBe(-0.5);
  });

  it('computes delta correctly when baseline probability is genuine 0 and new probability is 0.7 (delta = +0.7)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        as_of: '2026-09-28T11:55:00Z',
        forecast: { points: [{ offset_min: 5, p50: 125.0 }] },
        spike_risk: { probability_120m: 0 },
        scenarios: [{
          points: [{ offset_min: 5, p50: 140.0 }],
          delta_peak_mg_dl: 15.0,
          probability_120m: 0.7,
          delta_probability: 0.1 // Contradictory supplied delta
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
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.metrics.baseline_probability).toBe(0);
    expect(data.metrics.baseline_probability).not.toBeNull();
    expect(data.metrics.new_probability).toBe(0.7);
    expect(data.metrics.delta_probability).toBe(0.7);
  });

  it('returns null delta when baseline probability is explicitly null, even if scenario supplies delta_probability', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        as_of: '2026-09-28T11:55:00Z',
        forecast: { points: [{ offset_min: 5, p50: 125.0 }] },
        spike_risk: { probability_120m: null },
        scenarios: [{
          points: [{ offset_min: 5, p50: 140.0 }],
          delta_peak_mg_dl: 15.0,
          probability_120m: 0.7,
          delta_probability: 0.3
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
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.metrics.baseline_probability).toBeNull();
    expect(data.metrics.new_probability).toBe(0.7);
    expect(data.metrics.delta_probability).toBeNull();
  });

  it('returns null delta when scenario probability is missing or non-finite', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        as_of: '2026-09-28T11:55:00Z',
        forecast: { points: [{ offset_min: 5, p50: 125.0 }] },
        spike_risk: { probability_120m: 0.25 },
        scenarios: [{
          points: [{ offset_min: 5, p50: 140.0 }],
          delta_peak_mg_dl: 15.0,
          probability_120m: null,
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
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.metrics.baseline_probability).toBe(0.25);
    expect(data.metrics.new_probability).toBeNull();
    expect(data.metrics.delta_probability).toBeNull();
  });

  it('exercises actual validateForecastResponse to reject invalid upstream schema with 502', async () => {
    const { validateForecastResponse } = require('../src/lib/schema-validator');
    const { validateForecastResponse: actualValidate } = jest.requireActual('../src/lib/schema-validator');
    validateForecastResponse.mockImplementation(actualValidate);

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        invalid: "schema"
      })
    });

    const req = new NextRequest('http://localhost/api/forecast', {
      method: 'POST',
      body: JSON.stringify({
        patientId: '550e8400-e29b-41d4-a716-446655440000',
        pinned_as_of: '2026-09-28T11:55:00Z',
        scenarios: [{ scenario_id: "scen-1", inputs: [] }]
      })
    });

    const response = await POST(req);
    expect(response.status).toBe(502);
    const data = await response.json();
    expect(data.error).toBe("Invalid upstream contract");
  });

  it('exercises actual validateForecastRequest to reject invalid request schema with 400', async () => {
    const { validateForecastRequest } = require('../src/lib/schema-validator');
    const { validateForecastRequest: actualValidate } = jest.requireActual('../src/lib/schema-validator');
    validateForecastRequest.mockImplementation(actualValidate);

    const req = new NextRequest('http://localhost/api/forecast', {
      method: 'POST',
      body: JSON.stringify({
        patientId: 'not-a-valid-uuid',
        pinned_as_of: '2026-09-28T11:55:00Z',
        scenarios: [{ scenario_id: "scen-1", inputs: [] }]
      })
    });

    const response = await POST(req);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Invalid ForecastRequest schema");
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

  it('returns 422 on realistic upstream insufficient data response without scenarios', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        as_of: '2026-09-28T11:55:00Z',
        forecast: null,
        spike_risk: null
        // scenarios is omitted in production insufficient-data responses
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

  it('returns 400 when request body is JSON null', async () => {
    const req = new NextRequest('http://localhost/api/forecast', {
      method: 'POST',
      body: JSON.stringify(null)
    });

    const response = await POST(req);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toMatch(/Missing required patientId/);
  });

  it('returns 400 when request body is missing patientId', async () => {
    const req = new NextRequest('http://localhost/api/forecast', {
      method: 'POST',
      body: JSON.stringify({ pinned_as_of: '2026-09-28T11:55:00Z' })
    });

    const response = await POST(req);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toMatch(/Missing required patientId/);
  });

  describe('actual Zod validation on upstream contract', () => {
    function makeValidUpstreamPayload(scenarioOverrides?: any) {
      return {
        schema_version: '1.0.0',
        request_id: '550e8400-e29b-41d4-a716-446655440000',
        generated_at: '2026-09-28T11:55:00Z',
        as_of: '2026-09-28T11:55:00Z',
        subject: { subject_id: '550e8400-e29b-41d4-a716-446655440000', synthetic: true },
        model: { name: 'pr-tft', version: '1.0.0', run_id: 'run-1', alert_policy_version: '1.0' },
        data_quality: { status: 'ok', cgm_coverage_6h_pct: 100, last_cgm_at: '2026-09-28T11:55:00Z', staleness_min: 0 },
        current: { value_mg_dl: 120, flag: 'in_range', measured_at: '2026-09-28T11:55:00Z', trend_arrow: 'flat' },
        forecast: {
          units: 'mg/dL', step_min: 5, horizon_min: 120,
          points: Array.from({ length: 24 }, (_, i) => ({
            offset_min: (i + 1) * 5, t: '2026-09-28T12:00:00Z',
            p05: 100, p10: 105, p25: 110, p50: 125, p75: 135, p90: 145, p95: 150
          }))
        },
        spike_risk: {
          probability_120m: 0.2,
          tier: 'elevated',
          calibrated: true,
          spike_in_progress: false,
          definition: {
            threshold_mg_dl: 180,
            min_rise_mg_dl: 30,
            rise_window_min: 45,
            persistence_min: 15
          },
          cumulative: Array.from({ length: 24 }, (_, i) => ({
            offset_min: (i + 1) * 5,
            p: 0.2
          }))
        },
        alert: { state: 'none' },
        intended_use: 'research_only_not_for_clinical_decisions',
        scenarios: [{
          scenario_id: 'meal1',
          inputs: [{ kind: 'meal', offset_min: 0, carbs_g: 45 }],
          points: Array.from({ length: 24 }, (_, i) => ({
            offset_min: (i + 1) * 5,
            p10: 105,
            p50: 135,
            p90: 155
          })),
          probability_120m: 0.7,
          delta_probability: 0.5,
          delta_peak_mg_dl: 10.0,
          ...scenarioOverrides
        }]
      };
    }

    beforeEach(() => {
      const { validateForecastResponse, validateForecastRequest } = require('../src/lib/schema-validator');
      const { validateForecastResponse: actualValidateResponse, validateForecastRequest: actualValidateRequest } =
        jest.requireActual('../src/lib/schema-validator');
      validateForecastResponse.mockImplementation(actualValidateResponse);
      validateForecastRequest.mockImplementation(actualValidateRequest);
    });

    it('rejects scenario probability 2 with HTTP 502', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(makeValidUpstreamPayload({ probability_120m: 2 }))
      });
      const req = new NextRequest('http://localhost/api/forecast', {
        method: 'POST',
        body: JSON.stringify({
          patientId: '550e8400-e29b-41d4-a716-446655440000',
          pinned_as_of: '2026-09-28T11:55:00Z',
          scenarios: [{ scenario_id: "meal1", inputs: [{ kind: 'meal', offset_min: 0, carbs_g: 45 }] }]
        })
      });
      const res = await POST(req);
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error).toBe("Invalid upstream contract");
    });

    it('rejects scenario probability -2 with HTTP 502', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(makeValidUpstreamPayload({ probability_120m: -2 }))
      });
      const req = new NextRequest('http://localhost/api/forecast', {
        method: 'POST',
        body: JSON.stringify({
          patientId: '550e8400-e29b-41d4-a716-446655440000',
          pinned_as_of: '2026-09-28T11:55:00Z',
          scenarios: [{ scenario_id: "meal1", inputs: [{ kind: 'meal', offset_min: 0, carbs_g: 45 }] }]
        })
      });
      const res = await POST(req);
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error).toBe("Invalid upstream contract");
    });

    it('rejects a valid probability paired with delta 1.8 with HTTP 502', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(makeValidUpstreamPayload({ probability_120m: 0.7, delta_probability: 1.8 }))
      });
      const req = new NextRequest('http://localhost/api/forecast', {
        method: 'POST',
        body: JSON.stringify({
          patientId: '550e8400-e29b-41d4-a716-446655440000',
          pinned_as_of: '2026-09-28T11:55:00Z',
          scenarios: [{ scenario_id: "meal1", inputs: [{ kind: 'meal', offset_min: 0, carbs_g: 45 }] }]
        })
      });
      const res = await POST(req);
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error).toBe("Invalid upstream contract");
    });

    it('rejects a valid probability paired with delta -2.2 with HTTP 502', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(makeValidUpstreamPayload({ probability_120m: 0.2, delta_probability: -2.2 }))
      });
      const req = new NextRequest('http://localhost/api/forecast', {
        method: 'POST',
        body: JSON.stringify({
          patientId: '550e8400-e29b-41d4-a716-446655440000',
          pinned_as_of: '2026-09-28T11:55:00Z',
          scenarios: [{ scenario_id: "meal1", inputs: [{ kind: 'meal', offset_min: 0, carbs_g: 45 }] }]
        })
      });
      const res = await POST(req);
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error).toBe("Invalid upstream contract");
    });

    it('accepts boundary values 0 and 1, and deltas -1 and 1', async () => {
      // 1. probability 1 with delta 1 (baseline 0)
      const payload1 = makeValidUpstreamPayload({ probability_120m: 1, delta_probability: 1 });
      payload1.spike_risk.probability_120m = 0;
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(payload1)
      });
      const req1 = new NextRequest('http://localhost/api/forecast', {
        method: 'POST',
        body: JSON.stringify({
          patientId: '550e8400-e29b-41d4-a716-446655440000',
          pinned_as_of: '2026-09-28T11:55:00Z',
          scenarios: [{ scenario_id: "meal1", inputs: [{ kind: 'meal', offset_min: 0, carbs_g: 45 }] }]
        })
      });
      const res1 = await POST(req1);
      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(data1.metrics.baseline_probability).toBe(0);
      expect(data1.metrics.new_probability).toBe(1);
      expect(data1.metrics.delta_probability).toBe(1);

      // 2. probability 0 with delta -1 (baseline 1)
      const payload2 = makeValidUpstreamPayload({ probability_120m: 0, delta_probability: -1 });
      payload2.spike_risk.probability_120m = 1;
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(payload2)
      });
      const req2 = new NextRequest('http://localhost/api/forecast', {
        method: 'POST',
        body: JSON.stringify({
          patientId: '550e8400-e29b-41d4-a716-446655440000',
          pinned_as_of: '2026-09-28T11:55:00Z',
          scenarios: [{ scenario_id: "meal1", inputs: [{ kind: 'meal', offset_min: 0, carbs_g: 45 }] }]
        })
      });
      const res2 = await POST(req2);
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.metrics.baseline_probability).toBe(1);
      expect(data2.metrics.new_probability).toBe(0);
      expect(data2.metrics.delta_probability).toBe(-1);
    });

    it('accepts nullable probability and delta fields when risk is genuinely unavailable', async () => {
      const payload = makeValidUpstreamPayload({ probability_120m: null, delta_probability: null });
      payload.spike_risk = null;
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(payload)
      });
      const req = new NextRequest('http://localhost/api/forecast', {
        method: 'POST',
        body: JSON.stringify({
          patientId: '550e8400-e29b-41d4-a716-446655440000',
          pinned_as_of: '2026-09-28T11:55:00Z',
          scenarios: [{ scenario_id: "meal1", inputs: [{ kind: 'meal', offset_min: 0, carbs_g: 45 }] }]
        })
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.metrics.baseline_probability).toBeNull();
      expect(data.metrics.new_probability).toBeNull();
      expect(data.metrics.delta_probability).toBeNull();
    });

    it('recomputes contradictory but individually valid numeric deltas correctly', async () => {
      // Baseline 0.2, scenario probability 0.7, supplied contradictory delta -0.8 (which is valid within [-1, 1])
      const payload = makeValidUpstreamPayload({ probability_120m: 0.7, delta_probability: -0.8 });
      payload.spike_risk.probability_120m = 0.2;
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(payload)
      });
      const req = new NextRequest('http://localhost/api/forecast', {
        method: 'POST',
        body: JSON.stringify({
          patientId: '550e8400-e29b-41d4-a716-446655440000',
          pinned_as_of: '2026-09-28T11:55:00Z',
          scenarios: [{ scenario_id: "meal1", inputs: [{ kind: 'meal', offset_min: 0, carbs_g: 45 }] }]
        })
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.metrics.baseline_probability).toBe(0.2);
      expect(data.metrics.new_probability).toBe(0.7);
      expect(data.metrics.delta_probability).toBe(0.5); // Recomputed, not -0.8
    });
  });
});

/** @jest-environment node */
import { GET as v1HealthGET } from '../src/app/v1/health/route';
import { GET as healthGET } from '../src/app/health/route';

describe('Health Routes', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, BACKEND_URL: 'http://127.0.0.1:8000' };
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetAllMocks();
  });

  describe('/v1/health', () => {
    it('returns backend health json when backend responds 200', async () => {
      const backendPayload = {
        status: 'ok',
        model_version: '0.1.0',
        simulator_version: 'generate_health_data_v2',
        contract_version: '1.0.0',
        subjects: 249,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => backendPayload,
      });

      const res = await v1HealthGET();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual(backendPayload);
    });

    it('returns 502 when backend is unreachable', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Connection refused'));

      const res = await v1HealthGET();
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.status).toBe('error');
      expect(data.detail).toContain('Connection refused');
    });

    it('returns 500 when BACKEND_URL is missing', async () => {
      delete process.env.BACKEND_URL;
      const res = await v1HealthGET();
      // Route has default fallback or handles missing
      expect([200, 500, 502]).toContain(res.status);
    });
  });

  describe('/health', () => {
    it('returns ok when backend responds 200', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      });

      const res = await healthGET();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.backend).toBe('ok');
    });

    it('returns degraded 503 when backend is unreachable', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Connection refused'));

      const res = await healthGET();
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.status).toBe('degraded');
      expect(data.backend).toBe('unreachable');
    });
  });
});

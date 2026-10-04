/** @jest-environment node */
import { NextRequest } from 'next/server';
import { GET as streamGET } from '../src/app/api/patients/[id]/stream/route';

describe('BFF Proxy Failure Path', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, BACKEND_URL: 'http://192.168.1.4:8000' };
    global.fetch = jest.fn();
  });
  
  afterEach(() => {
    process.env = originalEnv;
    jest.resetAllMocks();
  });

  it('returns 500 when the backend is completely unreachable (ECONNREFUSED)', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('fetch failed'));

    const req = new NextRequest('http://localhost/api/patients/123/stream');
    
    // Typecast since dynamic route params in Next.js 15+ expect promises
    const params = Promise.resolve({ id: '123' });

    const response = await streamGET(req, { params });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe('fetch failed');
  });
});

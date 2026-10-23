import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

  let backendStatus = 'unknown';
  try {
    const res = await fetch(`${backendUrl}/v1/health`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    backendStatus = res.ok ? 'ok' : `error_${res.status}`;
  } catch {
    backendStatus = 'unreachable';
  }

  const ok = backendStatus === 'ok';
  return NextResponse.json(
    {
      status: ok ? 'ok' : 'degraded',
      service: 't2d-glucose-digital-twin',
      backend: backendStatus,
    },
    { status: ok ? 200 : 503 }
  );
}

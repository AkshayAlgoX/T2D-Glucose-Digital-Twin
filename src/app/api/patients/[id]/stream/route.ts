import { NextRequest } from 'next/server';
import { createSafeSSETransformStream } from '@/lib/sse-parser';

export const dynamic = 'force-dynamic';
const DEFAULT_CATCH_UP_READINGS = 72;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: patientId } = await params;
  const backendUrl = process.env.BACKEND_URL;
  const token = process.env.PR_TFT_SERVICE_TOKEN;

  if (!backendUrl) {
    return new Response('BACKEND_URL environment variable is missing.', { status: 500 });
  }
  
  const searchParams = request.nextUrl.searchParams;
  const asOf = searchParams.get('as_of');
  const speed = searchParams.get('speed') || '60';
  const include = searchParams.get('include') || 'drivers,twin_state,ehr_context,twin_overlay';
  
  // Open on six hours of real history: the backend sends the first 72 five-minute readings unpaced.
  // Every point is a full forecast; the window is index-based, so a Last-Event-ID resume is not re-sped.
  const catchUpParam = searchParams.get('catch_up') ?? String(DEFAULT_CATCH_UP_READINGS);
  if (!/^\d{1,3}$/.test(catchUpParam) || Number(catchUpParam) > 288) {
    return new Response('catch_up must be an integer from 0 to 288.', { status: 400 });
  }

  let url = `${backendUrl}/v1/subjects/${patientId}/stream?speed=${speed}&include=${encodeURIComponent(include)}&catch_up=${catchUpParam}`;
  if (asOf) {
    url += `&as_of=${encodeURIComponent(asOf)}`;
  }

  try {
    const headers: Record<string, string> = { 'Accept': 'text/event-stream' };
    const lastEventId = request.headers.get('Last-Event-ID');
    if (lastEventId) {
      headers['Last-Event-ID'] = lastEventId;
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const backendResponse = await fetch(url, { headers, signal: request.signal });

    if (!backendResponse.ok || !backendResponse.body) {
      return new Response('Backend error or no body', { status: backendResponse.status || 500 });
    }

    const transformedStream = backendResponse.body.pipeThrough(createSafeSSETransformStream());

    return new Response(transformedStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    });

  } catch (err: any) {
    return new Response(err.message, { status: 500 });
  }
}

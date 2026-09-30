import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: patientId } = await params;
  const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:8001';
  
  const searchParams = request.nextUrl.searchParams;
  const asOf = searchParams.get('as_of');
  
  let url = `${backendUrl}/v1/subjects/${patientId}/stream?speed=10`; // speed up for testing
  if (asOf) {
    url += `&as_of=${encodeURIComponent(asOf)}`;
  }

  try {
    const backendResponse = await fetch(url, {
      headers: {
        'Accept': 'text/event-stream',
      },
      signal: request.signal,
    });

    if (!backendResponse.ok || !backendResponse.body) {
      return new Response('Backend error or no body', { status: backendResponse.status || 500 });
    }

    return new Response(backendResponse.body, {
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

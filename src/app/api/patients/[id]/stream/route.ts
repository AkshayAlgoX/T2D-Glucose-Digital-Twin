import { NextRequest } from 'next/server';
import { validateStreamEvent } from '@/lib/schema-validator';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: patientId } = await params;
  const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:8001';
  
  const searchParams = request.nextUrl.searchParams;
  const asOf = searchParams.get('as_of');
  
  let url = `${backendUrl}/v1/subjects/${patientId}/stream?speed=10`;
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

    const reader = backendResponse.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let buffer = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            let currentEventData = '';
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                currentEventData += line.slice(6);
              } else if (line.trim() === '' && currentEventData) {
                // We have a full event
                try {
                  const payload = JSON.parse(currentEventData);
                  if (validateStreamEvent(payload)) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
                  } else {
                    console.error("Invalid StreamEvent schema:", validateStreamEvent.errors);
                    controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "Invalid contract" })}\n\n`));
                  }
                } catch (e) {
                  // ignore parse error if partial, but standard SSE lines should be full
                }
                currentEventData = '';
              } else {
                 controller.enqueue(encoder.encode(`${line}\n`));
              }
            }
          }
        } catch (err) {
          controller.error(err);
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
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

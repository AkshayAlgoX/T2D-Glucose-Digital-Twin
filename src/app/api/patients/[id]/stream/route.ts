import { NextRequest } from 'next/server';
import { validateStreamEvent, validateForecastResponse } from '@/lib/schema-validator';

export const dynamic = 'force-dynamic';

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
  
  let url = `${backendUrl}/v1/subjects/${patientId}/stream?speed=${speed}`;
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
                try {
                  const parsed = JSON.parse(currentEventData);
                  if (validateStreamEvent(parsed)) {
                    let isPayloadValid = true;
                    const validParsed = parsed as any;
                    if (validParsed.event === 'forecast.updated' && !validateForecastResponse(validParsed.payload)) {
                      isPayloadValid = false;
                      console.error("Invalid forecast payload inside stream", validateForecastResponse.errors);
                    }
                    if (isPayloadValid) {
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
                    } else {
                      controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "Invalid contract schema in payload" })}\n\n`));
                    }
                  } else {
                    console.error("Invalid stream event envelope", validateStreamEvent.errors);
                    controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "Invalid contract schema envelope" })}\n\n`));
                  }
                } catch (e) {
                  controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "Invalid JSON" })}\n\n`));
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

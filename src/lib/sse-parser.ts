import { validateStreamEvent } from './schema-validator';

export function createSafeSSETransformStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let currentEventName = '';
  let currentEventId = '';
  let currentData: string[] = [];

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      
      while (true) {
        const lfIdx = buffer.indexOf('\n\n');
        const crlfIdx = buffer.indexOf('\r\n\r\n');

        if (lfIdx === -1 && crlfIdx === -1) {
          break;
        }

        let boundaryIndex: number;
        let sepLen: number;

        if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx < lfIdx)) {
          boundaryIndex = crlfIdx;
          sepLen = 4;
        } else {
          boundaryIndex = lfIdx;
          sepLen = 2;
        }

        const block = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + sepLen);

        const lines = block.split(/\r?\n/);
        for (const line of lines) {
          if (line.startsWith(':')) continue;
          
          const colonIdx = line.indexOf(':');
          if (colonIdx === -1) {
            const field = line;
            if (field === 'event') currentEventName = '';
            else if (field === 'data') currentData.push('');
            else if (field === 'id') currentEventId = '';
          } else {
            const field = line.slice(0, colonIdx);
            const val = line.charAt(colonIdx + 1) === ' ' ? line.slice(colonIdx + 2) : line.slice(colonIdx + 1);
            if (field === 'event') currentEventName = val;
            else if (field === 'data') currentData.push(val);
            else if (field === 'id') currentEventId = val;
          }
        }

        if (currentData.length > 0) {
          const dataString = currentData.join('\n');
          try {
            const parsed = JSON.parse(dataString) as any;
            if (validateStreamEvent(parsed)) {
              let out = '';
              if (currentEventId) out += `id: ${currentEventId}\n`;
              if (currentEventName) out += `event: ${currentEventName}\n`;
              out += `data: ${JSON.stringify(parsed)}\n\n`;
              controller.enqueue(encoder.encode(out));
            } else {
              let out = '';
              if (currentEventId) out += `id: ${currentEventId}\n`;
              if (currentEventName) out += `event: ${currentEventName}\n`;
              out += currentData.map(d => `data: ${d}`).join('\n') + '\n\n';
              controller.enqueue(encoder.encode(out));
            }
          } catch (e) {
            // Not JSON, pass through safely as per P0-1
            let out = '';
            if (currentEventId) out += `id: ${currentEventId}\n`;
            if (currentEventName) out += `event: ${currentEventName}\n`;
            out += currentData.map(d => `data: ${d}`).join('\n') + '\n\n';
            controller.enqueue(encoder.encode(out));
          }
        }

        currentEventName = '';
        currentEventId = '';
        currentData = [];
      }
    },
    flush(controller) {
       // Ignore partial unfinished events on stream close
    }
  });
}

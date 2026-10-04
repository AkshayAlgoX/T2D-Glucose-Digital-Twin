import { TextDecoder, TextEncoder } from 'util';
import { TransformStream } from 'stream/web';
import { createSafeSSETransformStream } from '../src/lib/sse-parser';

Object.assign(global, { TextDecoder, TextEncoder, TransformStream });

describe('SSE Parser', () => {
  it('P0-1: handles data split across chunks', async () => {
    const stream = createSafeSSETransformStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Event split right before data
    writer.write(encoder.encode("id: 123\nevent: message\n"));
    writer.write(encoder.encode("data: {\"test"));
    writer.write(encoder.encode("\": 1}\n\n"));
    writer.close();

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const text = decoder.decode(value);
    
    expect(text).toContain("id: 123");
    expect(text).toContain("event: message");
    expect(text).toContain("data: {\"test\": 1}");
  });

  it('P0-1: handles blank terminator split across chunks', async () => {
    const stream = createSafeSSETransformStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    writer.write(encoder.encode("data: 1\n"));
    writer.write(encoder.encode("\n")); // the second \n
    writer.close();

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const text = decoder.decode(value);
    expect(text).toContain("data: 1\n\n");
  });
  
  it('P0-1: handles multiple events in one chunk', async () => {
    const stream = createSafeSSETransformStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    writer.write(encoder.encode("data: 1\n\ndata: 2\n\n"));
    writer.close();

    const res1 = await reader.read();
    expect(decoder.decode(res1.value)).toContain("data: 1\n\n");
    
    const res2 = await reader.read();
    expect(decoder.decode(res2.value)).toContain("data: 2\n\n");
  });
});

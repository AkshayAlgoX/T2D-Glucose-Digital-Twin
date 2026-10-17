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

  it('preserves invalid forecast.updated event without silently dropping it', async () => {
    const stream = createSafeSSETransformStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const invalidEnvelope = {
      event: 'forecast.updated',
      event_id: '000001-forecast',
      subject_id: '123e4567-e89b-12d3-a456-426614174000',
      emitted_at: '2026-10-16T12:00:00Z',
      payload: { invalid_payload: true },
    };

    writer.write(encoder.encode(`id: 000001-forecast\nevent: forecast.updated\ndata: ${JSON.stringify(invalidEnvelope)}\n\n`));
    writer.close();

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const text = decoder.decode(value);
    expect(text).toContain('id: 000001-forecast');
    expect(text).toContain('event: forecast.updated');
    expect(text).toContain('invalid_payload');
  });

  it('preserves multiline data fields in SSE framing', async () => {
    const stream = createSafeSSETransformStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    writer.write(encoder.encode("id: 42\ndata: line one\ndata: line two\n\n"));
    writer.close();

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const text = decoder.decode(value);
    expect(text).toContain("id: 42\n");
    expect(text).toContain("data: line one\ndata: line two\n\n");
  });

  describe('Mixed CRLF and LF delimiter chunking invariance (Tests A-D)', () => {
    async function collectStreamEvents(chunks: (string | Uint8Array)[]): Promise<string[]> {
      const stream = createSafeSSETransformStream();
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const writePromise = (async () => {
        for (const chunk of chunks) {
          const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
          await writer.write(bytes);
        }
        await writer.close();
      })();

      const results: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        results.push(decoder.decode(value));
      }
      await writePromise;
      return results;
    }

    const event1 = "id: evt-crlf-001\r\nevent: forecast.updated\r\ndata: {\"seq\":1,\"kind\":\"crlf\"}\r\n\r\n";
    const event2 = "id: evt-lf-002\nevent: forecast.updated\ndata: {\"seq\":2,\"kind\":\"lf\"}\n\n";
    const fullWire = event1 + event2;

    it('Test A — One coalesced chunk: CRLF event followed by LF event in single chunk emits 2 distinct events', async () => {
      const results = await collectStreamEvents([fullWire]);
      expect(results).toHaveLength(2);
      expect(results[0]).toContain('id: evt-crlf-001');
      expect(results[0]).toContain('event: forecast.updated');
      expect(results[0]).toContain('{"seq":1,"kind":"crlf"}');
      expect(results[1]).toContain('id: evt-lf-002');
      expect(results[1]).toContain('event: forecast.updated');
      expect(results[1]).toContain('{"seq":2,"kind":"lf"}');
    });

    it('Test B — Two chunks: identical bytes split at first event boundary emits identical 2 events', async () => {
      const coalescedResults = await collectStreamEvents([fullWire]);
      const chunkedResults = await collectStreamEvents([event1, event2]);
      expect(chunkedResults).toEqual(coalescedResults);
    });

    it('Test C — Delimiter split across chunks: partial CRLF terminators do not cause premature emission or merging', async () => {
      const coalescedResults = await collectStreamEvents([fullWire]);
      const event1Body = event1.slice(0, event1.length - 4); // without \r\n\r\n

      // Splits inside \r\n\r\n:
      // Split after '\r': chunk1 ends with \r, chunk2 starts with \n\r\n
      const splitAfterR = await collectStreamEvents([
        event1Body + '\r',
        '\n\r\n' + event2,
      ]);
      expect(splitAfterR).toEqual(coalescedResults);

      // Split after '\r\n': chunk1 ends with \r\n, chunk2 starts with \r\n
      const splitAfterRN = await collectStreamEvents([
        event1Body + '\r\n',
        '\r\n' + event2,
      ]);
      expect(splitAfterRN).toEqual(coalescedResults);

      // Split after '\r\n\r': chunk1 ends with \r\n\r, chunk2 starts with \n
      const splitAfterRNR = await collectStreamEvents([
        event1Body + '\r\n\r',
        '\n' + event2,
      ]);
      expect(splitAfterRNR).toEqual(coalescedResults);

      // Split inside LF terminator '\n\n' of event 2:
      const event2Body = event2.slice(0, event2.length - 2); // without \n\n
      const splitInsideLF = await collectStreamEvents([
        event1 + event2Body + '\n',
        '\n',
      ]);
      expect(splitInsideLF).toEqual(coalescedResults);
    });

    it('Test D — Partition invariance: byte-by-byte and boundary-adjacent partitions produce exact same events', async () => {
      const expected = await collectStreamEvents([fullWire]);
      const encoder = new TextEncoder();
      const fullBytes = encoder.encode(fullWire);

      // 1-byte chunks
      const oneByteChunks = Array.from(fullBytes).map(b => new Uint8Array([b]));
      const oneByteResults = await collectStreamEvents(oneByteChunks);
      expect(oneByteResults).toEqual(expected);

      // Every 2-chunk split partition from 1 to length - 1
      for (let i = 1; i < fullBytes.length; i++) {
        const chunk1 = fullBytes.slice(0, i);
        const chunk2 = fullBytes.slice(i);
        const splitResults = await collectStreamEvents([chunk1, chunk2]);
        expect(splitResults).toEqual(expected);
      }

      // Varied small and prime chunk sizes
      for (const chunkSize of [2, 3, 4, 5, 7, 11, 13, 17, 31]) {
        const chunks: Uint8Array[] = [];
        for (let offset = 0; offset < fullBytes.length; offset += chunkSize) {
          chunks.push(fullBytes.slice(offset, offset + chunkSize));
        }
        const chunkedResults = await collectStreamEvents(chunks);
        expect(chunkedResults).toEqual(expected);
      }
    });

    it('symmetrically handles LF event followed by CRLF event in single chunk and chunked', async () => {
      const reversedWire = event2 + event1;
      const coalesced = await collectStreamEvents([reversedWire]);
      expect(coalesced).toHaveLength(2);
      expect(coalesced[0]).toContain('id: evt-lf-002');
      expect(coalesced[1]).toContain('id: evt-crlf-001');

      const chunked = await collectStreamEvents([event2, event1]);
      expect(chunked).toEqual(coalesced);
    });
  });
});

import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { TextDecoder, TextEncoder } from 'util';
import { TransformStream } from 'stream/web';
Object.assign(global, { TextDecoder, TextEncoder, TransformStream });

import { useRealtimeTelemetry } from '../src/hooks/useRealtimeTelemetry';
import { createSafeSSETransformStream } from '../src/lib/sse-parser';
import { TimeContext } from '../src/components/digital-twin/TimeContext';
import { ForecastResponse } from '../src/types/forecast-response';
import { ForecastResponseSchema } from '../src/lib/zod-schemas';
import source from './fixtures/risk-audit-forecast.json';

const subjectA = '123e4567-e89b-12d3-a456-426614174000';

function validFixture(overrides: Record<string, unknown> = {}): ForecastResponse {
  return ForecastResponseSchema.parse({
    ...source,
    subject: {
      ...source.subject,
      subject_id: subjectA,
    },
    ...overrides,
  }) as ForecastResponse;
}

function sseEvent(envelope: Record<string, unknown>, id?: string, eventName?: string): string {
  let out = '';
  if (id) out += `id: ${id}\n`;
  if (eventName) out += `event: ${eventName}\n`;
  out += `data: ${JSON.stringify(envelope)}\n\n`;
  return out;
}

/**
 * Builds a fetch Response representing the actual output of the SSE proxy transform.
 * Pipes raw upstream wire text through createSafeSSETransformStream().
 */
function mockProxiedResponse(rawSseText: string, closeStream: boolean = true): any {
  const stream = createSafeSSETransformStream();
  const writer = stream.writable.getWriter();
  if (rawSseText.length > 0) {
    writer.write(new TextEncoder().encode(rawSseText)).catch(() => {});
  }
  if (closeStream) {
    writer.close().catch(() => {});
  }

  return {
    ok: true,
    status: 200,
    body: stream.readable,
    text: async () => {
      const reader = stream.readable.getReader();
      const decoder = new TextDecoder();
      let res = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res += decoder.decode(value, { stream: true });
      }
      return res;
    },
  };
}

function mockProxiedChunksResponse(chunks: string[], closeStream: boolean = true): any {
  const stream = createSafeSSETransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  (async () => {
    for (const chunk of chunks) {
      await writer.write(encoder.encode(chunk)).catch(() => {});
    }
    if (closeStream) {
      await writer.close().catch(() => {});
    }
  })();

  return {
    ok: true,
    status: 200,
    body: stream.readable,
  };
}

const replayWrapper = ({ children }: { children: React.ReactNode }) => (
  <TimeContext.Provider value={{ asOf: '2026-10-16T12:00:00Z', setAsOf: () => {} }}>
    {children}
  </TimeContext.Provider>
);

describe('SSE Proxy to Consumer Integration (createSafeSSETransformStream -> useRealtimeTelemetry)', () => {
  const originalFetch = Object.getOwnPropertyDescriptor(global, 'fetch');

  beforeEach(() => {
    Object.defineProperty(global, 'fetch', { configurable: true, writable: true, value: jest.fn() });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalFetch) Object.defineProperty(global, 'fetch', originalFetch);
    else Reflect.deleteProperty(global, 'fetch');
  });

  // ─────────────────────────────────────────────────────────────────
  // A. Invalid forecast only
  // ─────────────────────────────────────────────────────────────────
  describe('A. Invalid forecast only', () => {
    it('live-stream: consumer ends disconnected with contract-invalid (not clean EOF)', async () => {
      const invalidEvent = {
        event: 'forecast.updated',
        event_id: '000001-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:00:00Z',
        payload: { invalid: 'corrupted-forecast-payload' },
      };

      const rawWire = sseEvent(invalidEvent, '000001-forecast', 'forecast.updated');
      jest.spyOn(global, 'fetch').mockImplementation(async () => mockProxiedResponse(rawWire, false));

      const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

      await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
      expect(result.current.error?.message).toBe('contract-invalid');
      expect(result.current.forecast).toBeNull();
    });

    it('pinned replay: consumer rejects with contract-invalid (not clean EOF)', async () => {
      const invalidEvent = {
        event: 'forecast.updated',
        event_id: '000001-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:00:00Z',
        payload: { invalid: 'corrupted-forecast-payload' },
      };

      const rawWire = sseEvent(invalidEvent, '000001-forecast', 'forecast.updated');
      jest.spyOn(global, 'fetch').mockImplementation(async () => mockProxiedResponse(rawWire, true));

      const { result } = renderHook(() => useRealtimeTelemetry(subjectA), { wrapper: replayWrapper });

      await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
      expect(result.current.error?.message).toBe('contract-invalid');
      expect(result.current.forecast).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // B. Invalid forecast before valid forecast (Pinned Replay)
  // ─────────────────────────────────────────────────────────────────
  describe('B. Invalid forecast before valid forecast', () => {
    it('pinned replay: rejects entire replay with contract-invalid; later valid forecast is not accepted', async () => {
      const invalidEvent = {
        event: 'forecast.updated',
        event_id: '000001-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T11:55:00Z',
        payload: { missing_quantiles: true },
      };

      const validEvent = {
        event: 'forecast.updated',
        event_id: '000002-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:00:00Z',
        payload: validFixture(),
      };

      const rawWire = sseEvent(invalidEvent, '000001-forecast', 'forecast.updated') +
                      sseEvent(validEvent, '000002-forecast', 'forecast.updated');

      jest.spyOn(global, 'fetch').mockImplementation(async () => mockProxiedResponse(rawWire, true));

      const { result } = renderHook(() => useRealtimeTelemetry(subjectA), { wrapper: replayWrapper });

      await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
      expect(result.current.error?.message).toBe('contract-invalid');
      expect(result.current.forecast).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // C. Valid forecast before invalid forecast (Pinned Replay)
  // ─────────────────────────────────────────────────────────────────
  describe('C. Valid forecast before invalid forecast', () => {
    it('pinned replay: rejects entire replay with contract-invalid; earlier valid forecast does not save response', async () => {
      const validEvent = {
        event: 'forecast.updated',
        event_id: '000001-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T11:55:00Z',
        payload: validFixture(),
      };

      const invalidEvent = {
        event: 'forecast.updated',
        event_id: '000002-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:00:00Z',
        payload: { broken: true },
      };

      const rawWire = sseEvent(validEvent, '000001-forecast', 'forecast.updated') +
                      sseEvent(invalidEvent, '000002-forecast', 'forecast.updated');

      jest.spyOn(global, 'fetch').mockImplementation(async () => mockProxiedResponse(rawWire, true));

      const { result } = renderHook(() => useRealtimeTelemetry(subjectA), { wrapper: replayWrapper });

      await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
      expect(result.current.error?.message).toBe('contract-invalid');
      expect(result.current.forecast).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // D. Live-stream invalid forecast
  // ─────────────────────────────────────────────────────────────────
  describe('D. Live-stream invalid forecast', () => {
    it('live-stream: consumer raises contract-invalid and terminates; does not treat stream as successful', async () => {
      const invalidEvent = {
        event: 'forecast.updated',
        event_id: '000001-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:00:00Z',
        payload: { invalid_forecast: true },
      };

      const subsequentValidEvent = {
        event: 'forecast.updated',
        event_id: '000002-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:05:00Z',
        payload: validFixture({ as_of: '2026-10-16T12:05:00Z' }),
      };

      const rawWire = sseEvent(invalidEvent, '000001-forecast', 'forecast.updated') +
                      sseEvent(subsequentValidEvent, '000002-forecast', 'forecast.updated');

      jest.spyOn(global, 'fetch').mockImplementation(async () => mockProxiedResponse(rawWire, false));

      const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

      await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
      expect(result.current.error?.message).toBe('contract-invalid');
      expect(result.current.forecast).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // E. Positive controls
  // ─────────────────────────────────────────────────────────────────
  describe('E. Positive controls', () => {
    it('valid forecast passes through proxy and reaches the consumer', async () => {
      const forecast = validFixture();
      const event = {
        event: 'forecast.updated',
        event_id: '000001-forecast',
        subject_id: subjectA,
        emitted_at: forecast.generated_at,
        payload: forecast,
      };

      const rawWire = sseEvent(event, '000001-forecast', 'forecast.updated');
      jest.spyOn(global, 'fetch').mockImplementation(async () => mockProxiedResponse(rawWire, false));

      const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

      await waitFor(() => expect(result.current.forecast?.subject.subject_id).toBe(subjectA));
      expect(result.current.error).toBeNull();
      expect(result.current.cache.cgm.length).toBeGreaterThan(0);
    });

    it('valid companion event does not replace full forecast', async () => {
      const forecast = validFixture();
      const forecastEvt = {
        event: 'forecast.updated',
        event_id: '000001-forecast',
        subject_id: subjectA,
        emitted_at: forecast.generated_at,
        payload: forecast,
      };

      const alertEvt = {
        event: 'alert.raised',
        event_id: '000001-alert',
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:01:00Z',
        payload: {
          state: 'warning',
          alert_id: '123e4567-e89b-12d3-a456-426614174099',
          since: '2026-10-16T12:00:00Z',
          suppressed_until: null,
          message_key: 'alert.spike.warning',
        },
      };

      const rawWire = sseEvent(forecastEvt, '000001-forecast', 'forecast.updated') +
                      sseEvent(alertEvt, '000001-alert', 'alert.raised');

      jest.spyOn(global, 'fetch').mockImplementation(async () => mockProxiedResponse(rawWire, false));

      const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

      await waitFor(() => expect(result.current.cache.alerts.some(a => a.state === 'warning')).toBe(true));
      expect(result.current.forecast?.forecast?.points.length).toBe(24);
      expect(result.current.forecast?.alert.state).toBe('warning');
      expect(result.current.error).toBeNull();
    });

    it('empty finite replay remains error-free (clean EOF)', async () => {
      jest.spyOn(global, 'fetch').mockImplementation(async () => mockProxiedResponse('', true));

      const { result } = renderHook(() => useRealtimeTelemetry(subjectA), { wrapper: replayWrapper });

      await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
      expect(result.current.error).toBeNull();
      expect(result.current.forecast).toBeNull();
    });

    it('malformed JSON passes through proxy and produces contract-invalid in hook', async () => {
      const rawWire = 'id: 1\nevent: forecast.updated\ndata: {NOT_VALID_JSON}\n\n';
      jest.spyOn(global, 'fetch').mockImplementation(async () => mockProxiedResponse(rawWire, false));

      const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

      await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
      expect(result.current.error?.message).toBe('contract-invalid');
    });

    it('preserves multiline data fields and CRLF framing through transform', async () => {
      const forecast = validFixture();
      const prettyJson = JSON.stringify({
        event: 'forecast.updated',
        event_id: '000001-forecast',
        subject_id: subjectA,
        emitted_at: forecast.generated_at,
        payload: forecast,
      }, null, 2);

      // Pretty-printed JSON split across multiline data: fields with CRLF line breaks
      const dataLines = prettyJson.split('\n');
      const rawWire = `id: 000001-forecast\r\nevent: forecast.updated\r\n` +
                      dataLines.map(line => `data: ${line}`).join('\r\n') +
                      `\r\n\r\n`;

      jest.spyOn(global, 'fetch').mockImplementation(async () => mockProxiedResponse(rawWire, false));

      const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

      await waitFor(() => expect(result.current.forecast?.subject.subject_id).toBe(subjectA));
      expect(result.current.error).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // F. Mixed CRLF and LF delimiter chunking invariance (Tests E & F)
  // ─────────────────────────────────────────────────────────────────
  describe('F. Mixed CRLF and LF delimiter chunking invariance (Tests E & F)', () => {
    it('Test E: processes both forecasts without error when CRLF and LF events are coalesced in one chunk', async () => {
      const forecast1 = validFixture({ as_of: '2026-10-16T12:00:00Z', generated_at: '2026-10-16T12:00:00Z' });
      const forecast2 = validFixture({ as_of: '2026-10-16T12:05:00Z', generated_at: '2026-10-16T12:05:00Z' });

      const event1 = {
        event: 'forecast.updated',
        event_id: '000001-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:00:00Z',
        payload: forecast1,
      };

      const event2 = {
        event: 'forecast.updated',
        event_id: '000002-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:05:00Z',
        payload: forecast2,
      };

      // Event 1 is CRLF-terminated; Event 2 is LF-terminated. Both in a single chunk.
      const rawWire = `id: 000001-forecast\r\nevent: forecast.updated\r\ndata: ${JSON.stringify(event1)}\r\n\r\n` +
                      `id: 000002-forecast\nevent: forecast.updated\ndata: ${JSON.stringify(event2)}\n\n`;

      jest.spyOn(global, 'fetch').mockImplementation(async () => mockProxiedResponse(rawWire, false));

      const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

      // Hook should process both forecasts without error, settling on the second forecast
      await waitFor(() => expect(result.current.forecast?.generated_at).toBe('2026-10-16T12:05:00Z'));
      expect(result.current.forecast?.subject.subject_id).toBe(subjectA);
      expect(result.current.error).toBeNull();
      expect(result.current.connectionStatus).toBe('connected');
    });

    it('Test E: processes both forecasts without error when stream is delivered across arbitrary chunks', async () => {
      const forecast1 = validFixture({ as_of: '2026-10-16T12:00:00Z', generated_at: '2026-10-16T12:00:00Z' });
      const forecast2 = validFixture({ as_of: '2026-10-16T12:05:00Z', generated_at: '2026-10-16T12:05:00Z' });

      const event1Wire = `id: 000001-forecast\r\nevent: forecast.updated\r\ndata: ${JSON.stringify({
        event: 'forecast.updated',
        event_id: '000001-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:00:00Z',
        payload: forecast1,
      })}\r\n\r\n`;

      const event2Wire = `id: 000002-forecast\nevent: forecast.updated\ndata: ${JSON.stringify({
        event: 'forecast.updated',
        event_id: '000002-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:05:00Z',
        payload: forecast2,
      })}\n\n`;

      // Split right in the middle of CRLF delimiter (\r\n | \r\n)
      const splitPoint = event1Wire.length - 2;
      const chunk1 = event1Wire.slice(0, splitPoint);
      const chunk2 = event1Wire.slice(splitPoint) + event2Wire;

      jest.spyOn(global, 'fetch').mockImplementation(async () => mockProxiedChunksResponse([chunk1, chunk2], false));

      const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

      await waitFor(() => expect(result.current.forecast?.generated_at).toBe('2026-10-16T12:05:00Z'));
      expect(result.current.error).toBeNull();
      expect(result.current.connectionStatus).toBe('connected');
    });

    it('Test F: invalid forecast regression with mixed delimiters results in terminal contract-invalid (live-stream)', async () => {
      const invalidEvent = {
        event: 'forecast.updated',
        event_id: '000001-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:00:00Z',
        payload: { malformed_forecast: true },
      };

      const validEvent = {
        event: 'forecast.updated',
        event_id: '000002-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:05:00Z',
        payload: validFixture(),
      };

      // CRLF invalid forecast followed by LF valid forecast in single coalesced chunk
      const rawWire = `id: 000001-forecast\r\nevent: forecast.updated\r\ndata: ${JSON.stringify(invalidEvent)}\r\n\r\n` +
                      `id: 000002-forecast\nevent: forecast.updated\ndata: ${JSON.stringify(validEvent)}\n\n`;

      jest.spyOn(global, 'fetch').mockImplementation(async () => mockProxiedResponse(rawWire, false));

      const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

      await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
      expect(result.current.error?.message).toBe('contract-invalid');
      expect(result.current.forecast).toBeNull();
    });

    it('Test F: invalid forecast regression with mixed delimiters invalidates pinned replay (not clean EOF)', async () => {
      const validEvent = {
        event: 'forecast.updated',
        event_id: '000001-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T11:55:00Z',
        payload: validFixture(),
      };

      const invalidEvent = {
        event: 'forecast.updated',
        event_id: '000002-forecast',
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:00:00Z',
        payload: { corrupt_payload: 123 },
      };

      // LF valid forecast followed by CRLF invalid forecast in pinned replay
      const rawWire = `id: 000001-forecast\nevent: forecast.updated\ndata: ${JSON.stringify(validEvent)}\n\n` +
                      `id: 000002-forecast\r\nevent: forecast.updated\r\ndata: ${JSON.stringify(invalidEvent)}\r\n\r\n`;

      jest.spyOn(global, 'fetch').mockImplementation(async () => mockProxiedResponse(rawWire, true));

      const { result } = renderHook(() => useRealtimeTelemetry(subjectA), { wrapper: replayWrapper });

      await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
      expect(result.current.error?.message).toBe('contract-invalid');
      expect(result.current.forecast).toBeNull();
    });
  });
});

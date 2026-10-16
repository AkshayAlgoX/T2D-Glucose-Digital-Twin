import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { TextDecoder } from 'node:util';
import { useRealtimeTelemetry } from '../src/hooks/useRealtimeTelemetry';
import { TimeContext } from '../src/components/digital-twin/TimeContext';
import { ForecastResponse } from '../src/types/forecast-response';
import { ForecastResponseSchema } from '../src/lib/zod-schemas';
import source from './fixtures/risk-audit-forecast.json';

const subjectA = '123e4567-e89b-12d3-a456-426614174000';
const subjectB = '123e4567-e89b-12d3-a456-426614174001';

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

function ssePacket(eventObj: Record<string, unknown>): Uint8Array {
  return new Uint8Array(Buffer.from(`data: ${JSON.stringify(eventObj)}\n\n`));
}

describe('SSE Event Contract Correctness & Dispatch', () => {
  const originalDecoder = global.TextDecoder;
  const originalFetch = Object.getOwnPropertyDescriptor(global, 'fetch');

  beforeEach(() => {
    global.TextDecoder = TextDecoder as typeof global.TextDecoder;
    Object.defineProperty(global, 'fetch', { configurable: true, writable: true, value: jest.fn() });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.TextDecoder = originalDecoder;
    if (originalFetch) Object.defineProperty(global, 'fetch', originalFetch);
    else Reflect.deleteProperty(global, 'fetch');
  });

  it('handles forecast.updated event by validating ForecastResponse and populating forecast and cache', async () => {
    const forecast = validFixture();
    const event = {
      event: 'forecast.updated',
      event_id: '000001-forecast',
      subject_id: subjectA,
      emitted_at: forecast.generated_at,
      payload: forecast,
    };

    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: ssePacket(event) })
        .mockReturnValue(new Promise(() => {})), // keep open
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

    await waitFor(() => expect(result.current.forecast?.subject.subject_id).toBe(subjectA));
    expect(result.current.error).toBeNull();
    expect(result.current.cache.cgm.length).toBeGreaterThan(0);
    expect(result.current.cache.alerts.length).toBeGreaterThan(0);
    expect(result.current.cache.dataQuality.length).toBeGreaterThan(0);
  });

  it('handles alert.raised and alert.cleared without throwing contract-invalid and updates alert without destroying forecast', async () => {
    const forecast = validFixture({
      alert: { state: 'none', alert_id: null, since: null, suppressed_until: null, message_key: null },
    });

    const forecastEvent = {
      event: 'forecast.updated',
      event_id: '000001-forecast',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: forecast,
    };

    const alertRaisedEvent = {
      event: 'alert.raised',
      event_id: '000001-alert',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:05Z',
      payload: {
        state: 'warning',
        alert_id: '123e4567-e89b-12d3-a456-426614174099',
        since: '2026-10-16T12:00:00Z',
        suppressed_until: '2026-10-16T14:00:00Z',
        message_key: 'alert.spike.warning',
      },
    };

    const alertClearedEvent = {
      event: 'alert.cleared',
      event_id: '000002-alert',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:05:00Z',
      payload: {
        state: 'none',
        alert_id: null,
        since: null,
        suppressed_until: null,
        message_key: null,
      },
    };

    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: ssePacket(forecastEvent) })
        .mockResolvedValueOnce({ done: false, value: ssePacket(alertRaisedEvent) })
        .mockResolvedValueOnce({ done: false, value: ssePacket(alertClearedEvent) })
        .mockReturnValue(new Promise(() => {})),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

    // Verify initial forecast
    await waitFor(() => expect(result.current.forecast?.subject.subject_id).toBe(subjectA));

    // Verify alert.raised updated alert state while keeping forecast points intact
    await waitFor(() => expect(result.current.cache.alerts.some(a => a.state === 'warning')).toBe(true));
    expect(result.current.forecast?.alert.state).toBe('none'); // cleared by final event
    expect(result.current.forecast?.forecast?.points.length).toBe(24);
    expect(result.current.error).toBeNull();
    expect(reader.cancel).not.toHaveBeenCalled();

    // Verify both warning and none were recorded in cache
    expect(result.current.cache.alerts.some(a => a.state === 'warning')).toBe(true);
    expect(result.current.cache.alerts.some(a => a.state === 'none')).toBe(true);
  });

  it('handles data_quality.changed event without throwing contract-invalid and updates data_quality without destroying forecast', async () => {
    const forecast = validFixture({
      data_quality: {
        status: 'ok',
        cgm_coverage_6h_pct: 100,
        last_cgm_at: '2026-10-16T12:00:00Z',
        staleness_min: 0,
        reasons: [],
      },
    });

    const forecastEvent = {
      event: 'forecast.updated',
      event_id: '000001-forecast',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: forecast,
    };

    const dqEvent = {
      event: 'data_quality.changed',
      event_id: '000001-quality',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:05Z',
      payload: {
        status: 'degraded',
        cgm_coverage_6h_pct: 72,
        last_cgm_at: '2026-10-16T11:45:00Z',
        staleness_min: 15,
        reasons: ['cgm_gap'],
      },
    };

    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: ssePacket(forecastEvent) })
        .mockResolvedValueOnce({ done: false, value: ssePacket(dqEvent) })
        .mockReturnValue(new Promise(() => {})),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

    await waitFor(() => expect(result.current.forecast?.data_quality.status).toBe('degraded'));
    expect(result.current.forecast?.forecast?.points.length).toBe(24);
    expect(result.current.error).toBeNull();
    expect(result.current.cache.dataQuality.some(q => q.status === 'degraded')).toBe(true);
    expect(reader.cancel).not.toHaveBeenCalled();
  });

  it('handles twin.recalibrated event safely without mutating forecast or throwing contract-invalid', async () => {
    const forecast = validFixture();
    const forecastEvent = {
      event: 'forecast.updated',
      event_id: '000001-forecast',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: forecast,
    };

    const recalibratedEvent = {
      event: 'twin.recalibrated',
      event_id: '000001-recal',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:05Z',
      payload: {
        schema_version: '1.0.0',
        calibration_stage: 'adapter_finetuned',
      },
    };

    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: ssePacket(forecastEvent) })
        .mockResolvedValueOnce({ done: false, value: ssePacket(recalibratedEvent) })
        .mockReturnValue(new Promise(() => {})),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

    await waitFor(() => expect(result.current.forecast?.subject.subject_id).toBe(subjectA));
    expect(result.current.error).toBeNull();
    expect(reader.cancel).not.toHaveBeenCalled();
  });

  it('handles non-forecast events arriving before initial forecast packet without manufacturing invalid forecast', async () => {
    const alertRaisedEvent = {
      event: 'alert.raised',
      event_id: '000001-alert',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: {
        state: 'watch',
        alert_id: '123e4567-e89b-12d3-a456-426614174099',
        since: '2026-10-16T12:00:00Z',
        suppressed_until: '2026-10-16T14:00:00Z',
        message_key: 'alert.spike.watch',
      },
    };

    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: ssePacket(alertRaisedEvent) })
        .mockReturnValue(new Promise(() => {})),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

    await waitFor(() => expect(result.current.cache.alerts.length).toBe(1));
    expect(result.current.forecast).toBeNull(); // Still null, no invalid forecast object created
    expect(result.current.error).toBeNull();
    expect(result.current.cache.alerts[0].state).toBe('watch');
  });

  it('safely ignores cross-subject events on the SSE envelope without contaminating current subject', async () => {
    const forecastB = validFixture();
    forecastB.subject.subject_id = subjectB;

    const crossSubjectEvent = {
      event: 'forecast.updated',
      event_id: '000001-forecast',
      subject_id: subjectB, // belongs to subject B!
      emitted_at: forecastB.generated_at,
      payload: forecastB,
    };

    const crossSubjectAlert = {
      event: 'alert.raised',
      event_id: '000002-alert',
      subject_id: subjectB,
      emitted_at: '2026-10-16T12:00:05Z',
      payload: {
        state: 'warning',
        alert_id: '123e4567-e89b-12d3-a456-426614174099',
        since: '2026-10-16T12:00:00Z',
      },
    };

    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: ssePacket(crossSubjectEvent) })
        .mockResolvedValueOnce({ done: false, value: ssePacket(crossSubjectAlert) })
        .mockReturnValue(new Promise(() => {})),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

    // Wait a brief tick to allow reader to process packets
    await new Promise(r => setTimeout(r, 60));

    expect(result.current.forecast).toBeNull();
    expect(result.current.cache.cgm.length).toBe(0);
    expect(result.current.cache.alerts.length).toBe(0);
    expect(result.current.error).toBeNull();
    expect(reader.cancel).not.toHaveBeenCalled();
  });

  it('safely ignores inconsistent forecast.updated where envelope matches but inner payload subject is cross-subject', async () => {
    const forecastB = validFixture();
    forecastB.subject.subject_id = subjectB; // inner payload has subject B

    const inconsistentEvent = {
      event: 'forecast.updated',
      event_id: '000001-forecast',
      subject_id: subjectA, // envelope has subject A
      emitted_at: forecastB.generated_at,
      payload: forecastB,
    };

    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: ssePacket(inconsistentEvent) })
        .mockReturnValue(new Promise(() => {})),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA));

    await new Promise(r => setTimeout(r, 60));

    expect(result.current.forecast).toBeNull();
    expect(result.current.cache.cgm.length).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('advances stored event ID on non-forecast events and sends it as Last-Event-ID on reconnection', async () => {
    const forecast = validFixture();
    const forecastEvent = {
      event: 'forecast.updated',
      event_id: '000010-forecast',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: forecast,
    };

    const alertEvent = {
      event: 'alert.raised',
      event_id: '000010-alert',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:05Z',
      payload: {
        state: 'warning',
        alert_id: '123e4567-e89b-12d3-a456-426614174099',
        since: '2026-10-16T12:00:00Z',
      },
    };

    let attempt = 0;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        const streamReader = {
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: ssePacket(forecastEvent) })
            .mockResolvedValueOnce({ done: false, value: ssePacket(alertEvent) })
            .mockRejectedValueOnce(new Error('Connection dropped after alert')),
          cancel: jest.fn().mockResolvedValue(undefined),
        };
        return { ok: true, body: { getReader: () => streamReader } } as unknown as Response;
      }
      // Reconnect attempt: keep open
      const reconnectReader = {
        read: jest.fn().mockReturnValue(new Promise(() => {})),
        cancel: jest.fn().mockResolvedValue(undefined),
      };
      return { ok: true, body: { getReader: () => reconnectReader } } as unknown as Response;
    });

    renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 2, baseDelayMs: 20 }));

    // Wait for the reconnection fetch to occur
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const secondCallHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    expect(secondCallHeaders['Last-Event-ID']).toBe('000010-alert');
  });

  it('cross-subject events do not advance stored event ID', async () => {
    const forecastA = validFixture();
    const validEventA = {
      event: 'forecast.updated',
      event_id: '000005-forecast',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: forecastA,
    };

    const crossSubjectEvent = {
      event: 'forecast.updated',
      event_id: '000006-forecast',
      subject_id: subjectB,
      emitted_at: '2026-10-16T12:05:00Z',
      payload: validFixture({ subject: { subject_id: subjectB, synthetic: true } }),
    };

    let attempt = 0;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        const streamReader = {
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: ssePacket(validEventA) })
            .mockResolvedValueOnce({ done: false, value: ssePacket(crossSubjectEvent) })
            .mockRejectedValueOnce(new Error('Drop')),
          cancel: jest.fn().mockResolvedValue(undefined),
        };
        return { ok: true, body: { getReader: () => streamReader } } as unknown as Response;
      }
      const reconnectReader = {
        read: jest.fn().mockReturnValue(new Promise(() => {})),
        cancel: jest.fn().mockResolvedValue(undefined),
      };
      return { ok: true, body: { getReader: () => reconnectReader } } as unknown as Response;
    });

    renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 2, baseDelayMs: 20 }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const secondCallHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    // Must remain 000005-forecast, NOT the cross-subject 000006-forecast
    expect(secondCallHeaders['Last-Event-ID']).toBe('000005-forecast');
  });

  it('rejects malformed envelope with contract-invalid and cancels reader without retry', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const malformedEnvelope = {
      event: 'invalid.unknown_event',
      event_id: '000001',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: {},
    };

    const reader = {
      read: jest.fn().mockResolvedValueOnce({ done: false, value: ssePacket(malformedEnvelope) }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 3, baseDelayMs: 20 }));

    await waitFor(() => expect(result.current.error?.message).toBe('contract-invalid'));
    expect(result.current.connectionStatus).toBe('disconnected');
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1); // non-transient, no retry
  });

  it('rejects malformed alert payload with contract-invalid and cancels reader without retry', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const malformedAlert = {
      event: 'alert.raised',
      event_id: '000001-alert',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: {
        state: 'invalid_alert_state', // not 'none' | 'watch' | 'warning'
      },
    };

    const reader = {
      read: jest.fn().mockResolvedValueOnce({ done: false, value: ssePacket(malformedAlert) }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 3, baseDelayMs: 20 }));

    await waitFor(() => expect(result.current.error?.message).toBe('contract-invalid'));
    expect(result.current.connectionStatus).toBe('disconnected');
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed data_quality payload with contract-invalid and cancels reader without retry', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const malformedDq = {
      event: 'data_quality.changed',
      event_id: '000001-quality',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: {
        status: 'degraded',
        // missing required fields: cgm_coverage_6h_pct, last_cgm_at, staleness_min
      },
    };

    const reader = {
      read: jest.fn().mockResolvedValueOnce({ done: false, value: ssePacket(malformedDq) }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 3, baseDelayMs: 20 }));

    await waitFor(() => expect(result.current.error?.message).toBe('contract-invalid'));
    expect(result.current.connectionStatus).toBe('disconnected');
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects non-object twin.recalibrated payload with contract-invalid', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const invalidRecal = {
      event: 'twin.recalibrated',
      event_id: '000001-recal',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: 'string-instead-of-object',
    };

    const reader = {
      read: jest.fn().mockResolvedValueOnce({ done: false, value: ssePacket(invalidRecal) }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 3, baseDelayMs: 20 }));

    await waitFor(() => expect(result.current.error?.message).toBe('contract-invalid'));
    expect(result.current.connectionStatus).toBe('disconnected');
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('only forecast.updated events count toward event-count stability; a connection with two forecast events achieves stability', async () => {
    const forecast = validFixture();
    const forecastEvent1 = {
      event: 'forecast.updated',
      event_id: '000001-forecast',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: forecast,
    };
    const forecastEvent2 = {
      event: 'forecast.updated',
      event_id: '000002-forecast',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:01:00Z',
      payload: forecast,
    };
    const alertEvent = {
      event: 'alert.raised',
      event_id: '000001-alert',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:05Z',
      payload: {
        state: 'watch',
        since: '2026-10-16T12:00:00Z',
      },
    };

    let connectionAttempts = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      connectionAttempts++;
      if (connectionAttempts === 1) {
        // First connection: delivers 1 forecast + 1 alert, then drops (only 1 forecast < 2 threshold)
        const reader = {
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: ssePacket(forecastEvent1) })
            .mockResolvedValueOnce({ done: false, value: ssePacket(alertEvent) })
            .mockRejectedValueOnce(new Error('Drop 1')),
          cancel: jest.fn().mockResolvedValue(undefined),
        };
        return { ok: true, body: { getReader: () => reader } } as unknown as Response;
      }
      if (connectionAttempts === 2) {
        // Second connection: delivers 2 forecast events -> achieves stability!
        const reader = {
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: ssePacket(forecastEvent1) })
            .mockResolvedValueOnce({ done: false, value: ssePacket(forecastEvent2) })
            .mockReturnValue(new Promise(() => {})), // stays connected
          cancel: jest.fn().mockResolvedValue(undefined),
        };
        return { ok: true, body: { getReader: () => reader } } as unknown as Response;
      }
      return { ok: false, status: 500 } as unknown as Response;
    });

    const { result } = renderHook(() =>
      useRealtimeTelemetry(subjectA, {
        maxRetries: 2,
        baseDelayMs: 20,
        stableEventsThreshold: 2,
      })
    );

    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    // Retry count was reset upon reaching 2 forecast.updated events on connection 2
    expect(result.current.retryCount).toBe(0);
    expect(result.current.error).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────
  // Finding 1 — Companion events must not defeat bounded retries
  // ─────────────────────────────────────────────────────────────────

  it('F1: repeated connections each emitting forecast+companion then failing terminate after exactly maxRetries+1 total attempts', async () => {
    // Regression: with maxRetries=2, each short-lived connection emits 1 forecast.updated
    // and 1 alert.raised before failing. Because companion events do NOT count toward
    // the event-count stability threshold, each connection sees only 1 forecast event
    // (< stableEventsThreshold=2), so the retry budget is never reset, and the hook
    // must terminate after exactly 3 connection attempts (initial + 2 retries).
    const forecast = validFixture();
    let connectionAttempts = 0;

    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      connectionAttempts++;
      const forecastEvent = {
        event: 'forecast.updated',
        event_id: `00000${connectionAttempts}-forecast`,
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:00:00Z',
        payload: forecast,
      };
      const companionAlert = {
        event: 'alert.raised',
        event_id: `00000${connectionAttempts}-alert`,
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:00:01Z',
        payload: {
          state: 'watch',
          alert_id: '123e4567-e89b-12d3-a456-426614174099',
          since: '2026-10-16T12:00:00Z',
          suppressed_until: null,
          message_key: 'alert.spike.watch',
        },
      };
      const reader = {
        read: jest.fn()
          .mockResolvedValueOnce({ done: false, value: ssePacket(forecastEvent) })
          .mockResolvedValueOnce({ done: false, value: ssePacket(companionAlert) })
          .mockRejectedValueOnce(new Error(`Flap drop on connection ${connectionAttempts}`)),
        cancel: jest.fn().mockResolvedValue(undefined),
      };
      return { ok: true, body: { getReader: () => reader } } as unknown as Response;
    });

    const { result } = renderHook(() =>
      useRealtimeTelemetry(subjectA, {
        maxRetries: 2,
        baseDelayMs: 20,
        stableEventsThreshold: 2,
      })
    );

    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'), { timeout: 2000 });
    expect(result.current.error?.message).toBe('unavailable');
    // Exactly 3 total connection requests: initial + 2 retries
    expect(connectionAttempts).toBe(3);

    // Verify no further automatic retries are dispatched
    await new Promise(r => setTimeout(r, 80));
    expect(connectionAttempts).toBe(3);
  });

  it('F1: companion-only connections (no forecast.updated) do not reset retry budget and terminate after maxRetries', async () => {
    // Edge case: every connection delivers only alert and data_quality events with no
    // forecast.updated at all. The retry budget must never be reset.
    let connectionAttempts = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      connectionAttempts++;
      const alertEvent = {
        event: 'alert.raised',
        event_id: `00000${connectionAttempts}-alert`,
        subject_id: subjectA,
        emitted_at: '2026-10-16T12:00:00Z',
        payload: {
          state: 'watch',
          alert_id: '123e4567-e89b-12d3-a456-426614174099',
          since: '2026-10-16T12:00:00Z',
          suppressed_until: null,
          message_key: 'alert.spike.watch',
        },
      };
      const reader = {
        read: jest.fn()
          .mockResolvedValueOnce({ done: false, value: ssePacket(alertEvent) })
          .mockRejectedValueOnce(new Error('Drop without forecast')),
        cancel: jest.fn().mockResolvedValue(undefined),
      };
      return { ok: true, body: { getReader: () => reader } } as unknown as Response;
    });

    const { result } = renderHook(() =>
      useRealtimeTelemetry(subjectA, {
        maxRetries: 2,
        baseDelayMs: 20,
        stableEventsThreshold: 1, // even threshold=1 must not be satisfied without forecast
      })
    );

    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'), { timeout: 2000 });
    expect(result.current.error?.message).toBe('unavailable');
    expect(connectionAttempts).toBe(3);
  });

  // ─────────────────────────────────────────────────────────────────
  // Finding 2 — Reject arrays as twin.recalibrated payloads (streaming path)
  // ─────────────────────────────────────────────────────────────────

  it('F2: rejects array twin.recalibrated payload in streaming path with contract-invalid and does not advance event ID', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const arrayRecal = {
      event: 'twin.recalibrated',
      event_id: '000001-recal',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: [{ schema_version: '1.0.0' }], // array — must be rejected
    };

    const reader = {
      read: jest.fn().mockResolvedValueOnce({ done: false, value: ssePacket(arrayRecal) }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 3, baseDelayMs: 20 }));

    await waitFor(() => expect(result.current.error?.message).toBe('contract-invalid'));
    expect(result.current.connectionStatus).toBe('disconnected');
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1); // non-transient: no retry
  });

  it('F2: rejects null twin.recalibrated payload in streaming path with contract-invalid', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const nullRecal = {
      event: 'twin.recalibrated',
      event_id: '000001-recal',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: null,
    };

    const reader = {
      read: jest.fn().mockResolvedValueOnce({ done: false, value: ssePacket(nullRecal) }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 3, baseDelayMs: 20 }));

    await waitFor(() => expect(result.current.error?.message).toBe('contract-invalid'));
    expect(result.current.connectionStatus).toBe('disconnected');
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('F2: rejects primitive twin.recalibrated payload in streaming path with contract-invalid', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const primitiveRecal = {
      event: 'twin.recalibrated',
      event_id: '000001-recal',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: 42, // number primitive — must be rejected
    };

    const reader = {
      read: jest.fn().mockResolvedValueOnce({ done: false, value: ssePacket(primitiveRecal) }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 3, baseDelayMs: 20 }));

    await waitFor(() => expect(result.current.error?.message).toBe('contract-invalid'));
    expect(result.current.connectionStatus).toBe('disconnected');
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // Finding 2 — Reject arrays as twin.recalibrated payloads (replay path)
  // ─────────────────────────────────────────────────────────────────

  it('F2: rejects array twin.recalibrated payload in replay (asOf) path with contract-invalid', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const asOfSubjectA = '2026-10-16T12:00:00Z';
    const arrayRecalEvent = {
      event: 'twin.recalibrated',
      event_id: '000001-recal',
      subject_id: subjectA,
      emitted_at: asOfSubjectA,
      payload: [{ schema_version: '1.0.0' }], // array — must be rejected
    };

    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => `data: ${JSON.stringify(arrayRecalEvent)}\n\n`,
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA), {
      wrapper: ({ children }) => (
        <TimeContext.Provider value={{ asOf: asOfSubjectA, setAsOf: () => {} }}>
          {children}
        </TimeContext.Provider>
      ),
    });

    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
    expect(result.current.error?.message).toBe('contract-invalid');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('F2: rejects null twin.recalibrated payload in replay path with contract-invalid', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const asOfSubjectA = '2026-10-16T12:00:00Z';
    const nullRecalEvent = {
      event: 'twin.recalibrated',
      event_id: '000001-recal',
      subject_id: subjectA,
      emitted_at: asOfSubjectA,
      payload: null,
    };

    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => `data: ${JSON.stringify(nullRecalEvent)}\n\n`,
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA), {
      wrapper: ({ children }) => (
        <TimeContext.Provider value={{ asOf: asOfSubjectA, setAsOf: () => {} }}>
          {children}
        </TimeContext.Provider>
      ),
    });

    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
    expect(result.current.error?.message).toBe('contract-invalid');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('F2: rejects primitive twin.recalibrated payload in replay path with contract-invalid', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const asOfSubjectA = '2026-10-16T12:00:00Z';
    const primRecalEvent = {
      event: 'twin.recalibrated',
      event_id: '000001-recal',
      subject_id: subjectA,
      emitted_at: asOfSubjectA,
      payload: 12345,
    };

    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => `data: ${JSON.stringify(primRecalEvent)}\n\n`,
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA), {
      wrapper: ({ children }) => (
        <TimeContext.Provider value={{ asOf: asOfSubjectA, setAsOf: () => {} }}>
          {children}
        </TimeContext.Provider>
      ),
    });

    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
    expect(result.current.error?.message).toBe('contract-invalid');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // Finding 3 — Replay validation errors must not be swallowed
  // ─────────────────────────────────────────────────────────────────

  it('F3: malformed replay JSON routes through contract-invalid and sets disconnected with error', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => 'data: {BROKEN JSON}\n\n',
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA), {
      wrapper: ({ children }) => (
        <TimeContext.Provider value={{ asOf: '2026-10-16T12:00:00Z', setAsOf: () => {} }}>
          {children}
        </TimeContext.Provider>
      ),
    });

    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
    expect(result.current.error?.message).toBe('contract-invalid');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('F3: invalid replay SSE envelope routes through contract-invalid', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const invalidEnvelope = { event: 'unknown.event', event_id: '1', subject_id: subjectA, emitted_at: '2026-10-16T12:00:00Z', payload: {} };
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => `data: ${JSON.stringify(invalidEnvelope)}\n\n`,
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA), {
      wrapper: ({ children }) => (
        <TimeContext.Provider value={{ asOf: '2026-10-16T12:00:00Z', setAsOf: () => {} }}>
          {children}
        </TimeContext.Provider>
      ),
    });

    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
    expect(result.current.error?.message).toBe('contract-invalid');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('F3: invalid replay forecast payload routes through contract-invalid', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const invalidForecastEnvelope = {
      event: 'forecast.updated',
      event_id: '000001-forecast',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: { malformed: true }, // not a valid ForecastResponse
    };
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => `data: ${JSON.stringify(invalidForecastEnvelope)}\n\n`,
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA), {
      wrapper: ({ children }) => (
        <TimeContext.Provider value={{ asOf: '2026-10-16T12:00:00Z', setAsOf: () => {} }}>
          {children}
        </TimeContext.Provider>
      ),
    });

    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
    expect(result.current.error?.message).toBe('contract-invalid');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('F3: invalid replay recalibration payload (array) routes through contract-invalid', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const arrayRecalEnvelope = {
      event: 'twin.recalibrated',
      event_id: '000001-recal',
      subject_id: subjectA,
      emitted_at: '2026-10-16T12:00:00Z',
      payload: [{ schema_version: '1.0.0' }], // array — must be rejected
    };
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => `data: ${JSON.stringify(arrayRecalEnvelope)}\n\n`,
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA), {
      wrapper: ({ children }) => (
        <TimeContext.Provider value={{ asOf: '2026-10-16T12:00:00Z', setAsOf: () => {} }}>
          {children}
        </TimeContext.Provider>
      ),
    });

    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
    expect(result.current.error?.message).toBe('contract-invalid');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('F3: clean finite EOF in replay results in disconnected with null error and no retries', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '', // clean EOF: no data
    } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA), {
      wrapper: ({ children }) => (
        <TimeContext.Provider value={{ asOf: '2026-10-16T12:00:00Z', setAsOf: () => {} }}>
          {children}
        </TimeContext.Provider>
      ),
    });

    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

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
    const nextForecast = validFixture();
    nextForecast.as_of = new Date(Date.parse(forecast.as_of) + 5 * 60_000).toISOString();
    nextForecast.current.measured_at = nextForecast.as_of;
    nextForecast.data_quality.last_cgm_at = nextForecast.as_of;
    nextForecast.forecast?.points.forEach(point => {
      point.t = new Date(Date.parse(nextForecast.as_of) + point.offset_min * 60_000).toISOString();
    });
    const laterForecast = validFixture();
    laterForecast.as_of = new Date(Date.parse(nextForecast.as_of) + 5 * 60_000).toISOString();
    laterForecast.current.measured_at = laterForecast.as_of;
    laterForecast.data_quality.last_cgm_at = laterForecast.as_of;
    laterForecast.forecast?.points.forEach(point => {
      point.t = new Date(Date.parse(laterForecast.as_of) + point.offset_min * 60_000).toISOString();
    });
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
      payload: nextForecast,
    };
    const forecastEvent3 = {
      ...forecastEvent2,
      event_id: '000003-forecast',
      payload: laterForecast,
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
        // Second connection: delivers 2 previously unseen, forward forecasts.
        const reader = {
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: ssePacket(forecastEvent2) })
            .mockResolvedValueOnce({ done: false, value: ssePacket(forecastEvent3) })
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

  describe('distinct forecast stability', () => {
    function forecastAt(minutes: number) {
      const forecast = validFixture();
      forecast.as_of = new Date(Date.parse(forecast.as_of) + minutes * 60_000).toISOString();
      forecast.current.measured_at = forecast.as_of;
      forecast.data_quality.last_cgm_at = forecast.as_of;
      forecast.forecast?.points.forEach(point => {
        point.t = new Date(Date.parse(forecast.as_of) + point.offset_min * 60_000).toISOString();
      });
      return forecast;
    }
    const forecastEvent = (eventId: string, minutes: number) => ({
      event: 'forecast.updated', event_id: eventId, subject_id: subjectA,
      emitted_at: source.generated_at, payload: forecastAt(minutes),
    });

    it.each([
      { name: 'identical packets', packets: [['A', 0], ['A', 0]], threshold: 2 },
      { name: 'a reused ID with a later anchor', packets: [['A', 0], ['A', 5]], threshold: 2 },
      { name: 'different IDs at the same anchor', packets: [['A', 0], ['B', 0]], threshold: 2 },
      { name: 'an older anchor with a new ID', packets: [['A', 0], ['B', -5]], threshold: 2 },
      { name: 'non-adjacent ID reuse', packets: [['A', 0], ['B', 5], ['A', 10]], threshold: 3 },
      { name: 'the same progressing pair replayed on every reconnect', packets: [['A', 0], ['B', 5]], threshold: 2 },
    ])('exhausts the budget after three requests for $name', async ({ packets, threshold }) => {
      jest.useFakeTimers();
      let attempts = 0;
      const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
        // Bound the defective implementation too, so failure cannot hang the test.
        if (++attempts > 5) return { ok: false, status: 500 } as Response;
        const events = packets.map(([eventId, minutes]) => forecastEvent(String(eventId), Number(minutes)));
        let next = 0;
        return { ok: true, body: { getReader: () => ({
          read: async () => {
            if (next < events.length) return { done: false, value: ssePacket(events[next++]) };
            throw new Error('Short-lived duplicate stream');
          },
          cancel: async () => {},
        }) } } as unknown as Response;
      });
      const { result, unmount } = renderHook(() => useRealtimeTelemetry(subjectA, {
        maxRetries: 2, baseDelayMs: 1, stableEventsThreshold: threshold, stableDurationMs: 0,
      }));
      try {
        await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });
        expect(result.current.connectionStatus).toBe('disconnected');
        expect(result.current.error?.message).toBe('unavailable');
        expect(fetchMock).toHaveBeenCalledTimes(3);
        if (packets.every(([, minutes]) => minutes === 0)) {
          expect(result.current.cache.cgm).toHaveLength(1);
          expect(result.current.cache.risk).toHaveLength(1);
        }
        await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });
        expect(fetchMock).toHaveBeenCalledTimes(3);
      } finally {
        unmount();
        jest.useRealTimers();
      }
    });

    it('resets the budget for two distinct forward forecasts after a failed connection', async () => {
      jest.useFakeTimers();
      let drop!: (reason: Error) => void;
      const pending = new Promise((_, reject) => { drop = reject; });
      const reader = {
        read: jest.fn()
          .mockResolvedValueOnce({ done: false, value: ssePacket(forecastEvent('A', 0)) })
          .mockResolvedValueOnce({ done: false, value: ssePacket(forecastEvent('B', 5)) })
          .mockReturnValue(pending),
        cancel: jest.fn().mockResolvedValue(undefined),
      };
      const fetchMock = jest.spyOn(global, 'fetch')
        .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
        .mockResolvedValueOnce({ ok: true, body: { getReader: () => reader } } as unknown as Response)
        .mockResolvedValue({ ok: false, status: 500 } as Response);
      const { result, unmount } = renderHook(() => useRealtimeTelemetry(subjectA, {
        maxRetries: 2, baseDelayMs: 1, stableEventsThreshold: 2, stableDurationMs: 0,
      }));
      try {
        await act(async () => { await jest.advanceTimersByTimeAsync(5); });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.current.connectionStatus).toBe('connected');
        expect(result.current.retryCount).toBe(0);
        expect(result.current.cache.cgm).toHaveLength(2);
        await act(async () => { drop(new Error('Drop after genuine progress')); });
        await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });
        expect(fetchMock).toHaveBeenCalledTimes(4); // Full two-retry budget restored.
        expect(result.current.error?.message).toBe('unavailable');
      } finally {
        unmount();
        jest.useRealTimers();
      }
    });

    it.each(['none', 'new', 'cached'])('duration stability with %s forecast', async mode => {
      jest.useFakeTimers();
      const withForecast = mode !== 'none';
      const event = withForecast ? forecastEvent('A', 0) : {
        event: 'twin.recalibrated', event_id: 'A', subject_id: subjectA,
        emitted_at: source.generated_at, payload: {},
      };
      const reader = {
        read: jest.fn().mockResolvedValueOnce({ done: false, value: ssePacket(event) })
          .mockReturnValue(new Promise(() => {})),
        cancel: jest.fn().mockResolvedValue(undefined),
      };
      const fetchMock = jest.spyOn(global, 'fetch')
        .mockResolvedValueOnce(mode === 'cached' ? {
          ok: true, body: { getReader: () => ({
            read: jest.fn()
              .mockResolvedValueOnce({ done: false, value: ssePacket(forecastEvent('A', 0)) })
              .mockRejectedValueOnce(new Error('Drop before duration stability')),
          }) },
        } as unknown as Response : { ok: false, status: 500 } as Response)
        .mockResolvedValueOnce({ ok: true, body: { getReader: () => reader } } as unknown as Response);
      const { result, unmount } = renderHook(() => useRealtimeTelemetry(subjectA, {
        maxRetries: 2, baseDelayMs: 1, stableEventsThreshold: 2, stableDurationMs: 25,
      }));
      try {
        await act(async () => { await jest.advanceTimersByTimeAsync(5); });
        expect(result.current.retryCount).toBe(1);
        await act(async () => { await jest.advanceTimersByTimeAsync(30); });
        expect(result.current.connectionStatus).toBe('connected');
        expect(result.current.retryCount).toBe(withForecast ? 0 : 1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        unmount();
        await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(reader.cancel).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
      }
    });
  });

  describe('whole-response pinned replay validation', () => {
    const asOf = '2026-10-16T12:00:00Z';
    const replayEvent = (event: string, payload: unknown, eventId = '000002-replay') => ({
      event, event_id: eventId, subject_id: subjectA, emitted_at: asOf, payload,
    });
    const replayWrapper = ({ children }: { children: React.ReactNode }) => (
      <TimeContext.Provider value={{ asOf, setAsOf: () => {} }}>{children}</TimeContext.Provider>
    );
    const invalidEvents = [
      ['malformed JSON', '{BROKEN JSON}'],
      ['invalid envelope', JSON.stringify(replayEvent('unknown.event', {}))],
      ['invalid forecast', JSON.stringify(replayEvent('forecast.updated', { malformed: true }))],
      ['array recalibration', JSON.stringify(replayEvent('twin.recalibrated', []))],
      ['null recalibration', JSON.stringify(replayEvent('twin.recalibrated', null))],
      ['primitive recalibration', JSON.stringify(replayEvent('twin.recalibrated', 42))],
      ['invalid alert', JSON.stringify(replayEvent('alert.raised', { state: 'invalid' }))],
      ['invalid quality', JSON.stringify(replayEvent('data_quality.changed', { status: 'ok' }))],
    ];

    describe.each(['before', 'after'])('invalid event %s a valid forecast', position => {
      it.each(invalidEvents)('rejects %s without accepting any forecast or retrying', async (_label, invalid) => {
        jest.useFakeTimers();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const valid = JSON.stringify(replayEvent('forecast.updated', validFixture()));
        const events = position === 'before' ? [invalid, valid] : [valid, invalid];
        const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
          ok: true,
          text: async () => events.map(data => `data: ${data}\n\n`).join(''),
        } as unknown as Response);
        const committedForecasts: (ForecastResponse | null)[] = [];
        const { result, unmount } = renderHook(() => {
          const state = useRealtimeTelemetry(subjectA);
          React.useEffect(() => { committedForecasts.push(state.forecast); }, [state.forecast]);
          return state;
        }, { wrapper: replayWrapper });

        try {
          await act(async () => {});
          expect(result.current.connectionStatus).toBe('disconnected');
          expect(result.current.error?.message).toBe('contract-invalid');
          expect(result.current.forecast).toBeNull();
          expect(committedForecasts.every(value => value === null)).toBe(true);
          expect(result.current.cache.cgm).toEqual([]);
          // Advance beyond the full automatic-backoff window, not merely one tick.
          await act(async () => { jest.advanceTimersByTime(60_000); });
          expect(fetchMock).toHaveBeenCalledTimes(1);
          expect(result.current.connectionStatus).toBe('disconnected');
          expect(result.current.error?.message).toBe('contract-invalid');
        } finally {
          unmount();
          jest.useRealTimers();
        }
      });
    });

    it.each(['forecast.updated', 'alert.raised', 'alert.cleared', 'data_quality.changed', 'twin.recalibrated'])(
      'retains last-event selection when the final valid event is %s', async finalType => {
        const first = validFixture();
        const last = validFixture({ request_id: '123e4567-e89b-12d3-a456-426614174099' });
        const payload = finalType === 'forecast.updated' ? last
          : finalType === 'alert.raised' ? { state: 'watch', since: asOf }
          : finalType === 'alert.cleared' ? { state: 'none' }
          : finalType === 'data_quality.changed' ? first.data_quality
          : {}; // Generic recalibration objects have no additional required fields.
        const body = [replayEvent('forecast.updated', first, '000001-forecast'), replayEvent(finalType, payload)]
          .map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
        const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => body } as unknown as Response);
        const { result } = renderHook(() => useRealtimeTelemetry(subjectA), { wrapper: replayWrapper });

        await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
        expect(result.current.error).toBeNull();
        expect(result.current.forecast).toEqual(finalType === 'forecast.updated' ? last : null);
        expect(result.current.cache.cgm).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['\n', '\r\n'])('parses event boundaries, metadata, comments and multiline data with %j', async newline => {
      const first = replayEvent('twin.recalibrated', {});
      const last = replayEvent('forecast.updated', validFixture());
      const body = [
        ': keepalive', '',
        'id: 000001-recal', 'event: twin.recalibrated', `data:${JSON.stringify(first)}`, '',
        ': forecast follows', 'id: 000002-forecast', 'event: forecast.updated',
        ...JSON.stringify(last, null, 2).split('\n').map(line => `data: ${line}`), '', '',
      ].join(newline);
      jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => body } as unknown as Response);
      const { result } = renderHook(() => useRealtimeTelemetry(subjectA), { wrapper: replayWrapper });

      await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
      expect(result.current.error).toBeNull();
      expect(result.current.forecast).toEqual(last.payload);
    });
  });
});

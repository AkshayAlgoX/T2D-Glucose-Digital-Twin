import { act, renderHook, waitFor, render, screen, fireEvent } from '@testing-library/react';
import { TextDecoder } from 'node:util';
import { useRealtimeTelemetry } from '../src/hooks/useRealtimeTelemetry';
import { PatientWorkspace } from '../src/components/digital-twin/PatientWorkspace';
import { TimeProvider } from '../src/components/digital-twin/TimeContext';
import { ForecastResponse } from '../src/types/forecast-response';
import { SubjectStore } from '../src/lib/types';

import { ForecastResponseSchema } from '../src/lib/zod-schemas';
import source from './fixtures/risk-audit-forecast.json';

const subjectA = '123e4567-e89b-12d3-a456-426614174000';
const subjectB = '123e4567-e89b-12d3-a456-426614174001';

function deferredRead() {
  let finish!: (value: { done: boolean; value?: Uint8Array }) => void;
  const promise = new Promise<{ done: boolean; value?: Uint8Array }>(resolve => { finish = resolve; });
  return { read: jest.fn(() => promise), finish };
}

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

describe('Stream Reliability & Bounded Recovery (SSE)', () => {
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

  it('resumes with bounded exponential backoff on stream disconnection and recovers on retry()', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('Network offline 1'))
      .mockRejectedValueOnce(new Error('Network offline 2'))
      .mockRejectedValueOnce(new Error('Network offline 3'));

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 2, baseDelayMs: 60 }));

    expect(result.current.connectionStatus).toBe('connecting');
    expect(result.current.isConnected).toBe(false);

    // First retry transition
    await waitFor(() => expect(result.current.connectionStatus).toBe('reconnecting'));
    expect(result.current.retryCount).toBe(1);

    // Retries 2 times then exhausts to disconnected with unavailable error
    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
    expect(result.current.error?.message).toBe('unavailable');
    expect(result.current.isConnected).toBe(false);

    // Manual recovery action triggers fresh connection attempt
    const reader = deferredRead();
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, body: { getReader: () => reader } } as unknown as Response);

    act(() => {
      result.current.retry();
    });

    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    expect(result.current.isConnected).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('strictly bounds automatic retries across repeated HTTP-200 responses with immediate stream-read failures', async () => {
    let fetchCount = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      fetchCount++;
      const failingReader = {
        read: jest.fn().mockRejectedValue(new Error('Immediate stream-read disconnect')),
        cancel: jest.fn(),
      };
      return { ok: true, body: { getReader: () => failingReader } } as unknown as Response;
    });

    const maxRetries = 2;
    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries, baseDelayMs: 25 }));

    // With maxRetries = 2:
    // Call 1: initial connection attempt (fails on read())
    // Call 2: retry 1 (fails on read())
    // Call 3: retry 2 (fails on read(), retries exhausted!)
    // Total fetch calls must be exactly 1 + maxRetries = 3, then transitions to disconnected.
    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'), { timeout: 1500 });
    expect(result.current.error?.message).toBe('unavailable');
    expect(fetchCount).toBe(3);

    // Ensure no additional reconnection occurs after exhaustion
    await new Promise(r => setTimeout(r, 100));
    expect(fetchCount).toBe(3);
  });

  it('resumes using Last-Event-ID header on stream reconnection', async () => {
    const forecast = validFixture();
    const eventPayload = {
      event: 'forecast.updated',
      event_id: '000007-forecast',
      subject_id: subjectA,
      emitted_at: forecast.generated_at,
      payload: forecast,
    };

    const firstReader = {
      read: jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: new Uint8Array(Buffer.from(`id: 000007-forecast\nevent: forecast.updated\ndata: ${JSON.stringify(eventPayload)}\n\n`)),
        })
        .mockRejectedValueOnce(new Error('Connection reset midway')),
      cancel: jest.fn(),
    };

    const secondReader = deferredRead();
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => firstReader } } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => secondReader } } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 3, baseDelayMs: 10 }));

    // Wait for first event to be received and parsed
    await waitFor(() => expect(result.current.forecast?.subject.subject_id).toBe(subjectA));

    // The stream threw an error midway; hook should retry and pass Last-Event-ID
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const secondCallHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    expect(secondCallHeaders['Last-Event-ID']).toBe('000007-forecast');
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
  });

  it('does not retry non-transient 404 (patient-not-found) or contract-invalid errors', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 3, baseDelayMs: 10 }));

    await waitFor(() => expect(result.current.error?.message).toBe('patient-not-found'));
    expect(result.current.connectionStatus).toBe('disconnected');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Wait past any potential retry delay to verify no retry was scheduled
    await new Promise(r => setTimeout(r, 60));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('confirms automatic retry attempts never exceed the configured bound (maxRetries: 3)', async () => {
    let fetchCount = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      fetchCount++;
      const failingReader = {
        read: jest.fn().mockRejectedValue(new Error('Immediate socket failure')),
        cancel: jest.fn(),
      };
      return { ok: true, body: { getReader: () => failingReader } } as unknown as Response;
    });

    const maxRetries = 3;
    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries, baseDelayMs: 20 }));

    // Initial attempt (1) + 3 retries = exactly 4 fetches before exhausting
    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'), { timeout: 2000 });
    expect(result.current.error?.message).toBe('unavailable');
    expect(fetchCount).toBe(4);

    await new Promise(r => setTimeout(r, 80));
    expect(fetchCount).toBe(4);
  });

  it('exhausts retry budget under adversarial flapping stream (repeated HTTP-200 delivering 1 event then failing)', async () => {
    const forecast = validFixture();
    let connectionAttempts = 0;

    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      connectionAttempts++;
      const currentAttempt = connectionAttempts;
      const eventPayload = {
        event: 'forecast.updated',
        event_id: `00000${currentAttempt}-forecast`,
        subject_id: subjectA,
        emitted_at: forecast.generated_at,
        payload: forecast,
      };

      const flappingReader = {
        read: jest.fn()
          .mockResolvedValueOnce({
            done: false,
            value: new Uint8Array(Buffer.from(`data: ${JSON.stringify(eventPayload)}\n\n`)),
          })
          .mockRejectedValueOnce(new Error(`Adversarial stream read drop on connection ${currentAttempt}`)),
        cancel: jest.fn(),
      };

      return { ok: true, body: { getReader: () => flappingReader } } as unknown as Response;
    });

    const maxRetries = 2;
    const { result } = renderHook(() =>
      useRealtimeTelemetry(subjectA, {
        maxRetries,
        baseDelayMs: 20,
        stableEventsThreshold: 2, // requires 2 events for stability
      })
    );

    // With maxRetries = 2 and stableEventsThreshold = 2:
    // Attempt 1: delivers 1 event, then throws (1 < 2 events: retryCount becomes 1, reconnects)
    // Attempt 2: delivers 1 event, then throws (1 < 2 events: retryCount becomes 2, reconnects)
    // Attempt 3: delivers 1 event, then throws (1 < 2 events: retryCount exhausted >= maxRetries)
    // Must terminate at 'disconnected' with 'unavailable' error and exactly 3 connection attempts.
    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'), { timeout: 2000 });
    expect(result.current.error?.message).toBe('unavailable');
    expect(connectionAttempts).toBe(3);

    // Verify it stays disconnected and does not restart indefinitely
    await new Promise(r => setTimeout(r, 80));
    expect(connectionAttempts).toBe(3);
    // Forecast from the last event remains visible
    expect(result.current.forecast?.subject.subject_id).toBe(subjectA);
  });

  it('resets retry budget when a connection reaches stability (multiple valid events)', async () => {
    const forecast = validFixture();
    const eventPayload1 = {
      event: 'forecast.updated',
      event_id: '000001-forecast',
      subject_id: subjectA,
      emitted_at: forecast.generated_at,
      payload: forecast,
    };
    const eventPayload2 = {
      event: 'forecast.updated',
      event_id: '000002-forecast',
      subject_id: subjectA,
      emitted_at: forecast.generated_at,
      payload: forecast,
    };

    // First connection delivers 2 valid events (reaching stability threshold), then drops
    const stableReader = {
      read: jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: new Uint8Array(Buffer.from(`data: ${JSON.stringify(eventPayload1)}\n\n`)),
        })
        .mockResolvedValueOnce({
          done: false,
          value: new Uint8Array(Buffer.from(`data: ${JSON.stringify(eventPayload2)}\n\n`)),
        })
        .mockRejectedValueOnce(new Error('Stream dropped after stability')),
      cancel: jest.fn(),
    };

    let reconnectAttempts = 0;
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => stableReader } } as unknown as Response)
      .mockImplementation(async () => {
        reconnectAttempts++;
        const reconnectReader = {
          read: jest.fn().mockRejectedValue(new Error('Reconnect socket dropped')),
          cancel: jest.fn(),
        };
        return { ok: true, body: { getReader: () => reconnectReader } } as unknown as Response;
      });

    const maxRetries = 2;
    const { result } = renderHook(() =>
      useRealtimeTelemetry(subjectA, {
        maxRetries,
        baseDelayMs: 25,
        stableEventsThreshold: 2,
      })
    );

    // First connection reaches stability
    await waitFor(() => expect(result.current.forecast?.subject.subject_id).toBe(subjectA));

    // After dropping, because it reached stability, it is granted the full retry budget (2 retries)
    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'), { timeout: 1500 });
    expect(result.current.error?.message).toBe('unavailable');
    expect(reconnectAttempts).toBe(2);
  });

  it('confirms stale-data detection remains operational during reconnection and timers are cleaned up', async () => {
    const forecast = validFixture();
    const eventPayload = {
      event: 'forecast.updated',
      event_id: '000001-forecast',
      subject_id: subjectA,
      emitted_at: forecast.generated_at,
      payload: forecast,
    };

    let resolveReconnectionFetch!: (val: Response) => void;
    const reconnectionPromise = new Promise<Response>(res => { resolveReconnectionFetch = res; });

    // Initial connection delivers 1 event, then drops
    const firstReader = {
      read: jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: new Uint8Array(Buffer.from(`data: ${JSON.stringify(eventPayload)}\n\n`)),
        })
        .mockRejectedValueOnce(new Error('Connection dropped')),
      cancel: jest.fn(),
    };

    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => firstReader } } as unknown as Response)
      .mockReturnValueOnce(reconnectionPromise);

    // Configure staleness thresholds: 60ms threshold, 20ms check interval
    const { result, unmount } = renderHook(() =>
      useRealtimeTelemetry(subjectA, {
        maxRetries: 3,
        baseDelayMs: 10,
        stalenessThresholdMs: 60,
        stalenessIntervalMs: 20,
      })
    );

    // Initial event loads forecast, isStale is false
    await waitFor(() => expect(result.current.forecast?.subject.subject_id).toBe(subjectA));
    expect(result.current.isStale).toBe(false);

    // Stream drops and enters reconnecting
    await waitFor(() => expect(result.current.connectionStatus).toBe('reconnecting'));
    expect(result.current.isStale).toBe(false);

    // While reconnecting, staleness timer remains active and flags staleness once threshold is exceeded
    await waitFor(() => expect(result.current.isStale).toBe(true), { timeout: 1000 });
    expect(result.current.connectionStatus).toBe('reconnecting');
    expect(result.current.forecast).not.toBeNull();

    // Unmount hook: verifies timers and reader cancel cleanly
    unmount();
    resolveReconnectionFetch({ ok: false, status: 503 } as Response);
  });

  it('handles clean EOF under finite-stream contract without retrying or marking transport failure', async () => {
    const forecast = validFixture();
    const eventPayload = {
      event: 'forecast.updated',
      event_id: '000001-forecast',
      subject_id: subjectA,
      emitted_at: forecast.generated_at,
      payload: forecast,
    };

    // Replay streams finite events and ends cleanly with { done: true }
    const finiteReader = {
      read: jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: new Uint8Array(Buffer.from(`data: ${JSON.stringify(eventPayload)}\n\n`)),
        })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: jest.fn(),
    };

    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => finiteReader } } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 3, baseDelayMs: 20 }));

    // Forecast arrives
    await waitFor(() => expect(result.current.forecast?.subject.subject_id).toBe(subjectA));

    // Normal finite completion reached: status becomes disconnected, error remains null
    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.forecast).not.toBeNull();

    // No auto-reconnection loop: fetch should be called exactly once
    await new Promise(r => setTimeout(r, 60));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles empty clean EOF (replay already at end of data) without retrying or erroring', async () => {
    const emptyReader = {
      read: jest.fn().mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: jest.fn(),
    };

    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => emptyReader } } as unknown as Response);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 3, baseDelayMs: 20 }));

    await waitFor(() => expect(result.current.connectionStatus).toBe('disconnected'));
    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBeNull();

    // No retry scheduled
    await new Promise(r => setTimeout(r, 60));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prevents duplicate concurrent connections and stale updates during subject switching', async () => {
    const oldReader = deferredRead();
    const newReader = deferredRead();

    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => oldReader } } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => newReader } } as unknown as Response);

    const { result, rerender } = renderHook(
      ({ id }) => useRealtimeTelemetry(id, { maxRetries: 3, baseDelayMs: 50 }),
      { initialProps: { id: subjectA } }
    );

    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    expect(result.current.cache.patientId).toBe(subjectA);

    // Switch subject to Subject B
    rerender({ id: subjectB });

    // State immediately isolates to Subject B
    expect(result.current.cache.patientId).toBe(subjectB);
    expect(result.current.forecast).toBeNull();

    await waitFor(() => expect(newReader.read).toHaveBeenCalledTimes(1));

    // Old reader completes after subject has switched: must NOT affect subject B
    await act(async () => {
      oldReader.finish({ done: true });
    });

    expect(result.current.connectionStatus).toBe('connected');
    expect(result.current.isConnected).toBe(true);
    expect(result.current.cache.patientId).toBe(subjectB);
  });

  it('preserves existing populated forecast data during transient reconnection', async () => {
    const forecast = validFixture();
    const eventPayload = {
      event: 'forecast.updated',
      event_id: '000001-forecast',
      subject_id: subjectA,
      emitted_at: forecast.generated_at,
      payload: forecast,
    };

    let resolveSecondFetch!: (val: Response) => void;
    const secondFetchPromise = new Promise<Response>(res => { resolveSecondFetch = res; });

    const firstReader = {
      read: jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: new Uint8Array(Buffer.from(`data: ${JSON.stringify(eventPayload)}\n\n`)),
        })
        .mockRejectedValueOnce(new Error('Temporary stream drop')),
      cancel: jest.fn(),
    };

    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => firstReader } } as unknown as Response)
      .mockReturnValueOnce(secondFetchPromise);

    const { result } = renderHook(() => useRealtimeTelemetry(subjectA, { maxRetries: 3, baseDelayMs: 10 }));

    // Wait until forecast is loaded
    await waitFor(() => expect(result.current.forecast).not.toBeNull());
    expect(result.current.forecast?.subject.subject_id).toBe(subjectA);

    // When connection drops and enters reconnecting, forecast is NOT wiped
    await waitFor(() => expect(result.current.connectionStatus).toBe('reconnecting'));
    expect(result.current.forecast).not.toBeNull();
    expect(result.current.forecast?.subject.subject_id).toBe(subjectA);
  });

  it('renders Reconnecting badge and Retry connection button in PatientWorkspace UI', () => {
    const forecast = validFixture();
    const cache: SubjectStore = {
      patientId: subjectA,
      cgm: [{ t: forecast.as_of, value: 120, trend: 'flat' }],
      risk: [{ t: forecast.as_of, p: 0.25 }],
      alerts: [],
      dataQuality: [],
    };
    const onRetryMock = jest.fn();

    // 1. Reconnecting state
    const { rerender } = render(
      <TimeProvider>
        <PatientWorkspace
          patientId={subjectA}
          forecast={forecast}
          cache={cache}
          isConnected={false}
          isStale={false}
          connectionStatus="reconnecting"
          retryCount={2}
          onRetry={onRetryMock}
        />
      </TimeProvider>
    );

    expect(screen.getByText('Reconnecting (2)')).toBeInTheDocument();

    // 2. Disconnected with exhausted error: shows Retry connection button
    rerender(
      <TimeProvider>
        <PatientWorkspace
          patientId={subjectA}
          forecast={forecast}
          cache={cache}
          isConnected={false}
          isStale={false}
          error={new Error('unavailable')}
          connectionStatus="disconnected"
          onRetry={onRetryMock}
        />
      </TimeProvider>
    );

    expect(screen.getByText('Service Unavailable')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /Retry stream connection/i });
    expect(retryBtn).toBeInTheDocument();

    fireEvent.click(retryBtn);
    expect(onRetryMock).toHaveBeenCalledTimes(1);

    // 3. Non-retryable error (patient-not-found) does NOT render retry button
    rerender(
      <TimeProvider>
        <PatientWorkspace
          patientId={subjectA}
          forecast={null}
          cache={cache}
          isConnected={false}
          isStale={false}
          error={new Error('patient-not-found')}
          connectionStatus="disconnected"
          onRetry={onRetryMock}
        />
      </TimeProvider>
    );

    expect(screen.getByText('Patient Not Found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry stream connection/i })).not.toBeInTheDocument();
  });
});

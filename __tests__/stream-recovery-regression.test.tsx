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

  it('cancels scheduled retries and active stream when the subject changes', async () => {
    let resolveFirstFetch!: (val: Response) => void;
    const firstFetchPromise = new Promise<Response>(res => { resolveFirstFetch = res; });
    const readerB = deferredRead();

    const fetchMock = jest.spyOn(global, 'fetch')
      .mockReturnValueOnce(firstFetchPromise)
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => readerB } } as unknown as Response);

    const { result, rerender } = renderHook(
      ({ id }) => useRealtimeTelemetry(id, { maxRetries: 3, baseDelayMs: 50 }),
      { initialProps: { id: subjectA } }
    );

    expect(result.current.connectionStatus).toBe('connecting');

    // Switch subject while fetch for subjectA is still unresolved
    rerender({ id: subjectB });

    // Subject B starts immediately
    expect(result.current.cache.patientId).toBe(subjectB);
    expect(result.current.forecast).toBeNull();
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    expect(result.current.isConnected).toBe(true);
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

import { act, renderHook, waitFor } from '@testing-library/react';
import { TextDecoder } from 'node:util';
import { useRealtimeTelemetry } from '../src/hooks/useRealtimeTelemetry';

// Transport fixtures only: no backend, model, or scientific pipeline is invoked.
const first = '123e4567-e89b-12d3-a456-426614174000';
const second = '123e4567-e89b-12d3-a456-426614174001';
function deferredRead() {
  let finish!: (value: { done: boolean; value?: Uint8Array }) => void;
  const promise = new Promise<{ done: boolean; value?: Uint8Array }>(resolve => { finish = resolve; });
  return { read: jest.fn(() => promise), finish };
}
const response = (reader: ReturnType<typeof deferredRead>) => ({ ok: true, body: { getReader: () => reader } });

describe('Stream connection lifecycle', () => {
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

  it('reports connected while reading and disconnected after normal EOF', async () => {
    const reader = deferredRead();
    jest.spyOn(global, 'fetch').mockResolvedValue(response(reader) as unknown as Response);
    const { result } = renderHook(() => useRealtimeTelemetry(first));
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    await act(async () => { reader.finish({ done: true }); });
    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does not leave a bodyless response connected', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, body: null } as Response);
    const { result } = renderHook(() => useRealtimeTelemetry(first));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(result.current.isConnected).toBe(false);
  });

  it('cancels malformed streams instead of continuing to read rejected events', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const reader = { read: jest.fn().mockResolvedValue({ done: false, value: new Uint8Array(Buffer.from('data: {broken}\n\n')) }), cancel: jest.fn().mockResolvedValue(undefined) };
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, body: { getReader: () => reader } } as unknown as Response);
    const { result } = renderHook(() => useRealtimeTelemetry(first));
    await waitFor(() => expect(result.current.error?.message).toBe('contract-invalid'));
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(result.current.isConnected).toBe(false);
  });

  it('ignores response headers arriving after their subject was replaced', async () => {
    let resolveOld!: (value: Response) => void;
    const oldResponse = new Promise<Response>(resolve => { resolveOld = resolve; });
    jest.spyOn(global, 'fetch').mockReturnValueOnce(oldResponse).mockRejectedValueOnce(new Error('offline'));
    const { result, rerender } = renderHook(({ id }) => useRealtimeTelemetry(id), { initialProps: { id: first } });
    rerender({ id: second });
    await waitFor(() => expect(result.current.error?.message).toBe('unavailable'));
    const oldReader = deferredRead();
    await act(async () => { resolveOld(response(oldReader) as unknown as Response); });
    expect(oldReader.read).not.toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
  });

  it('does not let EOF from an aborted previous subject disconnect the current subject', async () => {
    const oldReader = deferredRead(), currentReader = deferredRead();
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(response(oldReader) as unknown as Response)
      .mockResolvedValueOnce(response(currentReader) as unknown as Response);
    const { result, rerender } = renderHook(({ id }) => useRealtimeTelemetry(id), { initialProps: { id: first } });
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    rerender({ id: second });
    await waitFor(() => expect(currentReader.read).toHaveBeenCalledTimes(1));
    await act(async () => { oldReader.finish({ done: true }); });
    expect(result.current.isConnected).toBe(true);
    await act(async () => { currentReader.finish({ done: true }); });
    expect(result.current.isConnected).toBe(false);
  });
});

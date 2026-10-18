import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReadableStream as NativeReadableStream } from 'node:stream/web';
import { TextDecoder, TextEncoder } from 'node:util';
import fs from 'fs/promises';
import EvidencePage from '../src/app/evidence/page';
import { NavigationRail } from '../src/components/digital-twin/NavigationRail';
import { useRealtimeTelemetry } from '../src/hooks/useRealtimeTelemetry';
import source from './fixtures/risk-audit-forecast.json';

const subject = '123e4567-e89b-12d3-a456-426614174000';
const subject2 = '223e4567-e89b-12d3-a456-426614174000';
let mockNavigate: (href: string) => void;
jest.mock('fs/promises', () => ({ readFile: jest.fn() }));
jest.mock('next/navigation', () => ({ usePathname: () => '/patients/123e4567-e89b-12d3-a456-426614174000' }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, prefetch: _prefetch, ...props }: { href: string; children: React.ReactNode; prefetch?: boolean }) =>
    <a {...props} href={href} onClick={event => { event.preventDefault(); mockNavigate(href); }}>{children}</a>,
}));

function ConnectedPatient({ patientId = subject, maxRetries = 2 }: { patientId?: string; maxRetries?: number }) {
  const { forecast, connectionStatus, error } = useRealtimeTelemetry(patientId, { maxRetries, baseDelayMs: 5, stableDurationMs: 0 });
  return (
    <>
      <NavigationRail active="patient" selectedSubjectId={patientId} />
      <h1>Patient dashboard</h1>
      <output data-testid="status">{connectionStatus}</output>
      <output data-testid="stream-error">{error?.message}</output>
      {forecast && <p>Forecast received for {forecast.subject.subject_id}</p>}
    </>
  );
}

function NavigationHarness({ evidence, maxRetries = 2 }: { evidence: React.ReactNode; maxRetries?: number }) {
  const [route, setRoute] = useState('/patients/' + subject);
  mockNavigate = setRoute;
  if (route === '/evidence') return evidence;
  if (route === '/cohort') return <div><h1>Cohort page</h1><a href={'/patients/' + subject} onClick={e => { e.preventDefault(); setRoute('/patients/' + subject); }}>Open Patient</a></div>;
  if (route === '/patients/' + subject2) return <ConnectedPatient patientId={subject2} maxRetries={maxRetries} />;
  return <ConnectedPatient patientId={subject} maxRetries={maxRetries} />;
}

describe('Connected patient to Evidence and Cohort cancellation lifecycle', () => {
  const originalFetch = Object.getOwnPropertyDescriptor(global, 'fetch');
  const originalDecoder = global.TextDecoder;
  const originalEncoder = global.TextEncoder;

  beforeEach(() => {
    global.TextDecoder = TextDecoder as typeof global.TextDecoder;
    global.TextEncoder = TextEncoder as typeof global.TextEncoder;
    Object.defineProperty(global, 'fetch', { configurable: true, writable: true, value: jest.fn() });
    (fs.readFile as jest.Mock).mockRejectedValue(Object.assign(new Error('Not evaluated'), { code: 'ENOENT' }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.TextDecoder = originalDecoder;
    global.TextEncoder = originalEncoder;
    if (originalFetch) Object.defineProperty(global, 'fetch', originalFetch); else Reflect.deleteProperty(global, 'fetch');
  });

  it('renders Evidence and consumes cancel rejection after aborting an active native stream, without reconnecting', async () => {
    const cancels: jest.SpyInstance[] = [];
    let signal!: AbortSignal;
    (fetch as jest.Mock).mockImplementation(async (_url: string, init: RequestInit) => {
      signal = init.signal!;
      const payload = { ...source, subject: { ...source.subject, subject_id: subject } };
      const packet = { event: 'forecast.updated', subject_id: subject, event_id: 'native-forecast', emitted_at: payload.generated_at, payload };
      const body = new NativeReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(packet) + '\n\n'));
          // Aborting fetch errors its body; cancel() then returns a rejected Promise.
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        }
      });
      const reader = body.getReader();
      cancels.push(jest.spyOn(reader, 'cancel'));
      return { ok: true, body: { getReader: () => reader } };
    });

    render(<NavigationHarness evidence={await EvidencePage()} />);
    await screen.findByText(`Forecast received for ${subject}`);
    expect(screen.getByTestId('status')).toHaveTextContent('connected');

    fireEvent.click(screen.getByRole('link', { name: 'Evidence', exact: true }));
    expect(await screen.findByRole('heading', { name: 'Evidence & validation' })).toBeInTheDocument();
    expect(screen.getByText('Not yet evaluated')).toBeInTheDocument();
    expect(signal.aborted).toBe(true);
    expect(cancels[0]).toHaveBeenCalledTimes(1);

    // Let native promise-rejection reporting and any erroneous retry scheduling run.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('stream-error')).not.toBeInTheDocument();
  });

  it('renders Cohort and consumes cancel rejection after aborting active stream without error', async () => {
    const cancels: jest.SpyInstance[] = [];
    let signal!: AbortSignal;
    (fetch as jest.Mock).mockImplementation(async (_url: string, init: RequestInit) => {
      signal = init.signal!;
      const payload = { ...source, subject: { ...source.subject, subject_id: subject } };
      const packet = { event: 'forecast.updated', subject_id: subject, event_id: 'native-forecast-cohort', emitted_at: payload.generated_at, payload };
      const body = new NativeReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(packet) + '\n\n'));
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        }
      });
      const reader = body.getReader();
      cancels.push(jest.spyOn(reader, 'cancel'));
      return { ok: true, body: { getReader: () => reader } };
    });

    render(<NavigationHarness evidence={<div>Evidence placeholder</div>} />);
    await screen.findByText(`Forecast received for ${subject}`);
    expect(screen.getByTestId('status')).toHaveTextContent('connected');

    fireEvent.click(screen.getByRole('link', { name: 'Cohort', exact: true }));
    expect(await screen.findByRole('heading', { name: 'Cohort page' })).toBeInTheDocument();
    expect(signal.aborted).toBe(true);
    expect(cancels[0]).toHaveBeenCalledTimes(1);

    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('switching subjects cleanly disposes previous active reader without delivering old events', async () => {
    (fetch as jest.Mock).mockImplementation(async (url: string, init: RequestInit) => {
      const isSub1 = url.includes(subject);
      const curSubject = isSub1 ? subject : subject2;
      const payload = { ...source, subject: { ...source.subject, subject_id: curSubject } };
      const packet = { event: 'forecast.updated', subject_id: curSubject, event_id: `ev-${curSubject}`, emitted_at: payload.generated_at, payload };
      const body = new NativeReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(packet) + '\n\n'));
          init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
        }
      });
      return { ok: true, body: { getReader: () => body.getReader() } };
    });

    render(<NavigationHarness evidence={<div>Evidence placeholder</div>} />);
    await screen.findByText(`Forecast received for ${subject}`);

    // Switch subject
    act(() => {
      mockNavigate('/patients/' + subject2);
    });

    await screen.findByText(`Forecast received for ${subject2}`);
    expect(screen.queryByText(`Forecast received for ${subject}`)).not.toBeInTheDocument();
  });

  it('ignores an in-flight fetch rejection caused by navigation, without scheduling retries', async () => {
    (fetch as jest.Mock).mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    render(<NavigationHarness evidence={await EvidencePage()} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('link', { name: 'Evidence', exact: true }));
    expect(await screen.findByRole('heading', { name: 'Evidence & validation' })).toBeInTheDocument();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['contract-invalid', 'contract-invalid'],
    ['HTTP 503', 'unavailable'],
    ['unexpected read failure', 'unavailable'],
    ['HTTP 404', 'patient-not-found'],
  ])('preserves the observable error for %s while the patient page is active', async (fault, expected) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    (fetch as jest.Mock).mockImplementation(async () => {
      if (fault.startsWith('HTTP')) return { ok: false, status: Number(fault.slice(5)) };
      const body = new NativeReadableStream<Uint8Array>({
        start(controller) {
          if (fault === 'contract-invalid') controller.enqueue(new TextEncoder().encode('data: {broken}\n\n'));
          else controller.error(new Error('unexpected socket failure'));
        }
      });
      return { ok: true, body: { getReader: () => body.getReader() } };
    });
    render(<NavigationHarness evidence={await EvidencePage()} maxRetries={0} />);
    await waitFor(() => expect(screen.getByTestId('stream-error')).toHaveTextContent(expected));
    expect(screen.getByTestId('status')).toHaveTextContent('disconnected');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

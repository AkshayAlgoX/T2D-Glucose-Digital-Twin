import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PatientWorkspace } from '../src/components/digital-twin/PatientWorkspace';
import { RiskStrip } from '../src/components/digital-twin/RiskStrip';
import type { SubjectStore } from '../src/lib/types';

// Presentation fixtures only; never application data or scientific evidence.
const empty: SubjectStore = { patientId: 'unit-subject', cgm: [], risk: [], alerts: [], dataQuality: [] };

it('keeps context, analysis, history and unavailable capabilities in a coherent reading sequence', () => {
  const { container } = render(<PatientWorkspace patientId="unit-subject" forecast={null} cache={empty} isConnected={false} isStale={false} />);
  const context = screen.getByRole('complementary', { name: 'Patient Identity' });
  const trajectory = screen.getByRole('region', { name: 'Glucose trajectory' });
  const risk = screen.getByRole('complementary', { name: 'Risk and model contributions' });
  const history = screen.getByRole('region', { name: 'Risk history' });
  const coverage = screen.getByRole('heading', { name: 'Data coverage' });
  const simulation = screen.getByRole('heading', { name: 'What-if simulation' });
  const disclaimer = screen.getByText('Research Only (Not for clinical decisions)');
  // Story order: forecast, risk, patient record, what-if, then history/coverage/provenance detail.
  // The disabled pinned-replay placeholder is no longer shown.
  expect(screen.queryByText('Pinned-time replay unavailable')).not.toBeInTheDocument();
  [trajectory, risk, context, simulation, history, coverage].forEach((element, index, elements) => {
    expect(element.compareDocumentPosition(elements[index + 1] ?? disclaimer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  expect(container.querySelector('.trajectory-panel .risk-history')).toBeNull();
  expect(container.querySelector('.insights-panel .data-availability')).toBeNull();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});

it('collapses mobile context without remounting analysis or losing its history selection when resized', () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  let compact = true;
  const listeners = new Set<() => void>();
  const query = {
    get matches() { return compact; },
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  };
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: jest.fn(() => query) });
  let unmount: (() => void) | undefined;
  try {
    const view = render(<PatientWorkspace patientId="unit-subject" forecast={null} cache={empty} isConnected={false} isStale={false} />);
    unmount = view.unmount;
    const details = view.container.querySelector('.patient-context')!;
    const trajectory = view.container.querySelector('.trajectory-panel');
    const history = view.container.querySelector('.risk-history');
    const risk = view.container.querySelector('.insights-panel');
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(details.querySelector('summary')!);
    expect(details).toHaveAttribute('open');
    fireEvent.click(details.querySelector('summary')!);
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(screen.getByRole('button', { name: 'Past 2h' }));
    act(() => { compact = false; listeners.forEach(listener => listener()); });
    expect(details).toHaveAttribute('open');
    expect(view.container.querySelector('.trajectory-panel')).toBe(trajectory);
    expect(view.container.querySelector('.risk-history')).toBe(history);
    expect(view.container.querySelector('.insights-panel')).toBe(risk);
    expect(screen.getByRole('button', { name: 'Past 2h' })).toHaveAttribute('aria-pressed', 'true');
    act(() => { compact = true; listeners.forEach(listener => listener()); });
    expect(details).not.toHaveAttribute('open');
    expect(screen.getAllByRole('heading', { name: 'What-if simulation' })).toHaveLength(1);
  } finally {
    unmount?.();
    if (descriptor) Object.defineProperty(window, 'matchMedia', descriptor);
    else Reflect.deleteProperty(window, 'matchMedia');
  }
  expect(listeners.size).toBe(0);
});

it('marks only received snapshots at their actual time/probability coordinates', () => {
  const risk = [
    { t: '2026-10-04T11:55:00Z', p: 0.123456 },
    { t: '2026-10-04T11:57:00Z', p: 0.456789 },
    { t: '2026-10-04T12:00:00Z', p: 0.234567 },
  ];
  const before = JSON.stringify(risk);
  risk.forEach(Object.freeze);
  Object.freeze(risk);
  render(<RiskStrip forecast={null} cache={{ ...empty, risk }} />);
  const markers = screen.getAllByTestId('risk-snapshot-marker');
  expect(markers).toHaveLength(risk.length);
  markers.forEach((marker, index) => {
    // Default 720 px width: plot x 40..710, y 128..10 on a fixed 0-100% scale.
    expect(Number(marker.getAttribute('cx'))).toBeCloseTo(40 + (Date.parse(risk[index].t) - Date.parse(risk[0].t)) / 300000 * 670);
    expect(Number(marker.getAttribute('cy'))).toBeCloseTo(128 - risk[index].p * 118);
    expect(marker.querySelector('title')?.textContent).toBe(`${risk[index].t} · onset probability ${risk[index].p}`);
  });
  expect(screen.getByText(/connecting steps are visual guides/)).toBeInTheDocument();
  expect(screen.getByText('35% reference')).toBeInTheDocument();
  expect(JSON.stringify(risk)).toBe(before);
});

it.each([
  { name: 'empty', risk: [] },
  { name: 'single', risk: [{ t: '2026-10-04T11:55:00Z', p: 0.123456 }] },
])('does not invent additional snapshots for $name history', ({ risk }) => {
  render(<RiskStrip forecast={null} cache={{ ...empty, risk }} />);
  expect(screen.queryAllByTestId('risk-snapshot-marker')).toHaveLength(0);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  if (risk.length) expect(screen.getByText('12.3%')).toBeInTheDocument();
  else expect(screen.getByText(/Historical risk is not backfilled/)).toBeInTheDocument();
});

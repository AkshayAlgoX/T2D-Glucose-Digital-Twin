import React from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { RiskStrip } from '../src/components/digital-twin/RiskStrip';
import { ScenarioEditor } from '../src/components/digital-twin/ScenarioEditor';
import type { SubjectStore } from '../src/lib/types';

// Presentation fixtures only; never used as patient data or scientific evidence.
const first = '2026-10-04T11:55:00Z';
const last = '2026-10-04T12:00:00Z';
function cache(risk: SubjectStore['risk'] = []): SubjectStore {
  return { patientId: 'unit-subject', cgm: [], risk, alerts: [], dataQuality: [] };
}

describe('Risk history plot density', () => {
  const originalObserver = global.ResizeObserver;
  let callback: ResizeObserverCallback;
  const observe = jest.fn();
  const disconnect = jest.fn();
  beforeEach(() => {
    observe.mockClear();
    disconnect.mockClear();
    global.ResizeObserver = class {
      constructor(handler: ResizeObserverCallback) { callback = handler; }
      observe = observe;
      disconnect = disconnect;
      unobserve = jest.fn();
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    cleanup();
    global.ResizeObserver = originalObserver;
  });
  function resize(width: number) {
    act(() => callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
  }

  // Simulated content-box sizes, not evidence of browser viewport rendering.
  it.each([934, 854, 678, 320])('uses the measured %i px content width without changing data', width => {
    const input = cache([
      { t: first, p: 0.123456 },
      { t: '2026-10-04T11:57:00Z', p: 0.456789 },
      { t: last, p: 0.234567 },
    ]);
    const before = JSON.stringify(input);
    input.risk.forEach(Object.freeze);
    Object.freeze(input.risk);
    const { container } = render(<RiskStrip forecast={null} cache={input} />);
    resize(width);
    const svg = screen.getByRole('img');
    // Drawn at the measured width without stretching (no preserveAspectRatio="none"), 150 px tall,
    // plot area x 40..width-10, y 10..128 on a fixed 0-100% scale.
    expect(svg).toHaveAttribute('viewBox', `0 0 ${width} 150`);
    expect(svg).toHaveAttribute('height', '150');
    expect(svg).not.toHaveAttribute('preserveAspectRatio');
    const reference = screen.getByTestId('risk-reference-line');
    expect(reference).toHaveAttribute('x1', '40');
    expect(reference).toHaveAttribute('x2', String(width - 10));
    expect(Number(reference.getAttribute('y1'))).toBeCloseTo(128 - 0.35 * 118);
    expect(Number(screen.getByTestId('risk-warning-line').getAttribute('y1'))).toBeCloseTo(128 - 0.6 * 118);
    const path = screen.getByTestId('risk-history-path');
    // d3 rounds display coordinates to three decimals, preserving source values.
    const y = (p: number) => Number((128 - p * 118).toFixed(3));
    const xm = Number((40 + (width - 50) * 0.4).toFixed(3));
    expect(path.getAttribute('d')).toBe(`M40,${y(input.risk[0].p)}L${xm},${y(input.risk[0].p)}L${xm},${y(input.risk[1].p)}L${width - 10},${y(input.risk[1].p)}L${width - 10},${y(input.risk[2].p)}`);
    expect(screen.getByTestId('risk-history-stats')).toHaveTextContent('Latest received23.5%');
    expect(screen.getByTestId('risk-history-stats')).toHaveTextContent('Highest in window45.7%');
    expect(Array.from(container.querySelectorAll('.history-time-labels time')).map(time => time.dateTime)).toEqual([first, last]);
    expect(screen.getByText('35% reference')).toBeInTheDocument();
    expect(JSON.stringify(input)).toBe(before);
  });

  it('keeps empty history explicit without drawing a fabricated trend', () => {
    render(<RiskStrip forecast={null} cache={cache()} />);
    expect(screen.getByText('No risk snapshots received. Historical risk is not backfilled.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('makes sparse, nearly identical snapshots readable without exaggerating their scale', () => {
    const input = cache([{ t: first, p: 0.35001 }, { t: last, p: 0.35002 }]);
    render(<RiskStrip forecast={null} cache={input} />);
    const table = screen.getByRole('table', { name: /Received observations/ });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getAllByRole('cell').map(cell => cell.getAttribute('title'))).toEqual([
      'Source probability: 0.35001', 'Source probability: 0.35002',
    ]);
    expect(Array.from(table.querySelectorAll('time')).map(time => time.dateTime)).toEqual([first, last]);
    expect(screen.getByText(/Fixed probability scale: 0–100%/)).toBeInTheDocument();
    const markers = screen.getAllByTestId('risk-snapshot-marker');
    expect(markers).toHaveLength(2);
    // Fixed 0-100% scale: a 0.00001 difference stays 0.00001 x 118 px, i.e. invisible, never stretched.
    expect(Math.abs(Number(markers[0].getAttribute('cy')) - Number(markers[1].getAttribute('cy')))).toBeLessThanOrEqual(0.00001 * 118 + 1e-6);
    expect(Number(screen.getByTestId('risk-reference-line').getAttribute('y1'))).toBeCloseTo(128 - 0.35 * 118);
  });

  it('keeps longer histories compact while retaining every actual observation in an accessible disclosure', () => {
    const risk = Array.from({ length: 6 }, (_, index) => ({
      t: new Date(Date.parse(first) + index * 60000).toISOString(), p: 0.2 + index * 0.01,
    }));
    const { container } = render(<RiskStrip forecast={null} cache={cache(risk)} />);
    const details = container.querySelector('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details.querySelector('summary')).toHaveTextContent('View all 6 received snapshots');
    expect(details.querySelectorAll('tbody tr')).toHaveLength(6);
    expect(Array.from(details.querySelectorAll('time')).map(time => time.dateTime)).toEqual(risk.map(point => point.t));
    expect(screen.getAllByTestId('risk-snapshot-marker')).toHaveLength(6);
  });

  it('shows the actual single snapshot probability and timestamp without inventing a line', () => {
    const { container } = render(<RiskStrip forecast={null} cache={cache([{ t: first, p: 0.123456 }])} />);
    expect(screen.getByText('1 received snapshot')).toBeInTheDocument();
    expect(screen.getByText('12.3%')).toBeInTheDocument();
    expect(container.querySelector('time')).toHaveAttribute('datetime', first);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('observes the persistent card before history arrives and cleans up on unmount', () => {
    const { rerender, unmount } = render(<RiskStrip forecast={null} cache={cache()} />);
    const element = observe.mock.calls[0][0];
    rerender(<RiskStrip forecast={null} cache={cache([{ t: first, p: 0.1 }, { t: last, p: 0.2 }])} />);
    expect(element.isConnected).toBe(true);
    expect(observe).toHaveBeenCalledTimes(1);
    resize(320);
    expect(screen.getByRole('img')).toHaveAttribute('viewBox', '0 0 320 150');
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

it('keeps the simulation honest before a forecast exists: no run, no fabricated output', () => {
  render(<ScenarioEditor patientId="unit-subject" />);
  expect(screen.getByText(/Simulated model response — not a validated causal treatment effect\./)).toBeInTheDocument();
  expect(screen.getByTestId('scenario-waiting')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Run simulation' })).toBeDisabled();
  screen.getAllByRole('button').forEach(button => expect(button).toBeDisabled());
  expect(screen.queryByTestId('scenario-result')).not.toBeInTheDocument();
});

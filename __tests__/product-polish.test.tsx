import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { SubjectIdentifier } from '../src/components/digital-twin/SubjectIdentifier';
import { ForecastCanvas } from '../src/components/digital-twin/ForecastCanvas';
import CohortPage from '../src/app/cohort/page';
import type { ForecastResponse } from '../src/types/forecast-response';
import type { SubjectStore } from '../src/lib/types';

jest.mock('next/navigation', () => ({ usePathname: () => '/cohort' }));
const id = '11111111-2222-4333-8444-555555555555';

describe('Full subject identity and clipboard feedback', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('reveals the complete ID on an accessible button and copies the untruncated ID', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<SubjectIdentifier subjectId={id} label="UNIT-1" />);
    expect(screen.getByText('11111111…5555')).toBeVisible();
    expect(screen.getByText(id)).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Show full subject ID for UNIT-1' }));
    expect(screen.getByText(id)).toBeVisible();
    expect(screen.getByRole('button', { name: /Hide full subject/ })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Copy full subject ID for UNIT-1' }));
    expect(await screen.findByText('Copied full ID')).toBeVisible();
    expect(writeText).toHaveBeenCalledWith(id);
  });

  it.each(['denied', 'missing'])('shows manual-copy recovery when the clipboard is %s', async kind => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: kind === 'missing' ? undefined : { writeText: jest.fn().mockRejectedValue(new Error('denied')) } });
    render(<SubjectIdentifier subjectId={id} label="UNIT-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Copy full subject/ }));
    expect(await screen.findByText(/Could not copy/)).toBeVisible();
    expect(screen.getByText(id)).toBeVisible();
    expect(screen.queryByText('Copied full ID')).not.toBeInTheDocument();
  });

  it('waits for clipboard completion and cannot report success for a replacement ID', async () => {
    let finish!: () => void;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise<void>(resolve => { finish = resolve; }) } });
    const { rerender } = render(<SubjectIdentifier subjectId={id} label="UNIT-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Copy full subject/ }));
    expect(screen.getByRole('button', { name: /Copy full subject/ })).toBeDisabled();
    expect(screen.queryByText('Copied full ID')).not.toBeInTheDocument();
    rerender(<SubjectIdentifier subjectId="replacement-subject" label="UNIT-2" />);
    await act(async () => finish());
    expect(screen.queryByText('Copied full ID')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy full subject.*UNIT-2/ })).toBeEnabled();
  });
});

describe('Copy button auto-reset timer', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('automatically restores the copy icon and label after ~1.75 s', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockResolvedValue(undefined) } });
    render(<SubjectIdentifier subjectId={id} label="UNIT-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Copy full subject/ }));
    expect(await screen.findByText('Copied full ID')).toBeVisible();
    act(() => { jest.advanceTimersByTime(1750); });
    expect(screen.queryByText('Copied full ID')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy full subject/ })).toBeEnabled();
  });

  it('restarts the reset timer on a repeated successful copy', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockResolvedValue(undefined) } });
    render(<SubjectIdentifier subjectId={id} label="UNIT-1" />);
    // First copy
    fireEvent.click(screen.getByRole('button', { name: /Copy full subject/ }));
    expect(await screen.findByText('Copied full ID')).toBeVisible();
    // Advance 1 second — still within the first timer window
    act(() => { jest.advanceTimersByTime(1000); });
    expect(screen.getByText('Copied full ID')).toBeVisible();
    // Second copy before reset fires — should restart the timer
    fireEvent.click(screen.getByRole('button', { name: /Copy full subject/ }));
    expect(await screen.findByText('Copied full ID')).toBeVisible();
    // Advance another 1 s — only 1 s into the *new* 1.75 s window
    act(() => { jest.advanceTimersByTime(1000); });
    expect(screen.getByText('Copied full ID')).toBeVisible();
    // Advance the remaining 0.75 s — restarted timer should now fire
    act(() => { jest.advanceTimersByTime(750); });
    expect(screen.queryByText('Copied full ID')).not.toBeInTheDocument();
  });

  it('does not show success feedback when the clipboard write fails', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockRejectedValue(new Error('denied')) } });
    render(<SubjectIdentifier subjectId={id} label="UNIT-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Copy full subject/ }));
    expect(await screen.findByText(/Could not copy/)).toBeVisible();
    act(() => { jest.advanceTimersByTime(2000); });
    // Timer must NOT have been set for failed state — failed message stays, no success
    expect(screen.queryByText('Copied full ID')).not.toBeInTheDocument();
    expect(screen.getByText(/Could not copy/)).toBeVisible();
  });

  it('clears any pending reset timer when the component unmounts', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockResolvedValue(undefined) } });
    const { unmount } = render(<SubjectIdentifier subjectId={id} label="UNIT-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Copy full subject/ }));
    expect(await screen.findByText('Copied full ID')).toBeVisible();
    // Unmount before the reset timer fires — should not throw or warn about setState on unmounted component
    act(() => { unmount(); });
    // Advance past the timer; no error should occur
    expect(() => { act(() => { jest.advanceTimersByTime(2000); }); }).not.toThrow();
  });
});



// Fixed presentation fixtures, never used as application data or model evidence.
const forecast = {
  as_of: '2026-10-04T12:00:00Z', current: { value_mg_dl: 125 },
  forecast: { horizon_min: 120, points: [
    { offset_min: 5, t: '2026-10-04T12:05:00Z', p05: 99.1, p10: 108.2, p50: 130.3, p90: 151.4, p95: 162.5 },
    { offset_min: 120, t: '2026-10-04T14:00:00Z', p05: 100, p10: 110, p50: 140, p90: 160, p95: 170 },
  ] },
} as ForecastResponse;
const cache = { patientId: id, cgm: [
  { t: '2026-10-04T11:50:12.345Z', value: 121.25, trend: 'flat' },
  { t: '2026-10-04T11:55:00Z', value: 123.5, trend: 'flat' },
], risk: [], alerts: [], dataQuality: [] } as SubjectStore;

describe('Observed and forecast inspection', () => {
  it('supports keyboard traversal, exact timestamps, quantiles, horizon, and Escape without changing source data', () => {
    const before = JSON.stringify({ forecast, cache });
    render(<ForecastCanvas forecast={forecast} cache={cache} />);
    const chart = screen.getByRole('img');
    fireEvent.focus(chart);
    let tooltip = within(screen.getByRole('tooltip'));
    expect(tooltip.getByText('121.25 mg/dL')).toBeVisible();
    // The exact source timestamp stays machine-readable; the visible time matches the axis.
    expect(tooltip.getByText('11:50 UTC')).toHaveAttribute('dateTime', '2026-10-04T11:50:12.345Z');
    expect(tooltip.queryByText('Forecast horizon')).not.toBeInTheDocument();
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    tooltip = within(screen.getByRole('tooltip'));
    expect(tooltip.getByText('Forecast · +5 min')).toBeVisible();
    expect(tooltip.getByText('130.3 mg/dL')).toBeVisible();
    expect(tooltip.getByText('108.2–151.4 mg/dL')).toBeVisible();
    expect(tooltip.getByText('99.1–162.5 mg/dL')).toBeVisible();
    expect(tooltip.queryByText('Forecast horizon')).not.toBeInTheDocument();
    fireEvent.keyDown(chart, { key: 'End' });
    expect(within(screen.getByRole('tooltip')).getByText('14:00 UTC')).toHaveAttribute('dateTime', '2026-10-04T14:00:00Z');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(within(screen.getByRole('tooltip')).getByText('Observed CGM')).toBeVisible();
    expect(JSON.stringify({ forecast, cache })).toBe(before);
  });

  it('handles observations with no forecast and labels missing quantiles as unavailable', () => {
    const { rerender } = render(<ForecastCanvas forecast={{ ...forecast, forecast: null } as ForecastResponse} cache={cache} />);
    fireEvent.keyDown(screen.getByRole('img'), { key: 'Home' });
    expect(within(screen.getByRole('tooltip')).getByText('121.25 mg/dL')).toBeVisible();
    rerender(<ForecastCanvas forecast={{ ...forecast, forecast: { points: [{ offset_min: 5, p50: 130.3 }] } } as ForecastResponse} cache={cache} />);
    fireEvent.keyDown(screen.getByRole('img'), { key: 'End' });
    expect(within(screen.getByRole('tooltip')).getAllByText('Unavailable')).toHaveLength(2);
  });

  it('inspects both sides with a pointer and dismisses until pointer re-entry', () => {
    const original = window.PointerEvent;
    window.PointerEvent = MouseEvent as typeof PointerEvent;
    try {
      const { container } = render(<ForecastCanvas forecast={forecast} cache={cache} />);
      const chart = screen.getByRole('img');
      jest.spyOn(chart, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 380 } as DOMRect);
      fireEvent.pointerMove(chart, { clientX: 100 });
      expect(within(screen.getByRole('tooltip')).getByText('Observed CGM')).toBeVisible();
      fireEvent.pointerMove(chart, { clientX: 780 });
      expect(within(screen.getByRole('tooltip')).getByText('Forecast · +120 min')).toBeVisible();
      fireEvent.pointerEnter(screen.getByRole('tooltip'));
      expect(screen.getByRole('tooltip')).toBeVisible();
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.pointerMove(chart, { clientX: 780 });
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      fireEvent.pointerLeave(container.querySelector('.forecast-plot')!);
      fireEvent.pointerMove(chart, { clientX: 780 });
      expect(screen.getByRole('tooltip')).toBeVisible();
      fireEvent.pointerLeave(container.querySelector('.forecast-plot')!);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    } finally { window.PointerEvent = original; }
  });

  it('clears inspection when its observed window hides the selected point', () => {
    const old = { ...cache, cgm: [{ t: '2026-10-04T08:00:00Z', value: 110, trend: 'flat' }] };
    render(<ForecastCanvas forecast={forecast} cache={old} />);
    fireEvent.keyDown(screen.getByRole('img'), { key: 'Home' });
    expect(screen.getByRole('tooltip')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Past 2h' }));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

it('uses placeholders only while the real directory request is pending', async () => {
  const original = global.fetch;
  let resolve!: (response: Response) => void;
  global.fetch = jest.fn(() => new Promise<Response>(finish => { resolve = finish; }));
  try {
    const { container } = render(<CohortPage />);
    expect(screen.getByText(/Loading subject directory/)).toBeInTheDocument();
    expect(container.querySelectorAll('.directory-loading-row')).toHaveLength(12);
    expect(screen.queryByRole('link', { name: /Open subject/ })).not.toBeInTheDocument();
    await act(async () => resolve({ ok: true, json: async () => [{ subject_id: id, patient_id: 'UNIT-1' }] } as Response));
    expect(container.querySelector('.directory-loading')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open subject UNIT-1' })).toHaveAttribute('href', '/patients/' + id);
  } finally { global.fetch = original; }
});

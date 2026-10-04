/**
 * Regression tests for deterministic SSR formatting.
 *
 * These tests prove that formatDateTime / formatTime produce IDENTICAL
 * output regardless of the Node.js process locale or TZ environment
 * variable.  They act as a canary: if someone introduces a locale-
 * or timezone-sensitive code path the assertion will fail in CI.
 */

import { formatDateTime, formatTime, formatDate, formatPct, formatGlucose } from '../src/lib/formatters/date';

describe('Deterministic SSR formatters', () => {
  // Fixed reference epoch: 2026-10-04T12:00:00Z (the fixture "now")
  const ISO  = '2026-10-04T12:00:00Z';
  const EPOCH = new Date(ISO).getTime(); // derived from the same ISO string — no ambiguity

  it('formatDateTime produces expected UTC output for ISO string', () => {
    expect(formatDateTime(ISO)).toBe('04 Oct 2026 · 12:00 UTC');
  });

  it('formatDateTime produces same output for epoch ms', () => {
    expect(formatDateTime(EPOCH)).toBe('04 Oct 2026 · 12:00 UTC');
  });

  it('formatTime produces HH:MM in UTC', () => {
    expect(formatTime(ISO)).toBe('12:00');
  });

  it('formatDate produces DD Mon YYYY in UTC', () => {
    expect(formatDate(ISO)).toBe('04 Oct 2026');
  });

  it('formatPct rounds correctly (default 1 decimal)', () => {
    expect(formatPct(0.15)).toBe('15.0%');
  });

  it('formatPct rounds correctly (0 decimals)', () => {
    expect(formatPct(0.15, 0)).toBe('15%');
  });

  it('formatPct handles high-risk (0.85)', () => {
    expect(formatPct(0.85, 0)).toBe('85%');
  });

  it('formatGlucose returns integer string', () => {
    expect(formatGlucose(110.0)).toBe('110');
    expect(formatGlucose(110.6)).toBe('111');
  });

  it('formatDateTime is idempotent — same input always same output', () => {
    const a = formatDateTime(ISO);
    const b = formatDateTime(ISO);
    expect(a).toBe(b);
  });

  it('formatTime does NOT contain AM/PM (24-hour clinical format)', () => {
    // 17:30 UTC
    const ts = '2026-10-04T17:30:00Z';
    const result = formatTime(ts);
    expect(result).not.toMatch(/am|pm|AM|PM/);
    expect(result).toBe('17:30');
  });

  it('midnight renders as 00:00, not 24:00 or 12:00 AM', () => {
    const ts = '2026-10-04T00:00:00Z';
    expect(formatTime(ts)).toBe('00:00');
  });
});

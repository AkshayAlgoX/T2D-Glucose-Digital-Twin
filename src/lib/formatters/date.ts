/**
 * Deterministic date/time formatters for SSR-safe rendering.
 *
 * RULES:
 * - Every function accepts an ISO timestamp or epoch ms.
 * - Every function passes an explicit locale ('en-GB') and explicit
 *   timeZone ('UTC') to Intl.DateTimeFormat.
 * - Output is IDENTICAL on the Node.js server and in every browser
 *   regardless of machine locale or system timezone.
 * - NEVER call .toLocaleString() / .toLocaleDateString() /
 *   .toLocaleTimeString() without the explicit options exported here.
 * - NEVER use these formatters with a value derived from Date.now()
 *   or new Date() (no args) during the render phase — those are
 *   non-deterministic on SSR.  Timestamp inputs must come from
 *   server-supplied data (forecast.as_of, cache entries, etc.).
 */

const LOCALE = 'en-GB';     // 24-hour, day-first — clinical standard
const TZ     = 'UTC';       // All times displayed as UTC; no TZ ambiguity

/**
 * "04 Oct 2026 · 17:30 UTC"
 * Primary timestamp shown in clinical readouts and accessibility text.
 */
export function formatDateTime(isoOrEpoch: string | number): string {
  const d = typeof isoOrEpoch === 'number' ? new Date(isoOrEpoch) : new Date(isoOrEpoch);
  const date = new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit', month: 'short', year: 'numeric',
    timeZone: TZ,
  }).format(d);
  const time = new Intl.DateTimeFormat(LOCALE, {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: TZ,
  }).format(d);
  return `${date} · ${time} UTC`;
}

/**
 * "17:30" — compact HH:MM for axis labels and now-bar.
 */
export function formatTime(isoOrEpoch: string | number): string {
  const d = typeof isoOrEpoch === 'number' ? new Date(isoOrEpoch) : new Date(isoOrEpoch);
  return new Intl.DateTimeFormat(LOCALE, {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: TZ,
  }).format(d);
}

/**
 * "04 Oct 2026" — date-only for headers.
 */
export function formatDate(isoOrEpoch: string | number): string {
  const d = typeof isoOrEpoch === 'number' ? new Date(isoOrEpoch) : new Date(isoOrEpoch);
  return new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit', month: 'short', year: 'numeric',
    timeZone: TZ,
  }).format(d);
}

/**
 * Percent with explicit decimal places. Never locale-dependent.
 * formatPct(0.152)   → "15.2%"
 * formatPct(0.152,0) → "15%"
 */
export function formatPct(fraction: number, decimals = 1): string {
  return `${(fraction * 100).toFixed(decimals)}%`;
}

/**
 * Clinical glucose value: always integer, no locale separator.
 * formatGlucose(110.0) → "110"
 */
export function formatGlucose(value: number): string {
  return Math.round(value).toString();
}

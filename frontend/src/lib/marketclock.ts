import { useEffect, useState } from 'react';
import type { ExchangeStatus } from './api';

/**
 * Live market-clock helpers. The server hands us an absolute `nextChangeAt`
 * instant; the client ticks a HH:MM:SS countdown toward it once a second,
 * correcting for any client/server clock skew so the number stays honest even
 * on a badly-set machine.
 */

/** Re-render every `ms` (default 1s). Returns the current client epoch (ms). */
export function useTicker(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Client→server clock skew in ms, derived from the server's own timestamp at
 * reply time vs. the client clock when the response landed (`dataUpdatedAt`).
 * Adding this to `Date.now()` yields the estimated server-now.
 */
export function clockSkewMs(serverNowUtc: string | undefined, dataUpdatedAt: number): number {
  if (!serverNowUtc || !dataUpdatedAt) return 0;
  const server = Date.parse(serverNowUtc);
  if (Number.isNaN(server)) return 0;
  return server - dataUpdatedAt;
}

/** Whole seconds remaining until `nextChangeAt`, floored at 0, skew-corrected. */
export function secondsUntil(nextChangeAt: string, nowMs: number, skewMs = 0): number {
  const target = Date.parse(nextChangeAt);
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.floor((target - (nowMs + skewMs)) / 1000));
}

/** `HH:MM:SS`, or `Nd HH:MM:SS` past a day. */
export function fmtCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  const clock = `${p(hh)}:${p(mm)}:${p(ss)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

const _tzFmt = new Map<string, Intl.DateTimeFormat>();

/** Current wall-clock time in an exchange's own timezone, `HH:MM:SS`. */
export function liveLocalTime(tz: string, nowMs: number): string {
  let fmt = _tzFmt.get(tz);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    } catch {
      fmt = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    }
    _tzFmt.set(tz, fmt);
  }
  return fmt.format(new Date(nowMs));
}

/** Everything a live view needs for one exchange, recomputed each tick. */
export function liveExchange(ex: ExchangeStatus, nowMs: number, skewMs = 0) {
  const remaining = secondsUntil(ex.nextChangeAt, nowMs, skewMs);
  return {
    remaining,
    countdown: fmtCountdown(remaining),
    localTime: liveLocalTime(ex.tz, nowMs),
    /** Client-corrected open/closed: flips the instant the countdown hits 0. */
    isOpen: remaining <= 0 ? !ex.isOpen : ex.isOpen,
  };
}

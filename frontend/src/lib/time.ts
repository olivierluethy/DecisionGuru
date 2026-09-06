/** Time helpers for the Alerts feed — relative time and calendar bucketing at day / week /
 *  month / year granularity. Lifted out of Alerts.tsx so the feed can group and index at any
 *  zoom level from one source of truth. */

/** Parse the API's timestamps, which arrive either ISO-Z or as naive UTC "YYYY-MM-DD HH:MM:SS". */
export function parseTs(iso: string): number {
  return new Date(iso.includes('Z') || iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime();
}

/** Compact relative time: "just now", "5m ago", "3h ago", "2d ago". */
export function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - parseTs(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** A coarse "time until" for the next scheduled scan: "42m", "3h", "3h 10m", or "soon". */
export function until(ms: number): string {
  if (ms <= 0) return 'soon';
  const mins = Math.round(ms / 60_000); // round to minutes first, then split (no "5h 60m")
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h <= 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export type Granularity = 'day' | 'week' | 'month' | 'year';

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  const mondayOffset = (s.getDay() + 6) % 7; // week starts Monday
  s.setDate(s.getDate() - mondayOffset);
  return s;
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The calendar bucket an item falls in, for the chosen granularity. Returns a stable `key`
 * (for grouping and anchors), a human `label` (section heading) and a `short` label (pills).
 * The two most recent buckets read as words ("Today"/"Yesterday", "This week"/"Last week",
 * …); older ones read as dates.
 */
export function bucketOf(iso: string, g: Granularity, now = new Date()): { key: string; label: string; short: string } {
  const d = new Date(parseTs(iso));

  if (g === 'day') {
    const startNow = startOfDay(now).getTime();
    const days = Math.round((startNow - startOfDay(d).getTime()) / 86_400_000);
    const key = ymd(d);
    if (days <= 0) return { key, label: 'Today', short: 'Today' };
    if (days === 1) return { key, label: 'Yesterday', short: 'Yest.' };
    if (days < 7) {
      return {
        key,
        label: d.toLocaleDateString(undefined, { weekday: 'long' }),
        short: d.toLocaleDateString(undefined, { weekday: 'short' }),
      };
    }
    const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    return { key, label: date, short: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) };
  }

  if (g === 'week') {
    const ws = startOfWeek(d);
    const weeks = Math.round((startOfWeek(now).getTime() - ws.getTime()) / (7 * 86_400_000));
    const key = `w${ymd(ws)}`;
    if (weeks <= 0) return { key, label: 'This week', short: 'This wk' };
    if (weeks === 1) return { key, label: 'Last week', short: 'Last wk' };
    const wl = `Week of ${ws.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
    return { key, label: wl, short: ws.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) };
  }

  if (g === 'month') {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    if (months <= 0) return { key, label: 'This month', short: 'This mo' };
    if (months === 1) return { key, label: 'Last month', short: 'Last mo' };
    const ml = d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    return { key, label: ml, short: d.toLocaleDateString(undefined, { month: 'short' }) };
  }

  const y = String(d.getFullYear());
  return { key: y, label: y, short: y };
}

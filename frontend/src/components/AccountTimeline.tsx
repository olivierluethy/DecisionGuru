import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Coins, Receipt, TrendingUp, TrendingDown, ZoomIn, ZoomOut, Maximize2, Expand } from 'lucide-react';
import clsx from 'clsx';
import type { TimelineEvent, TimelineKind } from '../lib/api';
import { fmtCHFSigned, fmtDate, plClass } from '../lib/format';

/**
 * Horizontal, zoomable, pannable account timeline. Every buy / sale / cash
 * event is placed date-proportionally along one axis and drawn as a lollipop —
 * money-in above the axis, money-out below, stem length scaled by magnitude —
 * so hundreds of events stay legible. Scroll to zoom (anchored on the cursor),
 * drag to pan; each marker is inspectable at its point in time. Distinct from
 * the vertical event feed: this is the account's shape over time.
 */

const DAY = 86_400_000;

const KIND_META: Record<TimelineKind, { label: string; color: string; Icon: typeof Coins }> = {
  deposit: { label: 'Deposit', color: 'var(--azure)', Icon: ArrowDownToLine },
  buy: { label: 'Buy', color: 'rgba(61,169,252,0.6)', Icon: TrendingUp },
  sell: { label: 'Sell', color: 'var(--gold)', Icon: TrendingDown },
  dividend: { label: 'Dividend', color: 'var(--gain)', Icon: Coins },
  fee: { label: 'Fee', color: 'var(--loss)', Icon: Receipt },
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 60;
const TOP = 108; // px, the axis baseline; money-in above, money-out below
const STEM_MAX = 84;
const STEM_MIN = 7;
const BOTTOM_PAD = 30; // room for the date-scale labels

type Tick = { ms: number; label: string };

function niceTicks(minMs: number, maxMs: number, trackW: number): Tick[] {
  const spanDays = Math.max(1, (maxMs - minMs) / DAY);
  const pxPerDay = trackW / spanDays;
  // smallest step whose on-screen spacing clears ~82px
  const steps: Array<[string, number]> = [
    ['day', 1], ['week', 7], ['month', 30], ['quarter', 91],
    ['halfyear', 182], ['year', 365], ['5year', 1825],
  ];
  let kind = 'year';
  for (const [k, d] of steps) {
    if (d * pxPerDay >= 82) { kind = k; break; }
  }
  const ticks: Tick[] = [];
  const monLabel = (ms: number, withYear: boolean) =>
    new Intl.DateTimeFormat('en-GB', { month: 'short', year: withYear ? '2-digit' : undefined, timeZone: 'UTC' }).format(new Date(ms));
  const dayLabel = (ms: number) =>
    new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(ms));
  const yearLabel = (ms: number) => new Date(ms).getUTCFullYear().toString();

  if (kind === 'day' || kind === 'week') {
    const step = (kind === 'day' ? 1 : 7) * DAY;
    const start = Math.ceil(minMs / step) * step;
    for (let t = start; t <= maxMs; t += step) ticks.push({ ms: t, label: dayLabel(t) });
  } else {
    const monthsPer = kind === 'month' ? 1 : kind === 'quarter' ? 3 : kind === 'halfyear' ? 6 : kind === 'year' ? 12 : 60;
    const d0 = new Date(minMs);
    let y = d0.getUTCFullYear();
    let m = Math.floor(d0.getUTCMonth() / monthsPer) * monthsPer;
    for (let i = 0; i < 400; i++) {
      const ms = Date.UTC(y, m, 1);
      if (ms > maxMs) break;
      if (ms >= minMs) {
        const label = monthsPer >= 12 ? yearLabel(ms) : monLabel(ms, m === 0);
        ticks.push({ ms, label });
      }
      m += monthsPer;
      if (m >= 12) { y += Math.floor(m / 12); m %= 12; }
    }
  }
  return ticks;
}

export function AccountTimeline({
  events,
  height: heightProp,
  onExpand,
}: {
  events: TimelineEvent[];
  /** Override the track height (e.g. taller inside a modal). */
  height?: number;
  /** When provided, show an expand button that opens the timeline larger. */
  onExpand?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<{ ev: TimelineEvent; left: number; top: number } | null>(null);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const model = useMemo(() => {
    const pts = events
      .filter((e) => e.date)
      .map((e) => ({ e, ms: Date.parse(`${e.date}T00:00:00Z`) }))
      .filter((p) => Number.isFinite(p.ms));
    if (!pts.length) return null;
    const msVals = pts.map((p) => p.ms);
    let min = Math.min(...msVals);
    let max = Math.max(...msVals, Date.now());
    // pad the domain by ~3% each side so edge markers aren't clipped
    const pad = Math.max((max - min) * 0.03, DAY * 3);
    min -= pad;
    max += pad;
    const maxMag = Math.max(1, ...pts.map((p) => Math.abs(p.e.amountCHF || 0)));
    return { pts, min, max, maxMag };
  }, [events]);

  if (!model) {
    return <div className="text-sm text-text-faint py-6 text-center">No dated events yet.</div>;
  }

  const { pts, min, max, maxMag } = model;
  const trackW = Math.max(viewW, viewW * zoom);
  const height = heightProp ?? TOP + STEM_MAX + BOTTOM_PAD;
  const xOf = (ms: number) => ((ms - min) / (max - min)) * trackW;
  const stemLen = (amt: number) =>
    Math.abs(amt) < 1 ? STEM_MIN : STEM_MIN + (STEM_MAX - STEM_MIN) * Math.sqrt(Math.abs(amt) / maxMag);
  const ticks = viewW ? niceTicks(min, max, trackW) : [];
  const nowX = xOf(Date.now());

  const applyZoom = (next: number, anchorX: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    const oldW = Math.max(viewW, viewW * zoom);
    const frac = (el.scrollLeft + anchorX) / oldW;
    const newW = Math.max(viewW, viewW * clamped);
    setZoom(clamped);
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollLeft = frac * newW - anchorX;
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!scrollRef.current) return;
    e.preventDefault();
    const rect = scrollRef.current.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    applyZoom(zoom * factor, e.clientX - rect.left);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!scrollRef.current) return;
    drag.current = { x: e.clientX, left: scrollRef.current.scrollLeft, moved: false };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !scrollRef.current) return;
    const dx = e.clientX - drag.current.x;
    if (Math.abs(dx) > 3) drag.current.moved = true;
    scrollRef.current.scrollLeft = drag.current.left - dx;
  };
  const onPointerUp = () => { drag.current = null; };

  const zoomButton = (dir: 1 | -1) => applyZoom(zoom * (dir > 0 ? 1.6 : 1 / 1.6), viewW / 2);

  return (
    <div ref={wrapRef} className="relative select-none">
      <div
        ref={scrollRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        className={clsx('relative overflow-x-auto overflow-y-hidden overscroll-x-contain',
          drag.current ? 'cursor-grabbing' : 'cursor-grab')}
        style={{ height }}
      >
        <div className="relative" style={{ width: trackW, height }}>
          {/* date-scale gridlines + labels */}
          {ticks.map((t) => {
            const x = xOf(t.ms);
            return (
              <div key={t.ms} className="absolute top-0 bottom-0" style={{ left: x }} aria-hidden>
                <div className="absolute top-0 w-px bg-hairline/60" style={{ height: TOP + STEM_MAX }} />
                <div className="absolute font-mono text-[10px] text-text-faint tnum whitespace-nowrap"
                     style={{ left: 4, top: height - BOTTOM_PAD + 8 }}>
                  {t.label}
                </div>
              </div>
            );
          })}

          {/* the axis */}
          <div className="absolute left-0 right-0 h-px bg-hairline-strong" style={{ top: TOP }} aria-hidden />

          {/* now marker */}
          {nowX >= 0 && nowX <= trackW && (
            <div className="absolute" style={{ left: nowX, top: 0, height: TOP + STEM_MAX }} aria-hidden>
              <div className="absolute top-0 bottom-0 w-px bg-azure/40" />
              <div className="absolute -translate-x-1/2 top-0 eyebrow text-azure/70">now</div>
            </div>
          )}

          {/* events */}
          {pts.map((p, i) => {
            const meta = KIND_META[p.e.kind];
            const x = xOf(p.ms);
            const up = (p.e.amountCHF || 0) >= 0;
            const len = stemLen(p.e.amountCHF || 0);
            const dotY = up ? TOP - len : TOP + len;
            return (
              <div
                key={`${p.e.date}-${p.e.kind}-${i}`}
                className="absolute"
                style={{ left: x, top: 0 }}
                onMouseEnter={(ev) => {
                  const wrap = wrapRef.current?.getBoundingClientRect();
                  if (!wrap) return;
                  setHover({ ev: p.e, left: ev.clientX - wrap.left, top: dotY });
                }}
                onMouseLeave={() => setHover(null)}
              >
                {/* stem */}
                <div
                  className="absolute w-px -translate-x-1/2"
                  style={{
                    left: 0,
                    top: up ? dotY : TOP,
                    height: len,
                    background: meta.color,
                    opacity: 0.45,
                  }}
                />
                {/* dot */}
                <div
                  className="absolute rounded-full -translate-x-1/2 -translate-y-1/2 border border-bg hover:scale-150 transition-transform"
                  style={{ left: 0, top: dotY, width: 8, height: 8, background: meta.color }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* controls */}
      <div className="absolute top-2 right-2 z-20 flex items-center gap-1">
        <button type="button" className="tl-btn" title="Zoom out" onClick={() => zoomButton(-1)} disabled={zoom <= MIN_ZOOM + 1e-6}>
          <ZoomOut size={14} />
        </button>
        <button type="button" className="tl-btn" title="Zoom in" onClick={() => zoomButton(1)} disabled={zoom >= MAX_ZOOM - 1e-6}>
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          className="tl-btn"
          title="Fit all events"
          disabled={Math.abs(zoom - MIN_ZOOM) < 1e-6}
          onClick={() => {
            setZoom(MIN_ZOOM);
            setHover(null);
            if (scrollRef.current) scrollRef.current.scrollLeft = 0;
          }}
        >
          <Maximize2 size={14} />
        </button>
        {onExpand && (
          <button type="button" className="tl-btn" title="Open larger" onClick={onExpand}>
            <Expand size={14} />
          </button>
        )}
      </div>

      {/* legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px] text-text-muted">
        {(Object.keys(KIND_META) as TimelineKind[]).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: KIND_META[k].color }} />
            {KIND_META[k].label}
          </span>
        ))}
        <span className="ml-auto text-text-faint">scroll to zoom · drag to pan</span>
      </div>

      {/* hover tooltip */}
      {hover && (
        <div
          className="pointer-events-none absolute z-20 min-w-[180px] max-w-[260px] rounded border border-hairline bg-surface-2 px-3 py-2 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.7)]"
          style={{
            left: Math.min(Math.max(hover.left - 90, 4), (wrapRef.current?.clientWidth ?? 0) - 184),
            top: hover.top > TOP ? hover.top + 14 : Math.max(hover.top - 74, 2),
          }}
        >
          <div className="flex items-center gap-1.5 mb-1">
            {(() => { const M = KIND_META[hover.ev.kind].Icon; return <M size={12} className="text-text-faint" />; })()}
            <span className="eyebrow">{KIND_META[hover.ev.kind].label}</span>
            <span className="ml-auto font-mono text-[10px] text-text-faint tnum">{fmtDate(hover.ev.date)}</span>
          </div>
          <div className="text-[13px] text-text leading-snug mb-1">{hover.ev.title}</div>
          <div className={clsx('font-mono tnum text-sm', plClass(hover.ev.amountCHF))}>
            {fmtCHFSigned(hover.ev.amountCHF)}
          </div>
        </div>
      )}
    </div>
  );
}

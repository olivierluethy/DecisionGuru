import { useRef, useState } from 'react';
import { ArrowDownToLine, Coins, Receipt, TrendingUp, TrendingDown } from 'lucide-react';
import clsx from 'clsx';
import type { TimelineEvent, TimelineKind } from '../lib/api';
import { fmtCHFSigned, fmtDate, plClass } from '../lib/format';

const KIND_META: Record<TimelineKind, { label: string; dot: string; Icon: typeof Coins }> = {
  deposit: { label: 'Deposit', dot: 'bg-azure', Icon: ArrowDownToLine },
  buy: { label: 'Buy', dot: 'bg-azure/60', Icon: TrendingUp },
  sell: { label: 'Sell', dot: 'bg-gold', Icon: TrendingDown },
  dividend: { label: 'Dividend', dot: 'bg-gain', Icon: Coins },
  fee: { label: 'Fee', dot: 'bg-loss', Icon: Receipt },
};

/**
 * Vertical, scrollable, drag-to-scroll chronological feed of account + trade events
 * built from both source files. Newest first. Cash-flow amounts are signed
 * (+ money in / − money out); colour follows the sign like every other figure.
 */
export function Timeline({ events }: { events: TimelineEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onDown = (e: React.MouseEvent) => {
    if (!ref.current) return;
    drag.current = { y: e.clientY, top: ref.current.scrollTop };
    setDragging(true);
  };
  const onMove = (e: React.MouseEvent) => {
    if (!drag.current || !ref.current) return;
    ref.current.scrollTop = drag.current.top - (e.clientY - drag.current.y);
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  if (events.length === 0) {
    return <div className="text-sm text-text-faint py-6 text-center">No dated events yet.</div>;
  }

  let lastDate = '';
  return (
    <div
      ref={ref}
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      className={clsx(
        'relative max-h-[440px] overflow-y-auto pr-1 select-none',
        dragging ? 'cursor-grabbing' : 'cursor-grab',
      )}
    >
      {/* the rail */}
      <div className="absolute left-[7px] top-2 bottom-2 w-px bg-hairline" aria-hidden />
      <ul className="space-y-1">
        {events.map((e, i) => {
          const m = KIND_META[e.kind];
          const showDate = e.date !== lastDate;
          lastDate = e.date;
          return (
            <li key={`${e.date}-${e.kind}-${i}`} className="relative pl-7">
              <span
                className={clsx(
                  'absolute left-0 top-[7px] w-[15px] h-[15px] rounded-full border-2 border-bg',
                  m.dot,
                )}
                aria-hidden
              />
              <div className="flex items-baseline justify-between gap-3 py-1.5">
                <div className="min-w-0">
                  {showDate && (
                    <div className="font-mono text-[11px] text-text-faint tnum mb-0.5">
                      {fmtDate(e.date)}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <m.Icon size={13} className="text-text-faint shrink-0" />
                    <span className="text-sm text-text truncate">{e.title}</span>
                  </div>
                </div>
                <div className={clsx('font-mono tnum text-sm shrink-0', plClass(e.amountCHF))}>
                  {fmtCHFSigned(e.amountCHF)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

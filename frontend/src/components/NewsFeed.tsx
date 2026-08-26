import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api } from '../lib/api';
import { Spinner } from './ui';

function ago(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '';
  const mins = Math.max(0, Math.round((Date.now() - d) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Per-ticker headline feed (Yahoo RSS, cached server-side). */
export function NewsFeed({ symbol, limit = 8 }: { symbol: string; limit?: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['news', symbol, limit],
    queryFn: () => api.news(symbol, limit),
    enabled: !!symbol,
  });

  if (isLoading) return <Spinner label="Loading news…" />;
  const items = data?.items ?? [];
  if (!items.length) {
    return <div className="text-sm text-text-faint py-6 text-center">No recent headlines for {symbol}.</div>;
  }

  return (
    <ul className="flex flex-col divide-y divide-hairline">
      {items.map((n) => (
        <li key={n.id} className="py-2.5">
          <a
            href={n.link ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="group flex items-start gap-2"
          >
            <span className="flex-1 text-sm text-text group-hover:text-azure transition-colors leading-snug">
              {n.title}
            </span>
            <ExternalLink size={13} className="text-text-faint mt-0.5 shrink-0 group-hover:text-azure" />
          </a>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-text-faint">
            <span>{n.publisher ?? 'Yahoo Finance'}</span>
            {n.publishedAt && <span>· {ago(n.publishedAt)}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

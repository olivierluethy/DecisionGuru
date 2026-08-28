import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Copy, Check, Building2, Info } from 'lucide-react';
import { api, type Listing } from '../lib/api';

/**
 * The exchange & currency read for an opportunity (§9e). Detects every known listing of the
 * company and shows the one line to buy for the investor's configured base currency — its
 * exchange, exact exchange-specific ticker, trading currency and a plain "why this exchange"
 * line — with a one-click copy and the labelled alternatives beneath so two listings of the
 * same company can't be confused. Degrades gracefully: a single known listing shows without
 * ceremony; missing cross-listing data is stated, never fabricated.
 */
export function ListingRecommendation({ symbol, name }: { symbol: string; name?: string | null }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['listings', symbol],
    queryFn: () => api.listings(symbol, name),
    staleTime: 60 * 60 * 1000, // resolved listings barely change; the server caches a week
  });

  if (isLoading) {
    return (
      <div className="text-[12px] text-text-faint flex items-center gap-2">
        <Building2 size={13} /> Resolving exchange listings…
      </div>
    );
  }

  // Network / resolver failure — show the name as-is with a copy, note the gap. Never invent.
  if (isError || !data) {
    return (
      <div className="border-l-2 border-l-hairline-strong pl-4 py-1">
        <div className="eyebrow mb-2">Listing</div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-text text-[15px]">{symbol}</span>
          <CopyTicker ticker={symbol} />
        </div>
        <p className="text-[12px] text-text-faint mt-2">
          Couldn't load alternative listings just now — showing the primary line.
        </p>
      </div>
    );
  }

  const { recommended, alternatives, base, currencyMatch, singleListing, crossListingAvailable } = data;

  // One known listing — no recommendation ceremony, just the ticker.
  if (singleListing) {
    return (
      <div className="border-l-2 border-l-hairline-strong pl-4 py-1">
        <div className="eyebrow mb-2">Listing</div>
        <ListingLine listing={recommended} emphasise />
        <p className="text-[12px] text-text-faint mt-2">
          {crossListingAvailable
            ? 'No other exchange listings were found for this company.'
            : "Cross-listing data wasn't available — showing the primary line only."}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className={clsx('border-l-2 pl-4 py-1', currencyMatch ? 'border-l-gain' : 'border-l-hairline-strong')}>
        <div className="eyebrow mb-2">Recommended for your {base} portfolio</div>
        <ListingLine listing={recommended} emphasise highlightCurrency={currencyMatch} />
        <p className="text-[13px] text-text-muted mt-2 leading-relaxed tnum flex gap-1.5">
          <Info size={13} className="shrink-0 mt-0.5 text-text-faint" />
          <span>{data.why}</span>
        </p>
      </div>

      {alternatives.length > 0 && (
        <div className="mt-4">
          <div className="eyebrow mb-2 text-text-faint">Other listings — don't confuse these</div>
          <ul className="divide-y divide-hairline border border-hairline rounded-sm overflow-hidden">
            {alternatives.map((l) => (
              <li key={l.symbol} className="flex items-center gap-3 px-3 py-2 bg-surface-2/40">
                <ListingLine listing={l} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Exchange · exact ticker · currency, with a copy button. `emphasise` renders the ticker
 *  larger (the recommended / single line); alternatives use the compact form. */
function ListingLine({
  listing, emphasise = false, highlightCurrency = false,
}: {
  listing: Listing;
  emphasise?: boolean;
  highlightCurrency?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap w-full">
      <span className={clsx('text-text-muted', emphasise ? 'text-[13px]' : 'text-[12px]')}>
        {listing.exchangeName}
      </span>
      <span className={clsx('font-mono text-text', emphasise ? 'text-[15px]' : 'text-[13px]')}>
        {listing.symbol}
      </span>
      {listing.currency && (
        <span className={clsx('chip !py-0 !px-1.5 text-[10px]',
          highlightCurrency ? 'text-gain border-gain/40' : 'text-text-muted')}>
          {listing.currency}
        </span>
      )}
      <div className="ml-auto">
        <CopyTicker ticker={listing.symbol} compact={!emphasise} />
      </div>
    </div>
  );
}

/** One-click copy of an exchange-specific ticker, with a copied-confirmation state (§9e).
 *  The canonical ticker-copy affordance — reuse it wherever a ticker is copied. */
export function CopyTicker({ ticker, compact = false }: { ticker: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ticker);
    } catch {
      // Fallback for clipboard-restricted contexts.
      const el = document.createElement('textarea');
      el.value = ticker;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      try { document.execCommand('copy'); } catch { /* nothing more we can do */ }
      document.body.removeChild(el);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `Copied ${ticker}` : `Copy ${ticker}`}
      className={clsx(
        'btn-secondary select-none',
        compact ? '!h-7 !px-2 text-[12px]' : '',
        copied && '!text-gain !border-gain/50',
      )}
    >
      {copied ? <Check size={compact ? 13 : 14} /> : <Copy size={compact ? 13 : 14} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

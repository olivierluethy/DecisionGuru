import { useEffect, useMemo, useRef, useState } from 'react';
import createGlobe from 'cobe';
import clsx from 'clsx';
import { ArrowUpRight, Clock } from 'lucide-react';
import type { GeoDensity, ScreenerRow } from '../lib/api';
import { BandBadge } from './ValuationBand';
import { fmtPct } from '../lib/format';

const TWO_PI = Math.PI * 2;

/**
 * Discover world map: the app's signature cobe globe driven by opportunity density — a
 * gold marker per market sized by how many attractive names it holds weighted by their
 * average margin of safety. A ranked country rail doubles as the legend; selecting a
 * market drills into its top value opportunities, owned and discovered distinguished.
 */
export function DiscoverMap({
  geo, rows, onOpen, onReplay,
}: {
  geo: GeoDensity[];
  rows: ScreenerRow[];
  onOpen: (symbol: string) => void;
  onReplay: (symbol: string, name?: string | null) => void;
}) {
  // Density is derived from the ROWS we're given (already filtered to the active mode),
  // using the backend geo array only as a centroid/name lookup — so the map tracks the
  // All-names / New-opportunities toggle automatically.
  const withCoords = useMemo(() => {
    const coords = new Map(geo.map((g) => [g.country, g]));
    const byCountry = new Map<string, { attractive: number; total: number; mosSum: number }>();
    for (const r of rows) {
      if (!r.country) continue;
      const b = byCountry.get(r.country) ?? { attractive: 0, total: 0, mosSum: 0 };
      b.total += 1;
      if (r.verdict === 'buy-more') {
        b.attractive += 1;
        if (r.marginOfSafety != null) b.mosSum += Math.max(r.marginOfSafety, 0);
      }
      byCountry.set(r.country, b);
    }
    const out: GeoDensity[] = [];
    for (const [cc, b] of byCountry) {
      const c = coords.get(cc);
      if (!c || c.lat == null || c.lng == null || b.attractive === 0) continue;
      const avgMos = b.attractive ? b.mosSum / b.attractive : 0;
      out.push({
        country: cc, name: c.name, lat: c.lat, lng: c.lng,
        attractiveCount: b.attractive, totalCount: b.total,
        avgMarginOfSafety: avgMos, density: b.attractive * (1 + avgMos), topSymbols: [],
      });
    }
    return out.sort((a, b) => b.density - a.density);
  }, [geo, rows]);
  const [selected, setSelected] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragging, setDragging] = useState(false);

  const maxDensity = Math.max(1, ...withCoords.map((g) => g.density));
  const markers = withCoords.map((g) => ({
    location: [g.lat as number, g.lng as number] as [number, number],
    size: Math.max(0.05, Math.min(0.16, Math.sqrt(g.density / maxDensity) * 0.16)),
  }));

  const primary = withCoords.slice().sort((a, b) => b.density - a.density)[0];
  const initialPhi = primary
    ? ((Math.PI - (((primary.lng as number) * Math.PI) / 180 - Math.PI / 2)) % TWO_PI + TWO_PI) % TWO_PI
    : 0;
  const initialTheta = primary ? ((primary.lat as number) * Math.PI) / 180 : 0.3;

  const phi = useRef(initialPhi);
  const theta = useRef(initialTheta);
  const draggingRef = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const width = 320;
    const globe = createGlobe(canvasRef.current, {
      devicePixelRatio: 2, width: width * 2, height: width * 2,
      phi: initialPhi, theta: initialTheta, dark: 1, diffuse: 1.2,
      mapSamples: 16000, mapBrightness: 5,
      baseColor: [0.16, 0.33, 0.5], markerColor: [0.85, 0.66, 0.3], glowColor: [0.1, 0.32, 0.55],
      markers,
      onRender: (state) => {
        if (!draggingRef.current) phi.current += 0.003;
        state.phi = phi.current; state.theta = theta.current;
        state.width = width * 2; state.height = width * 2;
      },
    });
    return () => globe.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(markers)]);

  const drill = useMemo(() => {
    if (!selected) return [];
    return rows.filter((r) => r.country === selected)
      .sort((a, b) => b.attractiveness - a.attractiveness);
  }, [selected, rows]);
  const selectedName = withCoords.find((g) => g.country === selected)?.name ?? selected;

  if (withCoords.length === 0) {
    return (
      <p className="text-sm text-text-faint">
        No opportunity density to map yet — screened names need cached fundamentals. Open a few in Research to populate the map.
      </p>
    );
  }

  return (
    <div className="grid lg:grid-cols-[320px_1fr] gap-6 items-start">
      <div className="flex justify-center">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Opportunity-density globe — drag to rotate"
          style={{ width: 320, height: 320, maxWidth: '100%', aspectRatio: '1',
            cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
          onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId);
            pointer.current = { x: e.clientX, y: e.clientY }; draggingRef.current = true; setDragging(true); }}
          onPointerMove={(e) => {
            if (!pointer.current) return;
            phi.current -= (e.clientX - pointer.current.x) / 120;
            theta.current = Math.max(-1.2, Math.min(1.2, theta.current + (e.clientY - pointer.current.y) / 120));
            pointer.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerUp={() => { pointer.current = null; draggingRef.current = false; setDragging(false); }}
          onPointerLeave={() => { pointer.current = null; draggingRef.current = false; setDragging(false); }}
        />
      </div>

      <div>
        {/* Country rail — the legend, ranked by density. Click to drill in. */}
        <div className="eyebrow mb-2">Opportunity density by market</div>
        <div className="flex flex-wrap gap-2 mb-4">
          {withCoords.slice(0, 16).map((g) => (
            <button
              key={g.country}
              onClick={() => setSelected(selected === g.country ? null : g.country)}
              className={clsx('chip !py-1 transition-colors',
                selected === g.country ? 'border-gold text-gold' : 'hover:border-hairline-strong')}
              title={`${g.attractiveCount} attractive · avg MoS ${fmtPct(g.avgMarginOfSafety, 0)}`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-gold" style={{ opacity: 0.4 + 0.6 * (g.density / maxDensity) }} />
              <span className="text-text ml-1.5">{g.name}</span>
              <span className="text-text-faint ml-1.5 tnum">{g.attractiveCount}</span>
            </button>
          ))}
        </div>

        {/* Drill-in for the selected market. */}
        {selected ? (
          drill.length === 0 ? (
            <p className="text-sm text-text-faint">No scored names in {selectedName} yet.</p>
          ) : (
            <div className="card !p-0 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-hairline flex items-center justify-between">
                <span className="text-sm font-medium">{selectedName} · top opportunities</span>
                <button className="text-[11px] text-text-faint hover:text-text" onClick={() => setSelected(null)}>clear</button>
              </div>
              <ul className="divide-y divide-hairline">
                {drill.slice(0, 10).map((r) => (
                  <li key={r.symbol} className="px-4 py-2.5 flex items-center gap-3 hover:bg-surface-2/50">
                    <button className="flex-1 min-w-0 text-left" onClick={() => onOpen(r.symbol)}>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-azure hover:underline">{r.symbol}</span>
                        {r.inPortfolio && <span className="chip !py-0 !px-1.5 text-[9px] text-gold border-gold/40">held</span>}
                        <ArrowUpRight size={11} className="text-text-faint" />
                      </div>
                      <div className="text-[12px] text-text-muted truncate">{r.name}</div>
                    </button>
                    <div className="text-right shrink-0">
                      {r.band && <BandBadge band={r.band} />}
                      <div className="text-[11px] text-text-faint tnum mt-0.5">
                        MoS {r.marginOfSafety != null ? fmtPct(r.marginOfSafety, 0) : '—'} · {r.attractiveness}/100
                      </div>
                    </div>
                    <button className="text-text-faint hover:text-azure shrink-0" title="Point-in-time replay"
                      onClick={() => onReplay(r.symbol, r.name)}>
                      <Clock size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )
        ) : (
          <p className="text-sm text-text-faint">
            Marker size is opportunity density — attractive names weighted by their discount to fair value.
            Select a market to drill into its top value opportunities.
          </p>
        )}
      </div>
    </div>
  );
}

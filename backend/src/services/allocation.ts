import type { AllocationBreakdown, AllocationSlice, HoldingSlice, Instrument } from '@decisionguru/shared';
import { COUNTRY_COORDS, countryFromSymbol, countryFromIsin } from '@decisionguru/shared';
import { getFundSummary } from './marketdata.js';

const SECTOR_LABELS: Record<string, string> = {
  realestate: 'Real estate',
  consumer_cyclical: 'Consumer cyclical',
  basic_materials: 'Basic materials',
  consumer_defensive: 'Consumer defensive',
  technology: 'Technology',
  communication_services: 'Communication',
  financial_services: 'Financials',
  utilities: 'Utilities',
  industrials: 'Industrials',
  energy: 'Energy',
  healthcare: 'Healthcare',
};

function coordsFor(country: string): { lat?: number; lng?: number } {
  const c = COUNTRY_COORDS[country];
  return c ? { lat: c.lat, lng: c.lng } : {};
}

export async function buildAllocation(instrument: Instrument): Promise<AllocationBreakdown> {
  if (instrument.allocationOverride) {
    return { ...instrument.allocationOverride, source: 'manual' };
  }

  const summary = await getFundSummary(instrument.symbol);

  if (instrument.kind === 'etf' && summary?.topHoldings) {
    return buildFundAllocation(summary);
  }

  // Single stock: HQ country + single holding + sector. Prefer the reliable signals —
  // the ISIN prefix and the stored country — over a possibly-empty Yahoo profile, so
  // Swiss/EU companies are never defaulted to the US.
  const profile = summary?.summaryProfile ?? summary?.assetProfile ?? {};
  const countryName: string = profile.country ?? '';
  const profileCc = Object.keys(COUNTRY_COORDS).find((k) => COUNTRY_COORDS[k].name === countryName);
  const cc =
    instrument.country ??
    countryFromIsin(instrument.isin) ??
    profileCc ??
    countryFromSymbol(instrument.symbol) ??
    'US';
  const sector = profile.sector ?? instrument.sector ?? 'Unknown';
  return {
    source: 'stock',
    countries: [
      { key: cc, label: COUNTRY_COORDS[cc]?.name ?? cc, weight: 1, ...coordsFor(cc) },
    ],
    sectors: [{ key: sector, label: sector, weight: 1 }],
    topHoldings: [
      { name: instrument.name, weight: 1, country: cc, ...coordsFor(cc) },
    ],
  };
}

function buildFundAllocation(summary: any): AllocationBreakdown {
  const holdings: HoldingSlice[] = (summary.topHoldings.holdings ?? []).map((h: any) => {
    const country = countryFromSymbol(h.symbol ?? '') ?? 'US';
    return {
      symbol: h.symbol,
      name: h.holdingName ?? h.symbol,
      weight: h.holdingPercent ?? 0,
      country,
      ...coordsFor(country),
    };
  });

  const sectors: AllocationSlice[] = (summary.topHoldings.sectorWeightings ?? [])
    .map((s: any) => {
      const key = Object.keys(s)[0];
      return { key, label: SECTOR_LABELS[key] ?? key, weight: Number(s[key]) || 0 };
    })
    .filter((s: AllocationSlice) => s.weight > 0)
    .sort((a: AllocationSlice, b: AllocationSlice) => b.weight - a.weight);

  // Aggregate top-holdings into an approximate country allocation.
  const byCountry = new Map<string, number>();
  for (const h of holdings) {
    const c = h.country ?? 'US';
    byCountry.set(c, (byCountry.get(c) ?? 0) + h.weight);
  }
  const countries: AllocationSlice[] = [...byCountry.entries()]
    .map(([key, weight]) => ({
      key,
      label: COUNTRY_COORDS[key]?.name ?? key,
      weight,
      ...coordsFor(key),
    }))
    .sort((a, b) => b.weight - a.weight);

  return { source: 'fund', countries, sectors, topHoldings: holdings };
}

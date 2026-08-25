// Country centroid coordinates (approx) for globe markers, keyed by ISO alpha-2.
export const COUNTRY_COORDS: Record<string, { lat: number; lng: number; name: string }> = {
  US: { lat: 39.8, lng: -98.6, name: 'United States' },
  CH: { lat: 46.8, lng: 8.2, name: 'Switzerland' },
  GB: { lat: 54.0, lng: -2.0, name: 'United Kingdom' },
  DE: { lat: 51.2, lng: 10.4, name: 'Germany' },
  FR: { lat: 46.6, lng: 2.2, name: 'France' },
  JP: { lat: 36.2, lng: 138.3, name: 'Japan' },
  CN: { lat: 35.9, lng: 104.2, name: 'China' },
  HK: { lat: 22.3, lng: 114.2, name: 'Hong Kong' },
  TW: { lat: 23.7, lng: 121.0, name: 'Taiwan' },
  KR: { lat: 36.5, lng: 127.9, name: 'South Korea' },
  IN: { lat: 22.0, lng: 79.0, name: 'India' },
  CA: { lat: 56.1, lng: -106.3, name: 'Canada' },
  AU: { lat: -25.3, lng: 133.8, name: 'Australia' },
  NL: { lat: 52.1, lng: 5.3, name: 'Netherlands' },
  IE: { lat: 53.4, lng: -8.2, name: 'Ireland' },
  IT: { lat: 41.9, lng: 12.6, name: 'Italy' },
  ES: { lat: 40.5, lng: -3.7, name: 'Spain' },
  SE: { lat: 60.1, lng: 18.6, name: 'Sweden' },
  DK: { lat: 56.3, lng: 9.5, name: 'Denmark' },
  FI: { lat: 61.9, lng: 25.7, name: 'Finland' },
  NO: { lat: 60.5, lng: 8.5, name: 'Norway' },
  BE: { lat: 50.5, lng: 4.5, name: 'Belgium' },
  BR: { lat: -14.2, lng: -51.9, name: 'Brazil' },
  MX: { lat: 23.6, lng: -102.5, name: 'Mexico' },
  SG: { lat: 1.35, lng: 103.8, name: 'Singapore' },
  ZA: { lat: -30.6, lng: 22.9, name: 'South Africa' },
  IL: { lat: 31.0, lng: 34.8, name: 'Israel' },
  SA: { lat: 23.9, lng: 45.1, name: 'Saudi Arabia' },
  AE: { lat: 23.4, lng: 53.8, name: 'United Arab Emirates' },
  AT: { lat: 47.5, lng: 14.6, name: 'Austria' },
  NZ: { lat: -41.0, lng: 174.9, name: 'New Zealand' },
  PT: { lat: 39.4, lng: -8.2, name: 'Portugal' },
};

/** Best-effort mapping of exchange suffix / market to a country code. */
export const EXCHANGE_COUNTRY: Record<string, string> = {
  SW: 'CH', // SIX
  L: 'GB', // London
  DE: 'DE',
  F: 'DE', // Frankfurt
  PA: 'FR', // Paris
  AS: 'NL', // Amsterdam
  MI: 'IT', // Milan
  MC: 'ES', // Madrid
  T: 'JP', // Tokyo
  HK: 'HK',
  TW: 'TW',
  KS: 'KR',
  TO: 'CA', // Toronto
  AX: 'AU', // ASX
  ST: 'SE', // Stockholm
  CO: 'DK', // Copenhagen
  HE: 'FI', // Helsinki
  OL: 'NO', // Oslo
  BR: 'BE', // Brussels
  SA: 'BR', // Sao Paulo
  MX: 'MX',
  SI: 'SG', // Singapore
  VX: 'CH',
};

export function countryFromSymbol(symbol: string): string | null {
  const parts = symbol.split('.');
  if (parts.length > 1) {
    const suffix = parts[parts.length - 1].toUpperCase();
    return EXCHANGE_COUNTRY[suffix] ?? null;
  }
  return 'US'; // bare symbols are typically US-listed on Yahoo
}

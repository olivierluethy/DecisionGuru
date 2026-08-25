"""Curated ISIN -> Yahoo symbol seed — port of shared/src/isin-map.ts."""
from __future__ import annotations

CURATED_ISIN_MAP: dict[str, dict] = {
    # Swiss blue chips (SIX, CHF)
    "CH0038863350": {"symbol": "NESN.SW", "currency": "CHF", "kind": "stock"},
    "CH0012005267": {"symbol": "NOVN.SW", "currency": "CHF", "kind": "stock"},
    "CH0012032048": {"symbol": "ROG.SW", "currency": "CHF", "kind": "stock"},
    "CH0002178181": {"symbol": "SRAIL.SW", "currency": "CHF", "kind": "stock"},
    "CH0012255144": {"symbol": "UHR.SW", "currency": "CHF", "kind": "stock"},
    "CH0009002962": {"symbol": "BARN.SW", "currency": "CHF", "kind": "stock"},
    # US large caps
    "US0846707026": {"symbol": "BRK-B", "currency": "USD", "kind": "stock"},
    "US6541061031": {"symbol": "NKE", "currency": "USD", "kind": "stock"},
    "US22041X1028": {"symbol": "CRSR", "currency": "USD", "kind": "stock"},
    "US0079031078": {"symbol": "AMD", "currency": "USD", "kind": "stock"},
    "US04342Y1047": {"symbol": "ASAN", "currency": "USD", "kind": "stock"},
    "US30303M1027": {"symbol": "META", "currency": "USD", "kind": "stock"},
    "US67066G1040": {"symbol": "NVDA", "currency": "USD", "kind": "stock"},
    "US7170811035": {"symbol": "PFE", "currency": "USD", "kind": "stock"},
    "US4592001014": {"symbol": "IBM", "currency": "USD", "kind": "stock"},
    "US8740541094": {"symbol": "TTWO", "currency": "USD", "kind": "stock"},
    "US87612E1064": {"symbol": "TGT", "currency": "USD", "kind": "stock"},
    "US9113121068": {"symbol": "UPS", "currency": "USD", "kind": "stock"},
    "US91324P1021": {"symbol": "UNH", "currency": "USD", "kind": "stock"},
    "US26817Q8868": {"symbol": "DX", "currency": "USD", "kind": "stock"},
    "US80105N1054": {"symbol": "SNY", "currency": "USD", "kind": "stock", "country": "FR"},
    # European listings
    "FR0000120578": {"symbol": "SAN.PA", "currency": "EUR", "kind": "stock"},
    "FR0000120172": {"symbol": "CA.PA", "currency": "EUR", "kind": "stock"},
    "DE0008232125": {"symbol": "LHA.DE", "currency": "EUR", "kind": "stock"},
    "DE000A1ML7J1": {"symbol": "VNA.DE", "currency": "EUR", "kind": "stock"},
    "CA21037X1006": {"symbol": "CSU.TO", "currency": "CAD", "kind": "stock"},
    "CA38210L1094": {"symbol": "GDNP.V", "currency": "CAD", "kind": "stock"},
    # Else Nutrition (multi-ISIN corporate actions -> live line)
    "CA2902576099": {"symbol": "BABY.V", "currency": "CAD", "kind": "stock"},
    "CA2902575000": {"symbol": "BABY.V", "currency": "CAD", "kind": "stock"},
    "CA2902571041": {"symbol": "BABY.V", "currency": "CAD", "kind": "stock"},
    # UCITS ETFs (Irish domicile, London USD lines)
    "IE00BFMXXD54": {"symbol": "VUAA.L", "currency": "USD", "kind": "etf"},
    "IE00BK5BQT80": {"symbol": "VWRA.L", "currency": "USD", "kind": "etf"},
    "IE00B53SZB19": {"symbol": "CNDX.L", "currency": "USD", "kind": "etf"},
    "IE00B6R52259": {"symbol": "SSAC.L", "currency": "USD", "kind": "etf"},
    "CH0017142719": {"symbol": "SMMCHA.SW", "currency": "CHF", "kind": "etf"},
}


def curated_resolve(isin: str | None) -> dict | None:
    if not isin:
        return None
    return CURATED_ISIN_MAP.get(isin.upper())

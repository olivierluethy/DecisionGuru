"""Curated screening universe — a broad, offline seed of large, liquid names across
sectors and regions, using the Yahoo symbology the app already quotes in.

The screener screens (this seed ∪ your holdings ∪ your watchlist) but only scores
names whose fundamentals are already cached — it never bulk-fetches, because the
provider rate-limits this IP hard. So the seed's job is to *offer* candidates; a
name becomes screenable once its fundamentals have been pulled (e.g. by opening it
in Research). Extend this list freely — it is just tickers.
"""
from __future__ import annotations

# Swiss blue chips (SMI + a few mid caps)
_SWISS = [
    "NESN.SW", "NOVN.SW", "ROG.SW", "UBSG.SW", "ZURN.SW", "ABBN.SW", "LONN.SW",
    "SIKA.SW", "GIVN.SW", "ALC.SW", "CFR.SW", "SGSN.SW", "SLHN.SW", "SREN.SW",
    "GEBN.SW", "HOLN.SW", "PGHN.SW", "SCMN.SW", "LOGN.SW", "KNIN.SW", "UHR.SW",
    "BAER.SW", "ADEN.SW", "SOON.SW",
]

# US mega / large caps across sectors
_US = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA", "BRK-B", "JPM", "V",
    "MA", "JNJ", "PG", "KO", "PEP", "XOM", "CVX", "WMT", "HD", "MCD", "DIS", "NKE",
    "INTC", "AMD", "CRM", "ORCL", "CSCO", "ADBE", "NFLX", "PFE", "MRK", "ABBV",
    "LLY", "UNH", "BAC", "WFC", "T", "VZ", "CAT", "BA", "GE", "MMM", "HON", "IBM",
    "QCOM", "TXN", "COST", "SBUX", "GS", "MS", "PM", "TMO", "AVGO",
]

# Europe / UK large caps (STOXX Europe 600 constituents subset)
_EUROPE = [
    "SHEL.L", "BP.L", "HSBA.L", "AZN.L", "ULVR.L", "GSK.L", "RIO.L", "BATS.L",
    "DGE.L", "VOD.L", "BARC.L", "GLEN.L", "MC.PA", "OR.PA", "AIR.PA", "SAN.PA",
    "BNP.PA", "SAP.DE", "SIE.DE", "ALV.DE", "BAS.DE", "BMW.DE", "VOW3.DE",
    "DTE.DE", "MBG.DE", "ASML.AS", "PHIA.AS", "TTE.PA", "IBE.MC", "ITX.MC",
    "ENEL.MI", "ISP.MI", "NOVO-B.CO", "NDA-FI.HE", "EQNR.OL", "INVE-B.ST",
]

# Asia-Pacific & emerging-market large caps (widen the map beyond CH/US/EU)
_ASIA = [
    "7203.T", "6758.T", "9984.T", "0700.HK", "9988.HK", "1299.HK", "005930.KS",
    "TSM", "BABA", "TCEHY", "RELIANCE.NS", "INFY.NS", "BHP.AX", "CBA.AX",
]

# Curated global ETF universe — broad market, regional and factor funds, including the
# VWRL all-world family this app benchmarks against. Valued on relative yield / valuation
# vs the benchmark when fundamentals are thin.
_ETFS = [
    "VWRL.SW", "VWRL.L", "VWRA.L", "VWCE.DE", "VT", "URTH", "ACWI",
    "CSPX.L", "SPY", "VOO", "IVV", "QQQ", "VTI",
    "VGK", "EZU", "IEUR", "EWU.L", "EWJ", "MCHI", "EEM", "VWO", "INDA",
    "VYM", "SCHD", "VIG", "VNQ", "IEF", "TLT", "GLD",
]

UNIVERSE_SEED: list[str] = [*_SWISS, *_US, *_EUROPE, *_ASIA, *_ETFS]

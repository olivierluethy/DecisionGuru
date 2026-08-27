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

# Europe / UK large caps
_EUROPE = [
    "SHEL.L", "BP.L", "HSBA.L", "AZN.L", "ULVR.L", "GSK.L", "RIO.L", "BATS.L",
    "DGE.L", "VOD.L", "BARC.L", "GLEN.L", "MC.PA", "OR.PA", "AIR.PA", "SAN.PA",
    "BNP.PA", "SAP.DE", "SIE.DE", "ALV.DE", "BAS.DE", "BMW.DE", "VOW3.DE",
    "DTE.DE", "MBG.DE", "ASML.AS", "PHIA.AS", "TTE.PA",
]

UNIVERSE_SEED: list[str] = [*_SWISS, *_US, *_EUROPE]

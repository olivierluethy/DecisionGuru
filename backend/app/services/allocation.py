"""Geographic / sector allocation breakdown — port of allocation.ts."""
from __future__ import annotations

from ..reference.geo import COUNTRY_COORDS, country_from_isin, country_from_symbol
from .marketdata import get_fund_summary

SECTOR_LABELS = {
    "realestate": "Real estate",
    "consumer_cyclical": "Consumer cyclical",
    "basic_materials": "Basic materials",
    "consumer_defensive": "Consumer defensive",
    "technology": "Technology",
    "communication_services": "Communication",
    "financial_services": "Financials",
    "utilities": "Utilities",
    "industrials": "Industrials",
    "energy": "Energy",
    "healthcare": "Healthcare",
}


def _coords_for(country: str) -> dict:
    c = COUNTRY_COORDS.get(country)
    return {"lat": c["lat"], "lng": c["lng"]} if c else {}


def build_allocation(instrument: dict) -> dict:
    if instrument.get("allocationOverride"):
        return {**instrument["allocationOverride"], "source": "manual"}

    summary = get_fund_summary(instrument["symbol"])

    if instrument.get("kind") == "etf" and summary and summary.get("topHoldings"):
        return _build_fund_allocation(summary)

    profile = (summary.get("summaryProfile") if summary else None) or \
              (summary.get("assetProfile") if summary else None) or {}
    country_name = profile.get("country") or ""
    profile_cc = next((k for k in COUNTRY_COORDS if COUNTRY_COORDS[k]["name"] == country_name), None)
    cc = (
        instrument.get("country")
        or country_from_isin(instrument.get("isin"))
        or profile_cc
        or country_from_symbol(instrument["symbol"])
        or "US"
    )
    sector = profile.get("sector") or instrument.get("sector") or "Unknown"
    return {
        "source": "stock",
        "countries": [
            {"key": cc, "label": (COUNTRY_COORDS.get(cc) or {}).get("name", cc), "weight": 1, **_coords_for(cc)},
        ],
        "sectors": [{"key": sector, "label": sector, "weight": 1}],
        "topHoldings": [
            {"name": instrument["name"], "weight": 1, "country": cc, **_coords_for(cc)},
        ],
    }


def _build_fund_allocation(summary: dict) -> dict:
    holdings = []
    for h in (summary["topHoldings"].get("holdings") or []):
        country = country_from_symbol(h.get("symbol") or "") or "US"
        holdings.append({
            "symbol": h.get("symbol"),
            "name": h.get("holdingName") or h.get("symbol"),
            "weight": h.get("holdingPercent") or 0,
            "country": country,
            **_coords_for(country),
        })

    sectors = []
    for s in (summary["topHoldings"].get("sectorWeightings") or []):
        key = next(iter(s.keys()))
        weight = float(s[key]) if s[key] is not None else 0
        sectors.append({"key": key, "label": SECTOR_LABELS.get(key, key), "weight": weight})
    sectors = [s for s in sectors if s["weight"] > 0]
    sectors.sort(key=lambda s: s["weight"], reverse=True)

    by_country: dict[str, float] = {}
    for h in holdings:
        c = h.get("country") or "US"
        by_country[c] = by_country.get(c, 0) + h["weight"]
    countries = [
        {"key": key, "label": (COUNTRY_COORDS.get(key) or {}).get("name", key), "weight": weight,
         **_coords_for(key)}
        for key, weight in by_country.items()
    ]
    countries.sort(key=lambda c: c["weight"], reverse=True)

    return {"source": "fund", "countries": countries, "sectors": sectors, "topHoldings": holdings}

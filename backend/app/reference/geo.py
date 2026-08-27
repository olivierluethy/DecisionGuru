"""Geo helpers — port of shared/src/geo.ts."""
from __future__ import annotations

import re

COUNTRY_COORDS: dict[str, dict] = {
    "US": {"lat": 39.8, "lng": -98.6, "name": "United States"},
    "CH": {"lat": 46.8, "lng": 8.2, "name": "Switzerland"},
    "GB": {"lat": 54.0, "lng": -2.0, "name": "United Kingdom"},
    "DE": {"lat": 51.2, "lng": 10.4, "name": "Germany"},
    "FR": {"lat": 46.6, "lng": 2.2, "name": "France"},
    "JP": {"lat": 36.2, "lng": 138.3, "name": "Japan"},
    "CN": {"lat": 35.9, "lng": 104.2, "name": "China"},
    "HK": {"lat": 22.3, "lng": 114.2, "name": "Hong Kong"},
    "TW": {"lat": 23.7, "lng": 121.0, "name": "Taiwan"},
    "KR": {"lat": 36.5, "lng": 127.9, "name": "South Korea"},
    "IN": {"lat": 22.0, "lng": 79.0, "name": "India"},
    "CA": {"lat": 56.1, "lng": -106.3, "name": "Canada"},
    "AU": {"lat": -25.3, "lng": 133.8, "name": "Australia"},
    "NL": {"lat": 52.1, "lng": 5.3, "name": "Netherlands"},
    "IE": {"lat": 53.4, "lng": -8.2, "name": "Ireland"},
    "IT": {"lat": 41.9, "lng": 12.6, "name": "Italy"},
    "ES": {"lat": 40.5, "lng": -3.7, "name": "Spain"},
    "SE": {"lat": 60.1, "lng": 18.6, "name": "Sweden"},
    "DK": {"lat": 56.3, "lng": 9.5, "name": "Denmark"},
    "FI": {"lat": 61.9, "lng": 25.7, "name": "Finland"},
    "NO": {"lat": 60.5, "lng": 8.5, "name": "Norway"},
    "BE": {"lat": 50.5, "lng": 4.5, "name": "Belgium"},
    "BR": {"lat": -14.2, "lng": -51.9, "name": "Brazil"},
    "MX": {"lat": 23.6, "lng": -102.5, "name": "Mexico"},
    "SG": {"lat": 1.35, "lng": 103.8, "name": "Singapore"},
    "ZA": {"lat": -30.6, "lng": 22.9, "name": "South Africa"},
    "IL": {"lat": 31.0, "lng": 34.8, "name": "Israel"},
    "SA": {"lat": 23.9, "lng": 45.1, "name": "Saudi Arabia"},
    "AE": {"lat": 23.4, "lng": 53.8, "name": "United Arab Emirates"},
    "AT": {"lat": 47.5, "lng": 14.6, "name": "Austria"},
    "NZ": {"lat": -41.0, "lng": 174.9, "name": "New Zealand"},
    "PT": {"lat": 39.4, "lng": -8.2, "name": "Portugal"},
}

EXCHANGE_COUNTRY: dict[str, str] = {
    "SW": "CH", "L": "GB", "DE": "DE", "F": "DE", "PA": "FR", "AS": "NL",
    "MI": "IT", "MC": "ES", "T": "JP", "HK": "HK", "TW": "TW", "KS": "KR",
    "TO": "CA", "AX": "AU", "ST": "SE", "CO": "DK", "HE": "FI", "OL": "NO",
    "BR": "BE", "SA": "BR", "MX": "MX", "SI": "SG", "VX": "CH", "NS": "IN",
    "BO": "IN",
}

_ISIN_PREFIX_OVERRIDES = {"KY": "KY", "BM": "BM", "JE": "JE", "GG": "GG", "XS": "XS"}
_ISO_COUNTRIES = set(COUNTRY_COORDS.keys())


def country_from_symbol(symbol: str) -> str | None:
    parts = (symbol or "").split(".")
    if len(parts) > 1:
        suffix = parts[-1].upper()
        return EXCHANGE_COUNTRY.get(suffix)
    return "US"  # bare symbols are typically US-listed on Yahoo


def country_from_isin(isin: str | None) -> str | None:
    if not isin:
        return None
    prefix = isin[:2].upper()
    if not re.fullmatch(r"[A-Z]{2}", prefix):
        return None
    if prefix in _ISIN_PREFIX_OVERRIDES:
        return _ISIN_PREFIX_OVERRIDES[prefix]
    return prefix


def known_country(code: str | None) -> bool:
    return bool(code) and code in _ISO_COUNTRIES

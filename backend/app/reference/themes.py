"""Industry/theme classification.

The data provider gives a fine-grained `industry` (e.g. "Semiconductors", "Drug
Manufacturers—General", "Oil & Gas E&P"). This collapses those many labels into a
handful of browsable themes (AI/Software, Semiconductors, Medicine, Energy,
Agriculture, …) so Discover can group not-yet-owned names by theme. It never invents a
classification: when nothing matches it falls back to the raw industry, then the sector,
then "Other".
"""
from __future__ import annotations

# Ordered (first match wins): (theme, [keywords matched against industry then sector]).
_THEME_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("Semiconductors", ("semiconductor", "chip")),
    ("Software & AI", ("software", "internet content", "information technology", "cloud", "cyber")),
    ("Medicine & Pharma", ("drug", "pharmaceutic", "biotech", "healthcare", "health care",
                            "medical", "diagnostics", "life sciences")),
    ("Energy", ("oil", "gas", "energy", "solar", "renewable", "coal", "petroleum", "uranium")),
    ("Agriculture & Food", ("agricultur", "farm", "fertilizer", "crop", "packaged food",
                             "food product", "beverage")),
    ("Financials", ("bank", "insurance", "capital markets", "financial", "asset management",
                     "credit", "mortgage")),
    ("Consumer", ("retail", "apparel", "restaurant", "luxury", "footwear", "e-commerce",
                   "consumer", "leisure", "lodging", "travel")),
    ("Industrials", ("aerospace", "defense", "machinery", "industrial", "construction",
                      "engineering", "transportation", "airlines", "railroad", "logistics")),
    ("Materials & Mining", ("chemical", "metal", "mining", "materials", "steel", "gold",
                             "copper", "building materials")),
    ("Real Estate", ("reit", "real estate")),
    ("Telecom & Media", ("telecom", "communication", "media", "entertainment", "broadcasting",
                          "publishing", "gaming")),
    ("Utilities", ("utilit", "electric power", "water")),
    ("Autos & Mobility", ("auto", "vehicle", "automobile", "electric vehicle")),
]


def classify_theme(sector: str | None, industry: str | None) -> str | None:
    """Map (sector, industry) to a browsable theme. Falls back industry → sector → None."""
    hay = f"{(industry or '').lower()} {(sector or '').lower()}"
    for theme, keywords in _THEME_RULES:
        if any(k in hay for k in keywords):
            return theme
    return industry or sector or None

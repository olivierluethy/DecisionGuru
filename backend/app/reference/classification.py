"""Company classification normalization + competitive-market determination.

Peer comparison must not hinge on raw provider strings. Two problems with the provider's
(yfinance) labels:

1.  A company's broad ``sector`` bundles unrelated businesses. "Consumer Cyclical" spans auto
    makers, restaurants, apparel, luxury goods and retail — so sector equality alone groups
    Toyota with Starbucks, Nike and Swatch. The *sector* is only a coarse pre-filter.
2.  The same classification is spelled inconsistently across listings — "Financial Services"
    vs "Financials", "Auto Manufacturers" vs "Auto Manufacturers — Major", "Banks—Regional"
    vs "Banks - Regional". Raw string equality wrongly splits genuine peers apart.

So we (a) normalize case / whitespace / punctuation and canonicalize a few well-known provider
aliases, then (b) define a company's *competitive market* by its normalized ``industry`` — the
most specific classification the cached fundamentals actually carry — guarded by a normalized
``sector`` match. Two companies compete iff they share the same normalized sector AND the same
normalized industry.

Everything here is deterministic and data-only: no external calls, no per-symbol I/O. It runs
purely on the sector/industry strings already stored in the cached fundamentals snapshot, so it
preserves the app's rate-limit-safe, cache-based architecture.
"""
from __future__ import annotations

import re

# Any run of non-alphanumeric characters (spaces, hyphens, em dashes, slashes, commas, dots)
# collapses to a single space — this alone reconciles the bulk of provider formatting variants
# such as "Banks—Regional" / "Banks - Regional" / "Banks Regional".
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def _norm(value: str | None) -> str | None:
    """Lowercase, expand ``&``→``and``, strip punctuation to spaces, collapse whitespace.

    Returns None for empty/whitespace-only input so callers can treat "missing" distinctly."""
    if not value:
        return None
    text = value.strip().lower().replace("&", " and ")
    text = _NON_ALNUM.sub(" ", text).strip()
    return text or None


# Known-equivalent SECTOR labels the provider emits inconsistently across listings. Mirrors the
# aliasing already relied on in ``reference/sector_etfs.py`` (right-hand side is the canonical
# form). Kept deliberately small and justified — not an arbitrary reclassification.
_SECTOR_ALIASES: dict[str, str] = {
    "information technology": "technology",
    "financials": "financial services",
    "consumer staples": "consumer defensive",
    "consumer discretionary": "consumer cyclical",
    "materials": "basic materials",
}

# Known-equivalent INDUSTRY labels (post-normalization). Normalization already reconciles
# punctuation/format variants, so this only needs to cover genuine synonymous provider labels.
# Extend here — with a real provider-observed synonym — rather than loosening the match logic.
_INDUSTRY_ALIASES: dict[str, str] = {
    "auto manufacturers major": "auto manufacturers",
    "autos": "auto manufacturers",
}


def normalize_sector(sector: str | None) -> str | None:
    """Canonical, comparison-safe sector key (or None when missing)."""
    key = _norm(sector)
    return _SECTOR_ALIASES.get(key, key) if key is not None else None


def normalize_industry(industry: str | None) -> str | None:
    """Canonical, comparison-safe industry key (or None when missing)."""
    key = _norm(industry)
    return _INDUSTRY_ALIASES.get(key, key) if key is not None else None


def market_key(sector: str | None, industry: str | None) -> tuple[str | None, str | None]:
    """A company's competitive-market key: (normalized sector, normalized industry).

    Industry is the specific dimension; sector is the coarse guard. A key is only as specific
    as the data allows — an absent industry yields ``(sector, None)``."""
    return normalize_sector(sector), normalize_industry(industry)


def same_market(
    subject_sector: str | None,
    subject_industry: str | None,
    candidate_sector: str | None,
    candidate_industry: str | None,
) -> bool:
    """True when the candidate competes in the subject's market.

    Hierarchy: sector is a coarse pre-filter, industry is the actual market boundary.

    - Different (normalized) sector, or either sector missing → not comparable.
    - Same sector AND same (normalized) industry → comparable. This is what keeps Toyota with
      the auto makers while excluding Starbucks/Nike/Swatch, which share the sector but not the
      "Auto Manufacturers" industry.
    - Same sector but the *subject* has no industry label → we cannot refine, so fall back to
      the sector match (a documented graceful degrade for the rare company the provider leaves
      un-classified at the industry level; better a coarse peer set than none).
    """
    subj_sector = normalize_sector(subject_sector)
    cand_sector = normalize_sector(candidate_sector)
    if subj_sector is None or cand_sector is None or subj_sector != cand_sector:
        return False

    subj_industry = normalize_industry(subject_industry)
    if subj_industry is None:
        return True  # no industry to refine on → coarse sector fallback

    return normalize_industry(candidate_industry) == subj_industry

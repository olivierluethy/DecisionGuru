"""Market position — where a company stands among its actual competitors on TWO axes at
once: how cheap it is (value) and how strongly it is growing relative to that market
(strength).

The gap this closes: the value engine can call a company attractive while every competitor
in the same market compounds faster. Buying the cheap name then means buying the laggard —
cheap for a reason. Neither the valuation section nor the peer table answers that on its
own, because one looks only at price-vs-worth and the other only at raw relative return.

Method — deliberately simple and explainable:

* Both axes are **percentile ranks inside the peer set**, not absolute scores. With 4-8
  peers a z-score is dominated by outliers; a percentile reads directly as "better than
  70% of the comparable companies" and is what the UI states.
* **Strength** blends the selected horizon's price return (60%), revenue growth (25%) and
  net margin (15%). Missing metrics drop out and the remaining weights are renormalised, so
  a peer with no revenue-growth figure is still ranked on what is known.
* **Value** is the percentile of the margin of safety from ``value_analysis`` — the very
  number shown when the reader clicks that peer open. Where no intrinsic value can be
  derived the whole market falls back to earnings yield, then to book yield, so the axis
  stays comparable across the set (one basis for everyone, reported as ``valueBasis``).
* Everything reads the caches only (``price_cache`` + ``fundamentals_cache``); the loop
  never touches the rate-limited provider.

The output is descriptive: a rank, a quadrant, and — when they exist — the peers that beat
the subject on BOTH axes. It never tells anyone what to buy.
"""
from __future__ import annotations

from .fundamentals import get_cached_fundamentals
from .marketdata import latest_cached_close
from .valuation import value_analysis

# Strength weights. Price return carries the most because it is the one metric available
# for every peer over the exact horizon the reader picked; the fundamentals temper it so a
# short momentum burst cannot alone make a company look like the market leader.
W_RETURN = 0.60
W_REV_GROWTH = 0.25
W_MARGIN = 0.15

# Peers that beat the subject on both axes, at most this many, best first.
MAX_ALTERNATIVES = 3

# A market of one (or two) has no meaningful "percentile within the market".
MIN_RANKABLE = 3


def _percentiles(values: dict[str, float | None]) -> dict[str, float | None]:
    """Percentile rank (0-100) of each non-None value within the set, higher = better.

    Uses the midpoint of the "strictly below" and "at or below" counts, so ties share one
    rank instead of the first-seen entry winning. A set with a single usable value yields
    50.0 for it: it is neither above nor below a market that is only itself.
    """
    usable = {k: v for k, v in values.items() if v is not None}
    out: dict[str, float | None] = {k: None for k in values}
    if not usable:
        return out
    nums = sorted(usable.values())
    n = len(nums)
    for key, v in usable.items():
        below = sum(1 for x in nums if x < v)
        at_or_below = sum(1 for x in nums if x <= v)
        out[key] = round((below + at_or_below) / 2 / n * 100, 1)
    return out


def _blend(parts: list[tuple[float | None, float]]) -> float | None:
    """Weighted mean over the parts that have a value, weights renormalised. None if none."""
    live = [(v, w) for v, w in parts if v is not None]
    if not live:
        return None
    total_w = sum(w for _v, w in live)
    if total_w <= 0:
        return None
    return round(sum(v * w for v, w in live) / total_w, 1)


def margin_of_safety(symbol: str, snap: dict, settings: dict | None) -> float | None:
    """Margin of safety from the cached fundamentals and the last cached close.

    Cached-only on purpose: ``resolve_price`` would fall through to a live quote, which for
    a whole peer loop is exactly the fan-out this module must not cause.
    """
    close = latest_cached_close(symbol)
    if not close:
        return None
    ccy = snap.get("currency") or snap.get("financialCurrency")
    try:
        va = value_analysis(symbol, close["close"], ccy, None, settings)
    except Exception:  # noqa: BLE001 — one unvaluable peer must not sink the whole market
        return None
    return va.get("marginOfSafety")


def _value_metrics(symbols: list[str], settings: dict | None) -> tuple[dict[str, float | None], str | None]:
    """The value axis for the whole market on ONE shared basis, plus which basis that is.

    Margin of safety first; if fewer than half the market can be valued that way the axis
    would compare incomparables, so the whole set falls back to earnings yield (E/P) and
    then to book yield (B/P) — both "more is cheaper", like the margin of safety.
    """
    snaps = {s: ((get_cached_fundamentals(s) or {}).get("snapshot") or {}) for s in symbols}

    mos = {s: margin_of_safety(s, snaps[s], settings) for s in symbols}
    if sum(1 for v in mos.values() if v is not None) * 2 >= len(symbols):
        return mos, "margin-of-safety"

    def _yield_of(field: str) -> dict[str, float | None]:
        out: dict[str, float | None] = {}
        for s in symbols:
            m = snaps[s].get(field)
            out[s] = round(1 / m, 6) if isinstance(m, (int, float)) and m > 0 else None
        return out

    earnings = _yield_of("trailingPE")
    if any(v is not None for v in earnings.values()):
        return earnings, "earnings-yield"

    book = _yield_of("priceToBook")
    if any(v is not None for v in book.values()):
        return book, "book-yield"

    return {s: None for s in symbols}, None


def _quadrant(value_pct: float | None, strength_pct: float | None) -> str | None:
    """Which of the four value x strength corners the subject sits in (median = 50)."""
    if value_pct is None or strength_pct is None:
        return None
    cheap = value_pct >= 50
    leading = strength_pct >= 50
    if cheap and leading:
        return "cheap-and-leading"
    if cheap:
        return "cheap-but-lagging"
    if leading:
        return "expensive-but-leading"
    return "expensive-and-lagging"


def market_position(symbol: str, competitors: list[dict], returns_by_symbol: dict[str, dict],
                    range_key: str, settings: dict | None = None) -> dict | None:
    """Score every company in the market on value and strength and place the subject.

    `competitors` are the enriched peer rows (subject included) as assembled by
    market_analysis; `returns_by_symbol` maps a symbol to its per-window return map.

    Returns None when the market is too small to rank inside (a percentile against one or
    two companies says nothing). Otherwise a dict with a per-symbol `scores` map — merged
    onto the competitor rows by the caller — and the subject's `verdict`.
    """
    symbols = [c["symbol"] for c in competitors if c.get("symbol")]
    if len(symbols) < MIN_RANKABLE:
        return None

    by_symbol = {c["symbol"]: c for c in competitors if c.get("symbol")}

    # --- strength axis -----------------------------------------------------------------
    ret_pct = _percentiles({s: (returns_by_symbol.get(s) or {}).get(range_key) for s in symbols})
    growth_pct = _percentiles({s: by_symbol[s].get("revenueGrowth") for s in symbols})
    margin_pct = _percentiles({s: by_symbol[s].get("profitMargins") for s in symbols})

    strength = {
        s: _blend([(ret_pct[s], W_RETURN), (growth_pct[s], W_REV_GROWTH), (margin_pct[s], W_MARGIN)])
        for s in symbols
    }

    # --- value axis --------------------------------------------------------------------
    value_raw, value_basis = _value_metrics(symbols, settings)
    value = _percentiles(value_raw)

    # --- composite ---------------------------------------------------------------------
    scores: dict[str, dict] = {}
    for s in symbols:
        v, st = value[s], strength[s]
        composite = _blend([(v, 0.5), (st, 0.5)])
        scores[s] = {
            "valuePct": v,
            "strengthPct": st,
            "compositeScore": composite,
            "rank": None,  # filled below, once the whole market is scored
        }

    ranked = sorted(
        (s for s in symbols if scores[s]["compositeScore"] is not None),
        key=lambda s: scores[s]["compositeScore"],
        reverse=True,
    )
    for idx, s in enumerate(ranked):
        scores[s]["rank"] = idx + 1

    subj = scores.get(symbol) or {}
    subj_value, subj_strength = subj.get("valuePct"), subj.get("strengthPct")

    # Peers that are BOTH cheaper and stronger than the subject — the only ones that can be
    # called unambiguously better positioned without trading one axis off against the other.
    alternatives = [
        {
            "symbol": s,
            "name": by_symbol[s].get("name"),
            "currency": by_symbol[s].get("currency"),
            "valuePct": scores[s]["valuePct"],
            "strengthPct": scores[s]["strengthPct"],
            "compositeScore": scores[s]["compositeScore"],
            "rank": scores[s]["rank"],
        }
        for s in ranked
        if s != symbol
        and subj_value is not None and subj_strength is not None
        and scores[s]["valuePct"] is not None and scores[s]["strengthPct"] is not None
        and scores[s]["valuePct"] > subj_value
        and scores[s]["strengthPct"] > subj_strength
    ][:MAX_ALTERNATIVES]

    return {
        "scores": scores,
        "basis": {
            "horizon": range_key,
            "rankedCount": len(ranked),
            "valueBasis": value_basis,
            "weights": {"return": W_RETURN, "revenueGrowth": W_REV_GROWTH, "profitMargins": W_MARGIN},
        },
        "verdict": {
            "symbol": symbol,
            "rank": subj.get("rank"),
            "of": len(ranked),
            "valuePct": subj_value,
            "strengthPct": subj_strength,
            "compositeScore": subj.get("compositeScore"),
            "quadrant": _quadrant(subj_value, subj_strength),
            "strongerAlternatives": alternatives,
        },
    }

"""Historical combinations — was holding ONE company in this market ever the best you
could have done, and if not, which pairing at which split would have beaten it?

Concentrating on a single name inside a market is a bet that this name is the winner. This
module tests that bet against the record: it takes the subject and its closest competitors,
sweeps every mix on a 10% grid, rebalances once a year, and reports what each mix actually
returned — CAGR, volatility, worst drawdown — over 1, 3 or 5 years of cached closes.

It also answers *why* a combination won, which is the part a bare leaderboard hides. Three
mechanisms are distinguished:

* ``partner-outperformed`` — the mix won because the partner was simply the better company.
* ``rebalancing-bonus``    — the mix beat BOTH of its legs held alone. That is only possible
  when the legs move imperfectly together and the annual rebalance keeps selling the leg that
  ran ahead; the reported correlation is the evidence.
* ``risk-reduction``       — the mix gave up little or no return but cut the worst drawdown.

Hard limits, stated because they decide how much the output is worth:

* This is **backward-looking**. Picking the historically best split is curve-fitting; the
  ranking is a record of what happened, not a forecast, and the UI says so.
* **Price return only** — no dividends, no Swiss tax, no trading costs, no FX. Every mix is
  measured the same way, so the comparison between them is fair even though no single figure
  is a real-world after-tax outcome.
* **Cached closes only** (``price_cache``), like the rest of Market analysis: a name whose
  history has not been warmed yet is excluded and named, never silently dropped.
"""
from __future__ import annotations

from itertools import combinations

import numpy as np
import pandas as pd

from .competitors import competitors
from .fundamentals import get_cached_fundamentals
from .market_analysis import cached_closes
from ..reference.sector_etfs import sector_etf_for

# Weight grid: 10% steps, as coarse as the conclusion can bear. A finer grid would fit the
# past more tightly and say nothing more about the future.
GRID_STEPS = 10

# Competitors considered, largest first. Triples over more than this make the sweep quadratic
# in peers for no gain in insight — the interesting pairings are among the market's real names.
MAX_PEERS = 6

# Combinations reported back (best first) beyond the named highlights.
TOP_N = 8

# Trading days a window must have, as a fraction of the ~252/year it should have, before a
# symbol can take part. Below this the CAGR is being computed off a stub of history.
MIN_COVERAGE = 0.6

TRADING_DAYS = 252

# A combination has to beat solo by more than this (annualised) before the verdict calls it
# a real lead rather than grid noise.
MATERIAL_CAGR = 0.01
# ...and cut this much off the worst drawdown before "risk reduction" is claimed.
MATERIAL_DRAWDOWN = 0.05

YEARS_ALLOWED = (1, 3, 5)


def _aligned_prices(symbols: list[str], start: str) -> tuple[list[str], np.ndarray, list[str]]:
    """Closes for the symbols that have enough history, on their common trading dates.

    Returns (dates, prices as a T x K array, symbols kept in column order). Inner-joining the
    dates is what makes the mixes comparable: every leg is measured over the same calendar.
    """
    series: dict[str, dict[str, float]] = {}
    for sym in symbols:
        rows = cached_closes(sym, start)
        if len(rows) >= 2:
            series[sym] = {r["date"]: r["close"] for r in rows}
    if not series:
        return [], np.empty((0, 0)), []

    common = set.intersection(*(set(v) for v in series.values()))
    dates = sorted(common)
    if len(dates) < 2:
        return [], np.empty((0, 0)), []

    kept = list(series)
    prices = np.array([[series[s][d] for s in kept] for d in dates], dtype=float)
    return dates, prices, kept


def _year_segments(dates: list[str]) -> list[tuple[int, int]]:
    """Row ranges [start, end) per calendar year — the annual rebalancing points."""
    bounds: list[tuple[int, int]] = []
    start = 0
    for i in range(1, len(dates)):
        if dates[i][:4] != dates[i - 1][:4]:
            bounds.append((start, i))
            start = i
    bounds.append((start, len(dates)))
    return bounds


def _simulate(prices: np.ndarray, segments: list[tuple[int, int]], weights: np.ndarray) -> np.ndarray:
    """Value paths for every weight vector at once, rebalanced at each segment boundary.

    `weights` is M x K (each row sums to 1); the result is T x M, each column a portfolio
    starting at 1.0. Inside a segment the mix drifts with the prices; at the boundary it is
    reset to the target weights — which is what an annual rebalance does.
    """
    total = np.empty((prices.shape[0], weights.shape[0]), dtype=float)
    level = np.ones(weights.shape[0], dtype=float)
    for a, b in segments:
        # Each segment is measured from the PREVIOUS segment's last close, which is the day
        # the rebalance happens on; rebasing to `prices[a]` instead would silently drop the
        # move across the year boundary.
        base = prices[a - 1] if a > 0 else prices[a]
        seg = (prices[a:b] / base) @ weights.T
        total[a:b] = seg * level
        level = total[b - 1]
    return total


def _metrics(paths: np.ndarray, years: float) -> dict[str, np.ndarray]:
    """CAGR, annualised volatility, worst drawdown and return-per-unit-risk per column."""
    end = paths[-1]
    total_return = end - 1.0
    cagr = np.power(np.maximum(end, 1e-9), 1.0 / years) - 1.0

    daily = paths[1:] / paths[:-1] - 1.0
    vol = daily.std(axis=0, ddof=1) * np.sqrt(TRADING_DAYS) if daily.shape[0] > 1 else np.zeros_like(end)

    peak = np.maximum.accumulate(paths, axis=0)
    drawdown = (paths / peak - 1.0).min(axis=0)

    with np.errstate(divide="ignore", invalid="ignore"):
        per_risk = np.where(vol > 1e-9, cagr / vol, np.nan)

    return {"totalReturn": total_return, "cagr": cagr, "volatility": vol,
            "maxDrawdown": drawdown, "returnPerRisk": per_risk}


def _weight_vectors(k: int) -> list[np.ndarray]:
    """Every mix of k legs on the 10% grid with all legs strictly held.

    Singles and pairs are enumerated separately, so requiring every weight to be positive
    here is what keeps a "triple" from silently being a pair with a zero leg.
    """
    out: list[np.ndarray] = []
    if k == 1:
        return [np.array([1.0])]
    if k == 2:
        return [np.array([w / GRID_STEPS, 1 - w / GRID_STEPS]) for w in range(1, GRID_STEPS)]
    for a in range(1, GRID_STEPS - 1):
        for b in range(1, GRID_STEPS - a):
            c = GRID_STEPS - a - b
            out.append(np.array([a, b, c], dtype=float) / GRID_STEPS)
    return out


def _why(legs: list[dict], cagr: float, drawdown: float, solo_cagr: dict[str, float],
         subject: str, subject_drawdown: float | None) -> str:
    """Which mechanism made this mix beat holding the subject alone."""
    if len(legs) == 1:
        return "subject-led" if legs[0]["symbol"] == subject else "partner-outperformed"
    leg_cagrs = [solo_cagr.get(l["symbol"]) for l in legs]
    known = [c for c in leg_cagrs if c is not None]
    if known and cagr > max(known) + 1e-6:
        # Beating every one of its own legs cannot come from picking a winner — only from
        # rebalancing between legs that do not move together.
        return "rebalancing-bonus"

    # Order matters: a better partner is the plainer explanation, so it is offered before
    # "risk reduction", which is the right label only when the RETURN did not improve.
    partner = max((c for l, c in zip(legs, leg_cagrs) if l["symbol"] != subject and c is not None),
                  default=None)
    subj = solo_cagr.get(subject)
    if partner is not None and subj is not None and partner > subj and cagr > subj:
        return "partner-outperformed"

    if (subject_drawdown is not None and drawdown > subject_drawdown + MATERIAL_DRAWDOWN
            and cagr >= (subj if subj is not None else -9) - MATERIAL_CAGR):
        return "risk-reduction"
    return "mix-effect"


def _correlation(prices: np.ndarray, cols: tuple[int, ...]) -> float | None:
    """Correlation of the two legs' daily returns — the evidence behind a rebalancing bonus."""
    if len(cols) != 2:
        return None
    r = prices[1:, list(cols)] / prices[:-1, list(cols)] - 1.0
    if r.shape[0] < 3 or r[:, 0].std() == 0 or r[:, 1].std() == 0:
        return None
    return round(float(np.corrcoef(r[:, 0], r[:, 1])[0, 1]), 4)


def market_combos(symbol: str, years: int = 5) -> dict:
    """Sweep single / pair / triple mixes of this market's names over the trailing window."""
    years = years if years in YEARS_ALLOWED else 5
    start = (pd.Timestamp.utcnow().normalize() - pd.DateOffset(years=years)).strftime("%Y-%m-%d")

    comp = competitors(symbol)
    peers = [p for p in (comp.get("peers") or []) if p.get("symbol")]
    names = {p["symbol"]: p.get("name") for p in peers}
    if symbol not in names:
        snap = (get_cached_fundamentals(symbol) or {}).get("snapshot") or {}
        names[symbol] = snap.get("name") or symbol

    # Subject first, then the market's largest names (competitors() already ranks by CHF cap).
    candidates = [symbol] + [p["symbol"] for p in peers if p["symbol"] != symbol][:MAX_PEERS]

    dates, prices, kept = _aligned_prices(candidates, start)
    expected = years * TRADING_DAYS
    excluded = [{"symbol": s, "name": names.get(s),
                 "reason": "no cached price history for this window"}
                for s in candidates if s not in kept]

    if symbol not in kept:
        reason = "no cached price history for this stock yet"
    elif len(dates) < expected * MIN_COVERAGE:
        reason = "not enough cached history for this window yet"
    elif len(kept) < 2:
        # A "market" of one company cannot answer whether concentrating in it was wise.
        reason = "no comparable companies with cached history over this window yet"
    else:
        reason = None

    if reason:
        return {
            "symbol": symbol, "name": names.get(symbol), "years": years, "available": False,
            "reason": reason,
            "startDate": dates[0] if dates else None, "endDate": dates[-1] if dates else None,
            "tradingDays": len(dates), "universe": [], "excluded": excluded,
        }

    index = {s: i for i, s in enumerate(kept)}
    subj_col = index[symbol]
    # The realised window, not the requested one — a shorter common history must not be
    # annualised as if it were five full years.
    span_years = max((pd.Timestamp(dates[-1]) - pd.Timestamp(dates[0])).days / 365.25, 1e-6)
    segments = _year_segments(dates)

    # --- every mix on the grid -----------------------------------------------------------
    combos: list[tuple[tuple[int, ...], np.ndarray]] = []
    for size in (1, 2, 3):
        if size > len(kept):
            break
        for cols in combinations(range(len(kept)), size):
            for w in _weight_vectors(size):
                combos.append((cols, w))

    weights = np.zeros((len(combos), len(kept)), dtype=float)
    for i, (cols, w) in enumerate(combos):
        weights[i, list(cols)] = w

    paths = _simulate(prices, segments, weights)
    met = _metrics(paths, span_years)

    # Each name held alone — the baseline every mix is explained against.
    solo_cagr: dict[str, float] = {}
    solo_drawdown: dict[str, float] = {}
    for i, (cols, _w) in enumerate(combos):
        if len(cols) == 1:
            sym = kept[cols[0]]
            solo_cagr[sym] = float(met["cagr"][i])
            solo_drawdown[sym] = float(met["maxDrawdown"][i])

    def row(i: int) -> dict:
        cols, w = combos[i]
        legs = [{"symbol": kept[c], "name": names.get(kept[c]), "weight": round(float(x), 2)}
                for c, x in zip(cols, w)]
        cagr = float(met["cagr"][i])
        dd = float(met["maxDrawdown"][i])
        per_risk = met["returnPerRisk"][i]
        return {
            "legs": legs,
            "includesSubject": subj_col in cols,
            "totalReturn": round(float(met["totalReturn"][i]), 6),
            "cagr": round(cagr, 6),
            "volatility": round(float(met["volatility"][i]), 6),
            "maxDrawdown": round(dd, 6),
            "returnPerRisk": None if not np.isfinite(per_risk) else round(float(per_risk), 4),
            "correlation": _correlation(prices, cols),
            "why": _why(legs, cagr, dd, solo_cagr, symbol, solo_drawdown.get(symbol)),
        }

    order = np.argsort(-met["cagr"])
    solo_idx = next(i for i, (cols, _w) in enumerate(combos) if cols == (subj_col,))
    solo = row(solo_idx)
    solo_rank = int(np.where(order == solo_idx)[0][0]) + 1

    best_idx = int(order[0])
    finite = np.where(np.isfinite(met["returnPerRisk"]), met["returnPerRisk"], -np.inf)
    best_risk_idx = int(np.argmax(finite))

    # The literal question — "how should I combine THIS stock with another, at what split?".
    # `best` above may well be a competitor held alone, which is worth knowing but is a
    # different answer; this one is always a real mix that still holds the subject.
    with_subject_idx = next(
        (int(i) for i in order
         if subj_col in combos[i][0] and len(combos[i][0]) > 1),
        None,
    )

    # The sector ETF, priced the same way — "would the index have done it for you?".
    etf_sym = sector_etf_for(comp.get("sector"))
    etf = None
    if etf_sym:
        e_dates, e_prices, e_kept = _aligned_prices([etf_sym], start)
        if e_kept and len(e_dates) >= expected * MIN_COVERAGE:
            e_span = max((pd.Timestamp(e_dates[-1]) - pd.Timestamp(e_dates[0])).days / 365.25, 1e-6)
            e_path = _simulate(e_prices, _year_segments(e_dates), np.array([[1.0]]))
            e_met = _metrics(e_path, e_span)
            etf = {"symbol": etf_sym, "cagr": round(float(e_met["cagr"][0]), 6),
                   "volatility": round(float(e_met["volatility"][0]), 6),
                   "maxDrawdown": round(float(e_met["maxDrawdown"][0]), 6),
                   "totalReturn": round(float(e_met["totalReturn"][0]), 6)}

    best = row(best_idx)
    cagr_gap = round(best["cagr"] - solo["cagr"], 6)

    # Did concentration pay? Only a lead bigger than the grid's own noise counts as one.
    if solo_rank == 1 or cagr_gap <= MATERIAL_CAGR:
        verdict_key = "solo-held-up"
    else:
        verdict_key = "combination-led"

    # A mix that matched solo's return with a materially shallower drawdown — the answer to
    # "was concentrating worth the ride?" even when solo won on return.
    # It must still hold the subject — otherwise the claim would not be "your concentration
    # cost you the ride" but "a different portfolio would have been calmer", which is trivial.
    safer_idx = None
    eligible = np.where((met["cagr"] >= solo["cagr"] - MATERIAL_CAGR)
                        & (met["maxDrawdown"] > solo["maxDrawdown"] + MATERIAL_DRAWDOWN))[0]
    eligible = [i for i in eligible if i != solo_idx and subj_col in combos[i][0]]
    if eligible:
        safer_idx = int(max(eligible, key=lambda i: met["maxDrawdown"][i]))

    return {
        "symbol": symbol,
        "name": names.get(symbol),
        "sector": comp.get("sector"),
        "industry": comp.get("industry"),
        "years": years,
        "available": True,
        "startDate": dates[0],
        "endDate": dates[-1],
        "tradingDays": len(dates),
        "spanYears": round(span_years, 2),
        "gridStepPct": round(1 / GRID_STEPS, 2),
        "rebalancing": "annual",
        "combinationsTested": len(combos),
        "universe": [{"symbol": s, "name": names.get(s),
                      "soloCagr": round(solo_cagr[s], 6),
                      "soloMaxDrawdown": round(solo_drawdown[s], 6)} for s in kept],
        "excluded": excluded,
        "solo": solo,
        "soloRank": solo_rank,
        "best": best,
        "bestWithSubject": row(with_subject_idx) if with_subject_idx is not None else None,
        "bestRiskAdjusted": row(best_risk_idx),
        "safestMatch": row(safer_idx) if safer_idx is not None else None,
        "sectorEtf": etf,
        "top": [row(int(i)) for i in order[:TOP_N]],
        "verdict": {
            "key": verdict_key,
            "soloRank": solo_rank,
            "of": len(combos),
            "cagrGap": cagr_gap,
            "drawdownGap": round(best["maxDrawdown"] - solo["maxDrawdown"], 6),
        },
    }

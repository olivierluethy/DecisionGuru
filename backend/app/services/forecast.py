"""Forecast / Prognose engine — issue #8 (the "Motivationshebel").

Turns the point-in-time Decisions view into a forward-looking timeline: *when* each
holding is likely worth acting on, *what* to do about it today, and — the motivation
lever — *how much money each day of inaction costs* according to the historical return
gap between the holding and the benchmark it would be reinvested into.

Everything here is composed from surfaces that already exist and are already cached, so a
forecast is as cheap as a Decisions call and never blocks on the network:

  · recommend.build_recommendations  — the ranked buy/hold/sell verdicts + reinvest targets
  · projection.benchmark_cagr        — the benchmark's trailing total-return CAGR
  · rivalry.rivalry_check            — a competitor's straight-line crossover date
  · news.get_news                    — the latest cached headline per flagged holding

No new market data, no invented earnings dates (the provider exposes none): predicted
timing is synthesised from conviction (how soon to act) and rivalry crossover dates (a
real dated extrapolation), and every figure is labelled as a historical-return estimate.
"""
from __future__ import annotations

import pandas as pd

from ..core.timefmt import iso_now
from .news import get_news
from .projection import benchmark_cagr
from .recommend import build_recommendations
from .rivalry import rivalry_check

# How soon to act, by conviction — the offset (in days) at which a sell/switch lands on the
# timeline. High conviction is "in the next day or two"; low conviction sits a week out.
_CONV_OFFSET = {"high": 1, "medium": 3, "low": 6}

# The forward window the timeline covers. Immediate actions cluster in the first days;
# rivalry crossovers are shown out to the edge of this window as watch items.
DEFAULT_HORIZON_DAYS = 30

# A news headline older than this is not surfaced as a "this happened" timeline entry —
# it is no longer news. It still rides along on its holding's action card if newer.
_NEWS_RECENT_DAYS = 7

_DAYS_PER_YEAR = 365.25


def _naive(ts) -> pd.Timestamp:
    """A tz-naive UTC Timestamp, whatever the input's awareness. Keeps date arithmetic
    from tripping over pandas' refusal to mix tz-aware and tz-naive timestamps."""
    t = pd.Timestamp(ts)
    if t.tzinfo is not None:
        t = t.tz_convert("UTC").tz_localize(None)
    return t


def _utc_today() -> pd.Timestamp:
    return _naive(pd.Timestamp.now("UTC")).normalize()


def _daily_return(cagr: float | None) -> float | None:
    """Annualised CAGR → the equivalent constant daily return."""
    if cagr is None:
        return None
    try:
        return (1.0 + cagr) ** (1.0 / _DAYS_PER_YEAR) - 1.0
    except (ValueError, OverflowError):
        return None


def _daily_drag_chf(value_chf: float, hold_cagr: float | None, etf_cagr: float | None) -> float | None:
    """Money lost per day by holding a laggard instead of the benchmark, from history.

    The estimate is the value of the position times the daily return gap between the
    benchmark (what the proceeds would earn) and the holding. A holding with no CAGR yet
    is treated as flat (0% p.a.) — a conservative floor, since the benchmark alone then
    sets the gap. Returns None when the benchmark's own return is unknown, 0.0 when the
    holding is expected to keep pace or beat it.
    """
    if value_chf <= 0:
        return None
    etf_daily = _daily_return(etf_cagr)
    if etf_daily is None:
        return None
    hold_daily = _daily_return(hold_cagr) or 0.0
    drag = etf_daily - hold_daily
    if drag <= 0:
        return 0.0
    return round(value_chf * drag, 2)


def _latest_news(symbol: str) -> dict | None:
    """The single most recent cached headline for a symbol, or None. Never raises."""
    try:
        data = get_news(symbol, limit=1)
    except Exception:  # noqa: BLE001 — news is a nice-to-have, never fail the forecast on it
        return None
    items = data.get("items") or []
    if not items:
        return None
    it = items[0]
    return {
        "title": it.get("title"),
        "link": it.get("link"),
        "publisher": it.get("publisher"),
        "publishedAt": it.get("publishedAt"),
    }


def _news_is_recent(published_at: str | None, today: pd.Timestamp) -> bool:
    if not published_at:
        return False
    try:
        when = _naive(published_at).normalize()
    except (ValueError, TypeError):
        return False
    return 0 <= (today - when).days <= _NEWS_RECENT_DAYS


def _rivalry_watch(instrument_id: int, symbol: str, settings: dict,
                   today: pd.Timestamp, horizon_days: int) -> dict | None:
    """A 'watch' event for the nearest competitor on track to overtake this holding,
    when that crossover falls inside the forecast window. Defensive: any gap in the
    rivalry data simply yields no event."""
    try:
        rc = rivalry_check(instrument_id, settings)
    except Exception:  # noqa: BLE001
        return None
    if not rc or not rc.get("available"):
        return None
    threat = rc.get("nearestThreat")
    if not threat:
        return None
    days = threat.get("daysToCrossover")
    crossover = threat.get("crossoverDate")
    if crossover is None or days is None or days < 0 or days > horizon_days:
        return None
    rival = threat.get("symbol")
    return {
        "id": f"rivalry-{instrument_id}",
        "date": crossover,
        "offsetDays": int(days),
        "kind": "watch",
        "symbol": symbol,
        "name": rc.get("name"),
        "title": f"{rival} on track to overtake {symbol}",
        "detail": (
            f"On the last {rc.get('speedWindowDays', 90)} trading days, {rival} is closing on "
            f"{symbol} and — extrapolated straight-line — draws level around this date. A cue to "
            f"re-check the switch, not a certainty."
        ),
        "confidence": "low",
        "opportunityCostPerDayCHF": None,
        "target": {"symbol": rival, "name": threat.get("name")},
        "news": None,
        "status": "upcoming",
        "basis": ["rivalry"],
    }


def build_forecast(settings: dict, horizon_days: int = DEFAULT_HORIZON_DAYS) -> dict:
    horizon_days = max(1, min(int(horizon_days), 120))
    today = _utc_today()

    data = build_recommendations(settings)
    recs = data["recommendations"]
    cash_signal = data.get("cashSignal")
    summary = data["summary"]

    # Trailing benchmark CAGR, memoised per benchmark symbol (usually one for the portfolio).
    _cagr: dict[str, float | None] = {}

    def etf_cagr(sym: str) -> float | None:
        if sym not in _cagr:
            try:
                _cagr[sym] = benchmark_cagr(sym)
            except Exception:  # noqa: BLE001
                _cagr[sym] = None
        return _cagr[sym]

    events: list[dict] = []
    actions: list[dict] = []
    total_daily = 0.0
    at_risk = 0.0

    def add_news_event(symbol: str, name: str | None, news: dict | None) -> None:
        """Surface a genuinely recent headline as a 'this happened' timeline entry."""
        if not news or not _news_is_recent(news.get("publishedAt"), today):
            return
        events.append({
            "id": f"news-{symbol}-{news.get('publishedAt')}",
            "date": (news.get("publishedAt") or "")[:10],
            "offsetDays": 0,
            "kind": "news",
            "symbol": symbol,
            "name": name,
            "title": news.get("title") or f"{symbol} in the news",
            "detail": (
                f"{news.get('publisher') or 'Headline'} — a fresh development on {symbol}. "
                f"Re-check the call above against it."
            ),
            "confidence": "medium",
            "opportunityCostPerDayCHF": None,
            "target": None,
            "news": news,
            "status": "occurred",
            "basis": ["news"],
        })

    for r in recs:
        action = r["action"]
        sym = r["symbol"]
        name = r["name"]
        conv = r["conviction"]
        value = r["currentValueCHF"] or 0.0

        if action == "sell":
            per_day = _daily_drag_chf(value, r.get("holdingCagr"), etf_cagr(r["benchmarkSymbol"]))
            total_daily += per_day or 0.0
            at_risk += value
            offset = _CONV_OFFSET.get(conv, 4)
            date = (today + pd.Timedelta(days=offset)).strftime("%Y-%m-%d")
            target = {"symbol": r["benchmarkSymbol"], "name": r["benchmarkName"]}
            news = _latest_news(sym)

            events.append({
                "id": f"sell-{r['instrumentId']}",
                "date": date,
                "offsetDays": offset,
                "kind": "sell",
                "symbol": sym,
                "name": name,
                "title": f"Sell / trim {sym}",
                "detail": r["reason"],
                "confidence": conv,
                "opportunityCostPerDayCHF": per_day,
                "target": target,
                "news": news,
                "status": "upcoming",
                "basis": _basis(r),
            })
            events.append({
                "id": f"reinvest-{r['instrumentId']}",
                "date": date,
                "offsetDays": offset,
                "kind": "reinvest",
                "symbol": target["symbol"],
                "name": target["name"],
                "title": f"Reinvest the proceeds into {target['symbol']}",
                "detail": (
                    f"Put the {sym} proceeds to work in {target['name']} ({target['symbol']}) — "
                    f"the benchmark the switch is measured against."
                ),
                "confidence": conv,
                "opportunityCostPerDayCHF": None,
                "target": target,
                "news": None,
                "status": "upcoming",
                "basis": ["reinvest"],
            })

            actions.append({
                "id": f"act-sell-{r['instrumentId']}",
                "kind": "sell",
                "instrumentId": r["instrumentId"],
                "symbol": sym,
                "name": name,
                "title": f"Sell {sym} → {target['symbol']}",
                "detail": r["reason"],
                "conviction": conv,
                "opportunityCostPerDayCHF": per_day,
                "opportunityCostCumulativeCHF": round(r.get("opportunityCostCHF") or 0.0, 2),
                "currentValueCHF": round(value, 2),
                "target": target,
            })

            add_news_event(sym, name, news)
            watch = _rivalry_watch(r["instrumentId"], sym, settings, today, horizon_days)
            if watch:
                events.append(watch)

        elif action == "buy":
            # Buy-more (undervalued, sound): a watch/top-up cue, dated a touch later than a
            # sell since there's no clock running against you the way a sell-zone holding has.
            offset = _CONV_OFFSET.get(conv, 4) + 1
            date = (today + pd.Timedelta(days=offset)).strftime("%Y-%m-%d")
            events.append({
                "id": f"buy-{r['instrumentId']}",
                "date": date,
                "offsetDays": offset,
                "kind": "buy",
                "symbol": sym,
                "name": name,
                "title": f"Consider topping up {sym}",
                "detail": r["reason"],
                "confidence": conv,
                "opportunityCostPerDayCHF": None,
                "target": None,
                "news": _latest_news(sym),
                "status": "upcoming",
                "basis": _basis(r),
            })

    if cash_signal:
        actions.insert(0, {
            "id": "act-deploy-cash",
            "kind": "deploy-cash",
            "instrumentId": None,
            "symbol": cash_signal["symbol"],
            "name": cash_signal["name"],
            "title": f"Deploy idle cash into {cash_signal['symbol']}",
            "detail": cash_signal["reason"],
            "conviction": "medium",
            "opportunityCostPerDayCHF": None,
            "opportunityCostCumulativeCHF": None,
            "currentValueCHF": round(cash_signal.get("cashCHF") or 0.0, 2),
            "target": {"symbol": cash_signal["symbol"], "name": cash_signal["name"]},
        })
        events.append({
            "id": "deploy-cash",
            "date": today.strftime("%Y-%m-%d"),
            "offsetDays": 0,
            "kind": "buy",
            "symbol": cash_signal["symbol"],
            "name": cash_signal["name"],
            "title": f"Deploy {_chf(cash_signal.get('cashCHF'))} idle cash",
            "detail": cash_signal["reason"],
            "confidence": "medium",
            "opportunityCostPerDayCHF": None,
            "target": {"symbol": cash_signal["symbol"], "name": cash_signal["name"]},
            "news": None,
            "status": "due",
            "basis": ["cash"],
        })

    # Chronological, with same-day ordering that reads like a to-do: what already happened
    # (news) first, then the actions, then downstream reinvest/watch cues.
    _kind_rank = {"news": 0, "sell": 1, "buy": 2, "reinvest": 3, "watch": 4}
    events.sort(key=lambda e: (e["date"], _kind_rank.get(e["kind"], 9)))

    return {
        "generatedAt": iso_now(),
        "horizonDays": horizon_days,
        "dailyOpportunityCostCHF": round(total_daily, 2),
        "atRiskValueCHF": round(at_risk, 2),
        "today": {"actions": actions, "count": len(actions)},
        "timeline": events,
        "summary": {
            "flagged": len(actions),
            "sells": summary["counts"].get("sell", 0),
            "buys": summary["counts"].get("buy", 0),
            "holds": summary["counts"].get("hold", 0),
            "portfolioValueCHF": summary.get("portfolioValueCHF", 0.0),
            "idleCashCHF": summary.get("idleCashCHF", 0.0),
            "reallocatableCHF": summary.get("reallocatableCHF", 0.0),
        },
    }


def _basis(rec: dict) -> list[str]:
    """The signals behind a recommendation, for the event's provenance chips."""
    tags: list[str] = ["valuation"]
    v = rec.get("verdict") or {}
    drivers = v.get("drivers") or {}
    if drivers.get("marginOfSafetyPct") is not None:
        tags.append("margin-of-safety")
    if (rec.get("opportunityCostCHF") or 0) > 0:
        tags.append("benchmark-lag")
    return tags


def _chf(v: float | None) -> str:
    if v is None:
        return "CHF 0"
    return f"CHF {v:,.0f}".replace(",", "'")

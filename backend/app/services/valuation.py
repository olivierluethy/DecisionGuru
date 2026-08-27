"""Value-investing analysis — intrinsic value + a Buffett-style quality scorecard.

From the cached fundamentals it estimates what a share is worth today (Graham number,
Graham growth formula, a two-stage owner-earnings DCF), the growth the market is pricing
in (reverse DCF), a margin of safety vs the live price, a plausible fundamentals-supported
return, and a 6-point quality score. Every figure is None-safe and explicitly an estimate —
nothing here is investment advice."""
from __future__ import annotations

import math

from . import fundamentals as fund

DISCOUNT_RATE = 0.09
TERMINAL_GROWTH = 0.025
DCF_YEARS = 10
GROWTH_CAP = 0.15

# Default band multipliers (overridable per-user via settings["valuation"]).
DEFAULT_MOS = 0.30
OVERVALUED_PREMIUM = 0.20
SIGNIFICANT_OVERVALUED_PREMIUM = 0.40


def _val_cfg(settings: dict | None) -> dict:
    """Pull the value-investing knobs from settings with safe fallbacks so the engine
    works even when called without a settings blob (e.g. bulk screening)."""
    v = (settings or {}).get("valuation") or {}
    return {
        "mos": float(v.get("marginOfSafety", DEFAULT_MOS)),
        "disc": float(v.get("discountRate", DISCOUNT_RATE)),
        "tg": float(v.get("terminalGrowth", TERMINAL_GROWTH)),
        "ov": float(v.get("overvaluedPremium", OVERVALUED_PREMIUM)),
        "sig": float(v.get("significantOvervaluedPremium", SIGNIFICANT_OVERVALUED_PREMIUM)),
    }


def classify_band(price: float | None, fair_value: float | None, cfg: dict) -> dict | None:
    """Map a live price onto the fair-value bands. Returns the band key, a plain-language
    label, the boundary prices, and the buy/fair/overvalued/sell zone edges used to shade
    the price chart. None when there's no fair value or price to place."""
    if not fair_value or fair_value <= 0 or not price or price <= 0:
        return None
    entry = fair_value * (1 - cfg["mos"])          # attractive buy target
    over = fair_value * (1 + cfg["ov"])            # overvalued threshold
    sig = fair_value * (1 + cfg["sig"])            # significantly overvalued / sell zone
    if price <= entry:
        band, label = "undervalued", "Undervalued"
    elif price >= sig:
        band, label = "significantly-overvalued", "Significantly overvalued"
    elif price >= over:
        band, label = "overvalued", "Overvalued"
    else:
        band, label = "fair", "Fairly valued"
    premium = round(price / fair_value - 1, 4)  # +ve = trading above fair value
    return {
        "band": band,
        "label": label,
        "premiumToFair": premium,
        "entryTarget": round(entry, 2),
        "fairValue": round(fair_value, 2),
        "overvaluedAt": round(over, 2),
        "sellZoneAt": round(sig, 2),
        # Zone edges for the price chart's shaded ReferenceAreas (buy ≤ entry,
        # fair (entry..over), overvalued (over..sig), sell ≥ sig).
        "zones": {
            "buy": [0.0, round(entry, 2)],
            "fair": [round(entry, 2), round(over, 2)],
            "overvalued": [round(over, 2), round(sig, 2)],
            "sell": [round(sig, 2), round(sig * 1.6, 2)],
        },
        "marginOfSafetyPct": cfg["mos"],
    }


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _pct(v: float | None) -> str:
    return f"{v * 100:.1f}%" if v is not None else "n/a"


def _hist_income_cagr(hist: list[dict]) -> float | None:
    pts = sorted([h for h in hist if h.get("netIncome") not in (None, 0)], key=lambda h: h["year"])
    if len(pts) < 2:
        return None
    a, b, n = pts[0]["netIncome"], pts[-1]["netIncome"], pts[-1]["year"] - pts[0]["year"]
    if a <= 0 or b <= 0 or n <= 0:
        return None
    return (b / a) ** (1 / n) - 1


def _dcf(eps0: float | None, g: float, r: float = DISCOUNT_RATE, years: int = DCF_YEARS,
         tg: float = TERMINAL_GROWTH, cap: bool = True) -> float | None:
    if eps0 is None or eps0 <= 0:
        return None
    if cap:
        g = _clamp(g, 0.0, GROWTH_CAP)
    if g >= r:
        g = r - 0.001  # keep the terminal value finite
    pv, e = 0.0, eps0
    for yr in range(1, years + 1):
        e *= (1 + g)
        pv += e / ((1 + r) ** yr)
    terminal = e * (1 + tg) / (r - tg)
    return pv + terminal / ((1 + r) ** years)


def _pick_growth(snap: dict, hist: list[dict]) -> tuple[float, float | None]:
    """A stable growth estimate. Prefers the multi-year income CAGR; falls back to revenue
    growth; treats single-period figures beyond ±50% as anomalies (low-base / one-offs) and
    ignores them. Returns (growth_used_before_clamp, raw_reported_earnings_growth)."""
    raw_eg = snap.get("earningsGrowth")
    candidates: list[float] = []
    hist_cagr = _hist_income_cagr(hist)
    if hist_cagr is not None:
        candidates.append(hist_cagr)
    rg = snap.get("revenueGrowth")
    if rg is not None and abs(rg) <= 0.5:
        candidates.append(rg)
    if raw_eg is not None and abs(raw_eg) <= 0.5:
        candidates.append(raw_eg)
    if not candidates:
        return 0.0, raw_eg
    candidates.sort()
    return candidates[len(candidates) // 2], raw_eg


def _confidence(snap: dict, models: dict, price: float | None) -> tuple[str, list[str]]:
    """Rate how much to trust the earnings-based value, and say why not."""
    eps, fwd = snap.get("trailingEps"), snap.get("forwardEps")
    sector = snap.get("sector") or ""
    flags: list[str] = []
    conf = "high"

    def demote(to: str) -> str:
        order = {"high": 2, "medium": 1, "low": 0}
        return to if order[to] < order[conf] else conf

    if eps is None or eps <= 0:
        flags.append("No positive trailing earnings — an earnings-based value is unreliable here.")
        conf = demote("low")
    elif eps <= 0.15 or (fwd and eps and fwd > eps * 1.8):
        flags.append(
            "Trailing earnings look depressed versus the forward estimate — earnings models "
            "understate a company whose profits are at a cyclical low or expected to recover."
        )
        conf = demote("low")

    vals = [v for v in models.values() if v and v > 0]
    if len(vals) >= 2 and min(vals) > 0 and max(vals) / min(vals) > 3:
        flags.append("The valuation models disagree widely — read the midpoint as a rough guide, not a target.")
        conf = demote("low")

    if sector in ("Real Estate", "Financial Services", "Financials", "Banks"):
        p2b = snap.get("priceToBook")
        book_note = f" It trades at {p2b:.2f}× book." if isinstance(p2b, (int, float)) else ""
        flags.append(
            f"{sector} is better judged on net asset value / book than on an earnings DCF.{book_note}"
        )
        conf = demote("medium")

    return conf, flags


def _implied_growth(eps0: float | None, price: float | None, r: float = DISCOUNT_RATE) -> float | None:
    """Reverse DCF: the constant growth rate that makes the DCF equal today's price."""
    if not eps0 or eps0 <= 0 or not price or price <= 0:
        return None
    lo, hi = -0.10, 0.40
    for _ in range(64):
        mid = (lo + hi) / 2
        v = _dcf(eps0, mid, r=r, cap=False)
        if v is None:
            return None
        if v < price:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def value_analysis(symbol: str, price: float | None, currency: str | None = None,
                   data: dict | None = None, settings: dict | None = None) -> dict:
    # `data` lets callers (e.g. the screener) pass an already-loaded fundamentals payload
    # so a bulk screen never re-fetches from the rate-limited provider. `settings` carries
    # the per-user valuation knobs (margin of safety, discount rate, band thresholds).
    cfg = _val_cfg(settings)
    data = data if data is not None else (fund.get_fundamentals(symbol) or {})
    snap = data.get("snapshot") or {}
    hist = data.get("history") or []
    ccy = currency or snap.get("currency")

    eps, fwd_eps = snap.get("trailingEps"), snap.get("forwardEps")
    p2b, roe, margins = snap.get("priceToBook"), snap.get("returnOnEquity"), snap.get("profitMargins")
    dy = snap.get("dividendYield")
    dy = (dy / 100) if (dy and dy > 1) else dy
    payout, debt, ebitda = snap.get("payoutRatio"), snap.get("totalDebt"), snap.get("ebitda")

    g_used_raw, g_reported = _pick_growth(snap, hist)
    g = _clamp(g_used_raw, -0.05, GROWTH_CAP)
    bvps = (price / p2b) if (p2b and price and p2b > 0) else None
    base_eps = eps if (eps and eps > 0) else fwd_eps

    models: dict[str, float] = {}
    if eps and eps > 0 and bvps and bvps > 0:
        models["grahamNumber"] = round(math.sqrt(22.5 * eps * bvps), 2)
    if eps and eps > 0:
        models["grahamGrowth"] = round(eps * (8.5 + 2 * min(max(g * 100, 0), 15)), 2)
    dcf = _dcf(base_eps, g, r=cfg["disc"], tg=cfg["tg"])
    if dcf:
        models["dcf"] = round(dcf, 2)

    vals = sorted(v for v in models.values() if v and v > 0)
    intrinsic = {
        "low": round(vals[0], 2) if vals else None,
        "mid": round(vals[len(vals) // 2], 2) if vals else None,
        "high": round(vals[-1], 2) if vals else None,
    }
    mos = round(intrinsic["mid"] / price - 1, 4) if (intrinsic["mid"] and price) else None
    implied_g = _implied_growth(base_eps, price, r=cfg["disc"])

    # Fair-value bands + attractive entry target. fairValue is the model midpoint; the
    # bands turn it into a plain buy/fair/overvalued/sell verdict the UI shades on charts.
    fair_value = intrinsic.get("mid")
    band = classify_band(price, fair_value, cfg)

    def chk(label: str, ok: bool, detail: str) -> dict:
        return {"label": label, "pass": bool(ok), "detail": detail}

    de = (debt / ebitda) if (debt and ebitda and ebitda > 0) else None
    hist_cagr = _hist_income_cagr(hist)
    checks = [
        chk("Return on equity ≥ 15%", roe is not None and roe >= 0.15, _pct(roe)),
        chk("Net margin ≥ 10%", margins is not None and margins >= 0.10, _pct(margins)),
        chk("Earnings growing", g_used_raw > 0, _pct(g_used_raw)),
        chk("Debt / EBITDA ≤ 3", de is not None and de <= 3, f"{de:.1f}x" if de is not None else "n/a"),
        chk("Payout sustainable ≤ 70%", payout is not None and 0 <= payout <= 0.7, _pct(payout)),
        chk("Positive long-run earnings trend", hist_cagr is not None and hist_cagr > 0, _pct(hist_cagr)),
    ]

    confidence, flags = _confidence(snap, models, price)

    return {
        "symbol": symbol,
        "currency": ccy,
        "price": price,
        "growthUsed": round(g, 4),
        "growthRaw": round(g_reported, 4) if g_reported is not None else None,
        "models": models,
        "intrinsic": intrinsic,
        "marginOfSafety": mos,
        "fairValue": fair_value,
        "entryTarget": band["entryTarget"] if band else None,
        "band": band,
        "impliedGrowth": round(implied_g, 4) if implied_g is not None else None,
        "supportableReturn": round((g or 0) + (dy or 0), 4),
        "quality": {"score": sum(1 for c in checks if c["pass"]), "max": len(checks), "checks": checks},
        "assumptions": {"discountRate": DISCOUNT_RATE, "terminalGrowth": TERMINAL_GROWTH, "years": DCF_YEARS},
        "confidence": confidence,
        "flags": flags,
        "sector": snap.get("sector"),
        "priceToBook": p2b,
        "eps": eps,
        "forwardEps": fwd_eps,
        "bookValuePerShare": round(bvps, 2) if bvps else None,
        "roe": roe,
        "dividendYield": dy,
        "hasData": bool(models) or eps is not None,
    }

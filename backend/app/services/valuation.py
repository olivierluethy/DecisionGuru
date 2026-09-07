"""Value-investing analysis — intrinsic value + a Buffett-style quality scorecard.

From the cached fundamentals it estimates what a share is worth today (Graham number,
Graham growth formula, a two-stage owner-earnings DCF), the growth the market is pricing
in (reverse DCF), a margin of safety vs the live price, a plausible fundamentals-supported
return, and a 6-point quality score. Every figure is None-safe and explicitly an estimate —
nothing here is investment advice."""
from __future__ import annotations

import math
import statistics
from datetime import date as _date

from . import fundamentals as fund
from . import fx
from . import quality as quality_mod
from . import earning_power as ep
from ..providers.base import normalize_minor_currency


def _per_share_series(hist: list[dict], balance: dict | None, cashflow: dict | None,
                      norm_fn) -> tuple[list, list]:
    """Per-share net-income and free-cash-flow series (balance-sheet shares → price-independent,
    minor-unit normalized), aligned by fiscal year. Feeds the Area 3 earning-power engine."""
    bal = {y.get("year"): y for y in (balance or {}).get("years") or []}
    cf = {y.get("year"): y for y in (cashflow or {}).get("years") or []}
    years = sorted(y for y in {h.get("year") for h in (hist or [])} if y)
    ni_by_year = {h.get("year"): h.get("netIncome") for h in (hist or [])}
    eps_s, fcf_s = [], []
    for y in years:
        sh = (bal.get(y) or {}).get("sharesOutstanding")
        ni, f = ni_by_year.get(y), (cf.get(y) or {}).get("freeCashFlow")
        eps_s.append(norm_fn(ni / sh) if (ni is not None and sh) else None)
        fcf_s.append(norm_fn(f / sh) if (f is not None and sh) else None)
    return eps_s, fcf_s

DISCOUNT_RATE = 0.09
TERMINAL_GROWTH = 0.025
DCF_YEARS = 10
GROWTH_CAP = 0.15

_CONF_RANK = {"high": 2, "medium": 1, "low": 0}

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


# --- Area 2: business-type routing + abstention ---------------------------------------
# Businesses whose intrinsic value is asset/book, not an earnings-growth DCF. An earnings model
# must never run as the OFFICIAL fair value for these (mark-dominated or revaluation-driven GAAP
# earnings) — they route to NAV/book, or abstain when the book data can't be trusted.
_BOOK_SECTORS = {
    "financial services", "financials", "financial", "banks", "bank",
    "insurance", "capital markets", "real estate", "reit", "mortgage reit",
}


def _framework_for_sector(sector: str | None) -> str:
    return "book_nav" if (sector or "").strip().lower() in _BOOK_SECTORS else "earnings"


def _positive_earnings_years(hist: list[dict]) -> int:
    return sum(1 for h in hist if isinstance(h.get("netIncome"), (int, float)) and h["netIncome"] > 0)


def validate_book_value(price: float | None, p2b: float | None, nav: float | None) -> tuple[bool, str | None]:
    """Guard book/NAV data before trusting it (your point 2). `nav` is the balance-sheet book
    per share (equity ÷ shares), already price-independent and minor-unit normalized. We reject:
      - no usable equity/shares;
      - an absurd price-to-book (Berkshire's 0.001×: per-A-share book vs the B-share price);
      - a balance-sheet book that disagrees with the feed's price-to-book book (a share-class /
        stale-data signal, e.g. Swatch's registered-vs-bearer count).
    A cross-listing where reporting ≠ trading currency already has nav=None upstream (the same
    guard the Graham number uses), so it abstains here too."""
    if nav is None or nav <= 0:
        return False, "no usable balance-sheet book value"
    if not p2b or p2b <= 0.05 or p2b > 50:
        return False, "implausible price-to-book — corrupt or share-class book data"
    if price and price > 0:
        implied = price / p2b
        if implied > 0 and not (0.6 <= nav / implied <= 1.7):
            return False, "balance-sheet and feed book values disagree — possible share-class / stale data"
    return True, None


def zone_edges(fair_value: float, cfg: dict) -> dict:
    """Buy/fair/overvalued/sell edges from a fair value + user cfg. Single source of the
    zone geometry, shared by classify_band and the historical reconstruction."""
    entry = fair_value * (1 - cfg["mos"])
    over = fair_value * (1 + cfg["ov"])
    sig = fair_value * (1 + cfg["sig"])
    return {
        "entryTarget": round(entry, 2),
        "overvaluedAt": round(over, 2),
        "sellZoneAt": round(sig, 2),
        "zones": {
            "buy": [0.0, round(entry, 2)],
            "fair": [round(entry, 2), round(over, 2)],
            "overvalued": [round(over, 2), round(sig, 2)],
            "sell": [round(sig, 2), round(sig * 1.6, 2)],
        },
    }


def compute_models(eps: float | None, bvps: float | None, base_eps: float | None,
                   g: float, normalized_fcf_ps: float | None, cfg: dict) -> dict[str, float]:
    """The four intrinsic-value models, returning only those that produced a positive
    value. Identical to the inline block in value_analysis (single source of the formulas)."""
    m: dict[str, float] = {}
    if eps and eps > 0 and bvps and bvps > 0:
        m["grahamNumber"] = round(math.sqrt(22.5 * eps * bvps), 2)
    if eps and eps > 0:
        m["grahamGrowth"] = round(eps * (8.5 + 2 * min(max(g * 100, 0), 15)), 2)
    dcf = _dcf(base_eps, g, r=cfg["disc"], tg=cfg["tg"])
    if dcf:
        m["dcf"] = round(dcf, 2)
    fcf_dcf = _dcf(normalized_fcf_ps, g, r=cfg["disc"], tg=cfg["tg"])
    if fcf_dcf:
        m["fcf"] = round(fcf_dcf, 2)
    return m


def classify_band(price: float | None, fair_value: float | None, cfg: dict) -> dict | None:
    """Map a live price onto the fair-value bands. Returns the band key, a plain-language
    label, the boundary prices, and the buy/fair/overvalued/sell zone edges used to shade
    the price chart. None when there's no fair value or price to place."""
    if not fair_value or fair_value <= 0 or not price or price <= 0:
        return None
    edges = zone_edges(fair_value, cfg)
    entry = edges["entryTarget"]
    over = edges["overvaluedAt"]
    sig = edges["sellZoneAt"]
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
        "entryTarget": entry,
        "fairValue": round(fair_value, 2),
        "overvaluedAt": over,
        "sellZoneAt": sig,
        # Zone edges for the price chart's shaded ReferenceAreas (buy ≤ entry,
        # fair (entry..over), overvalued (over..sig), sell ≥ sig).
        "zones": edges["zones"],
        "marginOfSafetyPct": cfg["mos"],
    }


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _median(vals: list[float]) -> float:
    """Robust midpoint of the surviving model values. For an even count this is the
    average of the two middle values (so two models {100, 200} → 150), NOT the higher
    of the two as an index-median (`vals[len//2]`) would wrongly pick — that bias
    inflated fair value and suppressed sell signals (see VALUE_INVESTING_AUDIT §3 T-4)."""
    return statistics.median(vals)


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
    """Two-stage owner-earnings DCF. Growth FADES linearly from the initial rate ``g`` (year
    1) to the terminal rate ``tg`` (final year), then a Gordon perpetuity at ``tg``.

    A finite explicit horizon converges for any initial growth — including g > r — so a
    high-quality compounder is no longer clipped to r−0.001 (the old cliff, AUDIT §3 F-5).
    The only true singularity is the terminal: it requires r > tg, else we cannot value it."""
    if eps0 is None or eps0 <= 0:
        return None
    if r <= tg:
        return None  # Gordon terminal undefined/negative when discount ≤ terminal growth
    g0 = _clamp(g, 0.0, GROWTH_CAP) if cap else g
    pv, e = 0.0, eps0
    for yr in range(1, years + 1):
        frac = (yr - 1) / (years - 1) if years > 1 else 1.0
        g_yr = g0 + (tg - g0) * frac          # g0 at yr 1 … tg at the final year
        e *= (1 + g_yr)
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
    return _median(candidates), raw_eg


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
    """Reverse DCF: the initial growth rate that makes the two-stage DCF equal today's price.

    Returns None — an honest "no economic solution" — when the price sits outside the value
    the plausible growth bracket [-10%, +40%] can produce, instead of the old saturation to
    ~0.40 for any richly-valued name (AUDIT §3 T-6)."""
    if not eps0 or eps0 <= 0 or not price or price <= 0:
        return None
    lo, hi = -0.10, 0.40
    v_lo, v_hi = _dcf(eps0, lo, r=r, cap=False), _dcf(eps0, hi, r=r, cap=False)
    if v_lo is None or v_hi is None:
        return None
    if price <= v_lo or price >= v_hi:
        return None  # market implies growth beyond the plausible band → no reliable solution
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
    # Normalise minor units (GBp→GBP ÷100) so the earnings models run on the same major
    # unit the (already-normalised) price uses — never ~100× off for a pence-quoted line
    # (VALUE_INVESTING_AUDIT §3 F-1). EPS is normalised by the SNAPSHOT's own currency
    # (its source unit), not the price currency, which the caller may already have
    # normalised to the major unit.
    snap_ccy = snap.get("currency")
    _, major_ccy = normalize_minor_currency(1.0, currency or snap_ccy)
    ccy = major_ccy or currency or snap_ccy

    # Cross-listing / ADR guard for the CASH lane. EPS/price are in the trading currency
    # (snap_ccy) — verified (AUDIT §9). But the cash-flow statement is in the REPORTING
    # currency (financialCurrency); dividing it by shares and comparing to the trading-currency
    # price with no FX contaminates the fair value and shows FCF/owner-earnings in the wrong
    # currency for every ADR (AUDIT §3 F-1, cash-lane part — not covered by the EPS "non-issue"
    # verification). We don't fabricate an FX rate: when the two currencies differ we drop the
    # cash lane (the EPS-based models stay, correctly in the trading currency) and say so.
    fin_ccy = (data or {}).get("financialCurrency")
    cash_lane_comparable = not (fin_ccy and snap_ccy and fin_ccy != snap_ccy)

    def _norm_px(v: float | None) -> float | None:
        return normalize_minor_currency(v, snap_ccy)[0] if v is not None else None

    eps, fwd_eps = _norm_px(snap.get("trailingEps")), _norm_px(snap.get("forwardEps"))
    p2b, roe, margins = snap.get("priceToBook"), snap.get("returnOnEquity"), snap.get("profitMargins")
    dy = snap.get("dividendYield")
    # yfinance (pinned 1.6.0) reports dividendYield as a PERCENT (e.g. 2.38 → 2.38%),
    # verified live against trailingAnnualDividendYield. Always ÷100; the old `>1`
    # heuristic corrupted genuine sub-1% yields (0.9 → 90%). See AUDIT §3 F-7.
    dy = (dy / 100.0) if dy is not None else None
    payout, debt, ebitda = snap.get("payoutRatio"), snap.get("totalDebt"), snap.get("ebitda")

    g_used_raw, g_reported = _pick_growth(snap, hist)
    g = _clamp(g_used_raw, -0.05, GROWTH_CAP)
    # Book value per share from the BALANCE SHEET (equity ÷ shares) — price-INDEPENDENT, so the
    # intrinsic value never tracks the market price and the margin of safety stays a real discount
    # to an independent estimate (was `price / priceToBook`, which made the Graham number rise with
    # the quote). Normalized by the snapshot's own currency for minor units. For a cross-listing
    # (reporting ≠ trading currency) the balance-sheet book is in the reporting currency and can't
    # be placed against the trading-currency EPS in the Graham number, so it is dropped there — the
    # same abstention the cash lane uses (`cash_lane_comparable`).
    _bal_years = (data.get("balance") or {}).get("years") or []
    _bal_latest = max(_bal_years, key=lambda y: y.get("year", 0)) if _bal_years else {}
    _equity, _bshares = _bal_latest.get("stockholdersEquity"), _bal_latest.get("sharesOutstanding")
    bvps = (
        _norm_px(_equity / _bshares)
        if (cash_lane_comparable and _equity is not None and _bshares and _bshares > 0)
        else None
    )
    base_eps = eps if (eps and eps > 0) else fwd_eps

    # --- Cash-based lane: free cash flow & owner earnings (AUDIT §3 F-8) ---------
    # A genuine cash figure, not accounting EPS relabeled. Normalised FCF/share is the
    # MEDIAN of the available years so a single lumpy-capex year doesn't distort it, and
    # it drives an additional DCF model in the intrinsic range. Owner earnings ≈
    # NetIncome + D&A − capex (capex is a negative outflow), reported per share.
    cf = (data or {}).get("cashflow") or {}
    shares = cf.get("sharesOutstanding")
    cf_years = sorted((cf.get("years") or []), key=lambda y: y.get("year", 0))

    def _per_share(v: float | None) -> float | None:
        if v is None or not shares or shares <= 0:
            return None
        return _norm_px(v / shares)   # per-share, minor-unit normalised by snapshot ccy

    fcf_ps_series = [ps for y in cf_years if (ps := _per_share(y.get("freeCashFlow"))) is not None] if cash_lane_comparable else []
    fcf_per_share = _per_share(cf_years[-1].get("freeCashFlow")) if (cf_years and cash_lane_comparable) else None
    normalized_fcf_ps = round(_median(fcf_ps_series), 2) if fcf_ps_series else None

    models = compute_models(eps, bvps, base_eps, g, normalized_fcf_ps, cfg)

    owner_earnings_ps = None
    if cf_years and cash_lane_comparable:
        last = cf_years[-1]
        ni, dna, capex = last.get("netIncome"), last.get("dna"), last.get("capex")
        if ni is not None and dna is not None and capex is not None:
            oe = _per_share(ni + dna + capex)
            owner_earnings_ps = round(oe, 2) if oe is not None else None

    fcf_yield = round(fcf_per_share / price, 4) if (fcf_per_share and price and price > 0) else None

    # --- Bear / base / bull scenarios (AUDIT §3 F-10) --------------------------
    # No single "magic" fair value: vary the ASSUMPTIONS (growth, discount, terminal)
    # to a conservative and an optimistic case around the base. The base case is the
    # same earnings DCF that feeds `models["dcf"]`, so the range is centred on it.
    def _scenario(g_s: float, r_s: float, tg_s: float) -> dict:
        v = _dcf(base_eps, g_s, r=r_s, tg=tg_s)
        return {
            "assumptions": {"growth": round(g_s, 4), "discountRate": round(r_s, 4),
                            "terminalGrowth": round(tg_s, 4)},
            "intrinsicValue": round(v, 2) if v else None,
            "marginOfSafety": round(v / price - 1, 4) if (v and price and price > 0) else None,
        }

    scenarios = None
    valuation_range = None
    valuation_uncertainty = None
    if base_eps and base_eps > 0:
        r0, tg0 = cfg["disc"], cfg["tg"]
        scenarios = {
            "bear": _scenario(max(g - 0.03, -0.02), r0 + 0.02, max(tg0 - 0.01, 0.0)),
            "base": _scenario(g, r0, tg0),
            "bull": _scenario(g + 0.03, max(r0 - 0.01, tg0 + 0.005), tg0 + 0.005),
        }
        lo_v = scenarios["bear"]["intrinsicValue"]
        base_v = scenarios["base"]["intrinsicValue"]
        hi_v = scenarios["bull"]["intrinsicValue"]
        spread = round(hi_v / lo_v, 2) if (lo_v and hi_v and lo_v > 0) else None
        valuation_range = {"low": lo_v, "base": base_v, "high": hi_v, "spread": spread}
        valuation_uncertainty = (
            "high" if (spread and spread > 2.5)
            else "moderate" if (spread and spread > 1.6)
            else "low"
        )

    vals = sorted(v for v in models.values() if v and v > 0)
    intrinsic = {
        "low": round(vals[0], 2) if vals else None,
        "mid": round(_median(vals), 2) if vals else None,   # true median, not index-max
        "high": round(vals[-1], 2) if vals else None,
    }
    mos = round(intrinsic["mid"] / price - 1, 4) if (intrinsic["mid"] and price) else None
    implied_g = _implied_growth(base_eps, price, r=cfg["disc"])

    # Fair-value bands + attractive entry target. fairValue is the model midpoint; the
    # bands turn it into a plain buy/fair/overvalued/sell verdict the UI shades on charts.
    fair_value = intrinsic.get("mid")
    band = classify_band(price, fair_value, cfg)

    def chk(label: str, ok: bool, detail: str, applicable: bool = True) -> dict:
        return {"label": label, "pass": bool(ok), "detail": detail, "applicable": applicable}

    # Leverage with correct debt-state semantics (AUDIT §3 F-2): a debt-free balance
    # sheet is a STRENGTH (pass), unknown debt is n/a (not counted), only genuine
    # leverage above the threshold fails. The old `if debt and …` made debt==0 → None
    # → a silent FAIL, penalising the safest companies.
    if debt == 0:
        lev = chk("Debt / EBITDA ≤ 3", True, "0.0x (debt-free)")
    elif debt is not None and ebitda and ebitda > 0:
        de = debt / ebitda
        lev = chk("Debt / EBITDA ≤ 3", de <= 3, f"{de:.1f}x")
    else:
        lev = chk("Debt / EBITDA ≤ 3", False, "n/a (no debt/EBITDA data)", applicable=False)

    hist_cagr = _hist_income_cagr(hist)
    checks = [
        chk("Return on equity ≥ 15%", roe is not None and roe >= 0.15, _pct(roe)),
        chk("Net margin ≥ 10%", margins is not None and margins >= 0.10, _pct(margins)),
        chk("Earnings growing", g_used_raw > 0, _pct(g_used_raw)),
        lev,
        chk("Payout sustainable ≤ 70%", payout is not None and 0 <= payout <= 0.7, _pct(payout)),
        chk("Positive long-run earnings trend", hist_cagr is not None and hist_cagr > 0, _pct(hist_cagr)),
    ]

    confidence, flags = _confidence(snap, models, price)
    if not cash_lane_comparable:
        flags.append(
            f"This is a cross-listing/ADR: it trades in {snap_ccy} but reports in {fin_ccy}. "
            f"Free-cash-flow, owner-earnings and book-value (Graham number) estimates are omitted "
            f"here (they can't be placed on the {snap_ccy} price without an FX assumption); the "
            f"valuation uses the trading-currency earnings models only."
        )
    if valuation_uncertainty == "high":
        # Extreme assumption-sensitivity → never present a high-confidence point (AUDIT §6).
        if _CONF_RANK[confidence] > _CONF_RANK["medium"]:
            confidence = "medium"
        flags.append(
            "Wide bear-to-bull valuation spread — intrinsic value is highly sensitive to the "
            "growth/discount assumptions; read the range, not a single fair value."
        )

    # --- Area 2: route by business type, then decide whether a value is reliable ----------
    # Financials/REITs are valued on NAV/book (their GAAP earnings are mark- or revaluation-
    # driven, so an earnings DCF would mislead); a company without enough positive-earnings
    # history gets NO RELIABLE FAIR VALUE instead of a forward-EPS fantasy. When we abstain the
    # earnings figures are cleared so no surface can show a value the evidence doesn't support.
    framework = _framework_for_sector(snap.get("sector"))
    reliable, reliability_reason, book_nav_block, earning_power_block = True, None, None, None
    reliability_tier = 1
    if framework == "book_nav":
        ok, why = validate_book_value(price, p2b, bvps)
        if ok:
            fair_value = bvps
            band = classify_band(price, fair_value, cfg)
            mos = round(fair_value / price - 1, 4) if (fair_value and price and price > 0) else None
            intrinsic = {"low": None, "mid": round(bvps, 2), "high": None}
            models = {}                       # earnings models are not the basis for a book value
            scenarios = valuation_range = valuation_uncertainty = None
            book_nav_block = {
                "navPerShare": round(bvps, 2),
                "priceToNav": round(price / fair_value, 3) if (fair_value and price) else None,
                "caveat": (
                    "Below or above NAV is a starting point, not a verdict: read it with leverage, "
                    "financing/rate risk and asset-mark quality. A discount to NAV is never an "
                    "automatic buy."
                ),
            }
        else:
            reliable, reliability_reason = False, why
    else:
        # --- Area 3: sustainable earning power first, growth only when justified -----------
        eps_s, fcf_s = _per_share_series(hist, data.get("balance"), data.get("cashflow"), _norm_px)
        measure, level = ep.select_measure(eps_s, fcf_s)
        chosen = fcf_s if "owner" in measure else eps_s
        recent_fcf = [x for x in fcf_s[-2:] if x is not None]
        if len([h for h in hist if isinstance(h.get("netIncome"), (int, float))]) >= 3 \
                and _positive_earnings_years(hist) < 3:
            reliable, reliability_reason = False, (
                "insufficient positive-earnings history (fewer than 3 profitable years on record)")
        elif not cash_lane_comparable:
            # Cross-listing (reports ≠ trades currency): earning power can't be normalized in the
            # trading currency/share basis without an FX/ADR assumption → abstain (honest).
            reliable, reliability_reason = False, (
                "cross-listing (reports in a different currency than it trades) — sustainable earning "
                "power can't be normalized in the trading-currency/share basis")
        elif measure.startswith("normalized net income") and recent_fcf and all(x <= 0 for x in recent_fcf):
            # Net income positive but the owner is not receiving cash (recent FCF ≤ 0) — owner
            # earning power isn't established, so an NI-based value would overstate it.
            reliable, reliability_reason = False, (
                "net income is positive but recent free cash flow is ≤ 0 — earning power is not "
                "converting to owner cash")
        elif level is None or level <= 0:
            reliable, reliability_reason = False, "normalized earning power is not positive/establishable"
        else:
            cser = [x for x in chosen if x is not None]
            cov = ep._cov(cser)
            if cser and cser[-1] < ep.EXTREME_TROUGH * level and cov and cov > ep.TROUGH_COV and len(cser) < 6:
                reliable, reliability_reason = False, (
                    "deep cyclical trough; the short history can't establish a through-cycle level")
            else:
                gr = ep.derive_growth(cser, roe, bool(margins and margins >= 0.08))
                g_asmp = gr["growth"]
                no_growth_value = ep.value_at_growth(level, 0.0, bvps, roe, cfg)
                fv = ep.value_at_growth(level, g_asmp, bvps, roe, cfg)
                if not fv:
                    reliable, reliability_reason = False, "no positive valuation anchor"
                else:
                    fair_value, mos = fv, (round(fv / price - 1, 4) if (price and price > 0) else None)
                    band = classify_band(price, fair_value, cfg)
                    intrinsic = {"low": no_growth_value, "mid": fv, "high": None}
                    models = {}
                    scenarios = valuation_range = valuation_uncertainty = None
                    # Sensitivity IS the reliability signal: does the ASSUMED growth change the
                    # verdict vs the no-growth anchor? (A hypothetical higher growth only ever makes
                    # a name look cheaper, so it can't threaten the conservative conclusion; what
                    # matters is whether credited growth turned the verdict away from no-growth.)
                    # An exceptional (capped) rate is inherently assumption-sensitive.
                    sens = ep.sensitivity(level, bvps, roe, g_asmp, cfg)
                    b0 = classify_band(price, sens["at0"], cfg)
                    bg = classify_band(price, sens["atG"], cfg)
                    verdict_moved = bool(b0 and bg and b0["band"] != bg["band"])
                    assumption_sensitive = verdict_moved or gr["basis"] == "high-capped"
                    reliability_tier = 2 if assumption_sensitive else 1
                    if gr["confidence"] == "low" or assumption_sensitive:
                        confidence = "low"     # a decision constraint, not just a label
                    earning_power_block = {
                        "measure": measure, "normalizedLevel": round(level, 2),
                        "growthAssumption": g_asmp, "growthBasis": gr["basis"],
                        "growthConfidence": gr["confidence"], "growthReason": gr["reason"],
                        "noGrowthValue": no_growth_value,
                        "sensitivity": {"at0": sens["at0"], "atGrowth": sens["atG"], "atGrowthPlus": sens["atGplus"]},
                        "assumptionSensitive": assumption_sensitive,
                    }

    if not reliable:
        fair_value = band = mos = None
        intrinsic = {"low": None, "mid": None, "high": None}
        models = {}
        scenarios = valuation_range = valuation_uncertainty = None
        reliability_tier = 3
        confidence = "low"
        if reliability_reason:
            flags.append(f"No reliable fair value — {reliability_reason}.")

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
        # Area 2: which framework valued it, whether the value is trustworthy, and (for a
        # financial/REIT) the NAV read. `reliableValue: false` means NO RELIABLE FAIR VALUE.
        "valuationFramework": framework,
        "reliableValue": reliable,
        "reliabilityReason": reliability_reason,
        "reliabilityTier": reliability_tier,   # 1 reliable · 2 assumption-sensitive (no buy) · 3 abstain
        "bookNav": book_nav_block,
        # Area 3: the earning-power basis. `noGrowthValue` is the fundamental anchor; `fairValue`
        # adds only justified growth; `assumptionSensitive`/tier-2 forbids a BUY.
        "earningPower": earning_power_block,
        "noGrowthValue": (earning_power_block or {}).get("noGrowthValue"),
        "growthAssumption": (earning_power_block or {}).get("growthAssumption"),
        "growthBasis": (earning_power_block or {}).get("growthBasis"),
        "assumptionSensitive": (earning_power_block or {}).get("assumptionSensitive", False),
        "impliedGrowth": round(implied_g, 4) if implied_g is not None else None,
        "supportableReturn": round((g or 0) + (dy or 0), 4),
        "quality": {
            # Score over APPLICABLE checks only, so an n/a check (e.g. unknown debt)
            # neither counts as a pass nor drags the denominator (AUDIT §3 F-2).
            "score": sum(1 for c in checks if c.get("applicable", True) and c["pass"]),
            "max": sum(1 for c in checks if c.get("applicable", True)),
            "checks": checks,
        },
        "assumptions": {"discountRate": DISCOUNT_RATE, "terminalGrowth": TERMINAL_GROWTH, "years": DCF_YEARS},
        "confidence": confidence,
        "flags": flags,
        "sector": snap.get("sector"),
        "priceToBook": p2b,
        "eps": eps,
        "forwardEps": fwd_eps,
        "bookValuePerShare": round(bvps, 2) if bvps else None,
        "fcfPerShare": fcf_per_share,
        "normalizedFcfPerShare": normalized_fcf_ps,
        "ownerEarningsPerShare": owner_earnings_ps,
        "fcfYield": fcf_yield,
        "scenarios": scenarios,
        "valuationRange": valuation_range,
        "valuationUncertainty": valuation_uncertainty,
        # Structured business-quality & financial-strength read (Phase 3) — additive,
        # None-safe; consumers can show ROIC / cash conversion / interest coverage /
        # consistency / dilution / moat and the distinct-debt-state strength rating.
        "qualityAssessment": quality_mod.assess_quality(data, price),
        "financialStrength": quality_mod.assess_financial_strength(data),
        "roe": roe,
        "dividendYield": dy,
        "hasData": bool(models) or eps is not None,
    }

def attach_display_currency(va: dict, base: str = "CHF", as_of: str | None = None) -> dict:
    """Attach a `displayCurrency` block so the UI can render every valuation figure in ONE
    currency (`base`, e.g. CHF) beside the native one — instead of a CHF price next to a
    USD fair value. Purely additive: the native fields and the currency-invariant
    `marginOfSafety` are untouched. Never fabricates a rate — an unresolvable pair (or a
    payload with no native currency) yields {code, fxRate: None} and no converted amounts.
    """
    native = va.get("currency")
    as_of = as_of or _date.today().isoformat()
    if not native:
        va["displayCurrency"] = {"code": base, "fxRate": None, "fxAsOf": as_of, "fxSource": "unresolved"}
        return va

    r = fx.resolve_fx(native, base, as_of)
    if r.rate is None:
        va["displayCurrency"] = {"code": base, "fxRate": None, "fxAsOf": as_of, "fxSource": r.source}
        return va

    k = r.rate

    def cv(v):
        return round(v * k, 2) if isinstance(v, (int, float)) else None

    intrinsic = va.get("intrinsic") or {}
    models = va.get("models") or {}
    va["displayCurrency"] = {
        "code": base,
        "fxRate": round(k, 6),
        "fxAsOf": as_of,
        "fxSource": r.source,
        "price": cv(va.get("price")),
        "fairValue": cv(va.get("fairValue")),
        "grahamNumber": cv(models.get("grahamNumber")),
        "entryTarget": cv(va.get("entryTarget")),
        "intrinsicLow": cv(intrinsic.get("low")),
        "intrinsicMid": cv(intrinsic.get("mid")),
        "intrinsicHigh": cv(intrinsic.get("high")),
    }
    return va

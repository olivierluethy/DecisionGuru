"""Area 3 — sustainable earning power first, growth only when it can be justified.

Deterministic, transparent, business-property-driven (never ticker-specific). The philosophy
(frozen): establish a normalized earning-power *level*; credit growth only when the chosen
measure demonstrably grows and the company is still in that trend — default is 0%; value the
level conservatively; and abstain when the level itself can't be established. Statistics are
implementation tools for the Graham/Buffett concept of normalized earning power — not a forecast.

Every number carries a reason code and a reliability tier so the UI can show *why* and *what
would have to be true for it to be wrong*. Thresholds below are one-time, principled design
constants — they are NOT tuned to make any particular holding land on a chosen verdict.
"""
from __future__ import annotations

import math
import statistics

# --- principled design constants (set once; not per-company) --------------------------
GROWTH_GUARDRAIL = 0.15      # model constraint, NOT a Graham/Buffett rule; growth is clamped here
GROWTH_CREDIT_FRACTION = 0.5  # credit only half of demonstrated growth (conservative haircut)
NEAR_PEAK = 0.95            # "still in the growth trend": latest ≥ 95% of the series peak
CYCLICAL_DRAWDOWN = 0.25   # a >25% peak-to-latest fall ⇒ post-peak/cyclical, not structural growth
EXTREME_TROUGH = 0.35      # latest < 35% of the normalized level ⇒ possible deep trough
TROUGH_COV = 0.60          # …and a volatile series ⇒ can't establish a through-cycle level → abstain
HIGH_GROWTH = 0.20         # above this, historical growth is not conservatively extrapolable
ASSET_LIGHT_ROE = 0.30     # ROE above this ⇒ book value isn't the value driver → drop Graham number
SENSITIVITY_STEP = 0.03    # verdict must hold across ±3 pp of growth to be "reliable" (tier 1)


def _cov(xs: list[float]) -> float | None:
    """Coefficient of variation of a series with a positive mean (else undefined)."""
    xs = [x for x in xs if x is not None]
    if len(xs) < 2:
        return None
    m = statistics.mean(xs)
    if m <= 0:
        return None
    return statistics.pstdev(xs) / m


def _smoothed_cagr(xs: list[float]) -> float | None:
    """Endpoint-smoothed CAGR: mean(first two) → mean(last two), so one distorted end year
    can't set the rate. None when the endpoints aren't both positive."""
    xs = [x for x in xs if x is not None]
    if len(xs) < 3:
        return None
    yrs = len(xs) - 1
    a = statistics.mean(xs[:2])
    b = statistics.mean(xs[-2:])
    if a <= 0 or b <= 0 or yrs <= 0:
        return None
    return (b / a) ** (1 / yrs) - 1


def _median_positive(xs: list[float]) -> float | None:
    pos = [x for x in xs if x is not None and x > 0]
    return statistics.median(pos) if len(pos) >= 3 else None


def _drawdown(xs: list[float]) -> float:
    """Largest peak-to-later fall in the series, as a fraction of the running peak. Distinguishes
    a steadily GROWING series (drawdown ~0) from an ERRATIC one — coefficient of variation can't,
    because a trend inflates it."""
    xs = [x for x in xs if x is not None]
    if not xs:
        return 1.0
    peak, mdd = xs[0], 0.0
    for x in xs:
        if x > peak:
            peak = x
        if peak > 0:
            mdd = max(mdd, (peak - x) / peak)
    return mdd


def select_measure(eps_series: list[float], fcf_series: list[float]) -> tuple[str, float | None]:
    """Choose the earning-power measure by the business's OWN economics (not a label):
      - FCF erratic / turns negative while earnings stay positive (working-capital / order timing)
        ⇒ normalized NET INCOME (the distortion is the balance sheet, not earning power);
      - FCF/owner-earnings persistently ABOVE net income and stable (amortization-heavy acquirer)
        ⇒ OWNER EARNINGS / FCF (accounting earnings understate the cash an owner receives);
      - otherwise the two agree ⇒ NET INCOME.
    Returns (measure_key, normalized_level = median of the chosen positive series)."""
    eps_level = _median_positive(eps_series)
    fcf_vals = [x for x in fcf_series if x is not None]
    fcf_pos = [x for x in fcf_vals if x > 0]
    fcf_level = statistics.median(fcf_pos) if len(fcf_pos) >= 3 else None
    # FCF is a usable earning-power proxy only if it stays positive and isn't erratic. A negative
    # year or a deep drawdown is the working-capital / timing signal → fall back to net income.
    fcf_usable = fcf_level is not None and not any(x <= 0 for x in fcf_vals) and _drawdown(fcf_vals) < 0.5
    if not fcf_usable:
        return "normalized net income", eps_level
    if eps_level is not None and fcf_level > eps_level * 1.10:
        return "owner earnings / free cash flow", fcf_level
    return "net income (converges with cash)", eps_level


def derive_growth(series: list[float], roe: float | None, margins_stable: bool) -> dict:
    """Growth default = 0. Credit >0 ONLY when the CHOSEN measure demonstrably grows and the
    company is still in that trend (latest near the series peak). Never from revenue, never from
    one year, never auto-high. Durability signals (ROE/margins) set *confidence*, never the number
    (no mechanical ROIC→growth unlock). Returns the assumption + a reason code + confidence."""
    xs = [x for x in series if x is not None]
    peak = max(xs) if xs else None
    latest = xs[-1] if xs else None
    sm = _smoothed_cagr(xs)

    def out(g, basis, conf, reason):
        return {"growth": round(g, 4), "basis": basis, "confidence": conf, "reason": reason}

    if peak is None or latest is None:
        return out(0.0, "none", "low", "No usable series to justify any growth; default 0%.")
    # Post-peak / cyclical decline: a rebound or a faded peak is not structural growth.
    if latest < peak * NEAR_PEAK or (peak > 0 and (peak - latest) / peak > CYCLICAL_DRAWDOWN):
        return out(0.0, "none",
                   "medium" if margins_stable else "low",
                   "Earning power is not in an uptrend (latest below its multi-year peak) — a "
                   "recovery or a faded peak is not credited as structural growth; default 0%.")
    if sm is None or sm <= 0:
        return out(0.0, "none", "medium",
                   "No positive multi-year trend in the chosen measure; default 0%.")
    # Demonstrated, still-trending growth → credit a conservative HALF, clamped by the guardrail.
    conf = "high" if (margins_stable and (roe or 0) >= 0.12) else "medium"
    if sm > HIGH_GROWTH:
        return out(GROWTH_GUARDRAIL, "high-capped",
                   "low",  # extrapolating an exceptional rate is not conservative → low confidence
                   f"Historical growth ~{sm*100:.0f}% is exceptional and not conservatively "
                   f"extrapolable; capped at the {GROWTH_GUARDRAIL*100:.0f}% guardrail — treat as "
                   f"assumption-sensitive, not a precise value.")
    g = min(sm * GROWTH_CREDIT_FRACTION, GROWTH_GUARDRAIL)
    return out(g, "supported", conf,
               f"Consistent multi-year growth (~{sm*100:.0f}%) in the chosen measure, still near "
               f"its peak; credited at a conservative half ({g*100:.0f}%).")


def _dcf(level: float, g: float, r: float = 0.09, years: int = 10, tg: float = 0.025) -> float | None:
    """Two-stage owner-earnings DCF on the normalized LEVEL (not trailing EPS): growth fades g→tg."""
    if level is None or level <= 0 or r <= tg:
        return None
    g0 = max(min(g, GROWTH_GUARDRAIL), 0.0)
    pv, e = 0.0, level
    for yr in range(1, years + 1):
        frac = (yr - 1) / (years - 1) if years > 1 else 1.0
        e *= (1 + (g0 + (tg - g0) * frac))
        pv += e / ((1 + r) ** yr)
    return pv + (e * (1 + tg) / (r - tg)) / ((1 + r) ** years)


def value_at_growth(level: float, g: float, bvps: float | None, roe: float | None,
                    cfg: dict | None = None) -> float | None:
    """Fair value = conservative capitalization of the normalized earning-power level at growth g.
    Anchors: an owner-earnings DCF and the Graham *growth* formula. The Graham NUMBER (book-based)
    is added ONLY when book is actually the value driver (present + not asset-light) — it is an
    optional Graham anchor, never a universal floor. Median of the available anchors."""
    r = (cfg or {}).get("disc", 0.09)
    tg = (cfg or {}).get("tg", 0.025)
    anchors: list[float] = []
    dcf = _dcf(level, g, r=r, tg=tg)
    if dcf:
        anchors.append(dcf)
    if level > 0:  # Graham 1974 growth formula on the normalized level
        anchors.append(level * (8.5 + 2 * min(max(g * 100, 0), GROWTH_GUARDRAIL * 100)))
    if bvps and bvps > 0 and (roe is None or roe < ASSET_LIGHT_ROE):
        anchors.append(math.sqrt(22.5 * level * bvps))  # book-relevant only
    anchors = [a for a in anchors if a and a > 0]
    return round(statistics.median(anchors), 2) if anchors else None


def sensitivity(level: float, bvps: float | None, roe: float | None, g: float,
                cfg: dict | None = None) -> dict:
    """How much the fair value moves with the growth assumption — the honest reliability signal,
    replacing a blanket cap as the decider. Returns fair value at 0% / g / g+3pp."""
    def fv(x):
        return value_at_growth(level, max(x, 0.0), bvps, roe, cfg)
    return {"at0": fv(0.0), "atG": fv(g), "atGplus": fv(g + SENSITIVITY_STEP)}

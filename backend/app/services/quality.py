"""Business quality + financial strength — a Buffett-style read the old 6-binary scorecard
could not give (VALUE_INVESTING_AUDIT §3, §5).

Every function is None-safe and additive: it consumes the fundamentals payload
(`snapshot`, `history`, `cashflow`, and — when the provider supplies them — `balance` and
`income`) and returns structured metrics with explicit ratings. Nothing is fabricated: a
metric without data is rated ``"unknown"``, and the moat signal is ``"unknown"`` rather than
an invented score when the measurable evidence is thin.
"""
from __future__ import annotations

import statistics

# --- rating thresholds (documented, single source) ------------------------------
_ROIC_STRONG, _ROIC_OK = 0.15, 0.08
_FCFCONV_STRONG, _FCFCONV_OK = 0.80, 0.60
_ICOV_STRONG, _ICOV_OK = 8.0, 3.0
_CV_STABLE, _CV_MODERATE = 0.15, 0.35          # coefficient of variation bands
_DIL_BAND = 0.01                               # ±1% share-count change = "stable"
_NETDEBT_LOW, _NETDEBT_HIGH = 1.0, 3.0         # netDebt/EBITDA bands
_GROSS_MOAT = 0.40                             # gross margin suggesting pricing power


def _median(vals: list[float]) -> float | None:
    return statistics.median(vals) if vals else None


def _latest(years: list[dict]) -> dict | None:
    return max(years, key=lambda y: y.get("year", 0)) if years else None


def _band(value: float | None, strong: float, ok: float, *, higher_is_better: bool = True) -> str:
    if value is None:
        return "unknown"
    if higher_is_better:
        return "strong" if value >= strong else "adequate" if value >= ok else "weak"
    return "strong" if value <= strong else "adequate" if value <= ok else "weak"


def _cv(series: list[float]) -> float | None:
    """Coefficient of variation (sample stdev / |mean|) — a scale-free consistency read."""
    pts = [v for v in series if v is not None]
    if len(pts) < 2:
        return None
    mean = statistics.mean(pts)
    if mean == 0:
        return None
    return statistics.stdev(pts) / abs(mean)


def _consistency(series: list[float]) -> dict:
    cv = _cv(series)
    if cv is None:
        rating = "unknown"
    elif cv < _CV_STABLE:
        rating = "stable"
    elif cv < _CV_MODERATE:
        rating = "moderate"
    else:
        rating = "variable"
    return {"cv": round(cv, 3) if cv is not None else None, "rating": rating}


def _roic(data: dict) -> dict:
    snap = data.get("snapshot") or {}
    income = _latest((data.get("income") or {}).get("years") or []) or {}
    hist = _latest(data.get("history") or []) or {}
    bal = _latest((data.get("balance") or {}).get("years") or []) or {}

    ebit = income.get("operatingIncome") if income.get("operatingIncome") is not None else hist.get("operatingIncome")
    invested = bal.get("investedCapital")
    if ebit is None or not invested or invested <= 0:
        return {"value": None, "rating": "unknown",
                "detail": "Operating income or invested capital unavailable."}

    pretax, tax = income.get("pretaxIncome"), income.get("taxProvision")
    eff_tax = (tax / pretax) if (tax is not None and pretax and pretax > 0) else 0.21
    eff_tax = max(0.0, min(0.5, eff_tax))
    nopat = ebit * (1 - eff_tax)
    roic = nopat / invested
    return {"value": round(roic, 4), "rating": _band(roic, _ROIC_STRONG, _ROIC_OK),
            "detail": f"NOPAT {nopat:,.0f} / invested capital {invested:,.0f} = {roic * 100:.1f}%"}


def _fcf_conversion(data: dict) -> dict:
    years = (data.get("cashflow") or {}).get("years") or []
    fcf = _median([y.get("freeCashFlow") for y in years if y.get("freeCashFlow") is not None])
    ni = _median([y.get("netIncome") for y in years if y.get("netIncome") is not None])
    if fcf is None or not ni or ni <= 0:
        return {"value": None, "rating": "unknown", "detail": "Free cash flow or net income unavailable."}
    conv = fcf / ni
    return {"value": round(conv, 4), "rating": _band(conv, _FCFCONV_STRONG, _FCFCONV_OK),
            "detail": f"median FCF {fcf:,.0f} / median net income {ni:,.0f} = {conv * 100:.0f}%"}


def _interest_coverage(data: dict) -> dict:
    snap = data.get("snapshot") or {}
    income = _latest((data.get("income") or {}).get("years") or []) or {}
    hist = _latest(data.get("history") or []) or {}
    ebit = income.get("operatingIncome") if income.get("operatingIncome") is not None else hist.get("operatingIncome")
    interest = income.get("interestExpense")
    if interest == 0 or (snap.get("totalDebt") == 0 and interest in (None, 0)):
        return {"value": None, "rating": "n/a", "detail": "No material interest expense (little/no debt)."}
    if ebit is None or interest is None:
        return {"value": None, "rating": "unknown", "detail": "EBIT or interest expense unavailable."}
    cov = ebit / abs(interest)
    return {"value": round(cov, 2), "rating": _band(cov, _ICOV_STRONG, _ICOV_OK),
            "detail": f"EBIT {ebit:,.0f} / interest {abs(interest):,.0f} = {cov:.1f}×"}


def _dilution(data: dict) -> dict:
    years = sorted((data.get("balance") or {}).get("years") or [], key=lambda y: y.get("year", 0))
    shares = [(y.get("year"), y.get("sharesOutstanding")) for y in years if y.get("sharesOutstanding")]
    if len(shares) < 2:
        return {"sharesChangePct": None, "rating": "unknown",
                "detail": "Insufficient share-count history."}
    first, last = shares[0][1], shares[-1][1]
    change = (last - first) / first if first else None
    if change is None:
        return {"sharesChangePct": None, "rating": "unknown", "detail": "Share count unavailable."}
    rating = "buyback" if change < -_DIL_BAND else "dilutive" if change > _DIL_BAND else "stable"
    return {"sharesChangePct": round(change, 4), "rating": rating,
            "detail": f"Shares {first:,.0f} → {last:,.0f} ({change * 100:+.1f}%)"}


def _moat(data: dict, roic: dict, fcf_conv: dict, gross_consistency: dict) -> dict:
    snap = data.get("snapshot") or {}
    gross = snap.get("grossMargins")
    evidence: list[str] = []
    if roic.get("rating") == "strong":
        evidence.append(f"High return on invested capital ({(roic['value'] or 0) * 100:.0f}%)")
    if gross is not None and gross >= _GROSS_MOAT:
        evidence.append(f"High gross margin ({gross * 100:.0f}%) — pricing power")
    if fcf_conv.get("rating") == "strong":
        evidence.append("Strong cash conversion of earnings")
    if gross_consistency.get("rating") in ("stable", "moderate"):
        evidence.append("Consistent operating margins")

    measurable_any = (roic.get("value") is not None or gross is not None
                      or fcf_conv.get("value") is not None)
    if not measurable_any:
        signal = "unknown"
    elif len(evidence) >= 2:
        signal = "measurable-strong"
    elif evidence:
        signal = "measurable-some"
    else:
        signal = "none-evident"
    detail = ("Durable-advantage signals are qualitative — this reads only measurable "
              "proxies; treat 'unknown' as requiring research, not as 'no moat'.")
    return {"signal": signal, "evidence": evidence, "detail": detail}


def assess_quality(data: dict, price: float | None = None) -> dict:
    hist = data.get("history") or []
    roic = _roic(data)
    fcf_conv = _fcf_conversion(data)
    icov = _interest_coverage(data)
    dilution = _dilution(data)
    consistency = {
        "revenue": _consistency([h.get("revenue") for h in hist]),
        "operatingMargin": _consistency([h.get("operatingMargin") for h in hist]),
        "fcf": _consistency([y.get("freeCashFlow") for y in (data.get("cashflow") or {}).get("years") or []]),
    }
    moat = _moat(data, roic, fcf_conv, consistency["operatingMargin"])
    return {
        "roic": roic,
        "fcfConversion": fcf_conv,
        "interestCoverage": icov,
        "consistency": consistency,
        "dilution": dilution,
        "moat": moat,
    }


def assess_financial_strength(data: dict) -> dict:
    snap = data.get("snapshot") or {}
    debt, ebitda, cash = snap.get("totalDebt"), snap.get("ebitda"), snap.get("totalCash")
    bal = _latest((data.get("balance") or {}).get("years") or []) or {}

    net_debt_to_ebitda = None
    if debt is not None and ebitda and ebitda > 0:
        net_debt_to_ebitda = round((debt - (cash or 0.0)) / ebitda, 2)

    fcf = _median([y.get("freeCashFlow") for y in (data.get("cashflow") or {}).get("years") or []
                   if y.get("freeCashFlow") is not None])
    debt_to_fcf = round(debt / fcf, 2) if (debt and fcf and fcf > 0) else None

    ca, cl = bal.get("currentAssets"), bal.get("currentLiabilities")
    current_ratio = round(ca / cl, 2) if (ca is not None and cl and cl > 0) else None

    icov = _interest_coverage(data)

    if debt is None:
        state, rating = "unknown", "unknown"
    elif debt == 0:
        state, rating = "debt-free", "strong"
    elif net_debt_to_ebitda is None:
        state, rating = "unknown", "unknown"
    elif net_debt_to_ebitda < _NETDEBT_LOW:
        state, rating = "low", "strong"
    elif net_debt_to_ebitda < _NETDEBT_HIGH:
        state, rating = "moderate", "adequate"
    else:
        state, rating = "high", "stretched"

    return {
        "debtState": state,
        "rating": rating,
        "netDebtToEbitda": net_debt_to_ebitda,
        "debtToFcf": debt_to_fcf,
        "interestCoverage": icov.get("value"),
        "interestCoverageRating": icov.get("rating"),
        "currentRatio": current_ratio,
        "cashPosition": cash,
    }

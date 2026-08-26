"""Aggregations over DEGIRO Account-statement events.

Pure functions over an event list (dicts as stored in `account_events`). All CHF
figures via `services.fx.to_chf`. Rows with `reversed` set are ignored everywhere —
storno pairs must never be double-counted. Cash per currency is the sum of signed
mutations for that currency (the live DEGIRO cash position), combined into a CHF
headline via FX; the running `Saldo` column is kept per row for detail/audit only.
"""
from __future__ import annotations

from collections import defaultdict

from .fx import to_chf

INCOME_TYPES = {"dividend", "withholding_tax"}
FEE_TYPES = {"corp_action_fee", "connectivity_fee"}
# A cash_sweep only shuttles money between DEGIRO's settlement account and the
# interest-bearing flatex Geldkonto — both are still the holder's cash. Counting it
# makes a deposit and its sweep cancel to ~0. It must be excluded from the ledger.
CASH_LEDGER_EXCLUDE = {"cash_sweep"}


def _active(events: list[dict]) -> list[dict]:
    return [e for e in events if not e.get("reversed")]


def cash_by_currency(events: list[dict]) -> dict[str, float]:
    """Canonical cash position per currency.

    = Σ signed mutations (non-reversed) EXCLUDING internal cash_sweep transfers.
    That is the ledger of money that entered the account (deposits + net dividends
    − fees + net FX) and has not been spent on securities. Summing sweeps too would
    cancel every deposit against its Geldkonto sweep → the old ``CHF -0.00`` bug."""
    out: dict[str, float] = defaultdict(float)
    for e in _active(events):
        if e.get("type") in CASH_LEDGER_EXCLUDE:
            continue
        ccy = e.get("currency")
        if ccy:
            out[ccy] += e.get("amount") or 0.0
    # +0.0 collapses any -0.0 float artefact to 0.0 before it reaches the UI.
    return {k: v + 0.0 for k, v in out.items()}


def cash_chf(events: list[dict], as_of: str) -> dict:
    by = cash_by_currency(events)
    detail: dict[str, dict] = {}
    total = 0.0
    for ccy, amt in by.items():
        chf = to_chf(amt, ccy, as_of) if ccy != "CHF" else amt
        detail[ccy] = {"amount": amt, "chf": chf + 0.0}
        total += chf
    return {"totalCHF": total + 0.0, "byCurrency": detail}


def dividends_by_isin(events: list[dict], as_of: str) -> dict[str, dict]:
    """Net dividend per security: gross `Dividende` + (negative) `Dividendensteuer`."""
    agg: dict[str, dict] = {}
    for e in _active(events):
        if e.get("type") not in INCOME_TYPES:
            continue
        isin = e.get("isin")
        if not isin:
            continue
        ccy = e.get("currency") or "CHF"
        amt = e.get("amount") or 0.0
        chf = to_chf(amt, ccy, as_of) if ccy != "CHF" else amt
        row = agg.setdefault(isin, {
            "isin": isin, "name": e.get("name"), "currency": ccy,
            "grossOrig": 0.0, "taxOrig": 0.0,
            "grossCHF": 0.0, "taxCHF": 0.0, "netCHF": 0.0, "count": 0,
        })
        if e.get("type") == "dividend":
            row["grossOrig"] += amt
            row["grossCHF"] += chf
            row["count"] += 1
        else:  # withholding_tax — amt is negative
            row["taxOrig"] += amt
            row["taxCHF"] += chf
        row["netCHF"] = row["grossCHF"] + row["taxCHF"]
        if not row.get("name") and e.get("name"):
            row["name"] = e.get("name")
    return agg


def dividend_events_chf(events: list[dict], isin: str | None, as_of: str) -> list[dict]:
    """Dated dividend / withholding-tax cash for one security, each in CHF.

    Returns one entry per account event: ``{date, type, chf}`` where a ``dividend``
    carries the positive gross amount and a ``withholding_tax`` the negative tax.
    Feeds the counterfactual actual-value curve so account dividends (the real
    dividend source of truth) count toward the holding's return — matching the
    ETF side, which already includes its distributions."""
    if not isin:
        return []
    out: list[dict] = []
    for e in _active(events):
        if e.get("type") not in INCOME_TYPES or e.get("isin") != isin:
            continue
        ccy = e.get("currency") or "CHF"
        amt = e.get("amount") or 0.0
        chf = to_chf(amt, ccy, as_of) if ccy != "CHF" else amt
        out.append({"date": e.get("date"), "type": e.get("type"), "chf": chf})
    return out


def _sum_types(events: list[dict], types: set[str], as_of: str) -> float:
    total = 0.0
    for e in _active(events):
        if e.get("type") in types:
            ccy = e.get("currency") or "CHF"
            amt = e.get("amount") or 0.0
            total += to_chf(amt, ccy, as_of) if ccy != "CHF" else amt
    return total


def deposits_total_chf(events: list[dict], as_of: str) -> float:
    return _sum_types(events, {"deposit"}, as_of)


def fees_total_chf(events: list[dict], as_of: str) -> float:
    return _sum_types(events, FEE_TYPES, as_of)


def events_summary(events: list[dict]) -> dict:
    """Per-type counts + the unmapped 'unknown' bucket (so it surfaces in the UI)."""
    counts: dict[str, int] = defaultdict(int)
    unknown: list[dict] = []
    reversed_count = 0
    for e in events:
        if e.get("reversed"):
            reversed_count += 1
            continue
        counts[e.get("type") or "unknown"] += 1
        if e.get("type") == "unknown":
            unknown.append(e)
    return {
        "counts": {k: v for k, v in counts.items()},
        "unknown": unknown,
        "unknownCount": len(unknown),
        "reversedCount": reversed_count,
        "total": len(events),
    }

"""Chronological account timeline — merges the two source files into one dated feed.

Combines cash movements (deposits, dividends, fees) from the account statement with
each buy / sell from the transactions export, so the Overview can scrub through the
account history in the order things actually happened. Newest first.

All amounts are the signed CHF cash effect (+ money in, − money out). Internal
plumbing (cash_sweep, fx_conversion) is intentionally omitted — it moves money
between the holder's own pools and would only add noise.
"""
from __future__ import annotations

import pandas as pd

from . import repo
from .fx import to_chf

# Account event types that belong on the timeline, with their display kind.
_ACCOUNT_KINDS = {
    "deposit": ("deposit", "Deposit"),
    "corp_action_fee": ("fee", "Corporate-action fee"),
    "connectivity_fee": ("fee", "Connectivity fee"),
}


def _sort_key(ev: dict) -> tuple:
    return (ev.get("date") or "", ev.get("time") or "")


def build_timeline(as_of: str | None = None) -> dict:
    as_of = as_of or pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d")
    events: list[dict] = []

    # ---- cash side: account statement --------------------------------------
    account_events = [e for e in repo.all_account_events() if not e.get("reversed")]

    # Dividends: net each 'Dividende' with its matching 'Dividendensteuer'
    # (same ISIN + date) into one event.
    tax_by_key: dict[tuple, float] = {}
    for e in account_events:
        if e.get("type") == "withholding_tax":
            k = (e.get("isin"), e.get("date"))
            ccy = e.get("currency") or "CHF"
            amt = e.get("amount") or 0.0
            tax_by_key[k] = tax_by_key.get(k, 0.0) + (
                amt if ccy == "CHF" else to_chf(amt, ccy, e.get("date") or as_of)
            )

    for e in account_events:
        etype = e.get("type")
        ccy = e.get("currency") or "CHF"
        amt = e.get("amount") or 0.0
        chf = amt if ccy == "CHF" else to_chf(amt, ccy, e.get("date") or as_of)
        if etype == "dividend":
            k = (e.get("isin"), e.get("date"))
            net = chf + tax_by_key.pop(k, 0.0)  # fold in the withholding (negative)
            events.append({
                "date": e.get("date"), "time": e.get("time"),
                "kind": "dividend", "category": "cash",
                "title": f"Dividend · {e.get('name') or e.get('isin') or ''}".strip(" ·"),
                "instrumentName": e.get("name"), "isin": e.get("isin"), "symbol": None,
                "amountCHF": net, "quantity": None,
            })
        elif etype in _ACCOUNT_KINDS:
            kind, label = _ACCOUNT_KINDS[etype]
            events.append({
                "date": e.get("date"), "time": e.get("time"),
                "kind": kind, "category": "cash",
                "title": label if etype != "deposit" else "Deposit",
                "instrumentName": e.get("name") or None, "isin": e.get("isin") or None,
                "symbol": None, "amountCHF": chf, "quantity": None,
            })

    # ---- trade side: transactions export -----------------------------------
    inst_by_id = {i["id"]: i for i in repo.list_instruments()}
    for t in repo.all_transactions():
        if t.get("category") == "corporate_action" or t.get("action") not in ("buy", "sell"):
            continue
        inst = inst_by_id.get(t.get("instrumentId")) or {}
        qty = t.get("quantity") or 0.0
        unit = t.get("unitPrice") or 0.0  # already CHF/share
        fees = t.get("fees") or 0.0
        gross = qty * unit
        is_buy = t.get("action") == "buy"
        amount_chf = -(gross + fees) if is_buy else (gross - fees)
        name = inst.get("name") or t.get("note") or ""
        symbol = inst.get("symbol")
        verb = "Bought" if is_buy else "Sold"
        label = symbol or inst.get("isin") or name
        events.append({
            "date": t.get("date"), "time": None,
            "kind": "buy" if is_buy else "sell", "category": "trade",
            "title": f"{verb} {qty:g} {label}".strip(),
            "instrumentName": name or None, "isin": inst.get("isin"),
            "symbol": symbol, "amountCHF": amount_chf, "quantity": qty,
        })

    events.sort(key=_sort_key, reverse=True)
    return {"events": events, "count": len(events)}

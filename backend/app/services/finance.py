"""Position builder — port of finance.ts buildPosition. All monetary outputs in CHF."""
from __future__ import annotations

import pandas as pd

from .datastatus import instrument_data_status
from .finance_math import cagr, xirr, years_between
from .fx import get_fx_rate, to_chf
from .marketdata import get_quote
from .tax import dividend_tax, wealth_tax
from ..providers.base import normalize_minor_currency


def build_position(instrument: dict, txs: list[dict], tax: dict, pre_tax: bool = False) -> dict:
    # Corporate actions (ISIN swaps, delistings) are tracked but excluded from P/L.
    sorted_txs = sorted(
        [t for t in txs if t.get("category") != "corporate_action"],
        key=lambda t: t["date"],
    )

    open_qty = 0.0
    open_cost_chf = 0.0
    open_cost_orig = 0.0
    total_buy_chf = 0.0
    total_buy_orig = 0.0
    realized_chf = 0.0
    total_proceeds_chf = 0.0

    flows_after_tax: list[dict] = []
    flows_pre_tax: list[dict] = []

    div_summary = {
        "grossCHF": 0.0, "swissWithholdingCHF": 0.0, "foreignWithholdingCHF": 0.0,
        "incomeTaxCHF": 0.0, "netAfterTaxCHF": 0.0, "count": 0,
    }

    today = pd.Timestamp.utcnow().strftime("%Y-%m-%d")
    first_date = sorted_txs[0]["date"] if sorted_txs else today

    for tx in sorted_txs:
        ccy = tx.get("currency") or instrument["currency"]
        action = tx["action"]
        qty = tx.get("quantity") or 0
        unit_price = tx.get("unitPrice") or 0
        fees = tx.get("fees") or 0
        if action == "buy":
            cost_orig = qty * unit_price + fees
            cost_chf = to_chf(cost_orig, ccy, tx["date"])
            open_qty += qty
            open_cost_orig += cost_orig
            open_cost_chf += cost_chf
            total_buy_chf += cost_chf
            total_buy_orig += cost_orig
            flows_after_tax.append({"date": tx["date"], "amount": -cost_chf})
            flows_pre_tax.append({"date": tx["date"], "amount": -cost_chf})
        elif action == "sell":
            q = min(qty, open_qty or qty)
            fraction = q / open_qty if open_qty > 0 else 0
            removed_chf = open_cost_chf * fraction
            proceeds_orig = qty * unit_price - fees
            proceeds_chf = to_chf(proceeds_orig, ccy, tx["date"])
            realized_chf += proceeds_chf - removed_chf
            total_proceeds_chf += proceeds_chf
            open_cost_chf -= removed_chf
            open_cost_orig -= open_cost_orig * fraction
            open_qty -= q
            flows_after_tax.append({"date": tx["date"], "amount": proceeds_chf})
            flows_pre_tax.append({"date": tx["date"], "amount": proceeds_chf})
        elif action == "dividend":
            gross = tx["grossAmount"] if tx.get("grossAmount") is not None else qty * unit_price
            gross_chf = to_chf(gross, ccy, tx["date"])
            bd = dividend_tax(gross_chf, instrument.get("domicile"), tax)
            div_summary["grossCHF"] += gross_chf
            div_summary["swissWithholdingCHF"] += bd.swissWithholdingCHF
            div_summary["foreignWithholdingCHF"] += bd.foreignWithholdingCHF
            div_summary["incomeTaxCHF"] += bd.incomeTaxCHF
            div_summary["netAfterTaxCHF"] += bd.netAfterTaxCHF
            div_summary["count"] += 1
            flows_after_tax.append({"date": tx["date"], "amount": bd.netAfterTaxCHF})
            flows_pre_tax.append({"date": tx["date"], "amount": gross_chf})

    # Delisted / untracked: no resolvable ticker (symbol never resolved past the
    # ISIN, or explicitly flagged unresolved). Never fetch a live quote for these —
    # they no longer trade — so they can't be valued at a stale price and don't spin
    # the refresh pool. Their realised P/L, dividends and cost history are preserved.
    delisted = bool(instrument.get("unresolved")) or (
        instrument.get("isin") and instrument.get("symbol") == instrument.get("isin")
    )
    # Current valuation. A "pending" quote (no cached price yet, refresh in flight)
    # leaves value unknown (None) rather than 0, so the row renders a pending state.
    quote = get_quote(instrument["symbol"]) if (open_qty > 0 and not delisted) else None
    pending = bool(quote and quote.get("pending"))
    current_price = None
    current_value_chf = None
    stale = False
    if open_qty > 0 and quote and not pending:
        # Minor-unit guard (e.g. GBp→GBP): normalise price + currency so FX is
        # applied exactly once against a real ECB rate, never degraded to 1.0.
        current_price, quote_ccy = normalize_minor_currency(
            quote["price"], quote["currency"] or instrument["currency"]
        )
        stale = quote["stale"]
        fx = get_fx_rate(quote_ccy or instrument["currency"], "CHF", today)
        current_value_chf = open_qty * current_price * fx
    elif open_qty <= 0:
        current_value_chf = 0.0

    if current_value_chf is not None and open_qty > 0:
        unrealized_chf = current_value_chf - open_cost_chf
    elif open_qty > 0:
        unrealized_chf = None
    else:
        unrealized_chf = 0.0

    years = years_between(first_date, today)

    mean_value = ((total_buy_chf or 0) + (current_value_chf or 0)) / 2
    wealth_tax_chf = wealth_tax(mean_value, years, tax)

    net_div = div_summary["grossCHF"] if pre_tax else div_summary["netAfterTaxCHF"]
    if current_value_chf is not None:
        absolute_pl_chf = (
            current_value_chf + total_proceeds_chf + net_div - total_buy_chf
            - (0 if pre_tax else wealth_tax_chf)
        )
        absolute_pl_chf_pre_tax = (
            current_value_chf + total_proceeds_chf + div_summary["grossCHF"] - total_buy_chf
        )
    else:
        absolute_pl_chf = None
        absolute_pl_chf_pre_tax = None
    percent_pl = (
        absolute_pl_chf / total_buy_chf if (total_buy_chf > 0 and absolute_pl_chf is not None) else None
    )

    def terminal_flows(flows: list[dict]) -> list[dict]:
        if current_value_chf is not None and open_qty > 0:
            return [*flows, {"date": today,
                             "amount": current_value_chf - (0 if pre_tax else wealth_tax_chf)}]
        return flows

    xirr_value = xirr(terminal_flows(flows_pre_tax if pre_tax else flows_after_tax))

    end_value_for_cagr = (
        (current_value_chf or 0) + total_proceeds_chf + net_div - (0 if pre_tax else wealth_tax_chf)
    )
    cagr_value = cagr(total_buy_chf, end_value_for_cagr, years) if total_buy_chf > 0 else None

    if current_value_chf and current_value_chf > 0 and div_summary["count"] > 0:
        current_yield = div_summary["grossCHF"] / max(years, 0.5) / current_value_chf
    else:
        current_yield = instrument.get("incomeYieldOverride")

    position = {
        "instrument": instrument,
        "openQuantity": open_qty,
        "avgCost": open_cost_orig / open_qty if open_qty > 0 else 0,
        "investedOriginal": total_buy_orig,
        "investedCHF": total_buy_chf,
        "currentPrice": current_price,
        "currentValueCHF": current_value_chf,
        "realizedCHF": realized_chf,
        "unrealizedCHF": unrealized_chf,
        "dividends": div_summary,
        "priceAsOf": quote["time"] if (quote and not pending) else None,
        "stale": stale,
        "delisted": bool(delisted),
        "dataStatus": instrument_data_status(instrument, open_qty),
        "metrics": {
            "absolutePLChf": absolute_pl_chf,
            "absolutePLChfPreTax": absolute_pl_chf_pre_tax,
            "percentPL": percent_pl,
            "xirr": xirr_value,
            "cagr": cagr_value,
            "currentYield": current_yield,
            "wealthTaxCHF": wealth_tax_chf,
        },
    }

    return {"position": position, "flowsAfterTax": flows_after_tax, "flowsPreTax": flows_pre_tax}

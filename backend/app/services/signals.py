"""Valuation-driven sell signals for owned positions.

A sell signal fires when a holding's live price enters the *significantly overvalued*
band (price ≥ fairValue × 1.40 by default); the softer *overvalued* band surfaces as a
'trim' watch. The reasoning combines the valuation premium with the position's cost basis
and the **after-tax** gain if sold now — and for a Swiss private investor that gain is
tax-free (capital gains on private movable assets are untaxed), which is itself part of
the case for realising an overvalued winner. Everything is an estimate, never advice.

This works off an already-built position (from finance.build_position) plus that symbol's
cached fundamentals, so it adds no extra provider calls and no second position rebuild.
"""
from __future__ import annotations

from .valuation import value_analysis


def sell_signal_for(position: dict, cached: dict | None, settings: dict) -> dict | None:
    """Return a sell/trim signal for a held position, or None when it is not (yet)
    overvalued, is closed/delisted, has no live price, or has no cached fundamentals to
    value it against."""
    inst = position.get("instrument") or {}
    symbol = inst.get("symbol")
    open_qty = position.get("openQuantity") or 0
    if not symbol or open_qty <= 0 or position.get("delisted"):
        return None

    price = position.get("currentPrice")
    if not price or price <= 0:
        return None

    snap = (cached or {}).get("snapshot")
    if not cached or not snap:
        return None

    va = value_analysis(symbol, price, snap.get("currency"), data=cached, settings=settings)
    band = va.get("band")
    if not band or band["band"] not in ("overvalued", "significantly-overvalued"):
        return None

    is_sell = band["band"] == "significantly-overvalued"
    tax = settings.get("tax") or {}

    # After-tax gain if the open lots were sold now. Swiss private investors pay no capital
    # gains tax (capitalGainsTaxable=False); professional traders are taxed at their
    # marginal income rate. Stamp duty (default 0) applies to the sale proceeds.
    gain_chf = position.get("unrealizedCHF") or 0.0
    value_chf = position.get("currentValueCHF") or 0.0
    cgt_chf = max(gain_chf, 0.0) * tax.get("marginalIncomeRate", 0.0) if tax.get("capitalGainsTaxable") else 0.0
    stamp_chf = value_chf * (tax.get("stampDutyRate") or 0.0)
    after_tax_gain_chf = gain_chf - cgt_chf - stamp_chf

    premium_pct = round((band.get("premiumToFair") or 0) * 100, 1)
    fair = band.get("fairValue")
    ccy = va.get("currency") or inst.get("currency") or ""

    # Plain, factual reasoning in the product voice (state numbers, never advise).
    tax_note = (
        "This gain is tax-free — Switzerland does not tax capital gains on private movable assets."
        if not tax.get("capitalGainsTaxable")
        else f"As a professional trader the gain is taxed at your marginal rate (≈CHF {cgt_chf:,.0f})."
    )
    reasoning = {
        "headline": (
            f"{symbol} trades {premium_pct:.1f}% above its estimated fair value of "
            f"{ccy} {fair:,.2f} — {band['label'].lower()}."
        ),
        "premiumToFairPct": premium_pct,
        "fairValue": fair,
        "sellZoneAt": band.get("sellZoneAt"),
        "marginOfSafetyConsumed": band.get("marginOfSafetyPct"),
        "costBasisCHF": round(position.get("investedCHF") or 0.0, 2),
        "currentValueCHF": round(value_chf, 2),
        "unrealizedGainCHF": round(gain_chf, 2),
        "capitalGainsTaxCHF": round(cgt_chf, 2),
        "afterTaxGainIfSoldCHF": round(after_tax_gain_chf, 2),
        "taxNote": tax_note,
        "qualityScore": va.get("quality"),
    }

    return {
        "instrumentId": inst.get("id"),
        "symbol": symbol,
        "name": inst.get("name"),
        "band": band["band"],
        "bandLabel": band["label"],
        "isSellSignal": is_sell,          # True only in the significantly-overvalued zone
        "severity": "sell" if is_sell else "trim",
        "price": price,
        "currency": ccy,
        "reasoning": reasoning,
        "confidence": va.get("confidence"),
    }

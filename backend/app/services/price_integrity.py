"""Executed-price vs resolved-series integrity guard.

The strongest per-holding ground truth we own is the *executed* transaction price:
the user really paid CHF 49.50 for a Swatch share on 2023-06-19. If the series we
resolved for that instrument says the price on that date was CHF 258, we resolved
the wrong instrument (share class), the wrong currency, or a mis-scaled line — and
every downstream value built on that series is wrong.

This compares, for each buy, the executed unit price against the cached series
price on the trade date, both converted to CHF via the trade-date FX rate so a
cross-currency listing (e.g. a Toronto line bought in EUR) does not read as a
mismatch. A ratio far from 1.0 is a data-integrity failure.

Empirically on this portfolio the real wrong-instrument bugs land at 5.2x (Swatch
bearer vs registered) and 2.8x (UBS SMIM vs SMI ETF), while the worst *legitimate*
noise (intraday fill vs daily close + FX timing) is ~1.16x — so a 2.0x tolerance
separates them cleanly.
"""
from __future__ import annotations

from .fx import get_fx_rate
from .marketdata import listing_currency, price_on

# A correct instrument's executed fill sits within intraday + FX-timing noise of
# its own daily close (<~1.2x here). A share-class / wrong-line swap is >=2x.
TOLERANCE = 2.0
# Absolute backstop: a normal equity share priced above this (in CHF) is almost
# certainly a wrong line, even if no executed price is available to compare.
IMPLAUSIBLE_SHARE_CHF = 5000.0


def check_price_integrity(instrument: dict, txs: list[dict]) -> dict | None:
    """Return an integrity verdict for one instrument, or None if inconclusive.

    Verdict: {ok, ratio, executedCHF, seriesCHF, tradeDate, symbol}. ``ok=False``
    means the resolved series disagrees with what the user actually paid."""
    symbol = instrument.get("symbol")
    if not symbol:
        return None

    listing_ccy = listing_currency(symbol, instrument.get("currency")) or "USD"
    inst_ccy = instrument.get("currency") or "USD"

    worst: dict | None = None
    for t in txs:
        if t.get("action") != "buy":
            continue
        unit = t.get("unitPrice") or 0
        if unit <= 0:
            continue
        date = t["date"]
        series_price = price_on(symbol, date)
        if not series_price or series_price <= 0:
            continue

        tx_ccy = t.get("currency") or inst_ccy
        exec_chf = unit * get_fx_rate(tx_ccy, "CHF", date)
        series_chf = series_price * get_fx_rate(listing_ccy, "CHF", date)
        if exec_chf <= 0 or series_chf <= 0:
            continue

        ratio = series_chf / exec_chf
        # Rank by distance from 1.0 in log space so 5x and 1/5x are equally bad.
        dev = ratio if ratio >= 1 else 1 / ratio
        if worst is None or dev > worst["_dev"]:
            worst = {
                "_dev": dev,
                "ratio": ratio,
                "executedCHF": exec_chf,
                "seriesCHF": series_chf,
                "tradeDate": date,
                "symbol": symbol,
            }

    if worst is None:
        # No executed price to compare — fall back to the absolute-plausibility
        # backstop for equities using the latest series price.
        if (instrument.get("kind") or "stock") == "stock":
            latest = price_on(symbol, "9999-12-31")
            if latest:
                series_chf = latest * get_fx_rate(listing_ccy, "CHF", "9999-12-31")
                if series_chf > IMPLAUSIBLE_SHARE_CHF:
                    return {
                        "ok": False, "ratio": None, "executedCHF": None,
                        "seriesCHF": series_chf, "tradeDate": None, "symbol": symbol,
                    }
        return None

    worst.pop("_dev", None)
    worst["ok"] = (1 / TOLERANCE) <= worst["ratio"] <= TOLERANCE
    return worst

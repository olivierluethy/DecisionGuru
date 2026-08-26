"""Geographic & sector exposure — per-asset (via `build_allocation`) and rolled up to the
whole portfolio by weighting each holding's breakdown by its current CHF market value.

Also compares two assets' exposures side by side to reveal concentration vs
diversification (overlap % + a Herfindahl concentration score per side).
"""
from __future__ import annotations

from ..reference.geo import COUNTRY_COORDS
from . import repo
from .allocation import build_allocation
from .finance import build_position


def _coords_for(country: str) -> dict:
    c = COUNTRY_COORDS.get(country)
    return {"lat": c["lat"], "lng": c["lng"]} if c else {}


def _merge(slices_weighted: list[tuple[dict, float]], kind: str) -> list[dict]:
    """Combine weighted allocation slices into a normalised breakdown (weights sum→1)."""
    acc: dict[str, dict] = {}
    total = 0.0
    for alloc, w in slices_weighted:
        for s in alloc.get(kind, []):
            key = s["key"]
            contrib = (s.get("weight") or 0) * w
            if contrib <= 0:
                continue
            total += contrib
            if key not in acc:
                acc[key] = {"key": key, "label": s.get("label") or key, "weight": 0.0}
                if s.get("lat") is not None:
                    acc[key].update({"lat": s["lat"], "lng": s["lng"]})
            acc[key]["weight"] += contrib
    out = list(acc.values())
    if total > 0:
        for s in out:
            s["weight"] = s["weight"] / total
    out.sort(key=lambda s: -s["weight"])
    return out


def _herfindahl(slices: list[dict]) -> float:
    """Concentration score 0..1 — sum of squared weights (1 = single bucket)."""
    return round(sum((s["weight"]) ** 2 for s in slices), 4)


def portfolio_exposure(settings: dict) -> dict:
    """Value-weighted geographic + sector exposure across all live holdings."""
    tax = settings["tax"]
    weighted: list[tuple[dict, float]] = []
    holdings: list[dict] = []
    total_value = 0.0
    for inst in repo.list_instruments():
        txs = repo.get_transactions(inst["id"])
        if not txs:
            continue
        pos = build_position(inst, txs, tax)["position"]
        value = pos.get("currentValueCHF") or 0
        if value <= 0 or pos["openQuantity"] <= 0:
            continue
        alloc = build_allocation(inst)
        total_value += value
        weighted.append((alloc, value))
        holdings.append({"instrumentId": inst["id"], "symbol": inst["symbol"],
                         "name": inst["name"], "valueCHF": value})
    countries = _merge(weighted, "countries")
    sectors = _merge(weighted, "sectors")
    for h in holdings:
        h["weight"] = (h["valueCHF"] / total_value) if total_value > 0 else 0.0
    holdings.sort(key=lambda h: -h["valueCHF"])
    return {
        "totalValueCHF": total_value,
        "countries": countries,
        "sectors": sectors,
        "holdings": holdings,
        "concentration": {
            "country": _herfindahl(countries),
            "sector": _herfindahl(sectors),
            "topHoldingWeight": holdings[0]["weight"] if holdings else 0.0,
        },
    }


def _overlap(a: list[dict], b: list[dict]) -> float:
    """Shared weight between two normalised breakdowns (Σ min(wa,wb))."""
    bw = {s["key"]: s["weight"] for s in b}
    return round(sum(min(s["weight"], bw.get(s["key"], 0.0)) for s in a), 4)


def compare_exposure(instrument_a: dict, instrument_b: dict) -> dict:
    """Two assets' exposures side by side + overlap and per-side concentration."""
    alloc_a = build_allocation(instrument_a)
    alloc_b = build_allocation(instrument_b)
    ca = _merge([(alloc_a, 1.0)], "countries")
    cb = _merge([(alloc_b, 1.0)], "countries")
    sa = _merge([(alloc_a, 1.0)], "sectors")
    sb = _merge([(alloc_b, 1.0)], "sectors")
    return {
        "a": {"symbol": instrument_a["symbol"], "name": instrument_a["name"],
              "countries": ca, "sectors": sa,
              "concentration": {"country": _herfindahl(ca), "sector": _herfindahl(sa)}},
        "b": {"symbol": instrument_b["symbol"], "name": instrument_b["name"],
              "countries": cb, "sectors": sb,
              "concentration": {"country": _herfindahl(cb), "sector": _herfindahl(sb)}},
        "overlap": {"country": _overlap(ca, cb), "sector": _overlap(sa, sb)},
    }

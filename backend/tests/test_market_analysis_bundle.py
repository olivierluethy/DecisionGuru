"""Bundle assembly for the market-analysis endpoint. Provider-touching sub-calls are
stubbed; price history is seeded into the cache so the returns/series are real."""
from __future__ import annotations

import pandas as pd
import pytest

from app.core import db
from app.services import market_analysis as ma


def _seed(symbol, points):
    for d, c in points:
        db.execute("INSERT OR REPLACE INTO price_cache (symbol, date, close) VALUES (?, ?, ?)",
                   (symbol, d, c))


@pytest.fixture(autouse=True)
def _clean():
    db.execute("DELETE FROM price_cache WHERE symbol LIKE 'MKT%' OR symbol IN ('SPY','VWRL.SW','XLV')")
    yield
    db.execute("DELETE FROM price_cache WHERE symbol LIKE 'MKT%' OR symbol IN ('SPY','VWRL.SW','XLV')")


def test_bundle_company_specific_weakness(monkeypatch):
    today = pd.Timestamp.utcnow().normalize()
    d1y = (today - pd.DateOffset(months=12)).strftime("%Y-%m-%d")
    dnow = today.strftime("%Y-%m-%d")
    # Subject down 20%, sector ETF up 12%, a peer up 10%.
    _seed("MKTS", [(d1y, 100.0), (dnow, 80.0)])
    _seed("XLV", [(d1y, 100.0), (dnow, 112.0)])
    _seed("MKTP", [(d1y, 100.0), (dnow, 110.0)])
    _seed("SPY", [(d1y, 100.0), (dnow, 111.0)])
    _seed("VWRL.SW", [(d1y, 100.0), (dnow, 108.0)])

    # Stub the peer set + fundamentals + price + valuation (no provider/network).
    monkeypatch.setattr(ma, "competitors", lambda sym: {
        "symbol": "MKTS", "sector": "Healthcare", "industry": "Drug Manufacturers",
        "peers": [
            {"symbol": "MKTS", "name": "Subject Co", "isSubject": True, "marketCap": 2e11,
             "currency": "USD", "trailingPE": 15, "priceToBook": 3, "profitMargins": 0.2,
             "revenueGrowth": 0.05},
            {"symbol": "MKTP", "name": "Peer Co", "isSubject": False, "marketCap": 1e11,
             "currency": "USD", "trailingPE": 20, "priceToBook": 4, "profitMargins": 0.1,
             "revenueGrowth": 0.08},
        ],
    })
    monkeypatch.setattr(ma, "get_cached_fundamentals", lambda sym: {
        "snapshot": {"name": "Subject Co", "sector": "Healthcare",
                     "industry": "Drug Manufacturers", "currency": "USD"}})
    monkeypatch.setattr(ma, "resolve_price", lambda sym, cur=None: {"price": 80.0, "currency": "USD"})
    monkeypatch.setattr(ma, "value_analysis", lambda *a, **k: {
        "band": {"band": "overvalued"}, "marginOfSafety": -0.15, "fairValue": 70.0})
    monkeypatch.setattr(ma, "get_fx_rate", lambda *a, **k: 0.9)
    monkeypatch.setattr(ma, "ensure_history", lambda *a, **k: None)

    b = ma.market_analysis("MKTS", "1Y", settings={})
    assert b["sector"] == "Healthcare"
    assert b["subject"]["returnPct"] == pytest.approx(-0.20, abs=1e-6)
    assert b["sectorLine"]["kind"] == "etf" and b["sectorLine"]["symbol"] == "XLV"
    assert b["sectorLine"]["returnPct"] == pytest.approx(0.12, abs=1e-6)
    assert b["classification"] == "company-specific-weakness"
    subj = next(c for c in b["competitors"] if c["isSubject"])
    assert subj["marketCapCHF"] == pytest.approx(2e11 * 0.9, rel=1e-6)
    assert b["valuation"]["band"]["band"] == "overvalued"
    assert any(bm["key"] == "sp500" for bm in b["benchmarks"])


def test_bundle_sector_falls_back_to_peer_median(monkeypatch):
    today = pd.Timestamp.utcnow().normalize()
    d1y = (today - pd.DateOffset(months=12)).strftime("%Y-%m-%d")
    dnow = today.strftime("%Y-%m-%d")
    _seed("MKTS", [(d1y, 100.0), (dnow, 90.0)])
    _seed("MKTP", [(d1y, 100.0), (dnow, 120.0)])   # peer +20%, no XLE seeded
    monkeypatch.setattr(ma, "competitors", lambda sym: {
        "symbol": "MKTS", "sector": "Energy", "industry": "Oil & Gas",
        "peers": [
            {"symbol": "MKTS", "name": "S", "isSubject": True, "marketCap": None, "currency": "USD"},
            {"symbol": "MKTP", "name": "P", "isSubject": False, "marketCap": None, "currency": "USD"},
        ]})
    monkeypatch.setattr(ma, "get_cached_fundamentals", lambda sym: {
        "snapshot": {"name": "S", "sector": "Energy", "industry": "Oil & Gas", "currency": "USD"}})
    monkeypatch.setattr(ma, "resolve_price", lambda sym, cur=None: {"price": 90.0, "currency": "USD"})
    monkeypatch.setattr(ma, "value_analysis", lambda *a, **k: {"band": None, "marginOfSafety": None, "fairValue": None})
    monkeypatch.setattr(ma, "get_fx_rate", lambda *a, **k: None)   # FX unresolved → no CHF cap
    monkeypatch.setattr(ma, "ensure_history", lambda *a, **k: None)
    db.execute("DELETE FROM price_cache WHERE symbol = 'XLE'")

    b = ma.market_analysis("MKTS", "1Y", settings={})
    assert b["sectorLine"]["kind"] == "peer-median"
    assert b["sectorLine"]["returnPct"] == pytest.approx(0.20, abs=1e-6)   # median of [peer +20%]
    subj = next(c for c in b["competitors"] if c["isSubject"])
    assert subj["marketCapCHF"] is None    # FX unresolved → not fabricated


def test_no_sector_yields_unavailable_sector_line(monkeypatch):
    monkeypatch.setattr(ma, "competitors", lambda sym: {
        "symbol": "MKTS", "sector": None, "industry": None, "peers": []})
    monkeypatch.setattr(ma, "get_cached_fundamentals", lambda sym: {"snapshot": {"currency": "USD"}})
    monkeypatch.setattr(ma, "resolve_price", lambda sym, cur=None: {"price": None, "currency": "USD"})
    monkeypatch.setattr(ma, "value_analysis", lambda *a, **k: {"band": None, "marginOfSafety": None, "fairValue": None})
    monkeypatch.setattr(ma, "get_fx_rate", lambda *a, **k: 0.9)
    monkeypatch.setattr(ma, "ensure_history", lambda *a, **k: None)
    b = ma.market_analysis("MKTS", "1Y", settings={})
    assert b["sectorLine"]["kind"] == "unavailable"
    assert b["classification"] is None
    assert b["competitors"] == []

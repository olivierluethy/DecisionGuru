from app.reference import sector_etfs as se


def test_known_sector_maps_to_spdr_etf():
    assert se.sector_etf_for("Healthcare") == "XLV"
    assert se.sector_etf_for("Technology") == "XLK"
    assert se.sector_etf_for("Financial Services") == "XLF"


def test_unknown_or_missing_sector_is_none():
    assert se.sector_etf_for("Nonexistent Sector") is None
    assert se.sector_etf_for(None) is None
    assert se.sector_etf_for("") is None


def test_market_analysis_symbols_covers_etfs_and_broad_benchmarks():
    for sym in se.SECTOR_ETF.values():
        assert sym in se.MARKET_ANALYSIS_SYMBOLS
    for _key, sym in se.BROAD_BENCHMARKS:
        assert sym in se.MARKET_ANALYSIS_SYMBOLS
    # No duplicates.
    assert len(se.MARKET_ANALYSIS_SYMBOLS) == len(set(se.MARKET_ANALYSIS_SYMBOLS))

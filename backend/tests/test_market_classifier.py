from app.services import market_analysis as ma


def test_scenario_a_market_wide_weakness():
    # Subject -20%, sector -18%, peers ~-19% → the whole market is weak.
    assert ma.classify(-0.20, -0.18, -0.19, -0.17) == "market-wide-weakness"


def test_scenario_b_company_specific_weakness():
    # Subject -20% while sector +12% and peers positive → the company, not the market.
    assert ma.classify(-0.20, 0.12, 0.10, 0.11) == "company-specific-weakness"


def test_outperforming_peers_when_ahead_of_both():
    assert ma.classify(0.30, 0.10, 0.08, 0.09) == "outperforming-peers"


def test_outperforming_sector_when_ahead_of_sector_only():
    # Ahead of the sector but not clearly ahead of the peer median.
    assert ma.classify(0.18, 0.10, 0.17, 0.09) == "outperforming-sector"


def test_inline_when_close_to_reference():
    assert ma.classify(0.11, 0.10, 0.10, 0.09) == "inline"


def test_none_when_no_reference():
    assert ma.classify(-0.20, None, None, None) is None
    assert ma.classify(None, 0.10, 0.10, 0.10) is None


def test_peer_median_ignores_none():
    r = {"A": {"1Y": 0.10}, "B": {"1Y": None}, "C": {"1Y": 0.30}}
    assert ma.peer_median(r, "1Y") == 0.20
    assert ma.peer_median({"A": {"1Y": None}}, "1Y") is None

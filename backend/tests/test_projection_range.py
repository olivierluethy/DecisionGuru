"""Register #11: the prospective projection now returns a bear/base/bull range, not a single
deterministic point."""
from app.services import projection as P


def test_prospective_projection_has_bear_base_bull_range():
    r = P.prospective_projection("AAPL", "VWRL.SW", amount_chf=10_000.0, years=5.0,
                                 stock_cagr=0.08, etf_cagr=0.05)
    hr = r["holdRange"]
    assert hr["bear"] < hr["base"] < hr["bull"]
    assert hr["bearCagr"] < hr["baseCagr"] < hr["bullCagr"]

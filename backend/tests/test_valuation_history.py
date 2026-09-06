# backend/tests/test_valuation_history.py  (create; more tests added in later tasks)
import pandas as pd
from app.providers import yfinance_provider as yp


def test_period_end_extracts_iso_date():
    assert yp._period_end(pd.Timestamp("2020-09-26")) == "2020-09-26"
    assert yp._period_end(None) is None
    assert yp._period_end("not-a-timestamp") is None


from app.services import valuation_history as vh
from app.services import valuation as v

CFG = v._val_cfg(None)


def _fixture():
    # 3 fiscal years; net income & FCF grow, shares flat. USD (major unit).
    # Net income 100 -> 108 -> 150 is deliberate: CAGR(2020->2021) = 8% stays BELOW
    # GROWTH_CAP (15%) while CAGR(2020->2022) ~= 22.5% clamps to 15% — so the raw (and
    # clamped) growth used for 2021 genuinely diverges from what a look-ahead bug (using
    # the full 2020-2022 series when computing 2021's growth) would produce. A fixture
    # where both CAGRs exceed GROWTH_CAP would clamp to the same value and mask that bug.
    history = [
        {"year": 2020, "periodEnd": "2020-12-31", "revenue": 1000.0, "netIncome": 100.0},
        {"year": 2021, "periodEnd": "2021-12-31", "revenue": 1100.0, "netIncome": 108.0},
        {"year": 2022, "periodEnd": "2022-12-31", "revenue": 1210.0, "netIncome": 150.0},
    ]
    cashflow = {"sharesOutstanding": 100.0, "years": [
        {"year": 2020, "periodEnd": "2020-12-31", "freeCashFlow": 90.0, "netIncome": 100.0, "dna": 20.0, "capex": -30.0},
        {"year": 2021, "periodEnd": "2021-12-31", "freeCashFlow": 110.0, "netIncome": 108.0, "dna": 22.0, "capex": -32.0},
        {"year": 2022, "periodEnd": "2022-12-31", "freeCashFlow": 140.0, "netIncome": 150.0, "dna": 25.0, "capex": -35.0},
    ]}
    balance = {"years": [
        {"year": 2020, "periodEnd": "2020-12-31", "stockholdersEquity": 500.0, "sharesOutstanding": 100.0},
        {"year": 2021, "periodEnd": "2021-12-31", "stockholdersEquity": 560.0, "sharesOutstanding": 100.0},
        {"year": 2022, "periodEnd": "2022-12-31", "stockholdersEquity": 640.0, "sharesOutstanding": 100.0},
    ]}
    return history, cashflow, balance


def test_year_inputs_reconstructs_per_share_values():
    history, cashflow, balance = _fixture()
    out = vh._year_inputs(2022, history, cashflow, balance, "USD", CFG)
    assert out is not None
    assert out["eps"] == 1.5          # 150 / 100
    assert out["bvps"] == 6.4         # 640 / 100
    assert out["fairValue"] and out["fairValue"] > 0
    assert set(out["models"]).issubset({"grahamNumber", "grahamGrowth", "dcf", "fcf"})


def test_no_look_ahead_growth_uses_only_past_years():
    history, cashflow, balance = _fixture()
    # Growth at 2021 must derive ONLY from 2020..2021, ignoring 2022. This is decisive:
    # the correct (filtered) CAGR is 8% (unclamped), while a look-ahead bug that let 2022
    # leak into the CAGR would compute ~22.47% (2020->2022), which clamps to 15% — a
    # different number from the correct 8%. (Contrast: with a fixture where BOTH raw
    # CAGRs exceed GROWTH_CAP, both clamp to the same 15% and the test can't tell the two
    # implementations apart — that was the bug in the original version of this test.)
    g2021 = vh._year_inputs(2021, history, cashflow, balance, "USD", CFG)["growth"]
    expected_filtered = (108.0 / 100.0) ** (1 / 1) - 1     # CAGR 2020->2021 = 0.08
    expected_leaked = (150.0 / 100.0) ** (1 / 2) - 1        # CAGR 2020->2022 (look-ahead bug)
    assert v._clamp(expected_filtered, -0.05, v.GROWTH_CAP) != v._clamp(expected_leaked, -0.05, v.GROWTH_CAP)
    assert abs(g2021 - v._clamp(expected_filtered, -0.05, v.GROWTH_CAP)) < 1e-9


def test_year_without_shares_is_not_reconstructable():
    history, cashflow, balance = _fixture()
    balance["years"][2]["sharesOutstanding"] = None
    # 2022 has no shares in balance and cashflow.sharesOutstanding is a *current* fallback we
    # must NOT use for a historical year -> not reconstructable from per-share inputs.
    out = vh._year_inputs(2022, history, cashflow, balance, "USD", CFG)
    assert out is None

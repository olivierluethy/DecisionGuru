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


import copy


def test_effective_date_uses_lag_when_no_filing_date():
    d, src = vh._effective_date("2020-12-31", None, 2020)
    assert d == "2021-03-31"   # +90 days
    assert src == "assumed"


def test_effective_date_prefers_filing_date():
    d, src = vh._effective_date("2020-12-31", "2021-02-10", 2020)
    assert d == "2021-02-10"
    assert src == "filing"


def test_build_snapshots_sorted_and_shaped():
    history, cashflow, balance = _fixture()
    data = {"history": history, "cashflow": cashflow, "balance": balance, "financialCurrency": "USD"}
    snaps = vh.build_snapshots(data, CFG)
    assert [s["fiscalYear"] for s in snaps] == sorted(s["fiscalYear"] for s in snaps)
    s = snaps[-1]
    assert s["fairValue"] > 0
    assert s["entryTarget"] == round(s["fairValue"] * (1 - CFG["mos"]), 2)
    assert s["sellZoneAt"] == round(s["fairValue"] * (1 + CFG["sig"]), 2)
    assert s["inputs"]["eps"] == 1.5
    assert s["effectiveDateSource"] == "assumed"


def test_stability_mutating_latest_year_leaves_priors_unchanged():
    history, cashflow, balance = _fixture()
    data = {"history": history, "cashflow": cashflow, "balance": balance, "financialCurrency": "USD"}
    before = vh.build_snapshots(copy.deepcopy(data), CFG)
    # Mutate ONLY the latest (2022) fundamentals — a proxy for "today's data changed".
    data["history"][2]["netIncome"] = 999.0
    data["cashflow"]["years"][2]["freeCashFlow"] = 999.0
    data["balance"]["years"][2]["stockholdersEquity"] = 9990.0
    after = vh.build_snapshots(data, CFG)
    prior_before = [s for s in before if s["fiscalYear"] < 2022]
    prior_after = [s for s in after if s["fiscalYear"] < 2022]
    assert prior_before == prior_after   # no look-ahead: history is immutable to future data


def test_delta_shapes():
    d = vh._delta(100.0, 110.0)
    assert d["before"] == 100.0 and d["after"] == 110.0
    assert abs(d["deltaPct"] - 0.10) < 1e-9 and d["dir"] == "up"
    assert vh._delta(None, 110.0)["deltaPct"] is None
    assert vh._delta(100.0, 90.0)["dir"] == "down"


def test_drivers_first_none_rest_full_chain():
    history, cashflow, balance = _fixture()
    data = {"history": history, "cashflow": cashflow, "balance": balance, "financialCurrency": "USD"}
    snaps = vh.build_snapshots(data, CFG)
    vh.attach_drivers(snaps)
    assert snaps[0]["drivers"] is None
    dr = snaps[-1]["drivers"]
    assert set(dr) == {"inputs", "models", "fairValue", "zones"}
    assert set(dr["inputs"]) == {"eps", "fcfPerShare", "bvps", "growth"}
    for mk in ("grahamNumber", "grahamGrowth", "dcf", "fcf"):
        assert "valid" in dr["models"][mk] and "contributed" in dr["models"][mk]
    assert dr["fairValue"]["after"] == snaps[-1]["fairValue"]


def test_model_valid_vs_contributed_distinct_when_negative_eps():
    # Craft a year whose eps is negative in the LATER year so graham models drop out.
    history = [
        {"year": 2020, "periodEnd": "2020-12-31", "revenue": 1000.0, "netIncome": 100.0},
        {"year": 2021, "periodEnd": "2021-12-31", "revenue": 900.0, "netIncome": -50.0},
    ]
    cashflow = {"sharesOutstanding": 100.0, "years": [
        {"year": 2020, "periodEnd": "2020-12-31", "freeCashFlow": 90.0},
        {"year": 2021, "periodEnd": "2021-12-31", "freeCashFlow": 80.0},
    ]}
    balance = {"years": [
        {"year": 2020, "periodEnd": "2020-12-31", "stockholdersEquity": 500.0, "sharesOutstanding": 100.0},
        {"year": 2021, "periodEnd": "2021-12-31", "stockholdersEquity": 450.0, "sharesOutstanding": 100.0},
    ]}
    data = {"history": history, "cashflow": cashflow, "balance": balance, "financialCurrency": "USD"}
    snaps = vh.build_snapshots(data, CFG)
    vh.attach_drivers(snaps)
    dr = snaps[-1]["drivers"]
    # grahamGrowth needs eps>0 -> invalid in 2021, so not contributed either.
    assert dr["models"]["grahamGrowth"]["valid"] is False
    assert dr["models"]["grahamGrowth"]["contributed"] is False

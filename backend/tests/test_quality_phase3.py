"""Phase-3: business quality + financial strength (VALUE_INVESTING_AUDIT §3 quality/strength).

A Buffett-style read the old 6-binary scorecard couldn't give: return on invested capital,
whether accounting profit converts to cash, interest coverage, earnings/margin consistency,
dilution vs buybacks, a financial-strength rating with DISTINCT debt states (0 ≠ unknown ≠
high), and a moat signal that is 'unknown' rather than fabricated when data is thin.
"""
from __future__ import annotations

from app.services import quality as Q


def payload(**over):
    data = {
        "snapshot": {
            "grossMargins": 0.55, "operatingMargins": 0.28, "profitMargins": 0.22,
            "returnOnEquity": 0.25, "ebitda": 1200.0, "totalDebt": 2000.0, "totalCash": 500.0,
            "sharesOutstanding": 1000.0,
        },
        "history": [
            {"year": 2021, "revenue": 10000.0, "operatingIncome": 2600.0, "operatingMargin": 0.26},
            {"year": 2022, "revenue": 11000.0, "operatingIncome": 2970.0, "operatingMargin": 0.27},
            {"year": 2023, "revenue": 12000.0, "operatingIncome": 3360.0, "operatingMargin": 0.28},
        ],
        "cashflow": {
            "sharesOutstanding": 1000.0,
            "years": [
                {"year": 2021, "freeCashFlow": 1800.0, "netIncome": 2000.0},
                {"year": 2022, "freeCashFlow": 1900.0, "netIncome": 2100.0},
                {"year": 2023, "freeCashFlow": 1980.0, "netIncome": 2200.0},
            ],
        },
        "balance": {
            "years": [
                {"year": 2021, "investedCapital": 10000.0, "totalDebt": 2200.0, "cash": 400.0,
                 "stockholdersEquity": 8000.0, "currentAssets": 6000.0, "currentLiabilities": 3000.0,
                 "sharesOutstanding": 1020.0},
                {"year": 2023, "investedCapital": 10000.0, "totalDebt": 2000.0, "cash": 500.0,
                 "stockholdersEquity": 9000.0, "currentAssets": 6600.0, "currentLiabilities": 3000.0,
                 "sharesOutstanding": 980.0},
            ],
        },
        "income": {
            "years": [
                {"year": 2023, "operatingIncome": 3360.0, "interestExpense": 168.0,
                 "pretaxIncome": 3000.0, "taxProvision": 600.0},
            ],
        },
    }
    data.update(over)
    return data


# --- ROIC -----------------------------------------------------------------------
def test_roic_uses_nopat_over_invested_capital():
    q = Q.assess_quality(payload())
    # NOPAT = EBIT 3360 × (1 − 600/3000=0.2) = 2688; ROIC = 2688/10000 = 0.2688
    assert abs(q["roic"]["value"] - 0.2688) < 1e-3
    assert q["roic"]["rating"] == "strong"


def test_roic_unknown_without_invested_capital():
    q = Q.assess_quality(payload(balance={"years": []}))
    assert q["roic"]["value"] is None
    assert q["roic"]["rating"] == "unknown"


# --- FCF conversion -------------------------------------------------------------
def test_fcf_conversion_is_fcf_over_net_income():
    q = Q.assess_quality(payload())
    # median FCF 1900 / median NI 2100 ≈ 0.905
    assert abs(q["fcfConversion"]["value"] - (1900.0 / 2100.0)) < 1e-3
    assert q["fcfConversion"]["rating"] == "strong"


# --- interest coverage ----------------------------------------------------------
def test_interest_coverage_ebit_over_interest():
    q = Q.assess_quality(payload())
    assert abs(q["interestCoverage"]["value"] - (3360.0 / 168.0)) < 1e-6  # 20×
    assert q["interestCoverage"]["rating"] == "strong"


def test_interest_coverage_na_when_debt_free():
    q = Q.assess_quality(payload(snapshot={**payload()["snapshot"], "totalDebt": 0.0},
                                 income={"years": [{"year": 2023, "operatingIncome": 3360.0,
                                                    "interestExpense": 0.0}]}))
    assert q["interestCoverage"]["rating"] in {"strong", "n/a"}


# --- dilution -------------------------------------------------------------------
def test_dilution_detects_buyback():
    q = Q.assess_quality(payload())
    # shares 1020 → 980 = −3.9% → buyback
    assert q["dilution"]["sharesChangePct"] < 0
    assert q["dilution"]["rating"] == "buyback"


def test_dilution_detects_share_issuance():
    bal = {"years": [
        {"year": 2021, "investedCapital": 10000.0, "sharesOutstanding": 900.0},
        {"year": 2023, "investedCapital": 10000.0, "sharesOutstanding": 1100.0},
    ]}
    q = Q.assess_quality(payload(balance=bal))
    assert q["dilution"]["sharesChangePct"] > 0
    assert q["dilution"]["rating"] == "dilutive"


# --- consistency ----------------------------------------------------------------
def test_revenue_consistency_stable():
    q = Q.assess_quality(payload())
    assert q["consistency"]["revenue"]["rating"] == "stable"


def test_revenue_consistency_variable():
    hist = [
        {"year": 2021, "revenue": 10000.0, "operatingIncome": 500.0, "operatingMargin": 0.05},
        {"year": 2022, "revenue": 4000.0, "operatingIncome": 200.0, "operatingMargin": 0.05},
        {"year": 2023, "revenue": 16000.0, "operatingIncome": 900.0, "operatingMargin": 0.056},
    ]
    q = Q.assess_quality(payload(history=hist))
    assert q["consistency"]["revenue"]["rating"] == "variable"


# --- financial strength ---------------------------------------------------------
def test_financial_strength_debt_free_state():
    fs = Q.assess_financial_strength(payload(snapshot={**payload()["snapshot"], "totalDebt": 0.0}))
    assert fs["debtState"] == "debt-free"
    assert fs["rating"] == "strong"


def test_financial_strength_unknown_when_debt_missing():
    fs = Q.assess_financial_strength(payload(snapshot={**payload()["snapshot"], "totalDebt": None}))
    assert fs["debtState"] == "unknown"


def test_financial_strength_high_leverage_is_stretched():
    snap = {**payload()["snapshot"], "totalDebt": 6000.0, "ebitda": 1000.0, "totalCash": 100.0}
    fs = Q.assess_financial_strength(payload(snapshot=snap))
    assert fs["debtState"] in {"high", "moderate"}
    assert fs["netDebtToEbitda"] > 3
    assert fs["rating"] in {"stretched", "adequate"}


def test_current_ratio_computed():
    fs = Q.assess_financial_strength(payload())
    assert abs(fs["currentRatio"] - (6600.0 / 3000.0)) < 1e-6


# --- moat -----------------------------------------------------------------------
def test_moat_measurable_when_signals_strong():
    q = Q.assess_quality(payload())
    assert q["moat"]["signal"] in {"measurable-strong", "measurable-some"}
    assert q["moat"]["evidence"]


def test_moat_unknown_when_data_thin():
    thin = {"snapshot": {}, "history": [], "cashflow": {"years": []}, "balance": {"years": []},
            "income": {"years": []}}
    q = Q.assess_quality(thin)
    assert q["moat"]["signal"] == "unknown"

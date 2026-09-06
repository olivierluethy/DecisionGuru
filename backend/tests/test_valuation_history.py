# backend/tests/test_valuation_history.py  (create; more tests added in later tasks)
import pandas as pd
from app.providers import yfinance_provider as yp


def test_period_end_extracts_iso_date():
    assert yp._period_end(pd.Timestamp("2020-09-26")) == "2020-09-26"
    assert yp._period_end(None) is None
    assert yp._period_end("not-a-timestamp") is None

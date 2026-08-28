"""Phase-4: ISIN / company-identity ownership across listings (AUDIT §3 F-12, Scenario G).

The old ownership test keyed on the exact ticker, so a company held as NESN.SW but
encountered as its ADR NSRGY read 'not owned' → "Buy" instead of "Buy more". Ownership is
now recognisable by the shared ISIN (economic entity), not just the symbol string.
"""
from __future__ import annotations

import pytest

from app.core import db
from app.services import repo

TEST_ISIN = "CH_PHASE4_TESTISIN"


@pytest.fixture
def two_listings_one_owned():
    # Clean any residue from a previous run (the test DB file persists).
    db.execute("DELETE FROM transactions WHERE instrumentId IN "
               "(SELECT id FROM instruments WHERE isin = ?)", (TEST_ISIN,))
    db.execute("DELETE FROM instruments WHERE isin = ?", (TEST_ISIN,))

    # The schema enforces one instrument per ISIN, so a cross-listing is NOT a second
    # instrument row — it's a query symbol (the ADR) that resolves to the held company's
    # ISIN. We hold NESN.SW; NSRGY is met elsewhere and resolves to the same ISIN.
    cur = db.execute(
        "INSERT INTO instruments (symbol, isin, name, kind, currency) VALUES (?, ?, ?, ?, ?)",
        ("NESN.SW", TEST_ISIN, "Nestle SA", "stock", "CHF"),
    )
    home_id = cur.lastrowid
    db.execute("INSERT INTO transactions (instrumentId, action, date, quantity) "
               "VALUES (?, 'buy', '2020-01-01', 10)", (home_id,))
    yield
    db.execute("DELETE FROM transactions WHERE instrumentId IN "
               "(SELECT id FROM instruments WHERE isin = ?)", (TEST_ISIN,))
    db.execute("DELETE FROM instruments WHERE isin = ?", (TEST_ISIN,))


def test_owned_isin_set_contains_the_held_company(two_listings_one_owned):
    assert TEST_ISIN in repo.owned_isin_set()


def test_ownership_recognised_on_the_other_listing_via_isin(two_listings_one_owned):
    # The ADR was never traded, but its ISIN is held → owned.
    assert repo.is_owned("NSRGY", isin=TEST_ISIN) is True


def test_symbol_alone_on_untraded_listing_reads_not_owned(two_listings_one_owned):
    assert repo.is_owned("NSRGY") is False


def test_held_symbol_is_owned(two_listings_one_owned):
    assert repo.is_owned("NESN.SW") is True

"""Area 4 — the Discover attractiveness score must gate on a REAL margin of safety.

A fair-priced name with good quality is not an opportunity: without a genuine discount to
fair value it must not out-rank a real bargain, and an assumption-sensitive (tier-2) discount
is sunk the same way an insufficient-data name is. The 0..100 score is a ranking signal only;
the binary 'attractive' comes from the canonical buy-more verdict.
"""
from __future__ import annotations

from app.services.screener import discover_attractiveness as da


def test_deep_discount_outranks_fair_quality_name():
    bargain = da(margin_of_safety=0.30, quality_rating="adequate", expected_return=0.08,
                 fit_bonus=0.5, confidence="high", data_sufficient=True)
    fair = da(margin_of_safety=0.0, quality_rating="strong", expected_return=0.08,
              fit_bonus=0.5, confidence="high", data_sufficient=True)
    assert bargain > fair


def test_no_margin_of_safety_is_sunk_even_with_strong_quality():
    """A strong, fairly-priced name is not an opportunity — it must score low."""
    score = da(margin_of_safety=0.0, quality_rating="strong", expected_return=0.10,
               fit_bonus=1.0, confidence="high", data_sufficient=True)
    assert score <= 40


def test_negative_margin_of_safety_is_sunk():
    score = da(margin_of_safety=-0.20, quality_rating="strong", expected_return=0.10,
               fit_bonus=1.0, confidence="high", data_sufficient=True)
    assert score <= 40


def test_assumption_sensitive_tier2_is_sunk_like_insufficient_data():
    reliable = da(margin_of_safety=0.30, quality_rating="strong", expected_return=0.10,
                  fit_bonus=0.5, confidence="high", data_sufficient=True, reliability_tier=1)
    sensitive = da(margin_of_safety=0.30, quality_rating="strong", expected_return=0.10,
                   fit_bonus=0.5, confidence="high", data_sufficient=True, reliability_tier=2)
    assert sensitive < reliable
    assert sensitive <= 40


def test_missing_margin_of_safety_scores_low():
    score = da(margin_of_safety=None, quality_rating="strong", expected_return=0.10,
               fit_bonus=1.0, confidence="high", data_sufficient=True)
    assert score <= 40

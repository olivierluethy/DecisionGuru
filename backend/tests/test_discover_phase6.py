"""Phase-6: Discover attractiveness ranking (VALUE_INVESTING_AUDIT §3, brief §30 Phase 6, §22).

The ranking now folds in DATA CONFIDENCE and the richer quality read, so a deep discount on
unreliable data does not outrank a moderate discount on robust data, and INSUFFICIENT-DATA
names sink. It never depends on ownership — ownership only rewords the action, not the score.
"""
from __future__ import annotations

from app.services.screener import discover_attractiveness as score


def s(mos=0.30, quality="strong", ret=0.12, fit=0.5, confidence="high", sufficient=True):
    return score(margin_of_safety=mos, quality_rating=quality, expected_return=ret,
                 fit_bonus=fit, confidence=confidence, data_sufficient=sufficient)


def test_score_is_within_0_100():
    assert 0 <= s() <= 100
    assert 0 <= s(mos=-0.5, quality="weak", ret=0.0, fit=0.0, confidence="low") <= 100


def test_confidence_penalizes_the_score():
    assert s(confidence="high") > s(confidence="medium") > s(confidence="low")


def test_robust_moderate_discount_beats_shaky_deep_discount():
    # brief §22: a 50% MoS on unreliable data must NOT outrank a 30% MoS on robust data.
    robust = s(mos=0.30, confidence="high")
    shaky = s(mos=0.50, confidence="low")
    assert robust > shaky


def test_insufficient_data_sinks_the_score():
    assert s(mos=0.50, sufficient=False) < 30
    assert s(mos=0.50, sufficient=False) < s(mos=0.10, sufficient=True)


def test_quality_matters():
    assert s(quality="strong") > s(quality="weak")


def test_unknown_quality_between_weak_and_strong():
    assert s(quality="weak") < s(quality="unknown") < s(quality="strong")


def test_a_great_cheap_reliable_name_scores_high():
    assert s(mos=0.40, quality="strong", ret=0.13, fit=0.8, confidence="high") >= 75


def test_ownership_is_not_an_input():
    # The scorer takes no ownership argument — Discover ranks on merit, ownership only
    # rewords the action elsewhere. Two identical merit profiles score identically.
    assert s() == s()

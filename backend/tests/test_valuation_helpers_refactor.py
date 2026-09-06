import math
from app.services import valuation as v


def test_zone_edges_matches_classify_band():
    cfg = v._val_cfg(None)  # defaults: mos .30, ov .20, sig .40
    fv = 100.0
    edges = v.zone_edges(fv, cfg)
    assert edges["entryTarget"] == 70.0
    assert edges["overvaluedAt"] == 120.0
    assert edges["sellZoneAt"] == 140.0
    assert edges["zones"] == {
        "buy": [0.0, 70.0], "fair": [70.0, 120.0],
        "overvalued": [120.0, 140.0], "sell": [140.0, round(140.0 * 1.6, 2)],
    }
    band = v.classify_band(price=100.0, fair_value=fv, cfg=cfg)
    for k in ("entryTarget", "overvaluedAt", "sellZoneAt", "zones"):
        assert band[k] == edges[k]


def test_compute_models_matches_inline_formulas():
    cfg = v._val_cfg(None)
    m = v.compute_models(eps=5.0, bvps=20.0, base_eps=5.0, g=0.10,
                         normalized_fcf_ps=4.0, cfg=cfg)
    assert m["grahamNumber"] == round(math.sqrt(22.5 * 5.0 * 20.0), 2)
    assert m["grahamGrowth"] == round(5.0 * (8.5 + 2 * min(max(0.10 * 100, 0), 15)), 2)
    assert "dcf" in m and m["dcf"] > 0
    assert "fcf" in m and m["fcf"] > 0
    # Graham models require positive eps & bvps
    assert "grahamNumber" not in v.compute_models(-1.0, 20.0, None, 0.1, None, cfg)
    assert "grahamGrowth" not in v.compute_models(-1.0, 20.0, None, 0.1, None, cfg)

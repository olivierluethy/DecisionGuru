"""Portfolio-level aggregation of per-position counterfactuals.

The heavy path (`analysis/portfolio`, `analysis/compare`, `scenarios/run`) sums each
position's counterfactual series by date. Runs on PySpark when a SparkSession is available
and degrades to an identical pandas reducer otherwise — port of analysis.ts
aggregateCounterfactuals + lastAtOrBefore."""
from __future__ import annotations

from .spark_service import aggregate_series_spark


def _last_at_or_before(series: list[dict], date: str) -> dict | None:
    found = None
    for p in series:
        if p["date"] <= date:
            found = p
        else:
            break
    return found


def _aggregate_series_pandas(cfs: list[dict]) -> list[dict]:
    dates: set[str] = set()
    for cf in cfs:
        for p in cf.get("series", []):
            dates.add(p["date"])
    ordered = sorted(dates)
    series = []
    for date in ordered:
        actual = 0.0
        benchmark = 0.0
        for cf in cfs:
            point = _last_at_or_before(cf.get("series", []), date)
            if point:
                actual += point["actualCHF"]
                benchmark += point["benchmarkCHF"]
        series.append({
            "date": date,
            "actualCHF": round(actual * 100) / 100,
            "benchmarkCHF": round(benchmark * 100) / 100,
        })
    return series


def aggregate_counterfactuals(cfs: list[dict]) -> dict:
    """Merge per-position counterfactual series into a portfolio-level aggregate."""
    series = aggregate_series_spark(cfs)
    if series is None:
        series = _aggregate_series_pandas(cfs)

    actual_value_chf = sum(c["actualValueCHF"] for c in cfs)
    counterfactual_value_chf = sum(c["counterfactualValueCHF"] for c in cfs)
    delta_chf = actual_value_chf - counterfactual_value_chf
    return {
        "actualValueCHF": actual_value_chf,
        "counterfactualValueCHF": counterfactual_value_chf,
        "deltaCHF": delta_chf,
        "deltaPct": delta_chf / abs(counterfactual_value_chf) if counterfactual_value_chf != 0 else 0,
        "series": series,
    }

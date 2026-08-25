"""PySpark heavy path — lazily-initialised local SparkSession for bulk analytics.

Used to sum per-position counterfactual series by date across a (potentially large) ticker
universe — a natural distributed group-by / reduce. Spins up a single lazy local session
inside this dedicated service; never forced onto interactive single-ticker endpoints. If a
SparkSession cannot be created the caller falls back to the identical pandas reducer, so the
contract never changes and a request never hangs.
"""
from __future__ import annotations

import threading

from ..core.config import settings
from ..core.logging import get_logger

log = get_logger("spark")

_session = None
_lock = threading.Lock()
_failed = False


def get_spark():
    """Return a cached local SparkSession, or None if Spark is unavailable/disabled."""
    global _session, _failed
    if not settings.spark_enabled or _failed:
        return None
    if _session is not None:
        return _session
    with _lock:
        if _session is not None:
            return _session
        if _failed:
            return None
        try:
            from pyspark.sql import SparkSession

            _session = (
                SparkSession.builder.appName("decisionguru-bulk")
                .master("local[*]")
                .config("spark.ui.enabled", "false")
                .config("spark.sql.shuffle.partitions", "8")
                .config("spark.driver.host", "127.0.0.1")
                .getOrCreate()
            )
            _session.sparkContext.setLogLevel("ERROR")
            log.info("SparkSession ready (local heavy path)")
            return _session
        except Exception as exc:  # noqa: BLE001
            log.warning("Spark unavailable (%s); using pandas reducer", exc)
            _failed = True
            return None


def aggregate_series_spark(cfs: list[dict]) -> list[dict] | None:
    """Sum per-cf series by date using Spark forward-fill (lastAtOrBefore) semantics.

    Returns the merged series, or None if Spark is unavailable (caller falls back)."""
    spark = get_spark()
    if spark is None:
        return None
    try:
        from pyspark.sql import Window
        from pyspark.sql import functions as F

        rows = []
        all_dates = set()
        for i, cf in enumerate(cfs):
            for p in cf.get("series", []):
                rows.append((i, p["date"], float(p["actualCHF"]), float(p["benchmarkCHF"])))
                all_dates.add(p["date"])
        if not rows:
            return []

        pts = spark.createDataFrame(rows, ["cf", "date", "actual", "benchmark"])
        cf_ids = spark.createDataFrame([(i,) for i in range(len(cfs))], ["cf"])
        dates = spark.createDataFrame([(d,) for d in sorted(all_dates)], ["target"])
        # target axis x each cf, then pick the latest point on/before target (step function).
        grid = cf_ids.crossJoin(dates)
        joined = grid.join(pts, on="cf", how="left").where(F.col("date") <= F.col("target"))
        w = Window.partitionBy("cf", "target").orderBy(F.col("date").desc())
        latest = (
            joined.withColumn("rn", F.row_number().over(w))
            .where(F.col("rn") == 1)
            .groupBy("target")
            .agg(F.sum("actual").alias("actual"), F.sum("benchmark").alias("benchmark"))
        )
        collected = latest.collect()
        by_date = {r["target"]: (r["actual"], r["benchmark"]) for r in collected}
        series = []
        for d in sorted(all_dates):
            a, b = by_date.get(d, (0.0, 0.0))
            series.append({"date": d, "actualCHF": round(a * 100) / 100, "benchmarkCHF": round(b * 100) / 100})
        return series
    except Exception as exc:  # noqa: BLE001
        log.warning("Spark aggregation failed (%s); using pandas reducer", exc)
        return None

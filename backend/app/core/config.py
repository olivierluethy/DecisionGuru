"""Application configuration via pydantic-settings (.env-backed)."""
from __future__ import annotations

import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/  (this file is backend/app/core/config.py)
ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "decisionguru.sqlite"

for _d in (DATA_DIR, UPLOAD_DIR):
    _d.mkdir(parents=True, exist_ok=True)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ROOT / ".env"), env_prefix="DG_", extra="ignore"
    )

    # Server
    port: int = 5178
    host: str = "0.0.0.0"

    # CORS — the existing Vite frontend origin(s). "*" allows all (dev default).
    cors_origins: str = "*"

    # Database
    db_path: str = str(DB_PATH)

    # Cache TTLs (seconds) — mirror the retired Node backend's CACHE_TTL_MS.
    # Quotes are served stale-while-revalidate, so a longer TTL only cuts refresh
    # churn; the UI never blocks on expiry.
    cache_ttl_quote: int = 60 * 60           # 1 h
    cache_ttl_history: int = 12 * 60 * 60    # 12 h
    cache_ttl_fund: int = 7 * 24 * 60 * 60   # 7 d
    cache_ttl_fx: int = 12 * 60 * 60         # 12 h

    # Optional Redis-backed cache (falls back to in-process cachetools when empty).
    redis_url: str = ""

    # yfinance reliability knobs
    yf_min_gap_ms: int = 150       # min spacing between upstream calls (politeness)
    yf_retries: int = 4            # attempts on rate-limit
    yf_timeout_s: float = 20.0
    history_cooldown_ms: int = 60 * 1000
    # Background refresh: how many upstream fetches may run concurrently. Also the
    # provider's concurrency gate. Kept modest to respect Yahoo rate-limiting.
    yf_concurrency: int = 4

    # PySpark heavy path
    spark_enabled: bool = True

    @property
    def cors_origin_list(self) -> list[str]:
        raw = self.cors_origins.strip()
        if raw == "*" or not raw:
            return ["*"]
        return [o.strip() for o in raw.split(",") if o.strip()]


settings = Settings()

# Allow overriding the DB path (used by tools/tests) without importing pydantic.
if os.environ.get("DG_DB_PATH"):
    settings.db_path = os.environ["DG_DB_PATH"]

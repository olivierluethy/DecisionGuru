# DecisionGuru backend (FastAPI)

100% Python backend for DecisionGuru. Serves the same `/api` contract the React frontend
consumes (see `../docs/API_CONTRACT.md`), on **port 5178**.

- **Framework:** FastAPI + Pydantic v2, uvicorn (dev) / gunicorn + uvicorn workers (prod)
- **Market data:** yfinance behind a `MarketDataProvider` interface, with retry/backoff,
  timeouts and a TTL cache over the persistent SQLite caches
- **Analytics:** pandas/numpy/scipy for interactive single-ticker endpoints; **PySpark**
  for the bulk/heavy path (portfolio/compare/scenario aggregation), degrading to an
  identical pandas reducer when Spark is unavailable
- **Storage:** the same local SQLite file as before (`data/decisionguru.sqlite`)

See `../docs/RUNNING.md` for how to run it.

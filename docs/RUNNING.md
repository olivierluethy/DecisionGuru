# Running DecisionGuru

The backend is now **100% Python (FastAPI)**; the frontend is unchanged. The Vite dev
server proxies `/api` → `http://localhost:5178`, so the backend must run on **port 5178**.

## Prerequisites

- **Python 3.12** and **[uv](https://docs.astral.sh/uv/)** for the backend
  (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- **Node ≥ 20** for the frontend tooling only (Vite/Tailwind)
- **Java 17+** on `PATH` for the PySpark heavy path (optional — the backend degrades to a
  pandas reducer if Spark can't start; set `DG_SPARK_ENABLED=false` to force pandas)

## Backend

```bash
cd backend
cp .env.example .env        # optional; sensible defaults otherwise
uv sync                     # create .venv and install deps from uv.lock

# dev (auto-reload)
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 5178

# prod (gunicorn + uvicorn workers)
uv run gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 1 -b 0.0.0.0:5178
```

> **Workers = 1.** The import flow (upload → preview → commit) keeps parsed files in an
> in-process store, so a single worker is required for imports to work. Scale out with a
> shared store (e.g. Redis) if you need more workers.

- Interactive API docs: <http://localhost:5178/docs>
- Health: <http://localhost:5178/api/health>

## Frontend

```bash
npm install                 # root install (shared + frontend workspaces)
npm run dev:frontend        # http://localhost:5173
```

## Both together

From the repo root (needs `uv` on `PATH`):

```bash
npm install
npm run dev                 # api (uvicorn :5178) + web (vite :5173)
```

Then open <http://localhost:5173>.

## Configuration

All backend settings are `DG_`-prefixed env vars (see `backend/.env.example`): server
port/host, CORS origins, SQLite path, cache TTLs, optional `DG_REDIS_URL`, yfinance
reliability knobs, and `DG_SPARK_ENABLED`.

## Data

Your transactions, instruments, scenarios, notes and settings live in
`backend/data/decisionguru.sqlite` (git-ignored) — the **same file** the previous backend
used, so nothing is lost in the migration. Market prices, dividends, fund holdings and FX
rates are fetched and cached in the same file.

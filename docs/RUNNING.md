# Running DecisionGuru

The backend is now **100% Python (FastAPI)**; the frontend is unchanged. The Vite dev
server proxies `/api` → `http://localhost:5178`, so the backend must run on **port 5178**.

## Prerequisites

| Tool | Required? | Why |
| --- | --- | --- |
| **[uv](https://docs.astral.sh/uv/)** | yes | Backend toolchain. It also **downloads Python 3.12 itself** (pinned in `backend/.python-version`), so you do *not* need a system Python 3.12 — any version, or none, is fine. |
| **Node ≥ 20** | yes | Frontend tooling only (Vite/Tailwind). |
| **Java 17+** | no | PySpark heavy path. Without it the backend logs one warning and falls back to an identical pandas reducer. Set `DG_SPARK_ENABLED=false` to skip the attempt. |

### macOS

macOS ships neither `uv` nor a real JVM, so nothing works out of the box — the symptom is
`sh: uv: command not found` from `npm run dev:backend`, followed by a wall of
`http proxy error: /api/… ECONNREFUSED` from Vite (the web app is fine; it just has no API
to talk to).

```bash
# Homebrew route (recommended — works on both Apple Silicon and Intel)
brew install uv node
uv --version && node --version     # both must print a version

# Optional: real JVM for the PySpark path
brew install --cask temurin@21
```

Without Homebrew, use Astral's installer — but note it installs into `~/.local/bin`, which
zsh does **not** have on `PATH` by default, so `uv` stays "not found" until you fix that:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

On Apple Silicon, Homebrew lives in `/opt/homebrew/bin` (Intel: `/usr/local/bin`). If
`brew` itself works but `uv` doesn't after installing, that directory is missing from your
`PATH` — `eval "$(/opt/homebrew/bin/brew shellenv)"` in `~/.zshrc` fixes it.

### Linux

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh    # restart your shell afterwards
# Node ≥ 20 from your distro, nvm, or https://nodejs.org
```

### Windows

```powershell
winget install --id=astral-sh.uv -e
winget install --id=OpenJS.NodeJS.LTS -e
```

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

`npm run dev` runs both halves under `concurrently`, prefixed `[api]` and `[web]`. When
something fails, read the `[api]` lines — a backend that never starts shows up on the
`[web]` side only as repeated `ECONNREFUSED` proxy errors, which is a symptom, not the cause.

## Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| `sh: uv: command not found` | `uv` missing or not on `PATH`. Install it (above), then open a **new** terminal — an already-open shell won't see the new `PATH`. |
| `[web] http proxy error: /api/… AggregateError [ECONNREFUSED]` | The backend isn't listening on 5178. Check the `[api]` output for the real error; verify with `curl http://127.0.0.1:5178/api/health`. |
| `Port 5173 is in use, trying another one...` | A previous dev server is still alive, and Vite silently moves to 5174 — so you may be looking at a stale tab. Kill the strays: `lsof -ti:5173,5178 \| xargs kill`, then re-run. |
| `Unable to locate a Java Runtime` / `Spark unavailable (…); using pandas reducer` | Expected without a JVM; results are identical. Install `temurin@21` or set `DG_SPARK_ENABLED=false`. |
| `error: No interpreter found for Python 3.12` | Old `uv`. Update it (`brew upgrade uv`, or `uv self update`) — current versions fetch Python 3.12 automatically. |
| Import upload works, then "unknown token" on commit | More than one worker. Imports need `-w 1` (see the note above). |
| Stale/odd backend behaviour after `git pull` | `cd backend && uv sync` to re-lock deps; delete `backend/.venv` and re-sync to start clean. |

## Configuration

All backend settings are `DG_`-prefixed env vars (see `backend/.env.example`): server
port/host, CORS origins, SQLite path, cache TTLs, optional `DG_REDIS_URL`, yfinance
reliability knobs, and `DG_SPARK_ENABLED`.

## Data

Your transactions, instruments, scenarios, notes and settings live in
`backend/data/decisionguru.sqlite` (git-ignored) — the **same file** the previous backend
used, so nothing is lost in the migration. Market prices, dividends, fund holdings and FX
rates are fetched and cached in the same file.

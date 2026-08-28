"""Test harness bootstrap.

The backend is run as a namespace app (`[tool.uv] package = false`), so `app` is not
installed on the path. Put the backend root on sys.path so `import app...` works, and
point the app at a throwaway SQLite file so tests never touch the real cache DB.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

# Isolate the DB before anything imports app.core.db.
os.environ.setdefault("DG_DB_PATH", str(Path(tempfile.gettempdir()) / "decisionguru_test.sqlite"))

# The DB connection is lazy (init_db sets the module connection, normally at app startup).
# Initialise it once for the whole test session so DB-backed tests have a live connection.
from app.core import db as _db  # noqa: E402

_db.init_db()

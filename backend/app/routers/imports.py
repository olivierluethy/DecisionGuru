from __future__ import annotations

import json
import secrets
from pathlib import Path

from fastapi import APIRouter, Request, UploadFile
from fastapi.concurrency import run_in_threadpool

from ..core import db
from ..core.config import UPLOAD_DIR
from ..core.errors import ApiError
from ..services import repo
from ..services.importer import (
    DEFAULT_ACTION_MAP,
    apply_mapping,
    get_parsed,
    parse_pdf,
    parse_upload,
    transform_degiro,
)

router = APIRouter()


@router.post("/upload")
async def upload(file: UploadFile | None = None) -> dict:
    if file is None:
        raise ApiError("No file uploaded", 400)
    ext = Path(file.filename or "").suffix.lower()
    dest = UPLOAD_DIR / secrets.token_hex(16)
    dest.write_bytes(await file.read())
    try:
        if ext == ".pdf":
            parsed = await run_in_threadpool(parse_pdf, str(dest), file.filename)
        else:
            parsed = await run_in_threadpool(parse_upload, str(dest), file.filename)
        return {**parsed, "defaultActionMap": DEFAULT_ACTION_MAP}
    except Exception as exc:  # noqa: BLE001
        raise ApiError(f"Could not parse file: {exc}", 422)


@router.get("/file/{file_id}")
async def get_file(file_id: str) -> dict:
    parsed = get_parsed(file_id)
    if not parsed:
        raise ApiError("File not found (re-upload)", 404)
    return parsed


def _build_preview_rows(mapping: dict) -> list[dict]:
    if mapping.get("broker") == "degiro":
        return transform_degiro(mapping["fileId"], mapping.get("sheetName"))
    return apply_mapping(mapping)


@router.post("/preview")
async def preview(request: Request) -> dict:
    mapping = await request.json() or {}
    if not mapping.get("fileId"):
        raise ApiError("fileId required", 400)
    if not get_parsed(mapping["fileId"]):
        raise ApiError("File not found (re-upload)", 404)
    rows = await run_in_threadpool(_build_preview_rows, mapping)
    ok_count = sum(1 for r in rows if r["ok"])
    corporate_actions = sum(1 for r in rows if r.get("category") == "corporate_action")
    trades = sum(1 for r in rows if r["ok"] and r.get("category") != "corporate_action")
    return {"rows": rows, "okCount": ok_count, "total": len(rows),
            "trades": trades, "corporateActions": corporate_actions}


@router.post("/commit")
async def commit(request: Request) -> dict:
    mapping = await request.json() or {}
    if not mapping.get("fileId"):
        raise ApiError("fileId required", 400)
    if not get_parsed(mapping["fileId"]):
        raise ApiError("File not found (re-upload)", 404)

    def _work() -> dict:
        rows = [r for r in _build_preview_rows(mapping) if r["ok"]]
        imported = 0
        skipped = 0
        corporate_actions = 0
        instrument_cache: dict[str, int] = {}
        touched: set[int] = set()

        for row in rows:
            t = row["tx"]
            key = (t.get("symbol") or t.get("isin") or t.get("name") or "").upper()
            instrument_id = instrument_cache.get(key)
            if instrument_id is None:
                inst = repo.resolve_instrument(
                    {"symbol": t.get("symbol"), "isin": t.get("isin"), "name": t.get("name")}
                )
                instrument_id = inst["id"]
                instrument_cache[key] = instrument_id
            dedupe_key = t.get("dedupeKey") or repo.make_dedupe_key({**t, "instrumentId": instrument_id})
            before = repo.transactions_count()
            repo.insert_transaction({
                "instrumentId": instrument_id,
                "action": t.get("action"),
                "date": t.get("date"),
                "quantity": t.get("quantity") or 0,
                "unitPrice": t.get("unitPrice") or 0,
                "fees": t.get("fees") or 0,
                "currency": t.get("currency"),
                "grossAmount": t.get("grossAmount"),
                "netAmount": t.get("netAmount"),
                "withholding": t.get("withholding"),
                "category": row.get("category") or "trade",
                "note": t.get("note"),
                "source": f"import:{mapping.get('broker') or mapping['fileId']}",
                "dedupeKey": dedupe_key,
            })
            after = repo.transactions_count()
            if after > before:
                imported += 1
                if row.get("category") == "corporate_action":
                    corporate_actions += 1
                touched.add(instrument_id)
            else:
                skipped += 1

        return {"imported": imported, "skipped": skipped,
                "corporateActions": corporate_actions, "instruments": list(touched)}

    return await run_in_threadpool(_work)


# ---- presets ----------------------------------------------------------------

@router.get("/presets")
async def list_presets() -> list[dict]:
    rows = db.q("SELECT * FROM import_presets ORDER BY name").all()
    return [{**dict(r), "mapping": json.loads(r["mapping"])} for r in rows]


@router.post("/presets")
async def save_preset(request: Request) -> dict:
    body = await request.json() or {}
    if not body.get("name") or not body.get("mapping"):
        raise ApiError("name and mapping required", 400)
    db.execute(
        "INSERT INTO import_presets (name, mapping) VALUES (?, ?) "
        "ON CONFLICT(name) DO UPDATE SET mapping = excluded.mapping",
        (body["name"], json.dumps(body["mapping"])),
    )
    return {"ok": True}


@router.delete("/presets/{preset_id}")
async def delete_preset(preset_id: int) -> dict:
    db.execute("DELETE FROM import_presets WHERE id = ?", (preset_id,))
    return {"ok": True}

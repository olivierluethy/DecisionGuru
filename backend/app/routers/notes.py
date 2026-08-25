from __future__ import annotations

from fastapi import APIRouter, Request

from ..core.errors import ApiError
from ..services import repo

router = APIRouter()


@router.get("")
async def list_notes(target: str | None = None, targetId: int | None = None) -> list[dict]:
    if not target:
        return repo.all_notes()
    return repo.list_notes(target, targetId)


@router.post("")
async def add_note(request: Request) -> dict:
    body = await request.json() or {}
    if not body.get("target") or not body.get("body"):
        raise ApiError("target and body required", 400)
    return repo.insert_note(body["target"], body.get("targetId"), body["body"])


@router.patch("/{note_id}")
async def update_note(note_id: int, request: Request) -> dict:
    body = await request.json() or {}
    note = repo.update_note(note_id, body.get("body") or "")
    if not note:
        raise ApiError("Not found", 404)
    return note


@router.delete("/{note_id}")
async def delete_note(note_id: int) -> dict:
    repo.delete_note(note_id)
    return {"ok": True}

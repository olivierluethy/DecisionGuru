"""Data-access repository — port of repo.ts. Returns JSON-ready dicts (camelCase keys)."""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from ..core import db
from .resolution import ResolvedSymbol, resolve_symbol


def _row_to_instrument(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["allocationOverride"] = json.loads(d["allocationOverride"]) if d.get("allocationOverride") else None
    d["unresolved"] = bool(d.get("unresolved"))
    return d


def _row_to_dict(r: sqlite3.Row | None) -> dict | None:
    return dict(r) if r is not None else None


# ---- instruments ------------------------------------------------------------

def list_instruments() -> list[dict]:
    rows = db.q("SELECT * FROM instruments ORDER BY name").all()
    return [_row_to_instrument(r) for r in rows]


def get_instrument(id_: int) -> dict | None:
    r = db.q("SELECT * FROM instruments WHERE id = ?").get((id_,))
    return _row_to_instrument(r) if r else None


def get_instrument_by_symbol(symbol: str) -> dict | None:
    r = db.q("SELECT * FROM instruments WHERE symbol = ?").get((symbol,))
    return _row_to_instrument(r) if r else None


def get_transactions(instrument_id: int) -> list[dict]:
    rows = db.q(
        "SELECT * FROM transactions WHERE instrumentId = ? ORDER BY date, id"
    ).all((instrument_id,))
    return [dict(r) for r in rows]


def owned_symbol_set() -> set[str]:
    """Symbols currently held — net open quantity (buys − sells) > 0 — computed OFFLINE
    from transactions only, no provider calls. This is the canonical 'owned' test:
    a fully-sold instrument (net qty 0) is NOT owned, per the ownership model."""
    rows = db.q(
        """SELECT i.symbol AS symbol,
                  SUM(CASE t.action WHEN 'buy' THEN t.quantity
                                    WHEN 'sell' THEN -t.quantity ELSE 0 END) AS net
             FROM instruments i JOIN transactions t ON t.instrumentId = i.id
            WHERE i.symbol IS NOT NULL
            GROUP BY i.symbol"""
    ).all()
    return {r["symbol"] for r in rows if (r["net"] or 0) > 1e-9}


def owned_isin_set() -> set[str]:
    """ISINs currently held — net open quantity > 0 — so ownership is recognised by the
    ECONOMIC ENTITY, not just the ticker string. A company held on one listing (NESN.SW) is
    then still 'owned' when met as another listing (NSRGY) that shares the ISIN
    (VALUE_INVESTING_AUDIT §3 F-12)."""
    rows = db.q(
        """SELECT i.isin AS isin,
                  SUM(CASE t.action WHEN 'buy' THEN t.quantity
                                    WHEN 'sell' THEN -t.quantity ELSE 0 END) AS net
             FROM instruments i JOIN transactions t ON t.instrumentId = i.id
            WHERE i.isin IS NOT NULL
            GROUP BY i.isin"""
    ).all()
    return {r["isin"] for r in rows if (r["net"] or 0) > 1e-9}


def is_owned(symbol: str | None = None, isin: str | None = None,
             owned_symbols: set[str] | None = None, owned_isins: set[str] | None = None) -> bool:
    """Ownership by company identity: owned if the symbol is held OR the ISIN (economic
    entity) is held on any listing. Callers in hot loops may pass precomputed sets to avoid
    per-call queries; otherwise they are fetched once here."""
    if symbol:
        syms = owned_symbols if owned_symbols is not None else owned_symbol_set()
        if symbol in syms:
            return True
    if isin:
        isins = owned_isins if owned_isins is not None else owned_isin_set()
        if isin in isins:
            return True
    return False


def all_transactions() -> list[dict]:
    return [dict(r) for r in db.q("SELECT * FROM transactions ORDER BY date, id").all()]


def insert_instrument(data: dict) -> dict:
    cur = db.execute(
        "INSERT INTO instruments "
        "(symbol, isin, name, kind, currency, domicile, exchange, country, sector, "
        " incomeYieldOverride, allocationOverride, resolutionSource, unresolved) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            data.get("symbol"),
            data.get("isin"),
            data.get("name") or data.get("symbol"),
            data.get("kind") or "stock",
            data.get("currency") or "USD",
            data.get("domicile"),
            data.get("exchange"),
            data.get("country"),
            data.get("sector"),
            data.get("incomeYieldOverride"),
            json.dumps(data["allocationOverride"]) if data.get("allocationOverride") else None,
            data.get("resolutionSource"),
            1 if data.get("unresolved") else 0,
        ),
    )
    return get_instrument(int(cur.lastrowid))


def update_instrument(id_: int, patch: dict) -> dict | None:
    current = get_instrument(id_)
    if not current:
        return None
    merged = {**current, **patch}
    db.execute(
        "UPDATE instruments SET symbol=?, isin=?, name=?, kind=?, currency=?, domicile=?, "
        "exchange=?, country=?, sector=?, incomeYieldOverride=?, allocationOverride=?, "
        "resolutionSource=?, unresolved=? WHERE id=?",
        (
            merged.get("symbol"),
            merged.get("isin"),
            merged.get("name"),
            merged.get("kind"),
            merged.get("currency"),
            merged.get("domicile"),
            merged.get("exchange"),
            merged.get("country"),
            merged.get("sector"),
            merged.get("incomeYieldOverride"),
            json.dumps(merged["allocationOverride"]) if merged.get("allocationOverride") else None,
            merged.get("resolutionSource"),
            1 if merged.get("unresolved") else 0,
            id_,
        ),
    )
    return get_instrument(id_)


def delete_instrument(id_: int) -> None:
    db.execute("DELETE FROM instruments WHERE id = ?", (id_,))


def resolve_instrument(ident: dict) -> dict:
    """Find an existing instrument by isin/symbol, or create one (via the tiered resolver)."""
    isin = ident.get("isin")
    if isin:
        by_isin = db.q("SELECT * FROM instruments WHERE isin = ?").get((isin,))
        if by_isin:
            return _row_to_instrument(by_isin)
    if ident.get("symbol"):
        by_sym = get_instrument_by_symbol(ident["symbol"])
        if by_sym:
            return by_sym

    r = resolve_symbol(ident)
    return insert_instrument({
        "symbol": r.symbol,
        "isin": isin,
        "name": r.name or ident.get("name") or r.symbol,
        "kind": r.kind,
        "currency": r.currency,
        "domicile": r.country,
        "country": r.country,
        "exchange": r.exchange,
        "resolutionSource": r.source,
        "unresolved": r.unresolved,
    })


def reresolve_instrument(id_: int, offline: bool = False) -> dict | None:
    inst = get_instrument(id_)
    if not inst:
        return None
    r = resolve_symbol({"isin": inst.get("isin"), "name": inst.get("name"), "symbol": None},
                       offline=offline)
    if r.unresolved:
        return update_instrument(id_, {"unresolved": True, "resolutionSource": "unresolved"})
    return update_instrument(id_, {
        "symbol": r.symbol,
        "kind": r.kind,
        "currency": r.currency,
        "domicile": r.country or inst.get("domicile"),
        "country": r.country or inst.get("country"),
        "exchange": r.exchange or inst.get("exchange"),
        "name": inst.get("name") or r.name or r.symbol,
        "resolutionSource": r.source,
        "unresolved": False,
    })


def unresolved_instruments() -> list[dict]:
    return [
        i for i in list_instruments()
        if i.get("unresolved") or (i.get("isin") and i.get("symbol") == i.get("isin"))
    ]


# ---- transactions -----------------------------------------------------------

def make_dedupe_key(tx: dict) -> str:
    return "|".join(str(tx.get(k, "")) if tx.get(k) is not None else ""
                    for k in ("instrumentId", "action", "date", "quantity", "unitPrice", "currency"))


def insert_transaction(tx: dict) -> dict:
    dedupe_key = tx.get("dedupeKey") or make_dedupe_key(tx)
    cur = db.execute(
        "INSERT OR IGNORE INTO transactions "
        "(instrumentId, action, date, quantity, unitPrice, fees, currency, grossAmount, "
        " netAmount, withholding, category, note, source, dedupeKey) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            tx.get("instrumentId"),
            tx.get("action"),
            tx.get("date"),
            tx.get("quantity") or 0,
            tx.get("unitPrice") or 0,
            tx.get("fees") or 0,
            tx.get("currency") or "USD",
            tx.get("grossAmount"),
            tx.get("netAmount"),
            tx.get("withholding"),
            tx.get("category") or "trade",
            tx.get("note"),
            tx.get("source") or "manual",
            dedupe_key,
        ),
    )
    row = db.q("SELECT * FROM transactions WHERE id = ?").get((int(cur.lastrowid),))
    return dict(row) if row else {}


def transactions_count() -> int:
    return db.q("SELECT COUNT(*) AS c FROM transactions").get(())["c"]


def delete_transaction(id_: int) -> None:
    db.execute("DELETE FROM transactions WHERE id = ?", (id_,))


# ---- account events (DEGIRO Account statement) ------------------------------

def _instrument_id_for_isin(isin: str | None) -> int | None:
    """DB-only ISIN→instrument lookup (never triggers a Yahoo resolve)."""
    if not isin:
        return None
    row = db.q("SELECT id FROM instruments WHERE isin = ?").get((isin,))
    return row["id"] if row else None


def insert_account_event(ev: dict) -> dict:
    isin = ev.get("isin") or None
    instrument_id = _instrument_id_for_isin(isin)
    db.execute(
        "INSERT OR IGNORE INTO account_events "
        "(date, time, valueDate, name, isin, description, type, fx, currency, amount, "
        " balanceCurrency, balance, orderId, instrumentId, reversed, source, dedupeKey) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            ev.get("date"),
            ev.get("time"),
            ev.get("valueDate"),
            ev.get("name") or None,
            isin,
            ev.get("description"),
            ev.get("type") or "unknown",
            ev.get("fx"),
            ev.get("currency"),
            ev.get("amount") or 0,
            ev.get("balanceCurrency"),
            ev.get("balance"),
            ev.get("orderId"),
            instrument_id,
            1 if ev.get("reversed") else 0,
            ev.get("source") or "import",
            ev.get("dedupeKey"),
        ),
    )
    row = db.q("SELECT * FROM account_events WHERE dedupeKey = ?").get((ev.get("dedupeKey"),))
    return dict(row) if row else {}


def all_account_events() -> list[dict]:
    return [dict(r) for r in db.q("SELECT * FROM account_events ORDER BY date, time, id").all()]


def account_events_count() -> int:
    return db.q("SELECT COUNT(*) AS c FROM account_events").get(())["c"]


def link_account_events_to_instruments() -> int:
    """Backfill instrumentId on account events whose ISIN now matches an instrument.
    Runs after either import order so dividends attach regardless of upload sequence."""
    cur = db.execute(
        "UPDATE account_events SET instrumentId = ("
        "  SELECT id FROM instruments WHERE instruments.isin = account_events.isin) "
        "WHERE instrumentId IS NULL AND isin IS NOT NULL AND isin != '' "
        "  AND EXISTS (SELECT 1 FROM instruments WHERE instruments.isin = account_events.isin)"
    )
    return cur.rowcount


# ---- notes ------------------------------------------------------------------

def list_notes(target: str, target_id: int | None) -> list[dict]:
    if target_id is None:
        rows = db.q("SELECT * FROM notes WHERE target = ? ORDER BY updatedAt DESC").all((target,))
    else:
        rows = db.q(
            "SELECT * FROM notes WHERE target = ? AND targetId = ? ORDER BY updatedAt DESC"
        ).all((target, target_id))
    return [dict(r) for r in rows]


def all_notes() -> list[dict]:
    return [dict(r) for r in db.q("SELECT * FROM notes ORDER BY updatedAt DESC").all()]


def insert_note(target: str, target_id: int | None, body: str) -> dict:
    cur = db.execute("INSERT INTO notes (target, targetId, body) VALUES (?, ?, ?)",
                     (target, target_id, body))
    return dict(db.q("SELECT * FROM notes WHERE id = ?").get((int(cur.lastrowid),)))


def update_note(id_: int, body: str) -> dict | None:
    db.execute("UPDATE notes SET body = ?, updatedAt = datetime('now') WHERE id = ?", (body, id_))
    return _row_to_dict(db.q("SELECT * FROM notes WHERE id = ?").get((id_,)))


def delete_note(id_: int) -> None:
    db.execute("DELETE FROM notes WHERE id = ?", (id_,))


# ---- scenarios --------------------------------------------------------------

def _row_to_scenario(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["config"] = json.loads(d["config"])
    return d


def list_scenarios() -> list[dict]:
    return [_row_to_scenario(r) for r in db.q("SELECT * FROM scenarios ORDER BY updatedAt DESC").all()]


def get_scenario(id_: int) -> dict | None:
    r = db.q("SELECT * FROM scenarios WHERE id = ?").get((id_,))
    return _row_to_scenario(r) if r else None


def insert_scenario(name: str, config: Any) -> dict:
    cur = db.execute("INSERT INTO scenarios (name, config) VALUES (?, ?)", (name, json.dumps(config)))
    return get_scenario(int(cur.lastrowid))


def update_scenario(id_: int, name: str, config: Any) -> dict | None:
    db.execute("UPDATE scenarios SET name = ?, config = ?, updatedAt = datetime('now') WHERE id = ?",
               (name, json.dumps(config), id_))
    return get_scenario(id_)


def delete_scenario(id_: int) -> None:
    db.execute("DELETE FROM scenarios WHERE id = ?", (id_,))

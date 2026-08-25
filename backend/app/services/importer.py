"""File importer — port of importer.ts. CSV/XLSX/PDF parsing, generic column mapping,
and the DeGiro dedicated transform (auto-detected, encoding-corrected)."""
from __future__ import annotations

import re
import secrets
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd

# In-memory store of parsed uploads for the current session (single process).
_store: dict[str, dict] = {}


# ---- encoding-aware text decode ---------------------------------------------

def decode_text(buf: bytes) -> tuple[str, str]:
    if len(buf) >= 3 and buf[0] == 0xEF and buf[1] == 0xBB and buf[2] == 0xBF:
        return buf[3:].decode("utf-8"), "utf-8"
    if len(buf) >= 2 and buf[0] == 0xFF and buf[1] == 0xFE:
        return buf[2:].decode("utf-16-le"), "utf-16le"
    if len(buf) >= 2 and buf[0] == 0xFE and buf[1] == 0xFF:
        return buf[2:].decode("utf-16-be"), "utf-16be"
    try:
        return buf.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return buf.decode("cp1252", errors="replace"), "windows-1252"


# ---- RFC4180 CSV parser -----------------------------------------------------

def _count(s: str, ch: str) -> int:
    return sum(1 for c in s if c == ch)


def parse_csv_rows(text: str, delimiter: str | None = None) -> list[list[str]]:
    nl = text.find("\n")
    first_line = text[: nl if nl != -1 else len(text)]
    if delimiter is None:
        delimiter = sorted([",", ";", "\t"], key=lambda d: _count(first_line, d), reverse=True)[0] or ","

    rows: list[list[str]] = []
    row: list[str] = []
    field = ""
    in_quotes = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if in_quotes:
            if ch == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field += '"'
                    i += 1
                else:
                    in_quotes = False
            else:
                field += ch
        elif ch == '"':
            in_quotes = True
        elif ch == delimiter:
            row.append(field)
            field = ""
        elif ch == "\n":
            row.append(field)
            rows.append(row)
            row = []
            field = ""
        elif ch == "\r":
            pass
        else:
            field += ch
        i += 1
    if len(field) > 0 or len(row) > 0:
        row.append(field)
        rows.append(row)
    return [[c.strip() for c in r] for r in rows]


# ---- header helpers ---------------------------------------------------------

def norm_header(h: str) -> str:
    s = unicodedata.normalize("NFD", h or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]", "", s.lower())


HEADER_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("date", re.compile(r"(trade|value|settle|booking)?\s*(date|datum)", re.I)),
    ("action", re.compile(r"type|action|transaction|buchung|art|richtung|side|operation|vorgang", re.I)),
    ("isin", re.compile(r"isin", re.I)),
    ("symbol", re.compile(r"symbol|ticker|valor", re.I)),
    ("name", re.compile(r"name|description|security|instrument|bezeichnung|titel|produkt", re.I)),
    ("quantity", re.compile(r"quantity|qty|shares|anzahl|st(ü|ue)ck|menge|units|nominal", re.I)),
    ("unitPrice", re.compile(r"price|kurs|rate|unit\s*price|preis", re.I)),
    ("fees", re.compile(r"fee|commission|courtage|geb(ü|ue)hr|kommission|charges|spesen", re.I)),
    ("withholding", re.compile(r"withhold|verrechnung|quellensteuer|source\s*tax", re.I)),
    ("grossAmount", re.compile(r"gross|brutto", re.I)),
    ("netAmount", re.compile(r"net|amount|betrag|total|netto|value", re.I)),
    ("currency", re.compile(r"currency|ccy|w(ä|ae)hrung|whrg|curr", re.I)),
]


def suggest_mapping(headers: list[str]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    used: set[str] = set()
    for header in headers:
        matched = "ignore"
        for field, rex in HEADER_PATTERNS:
            if field in used:
                continue
            if rex.search(header):
                matched = field
                break
        if matched != "ignore":
            used.add(matched)
        mapping[header] = matched
    return mapping


def _is_number(s: str) -> bool:
    try:
        float(re.sub(r"[',\s]", "", s))
        return True
    except ValueError:
        return False


def detect_header_row(rows: list[list[str]]) -> int:
    best = 0
    best_score = -1
    limit = min(len(rows), 15)
    for i in range(limit):
        cells = rows[i]
        non_empty = sum(1 for c in cells if c != "")
        textish = sum(1 for c in cells if c != "" and not _is_number(c))
        score = non_empty + textish * 2
        if score > best_score:
            best_score = score
            best = i
    return best


def build_sheet(name: str, rows: list[list[str]]) -> dict:
    header_row_index = detect_header_row(rows)
    raw_headers = [h or "" for h in (rows[header_row_index] if header_row_index < len(rows) else [])]
    headers = [h if h != "" else f"Column {i + 1}" for i, h in enumerate(raw_headers)]
    data_rows = [r for r in rows[header_row_index + 1:] if any(c != "" for c in r)]
    return {
        "name": name,
        "headers": headers,
        "rawHeaders": raw_headers,
        "rows": data_rows,
        "suggestedMapping": suggest_mapping(headers),
    }


# ---- broker detection -------------------------------------------------------

DEGIRO_SIGNATURE = ["datum", "produkt", "isin", "referenzborse", "ausfuhrungsort",
                    "wertinlokalwahrung", "autofxgebuhr", "orderid"]


def detect_broker(raw_headers: list[str]) -> str | None:
    norm = [norm_header(h) for h in raw_headers]
    has_all = all(sig in norm for sig in DEGIRO_SIGNATURE)
    idx_kurs = norm.index("kurs") if "kurs" in norm else -1
    idx_local = norm.index("wertinlokalwahrung") if "wertinlokalwahrung" in norm else -1
    empty_after_kurs = idx_kurs >= 0 and (raw_headers[idx_kurs + 1] if idx_kurs + 1 < len(raw_headers) else "") == ""
    empty_after_local = idx_local >= 0 and (raw_headers[idx_local + 1] if idx_local + 1 < len(raw_headers) else "") == ""
    if has_all and empty_after_kurs and empty_after_local:
        return "degiro"
    return None


DEGIRO_BROKER_NAME = "DeGiro — Transactions export"

DEGIRO_MAPPING_DISPLAY = [
    {"header": "Datum", "field": "date", "note": "DD-MM-YYYY"},
    {"header": "Uhrzeit", "field": "time", "note": "combined into timestamp"},
    {"header": "Produkt", "field": "name", "note": "quoted names with commas handled"},
    {"header": "ISIN", "field": "isin", "note": "primary instrument key"},
    {"header": "Referenzbörse", "field": "referenceExchange"},
    {"header": "Ausführungsort", "field": "executionVenue", "note": "may be empty"},
    {"header": "Anzahl", "field": "quantity", "note": "signed → buy / sell"},
    {"header": "Kurs", "field": "unitPrice"},
    {"header": "(empty)", "field": "priceCurrency", "note": "currency of Kurs"},
    {"header": "Wert in Lokalwährung", "field": "localValue", "note": "signed → cash in / out"},
    {"header": "(empty)", "field": "localCurrency", "note": "currency of local value"},
    {"header": "Wert CHF", "field": "valueCHF"},
    {"header": "Wechselkurs", "field": "fxRate"},
    {"header": "AutoFX-Gebühr", "field": "fees (part)", "note": "CHF, may be empty"},
    {"header": "Transaktionsgebühren …", "field": "fees (part)", "note": "CHF, may be empty"},
    {"header": "Gesamt CHF", "field": "totalCHF", "note": "net cash effect"},
    {"header": "Order-ID", "field": "orderId", "note": "empty for corporate actions"},
]


# ---- DEGIRO Account statement (Kontoauszug) detection ------------------------

# Columns 9 (mutation amount) and 11 (running balance) have BLANK headers; the file
# also carries Valutadatum/Beschreibung/Saldo which the Transactions export lacks.
ACCOUNT_SIGNATURE = ["datum", "valutadatum", "produkt", "isin", "beschreibung", "saldo", "orderid"]

ACCOUNT_BROKER_NAME = "DeGiro — Account statement (Kontoauszug)"

ACCOUNT_MAPPING_DISPLAY = [
    {"header": "Datum", "field": "date", "note": "DD-MM-YYYY"},
    {"header": "Uhrze", "field": "time", "note": "booking time (header typo for Uhrzeit)"},
    {"header": "Valutadatum", "field": "valueDate"},
    {"header": "Produkt", "field": "name", "note": "empty on pure cash/FX/fee rows"},
    {"header": "ISIN", "field": "isin", "note": "attributes dividends to a security"},
    {"header": "Beschreibung", "field": "description", "note": "→ normalized event type"},
    {"header": "FX", "field": "fx", "note": "only on Währungswechsel rows"},
    {"header": "Änderung", "field": "currency", "note": "currency of the mutation"},
    {"header": "(blank)", "field": "amount", "note": "signed mutation amount — parsed by position"},
    {"header": "Saldo", "field": "balanceCurrency", "note": "currency of the running balance"},
    {"header": "(blank)", "field": "balance", "note": "running balance per currency — by position"},
    {"header": "Order-ID", "field": "orderId", "note": "empty on cash events"},
]


def detect_account(raw_headers: list[str]) -> bool:
    norm = [norm_header(h) for h in raw_headers]
    has_all = all(sig in norm for sig in ACCOUNT_SIGNATURE)
    idx_ander = norm.index("anderung") if "anderung" in norm else -1
    idx_saldo = norm.index("saldo") if "saldo" in norm else -1
    blank_after_ander = idx_ander >= 0 and (norm[idx_ander + 1] if idx_ander + 1 < len(norm) else "x") == ""
    blank_after_saldo = idx_saldo >= 0 and (norm[idx_saldo + 1] if idx_saldo + 1 < len(norm) else "x") == ""
    return has_all and blank_after_ander and blank_after_saldo


# ---- parse entrypoints ------------------------------------------------------

def _detect_kinds(raw_headers: list[str]) -> tuple[str | None, str | None]:
    """Returns (detectedBroker, detectedKind). Kind ∈ 'transactions' | 'account' | None."""
    if detect_account(raw_headers):
        return None, "account"
    broker = detect_broker(raw_headers)
    return broker, ("transactions" if broker == "degiro" else None)


def _finalize_parsed(filename: str, sheets: list[dict], encoding: str,
                    detected_broker: str | None, detected_kind: str | None = None) -> dict:
    is_degiro_tx = detected_broker == "degiro"
    is_account = detected_kind == "account"
    parsed = {
        "fileId": secrets.token_urlsafe(8)[:10],
        "filename": filename,
        "sheets": sheets,
        "encoding": encoding,
        "detectedBroker": detected_broker,
        "detectedKind": detected_kind,
        "brokerName": DEGIRO_BROKER_NAME if is_degiro_tx else (ACCOUNT_BROKER_NAME if is_account else None),
        "brokerMapping": DEGIRO_MAPPING_DISPLAY if is_degiro_tx else (ACCOUNT_MAPPING_DISPLAY if is_account else None),
    }
    _store[parsed["fileId"]] = parsed
    return parsed


def parse_csv(file_path: str, filename: str) -> dict:
    text, encoding = decode_text(Path(file_path).read_bytes())
    rows = parse_csv_rows(text)
    sheet = build_sheet("CSV", rows)
    broker, kind = _detect_kinds(sheet["rawHeaders"])
    return _finalize_parsed(filename, [sheet], encoding, broker, kind)


def parse_workbook(file_path: str, filename: str) -> dict:
    frames = pd.read_excel(file_path, sheet_name=None, header=None, dtype=str)
    sheets: list[dict] = []
    for name, df in frames.items():
        rows = [
            ["" if (c is None or (isinstance(c, float) and pd.isna(c))) else str(c).strip() for c in row]
            for row in df.values.tolist()
        ]
        sheet = build_sheet(name, rows)
        if sheet["rows"]:
            sheets.append(sheet)
    broker, kind = _detect_kinds(sheets[0]["rawHeaders"]) if sheets else (None, None)
    return _finalize_parsed(filename, sheets, "binary", broker, kind)


def parse_pdf(file_path: str, filename: str) -> dict:
    from pypdf import PdfReader

    reader = PdfReader(file_path)
    text = "\n".join((page.extract_text() or "") for page in reader.pages)
    lines = [ln.strip() for ln in re.split(r"\r?\n", text) if ln.strip()]
    rows = [re.split(r"\t|\s{2,}", ln) for ln in lines]
    rows = [[c.strip() for c in r] for r in rows]
    max_cols = max((len(r) for r in rows), default=0)
    padded = [r + [""] * (max_cols - len(r)) for r in rows]
    return _finalize_parsed(filename, [build_sheet("PDF", padded)], "utf-8", None)


def parse_upload(file_path: str, filename: str) -> dict:
    ext = Path(filename).suffix.lower()
    if ext in (".csv", ".txt"):
        return parse_csv(file_path, filename)
    return parse_workbook(file_path, filename)


def get_parsed(file_id: str) -> dict | None:
    return _store.get(file_id)


# ---- generic date / number parsing ------------------------------------------

_DATE_FORMATS = [
    "%Y-%m-%d", "%d-%m-%Y", "%d.%m.%Y", "%d.%m.%Y", "%d/%m/%Y", "%m/%d/%Y",
    "%Y/%m/%d", "%d.%m.%y", "%b %d, %Y", "%d %b %Y",
]


def parse_date(raw: str | None, formats: list[str] | None = None) -> str | None:
    if not raw:
        return None
    cleaned = raw.strip()
    for fmt in (formats or _DATE_FORMATS):
        try:
            return datetime.strptime(cleaned, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    # Loose fallback: dayjs(cleaned) valid AND has a 4-digit year.
    if re.search(r"\d{4}", cleaned):
        try:
            from dateutil import parser as _dp

            return _dp.parse(cleaned, dayfirst=False).strftime("%Y-%m-%d")
        except (ValueError, OverflowError):
            return None
    return None


# maps dayjs tokens used in transformDegiro to strptime
_DEGIRO_DATE_FORMATS = ["%d-%m-%Y", "%d-%m-%Y", "%d.%m.%Y", "%Y-%m-%d"]


def parse_num(raw: Any) -> float | None:
    if raw is None:
        return None
    s = str(raw).strip()
    if s == "":
        return None
    sign = 1
    if re.fullmatch(r"\(.*\)", s):
        sign = -1
        s = s[1:-1]
    s = re.sub(r"[^0-9.,'\-\s]", "", s).replace("'", "").replace(" ", "")
    last_comma = s.rfind(",")
    last_dot = s.rfind(".")
    if last_comma > -1 and last_dot > -1:
        if last_comma > last_dot:
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif last_comma > -1:
        parts = s.split(",")
        if len(parts[-1]) <= 2:
            s = s.replace(",", ".")
        else:
            s = s.replace(",", "")
    try:
        n = float(s)
    except ValueError:
        return None
    if not (n == n and abs(n) != float("inf")):
        return None
    return sign * n


# ---- generic mapping application --------------------------------------------

def _classify_action(raw: str, action_map: dict) -> str | None:
    v = (raw or "").lower().strip()
    if not v:
        return None
    def has(lst):
        return any(k.lower() in v for k in lst)
    if has(action_map.get("dividend", [])):
        return "dividend"
    if has(action_map.get("sell", [])):
        return "sell"
    if has(action_map.get("buy", [])):
        return "buy"
    return None


DEFAULT_ACTION_MAP = {
    "buy": ["buy", "kauf", "purchase", "achat", "acquisto", "subscription"],
    "sell": ["sell", "verkauf", "sale", "vente", "redemption", "disposal"],
    "dividend": ["dividend", "dividende", "distribution", "ausschüttung", "coupon", "interest", "ertrag"],
}


def apply_mapping(mapping: dict) -> list[dict]:
    file = _store.get(mapping["fileId"])
    if not file:
        return []
    sheet = next((s for s in file["sheets"] if s["name"] == mapping.get("sheetName")), None) or \
        (file["sheets"][0] if file["sheets"] else None)
    if not sheet:
        return []

    header_index: dict[str, int] = {}
    for i, h in enumerate(sheet["headers"]):
        field = mapping["mapping"].get(h)
        if field and field != "ignore" and field not in header_index:
            header_index[field] = i

    def get(row: list[str], field: str) -> str:
        idx = header_index.get(field)
        if idx is None:
            return ""
        return row[idx] if idx < len(row) else ""

    action_map = mapping.get("actionMap") or DEFAULT_ACTION_MAP
    default_currency = mapping.get("defaultCurrency")
    out: list[dict] = []
    for row in sheet["rows"]:
        errors: list[str] = []
        date = parse_date(get(row, "date"))
        action = _classify_action(get(row, "action"), action_map)
        quantity = parse_num(get(row, "quantity")) or 0
        unit_price = parse_num(get(row, "unitPrice")) or 0
        fees = parse_num(get(row, "fees")) or 0
        gross_amount = parse_num(get(row, "grossAmount"))
        net_amount = parse_num(get(row, "netAmount"))
        withholding = parse_num(get(row, "withholding"))
        currency = (get(row, "currency") or default_currency or "").upper() or None
        symbol = get(row, "symbol") or None
        isin = get(row, "isin") or None
        name = get(row, "name") or None

        if not date:
            errors.append("Unrecognised date")
        if not action:
            errors.append("Unknown action")
        if not symbol and not isin and not name:
            errors.append("No instrument identifier")
        if action in ("buy", "sell") and not (quantity > 0):
            errors.append("Quantity required for buy/sell")

        out.append({
            "ok": len(errors) == 0,
            "errors": errors,
            "category": "trade",
            "label": (action[0].upper() + action[1:]) if action else None,
            "tx": {
                "action": action,
                "date": date,
                "quantity": abs(quantity),
                "unitPrice": abs(unit_price),
                "fees": abs(fees),
                "currency": currency,
                "grossAmount": gross_amount,
                "netAmount": net_amount,
                "withholding": withholding,
                "symbol": symbol,
                "isin": isin,
                "name": name,
            },
        })
    return out


# ---- DeGiro dedicated transform ---------------------------------------------

def _base_name(name: str) -> str:
    s = re.split(r"\s+-\s+", name)[0]
    s = re.sub(r"\bclass\b.*", "", s, flags=re.I)
    s = re.sub(r"[^a-z0-9 ]", " ", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip().upper()
    return s


def _normalize_currency(ccy: str, price: float) -> tuple[str, float]:
    c = (ccy or "").upper()
    if c == "GBX" or c == "GBP MINOR" or ccy == "GBp":
        return "GBP", price / 100
    return c, price


def transform_degiro(file_id: str, sheet_name: str | None = None) -> list[dict]:
    file = _store.get(file_id)
    if not file:
        return []
    sheet = (sheet_name and next((s for s in file["sheets"] if s["name"] == sheet_name), None)) or \
        (file["sheets"][0] if file["sheets"] else None)
    if not sheet:
        return []

    norm = [norm_header(h) for h in sheet["rawHeaders"]]

    def at(key: str) -> int:
        return norm.index(key) if key in norm else -1

    tx_fees_idx = next((i for i, h in enumerate(norm) if h.startswith("transaktionsgebuhren")), -1)
    idx = {
        "date": at("datum"), "time": at("uhrzeit"), "name": at("produkt"), "isin": at("isin"),
        "refEx": at("referenzborse"), "venue": at("ausfuhrungsort"), "qty": at("anzahl"),
        "price": at("kurs"), "priceCcy": at("kurs") + 1, "localVal": at("wertinlokalwahrung"),
        "localCcy": at("wertinlokalwahrung") + 1, "valueCHF": at("wertchf"), "fx": at("wechselkurs"),
        "autoFx": at("autofxgebuhr"), "txFees": tx_fees_idx, "total": at("gesamtchf"),
        "orderId": at("orderid"),
    }

    def cell(row: list[str], i: int) -> str:
        return (row[i] if 0 <= i < len(row) else "").strip() if i >= 0 else ""

    parsed: list[dict] = []
    for i, row in enumerate(sheet["rows"]):
        price_ccy_raw = cell(row, idx["priceCcy"])
        raw_price = parse_num(cell(row, idx["price"])) or 0
        ccy2, price2 = _normalize_currency(price_ccy_raw, raw_price)
        parsed.append({
            "i": i,
            "date": parse_date(cell(row, idx["date"]), ["%d-%m-%Y", "%d-%m-%Y", "%d.%m.%Y", "%Y-%m-%d"]),
            "time": cell(row, idx["time"]),
            "name": cell(row, idx["name"]),
            "isin": cell(row, idx["isin"]),
            "refEx": cell(row, idx["refEx"]),
            "venue": cell(row, idx["venue"]),
            "qty": parse_num(cell(row, idx["qty"])) or 0,
            "price": price2,
            "priceCcy": ccy2,
            "localVal": parse_num(cell(row, idx["localVal"])) or 0,
            "localCcy": _normalize_currency(cell(row, idx["localCcy"]), 0)[0],
            "valueCHF": parse_num(cell(row, idx["valueCHF"])) or 0,
            "fx": parse_num(cell(row, idx["fx"])) or 0,
            "autoFx": parse_num(cell(row, idx["autoFx"])) or 0,
            "txFees": parse_num(cell(row, idx["txFees"])) or 0,
            "totalCHF": parse_num(cell(row, idx["total"])) or 0,
            "orderId": cell(row, idx["orderId"]),
        })

    # Detect corporate-action pairs: same date + base name, with both +/- quantities.
    groups: dict[str, list[dict]] = {}
    for r in parsed:
        if not r["date"]:
            continue
        key = f"{r['date']}|{_base_name(r['name'])}"
        groups.setdefault(key, []).append(r)
    paired_info: dict[int, str] = {}
    for g in groups.values():
        if len(g) < 2:
            continue
        has_pos = any(r["qty"] > 0 for r in g)
        has_neg = any(r["qty"] < 0 for r in g)
        if has_pos and has_neg:
            isins = {r["isin"] for r in g}
            label = "ISIN change" if len(isins) > 1 else "Class swap"
            for r in g:
                paired_info[r["i"]] = label

    occurrence: dict[str, int] = {}
    out: list[dict] = []
    for r in parsed:
        errors: list[str] = []
        if not r["date"]:
            errors.append("Unrecognised date")
        if not r["isin"] and not r["name"]:
            errors.append("No instrument identifier")

        zero_value = r["price"] == 0 and r["valueCHF"] == 0
        paired = paired_info.get(r["i"])
        category = "corporate_action" if (zero_value or paired) else "trade"
        action = "buy" if r["qty"] >= 0 else "sell"
        label = "Delisting" if zero_value else (paired if paired else ("Buy" if action == "buy" else "Sell"))

        qty_abs = abs(r["qty"])
        value_abs = abs(r["valueCHF"])
        fees = abs(r["autoFx"]) + abs(r["txFees"])
        unit_price_chf = value_abs / qty_abs if (qty_abs > 0 and value_abs > 0) else 0

        base_key = (
            f"degiro:{r['orderId']}:{r['time']}:{r['qty']}:{r['valueCHF']}"
            if r["orderId"]
            else f"degiro:{r['date']}:{r['time']}:{r['isin']}:{r['qty']}:{r['valueCHF']}"
        )
        seq = occurrence.get(base_key, 0)
        occurrence[base_key] = seq + 1
        dedupe_key = f"{base_key}#{seq}"

        tx = {
            "action": action,
            "date": r["date"],
            "time": r["time"],
            "quantity": qty_abs,
            "unitPrice": unit_price_chf,
            "fees": fees,
            "currency": "CHF",
            "category": category,
            "isin": r["isin"] or None,
            "name": r["name"] or None,
            "nativePrice": r["price"],
            "priceCurrency": r["priceCcy"],
            "localCurrency": r["localCcy"],
            "valueCHF": r["valueCHF"],
            "totalCHF": r["totalCHF"],
            "referenceExchange": r["refEx"],
            "executionVenue": r["venue"],
            "orderId": r["orderId"] or None,
            "note": f"DeGiro {r['refEx']}{'/' + r['venue'] if r['venue'] else ''} · "
                    f"{r['qty']} @ {r['price']} {r['priceCcy']}"
                    f"{'' if r['orderId'] else ' · corporate action'}",
            "dedupeKey": dedupe_key,
        }
        out.append({"ok": len(errors) == 0, "errors": errors, "category": category, "label": label, "tx": tx})
    return out


# ---- DEGIRO Account statement dedicated transform ---------------------------

_ACCOUNT_TYPE_LABELS = {
    "deposit": "Deposit",
    "cash_sweep": "Cash sweep",
    "fx_conversion": "FX conversion",
    "dividend": "Dividend",
    "withholding_tax": "Dividend tax",
    "corp_action_fee": "Corporate-action fee",
    "connectivity_fee": "Connectivity fee",
    "unknown": "Unknown",
}


def _classify_account_type(desc: str) -> str:
    dl = (desc or "").strip().lower()
    if not dl:
        return "unknown"
    if dl.startswith("einzahlung"):
        return "deposit"
    if "flatexdegiro" in dl or "cash sweep" in dl or "geldkonto" in dl:
        return "cash_sweep"
    if "wahrungswechsel" in dl.replace("ä", "a") or "währungswechsel" in dl:
        return "fx_conversion"
    # dividendensteuer must be checked before dividende (prefix collision)
    if dl.startswith("dividendensteuer"):
        return "withholding_tax"
    if dl.startswith("dividende"):
        return "dividend"
    if "kapitalma" in dl:  # Gebühr für Kapitalmaßnahme / Kapitalmassnahme
        return "corp_action_fee"
    if "handelsmodalit" in dl:  # Einrichtung von Handelsmodalitäten …
        return "connectivity_fee"
    return "unknown"


def _account_dt(date_iso: str | None, time_str: str) -> datetime | None:
    if not date_iso:
        return None
    t = (time_str or "").strip()
    try:
        if re.fullmatch(r"\d{1,2}:\d{2}", t):
            return datetime.strptime(f"{date_iso} {t}", "%Y-%m-%d %H:%M")
        return datetime.strptime(date_iso, "%Y-%m-%d")
    except ValueError:
        return None


def _minutes_apart(a: datetime | None, b: datetime | None) -> float:
    if a is None or b is None:
        return float("inf")
    return abs((a - b).total_seconds()) / 60.0


def transform_account(file_id: str, sheet_name: str | None = None) -> list[dict]:
    """Parse a DEGIRO Account statement into normalized cash/dividend/fee events.

    Columns 8 (mutation amount) and 10 (running balance) have blank headers and are
    read BY POSITION relative to the Änderung / Saldo currency columns. Reversal
    (storno) pairs are matched on same security + type + |amount| + currency within
    10 minutes and flagged `reversed` so they net out.
    """
    file = _store.get(file_id)
    if not file:
        return []
    sheet = (sheet_name and next((s for s in file["sheets"] if s["name"] == sheet_name), None)) or \
        (file["sheets"][0] if file["sheets"] else None)
    if not sheet:
        return []

    norm = [norm_header(h) for h in sheet["rawHeaders"]]

    def at(key: str) -> int:
        return norm.index(key) if key in norm else -1

    idx_ander = at("anderung")
    idx_saldo = at("saldo")
    time_idx = at("uhrze")
    if time_idx < 0:
        time_idx = at("uhrzeit")
    if time_idx < 0 and at("datum") >= 0:
        time_idx = at("datum") + 1
    idx = {
        "date": at("datum"),
        "time": time_idx,
        "valueDate": at("valutadatum"),
        "name": at("produkt"),
        "isin": at("isin"),
        "desc": at("beschreibung"),
        "fx": at("fx"),
        "currency": idx_ander,
        "amount": idx_ander + 1 if idx_ander >= 0 else -1,
        "balanceCurrency": idx_saldo,
        "balance": idx_saldo + 1 if idx_saldo >= 0 else -1,
        "orderId": at("orderid"),
    }

    def cell(row: list[str], i: int) -> str:
        return (row[i] if 0 <= i < len(row) else "").strip() if i >= 0 else ""

    events: list[dict] = []
    for row in sheet["rows"]:
        date_iso = parse_date(cell(row, idx["date"]), ["%d-%m-%Y"])
        time_str = cell(row, idx["time"])
        desc = cell(row, idx["desc"])
        ev = {
            "date": date_iso,
            "time": time_str,
            "valueDate": parse_date(cell(row, idx["valueDate"]), ["%d-%m-%Y"]),
            "name": cell(row, idx["name"]),
            "isin": cell(row, idx["isin"]),
            "description": desc,
            "type": _classify_account_type(desc),
            "fx": parse_num(cell(row, idx["fx"])),
            "currency": (cell(row, idx["currency"]) or "").upper() or None,
            "amount": parse_num(cell(row, idx["amount"])) or 0.0,
            "balanceCurrency": (cell(row, idx["balanceCurrency"]) or "").upper() or None,
            "balance": parse_num(cell(row, idx["balance"])),
            "orderId": cell(row, idx["orderId"]) or None,
            "reversed": False,
            "_dt": _account_dt(date_iso, time_str),
        }
        events.append(ev)

    # Reversal (storno) netting: same security + type + |amount| + currency, opposite
    # signs, within 10 minutes → flag both so they cancel (handles re-booked triples too).
    groups: dict[tuple, list[dict]] = {}
    for e in events:
        skey = e["isin"] or _base_name(e["name"] or "")
        key = (skey, e["type"], round(abs(e["amount"]), 2), e["currency"])
        groups.setdefault(key, []).append(e)
    for g in groups.values():
        if len(g) < 2:
            continue
        pos = [e for e in g if e["amount"] > 0 and not e["reversed"]]
        neg = [e for e in g if e["amount"] < 0 and not e["reversed"]]
        used: set[int] = set()
        for p in pos:
            for i, n in enumerate(neg):
                if i in used:
                    continue
                if _minutes_apart(p["_dt"], n["_dt"]) <= 10:
                    p["reversed"] = True
                    n["reversed"] = True
                    used.add(i)
                    break

    out: list[dict] = []
    for e in events:
        errors: list[str] = []
        if not e["date"]:
            errors.append("Unrecognised date")
        if e["type"] == "unknown":
            errors.append(f"Unmapped description: {e['description'] or '(empty)'}")
        dedupe_key = (
            f"account:{e['date']}:{e['time']}:{e['isin']}:{e['description']}:"
            f"{e['amount']}:{e['balance']}"
        )
        event = {k: v for k, v in e.items() if k != "_dt"}
        event["dedupeKey"] = dedupe_key
        out.append({
            "ok": len(errors) == 0,
            "errors": errors,
            "type": e["type"],
            "label": _ACCOUNT_TYPE_LABELS.get(e["type"], "Unknown"),
            "event": event,
        })
    return out

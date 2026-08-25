import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import { nanoid } from 'nanoid';
import type {
  BrokerMappingRow,
  CanonicalField,
  DetectedBroker,
  ImportMapping,
  ImportPreviewRow,
  ParsedFile,
  ParsedSheet,
  PreviewTx,
  TxCategory,
} from '@decisionguru/shared';

dayjs.extend(customParseFormat);

// In-memory store of parsed uploads for the current session.
const store = new Map<string, ParsedFile & { encoding: string }>();

// ---- encoding-aware text decode ----------------------------------------

/** Decode a file buffer to a clean string: BOM-aware, UTF-8 with Windows-1252 fallback. */
export function decodeText(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  }
  try {
    // Strict UTF-8: throws on invalid byte sequences (mojibake source).
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text, encoding: 'utf-8' };
  } catch {
    // Legacy DeGiro / Excel CSVs are often Windows-1252.
    return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' };
  }
}

// ---- RFC4180 CSV parser (honours quoted fields with embedded commas) ----

export function parseCsvRows(text: string, delimiter?: string): string[][] {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const delim =
    delimiter ??
    ([',', ';', '\t'].sort((a, b) => count(firstLine, b) - count(firstLine, a))[0] || ',');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // swallow; handled by \n
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

// ---- header helpers -----------------------------------------------------

/** Normalise a header for robust matching: lowercase, strip diacritics & non-alphanumerics. */
export function normHeader(h: string): string {
  return (h ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const HEADER_PATTERNS: Array<[CanonicalField, RegExp]> = [
  ['date', /(trade|value|settle|booking)?\s*(date|datum)/i],
  ['action', /type|action|transaction|buchung|art|richtung|side|operation|vorgang/i],
  ['isin', /isin/i],
  ['symbol', /symbol|ticker|valor/i],
  ['name', /name|description|security|instrument|bezeichnung|titel|produkt/i],
  ['quantity', /quantity|qty|shares|anzahl|st(ü|ue)ck|menge|units|nominal/i],
  ['unitPrice', /price|kurs|rate|unit\s*price|preis/i],
  ['fees', /fee|commission|courtage|geb(ü|ue)hr|kommission|charges|spesen/i],
  ['withholding', /withhold|verrechnung|quellensteuer|source\s*tax/i],
  ['grossAmount', /gross|brutto/i],
  ['netAmount', /net|amount|betrag|total|netto|value/i],
  ['currency', /currency|ccy|w(ä|ae)hrung|whrg|curr/i],
];

export function suggestMapping(headers: string[]): Record<string, CanonicalField> {
  const mapping: Record<string, CanonicalField> = {};
  const used = new Set<CanonicalField>();
  for (const header of headers) {
    let matched: CanonicalField = 'ignore';
    for (const [field, re] of HEADER_PATTERNS) {
      if (used.has(field)) continue;
      if (re.test(header)) {
        matched = field;
        break;
      }
    }
    if (matched !== 'ignore') used.add(matched);
    mapping[header] = matched;
  }
  return mapping;
}

function detectHeaderRow(rows: string[][]): number {
  let best = 0;
  let bestScore = -1;
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i];
    const nonEmpty = cells.filter((c) => c !== '').length;
    const textish = cells.filter((c) => c !== '' && Number.isNaN(Number(c.replace(/[',\s]/g, '')))).length;
    const score = nonEmpty + textish * 2;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function buildSheet(name: string, rows: string[][]): ParsedSheet {
  const headerRowIndex = detectHeaderRow(rows);
  const rawHeaders = (rows[headerRowIndex] ?? []).map((h) => h ?? '');
  const headers = rawHeaders.map((h, i) => (h === '' ? `Column ${i + 1}` : h));
  const dataRows = rows.slice(headerRowIndex + 1).filter((r) => r.some((c) => c !== ''));
  return { name, headers, rawHeaders, rows: dataRows, suggestedMapping: suggestMapping(headers) };
}

// ---- broker detection ---------------------------------------------------

const DEGIRO_SIGNATURE = ['datum', 'produkt', 'isin', 'referenzborse', 'ausfuhrungsort', 'wertinlokalwahrung', 'autofxgebuhr', 'orderid'];

export function detectBroker(rawHeaders: string[]): DetectedBroker | null {
  const norm = rawHeaders.map(normHeader);
  const hasAll = DEGIRO_SIGNATURE.every((sig) => norm.includes(sig));
  // The two empty currency headers sit right after Kurs and after Wert in Lokalwährung.
  const idxKurs = norm.indexOf('kurs');
  const idxLocal = norm.indexOf('wertinlokalwahrung');
  const emptyAfterKurs = idxKurs >= 0 && (rawHeaders[idxKurs + 1] ?? '') === '';
  const emptyAfterLocal = idxLocal >= 0 && (rawHeaders[idxLocal + 1] ?? '') === '';
  if (hasAll && emptyAfterKurs && emptyAfterLocal) return 'degiro';
  return null;
}

export const DEGIRO_BROKER_NAME = 'DeGiro — Transactions export';

export const DEGIRO_MAPPING_DISPLAY: BrokerMappingRow[] = [
  { header: 'Datum', field: 'date', note: 'DD-MM-YYYY' },
  { header: 'Uhrzeit', field: 'time', note: 'combined into timestamp' },
  { header: 'Produkt', field: 'name', note: 'quoted names with commas handled' },
  { header: 'ISIN', field: 'isin', note: 'primary instrument key' },
  { header: 'Referenzbörse', field: 'referenceExchange' },
  { header: 'Ausführungsort', field: 'executionVenue', note: 'may be empty' },
  { header: 'Anzahl', field: 'quantity', note: 'signed → buy / sell' },
  { header: 'Kurs', field: 'unitPrice' },
  { header: '(empty)', field: 'priceCurrency', note: 'currency of Kurs' },
  { header: 'Wert in Lokalwährung', field: 'localValue', note: 'signed → cash in / out' },
  { header: '(empty)', field: 'localCurrency', note: 'currency of local value' },
  { header: 'Wert CHF', field: 'valueCHF' },
  { header: 'Wechselkurs', field: 'fxRate' },
  { header: 'AutoFX-Gebühr', field: 'fees (part)', note: 'CHF, may be empty' },
  { header: 'Transaktionsgebühren …', field: 'fees (part)', note: 'CHF, may be empty' },
  { header: 'Gesamt CHF', field: 'totalCHF', note: 'net cash effect' },
  { header: 'Order-ID', field: 'orderId', note: 'empty for corporate actions' },
];

// ---- parse entrypoints --------------------------------------------------

export function parseUpload(filePath: string, filename: string): ParsedFile {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.csv' || ext === '.txt') return parseCsv(filePath, filename);
  return parseWorkbook(filePath, filename);
}

export function parseCsv(filePath: string, filename: string): ParsedFile {
  const { text, encoding } = decodeText(fs.readFileSync(filePath));
  const rows = parseCsvRows(text);
  const sheet = buildSheet('CSV', rows);
  const detectedBroker = detectBroker(sheet.rawHeaders);
  const parsed = finalizeParsed(filename, [sheet], encoding, detectedBroker);
  return parsed;
}

export function parseWorkbook(filePath: string, filename: string): ParsedFile {
  const buf = fs.readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const sheets: ParsedSheet[] = wb.SheetNames.map((n) => {
    const rows = XLSX.utils
      .sheet_to_json<string[]>(wb.Sheets[n], { header: 1, blankrows: false, defval: '', raw: false })
      .map((r) => r.map((c) => (c == null ? '' : String(c).trim())));
    return buildSheet(n, rows);
  }).filter((s) => s.rows.length > 0);
  const detectedBroker = sheets.length ? detectBroker(sheets[0].rawHeaders) : null;
  return finalizeParsed(filename, sheets, 'binary', detectedBroker);
}

export async function parsePdf(filePath: string, filename: string): Promise<ParsedFile> {
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  const pdfParse = (mod.default ?? mod) as (b: Buffer) => Promise<{ text: string }>;
  const { text } = await pdfParse(fs.readFileSync(filePath));
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const rows = lines.map((l) => l.split(/\t|\s{2,}/).map((c) => c.trim()));
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const padded = rows.map((r) => [...r, ...Array(maxCols - r.length).fill('')]);
  return finalizeParsed(filename, [buildSheet('PDF', padded)], 'utf-8', null);
}

function finalizeParsed(
  filename: string,
  sheets: ParsedSheet[],
  encoding: string,
  detectedBroker: DetectedBroker | null,
): ParsedFile {
  const parsed: ParsedFile & { encoding: string } = {
    fileId: nanoid(10),
    filename,
    sheets,
    encoding,
    detectedBroker,
    brokerName: detectedBroker === 'degiro' ? DEGIRO_BROKER_NAME : undefined,
    brokerMapping: detectedBroker === 'degiro' ? DEGIRO_MAPPING_DISPLAY : undefined,
  };
  store.set(parsed.fileId, parsed);
  return parsed;
}

export function getParsed(fileId: string): (ParsedFile & { encoding: string }) | undefined {
  return store.get(fileId);
}

// ---- generic date / number parsing -------------------------------------

const DATE_FORMATS = [
  'YYYY-MM-DD',
  'DD-MM-YYYY',
  'DD.MM.YYYY',
  'D.M.YYYY',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'YYYY/MM/DD',
  'DD.MM.YY',
  'MMM D, YYYY',
  'D MMM YYYY',
];

export function parseDate(raw: string, formats = DATE_FORMATS): string | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  for (const fmt of formats) {
    const d = dayjs(cleaned, fmt, true);
    if (d.isValid()) return d.format('YYYY-MM-DD');
  }
  const iso = dayjs(cleaned);
  if (iso.isValid() && /\d{4}/.test(cleaned)) return iso.format('YYYY-MM-DD');
  return null;
}

export function parseNum(raw: string): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === '') return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^0-9.,'\-\s]/g, '').replace(/'/g, '').replace(/\s/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    const parts = s.split(',');
    if (parts[parts.length - 1].length <= 2) s = s.replace(/,/g, '.');
    else s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? sign * n : null;
}

// ---- generic mapping application ---------------------------------------

function classifyAction(raw: string, actionMap: ImportMapping['actionMap']): 'buy' | 'sell' | 'dividend' | null {
  const v = (raw ?? '').toLowerCase().trim();
  if (!v) return null;
  const has = (list: string[]) => list.some((k) => v.includes(k.toLowerCase()));
  if (has(actionMap.dividend)) return 'dividend';
  if (has(actionMap.sell)) return 'sell';
  if (has(actionMap.buy)) return 'buy';
  return null;
}

export function applyMapping(mapping: ImportMapping): ImportPreviewRow[] {
  const file = store.get(mapping.fileId);
  if (!file) return [];
  const sheet = file.sheets.find((s) => s.name === mapping.sheetName) ?? file.sheets[0];
  if (!sheet) return [];

  const headerIndex: Partial<Record<CanonicalField, number>> = {};
  sheet.headers.forEach((h, i) => {
    const field = mapping.mapping[h];
    if (field && field !== 'ignore' && headerIndex[field] === undefined) headerIndex[field] = i;
  });
  const get = (row: string[], field: CanonicalField) => {
    const idx = headerIndex[field];
    return idx === undefined ? '' : row[idx] ?? '';
  };

  return sheet.rows.map((row) => {
    const errors: string[] = [];
    const date = parseDate(get(row, 'date'));
    const action = classifyAction(get(row, 'action'), mapping.actionMap);
    const quantity = parseNum(get(row, 'quantity')) ?? 0;
    const unitPrice = parseNum(get(row, 'unitPrice')) ?? 0;
    const fees = parseNum(get(row, 'fees')) ?? 0;
    const grossAmount = parseNum(get(row, 'grossAmount'));
    const netAmount = parseNum(get(row, 'netAmount'));
    const withholding = parseNum(get(row, 'withholding'));
    const currency = (get(row, 'currency') || mapping.defaultCurrency || '').toUpperCase() || undefined;
    const symbol = get(row, 'symbol') || undefined;
    const isin = get(row, 'isin') || undefined;
    const name = get(row, 'name') || undefined;

    if (!date) errors.push('Unrecognised date');
    if (!action) errors.push('Unknown action');
    if (!symbol && !isin && !name) errors.push('No instrument identifier');
    if ((action === 'buy' || action === 'sell') && !(quantity > 0)) errors.push('Quantity required for buy/sell');

    return {
      ok: errors.length === 0,
      errors,
      category: 'trade' as TxCategory,
      label: action ? action[0].toUpperCase() + action.slice(1) : undefined,
      tx: {
        action: action ?? undefined,
        date: date ?? undefined,
        quantity: Math.abs(quantity),
        unitPrice: Math.abs(unitPrice),
        fees: Math.abs(fees),
        currency,
        grossAmount: grossAmount ?? undefined,
        netAmount: netAmount ?? undefined,
        withholding: withholding ?? undefined,
        symbol,
        isin,
        name,
      },
    };
  });
}

export const DEFAULT_ACTION_MAP: ImportMapping['actionMap'] = {
  buy: ['buy', 'kauf', 'purchase', 'achat', 'acquisto', 'subscription'],
  sell: ['sell', 'verkauf', 'sale', 'vente', 'redemption', 'disposal'],
  dividend: ['dividend', 'dividende', 'distribution', 'ausschüttung', 'coupon', 'interest', 'ertrag'],
};

// ---- DeGiro dedicated transform ----------------------------------------

interface DegiroRow {
  i: number;
  date: string | null;
  time: string;
  name: string;
  isin: string;
  refEx: string;
  venue: string;
  qty: number;
  price: number;
  priceCcy: string;
  localVal: number;
  localCcy: string;
  valueCHF: number;
  fx: number;
  autoFx: number;
  txFees: number;
  totalCHF: number;
  orderId: string;
}

/** Strip class/venue suffixes so paired corporate-action rows group on the same base name. */
function baseName(name: string): string {
  return name
    .split(/\s+-\s+/)[0]
    .replace(/\bclass\b.*/i, '')
    .replace(/[^a-z0-9 ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function normalizeCurrency(ccy: string, price: number): { ccy: string; price: number } {
  const c = (ccy || '').toUpperCase();
  if (c === 'GBX' || c === 'GBP MINOR' || ccy === 'GBp') {
    return { ccy: 'GBP', price: price / 100 };
  }
  return { ccy: c, price };
}

export function transformDegiro(fileId: string, sheetName?: string): ImportPreviewRow[] {
  const file = store.get(fileId);
  if (!file) return [];
  const sheet = (sheetName && file.sheets.find((s) => s.name === sheetName)) || file.sheets[0];
  if (!sheet) return [];

  const norm = sheet.rawHeaders.map(normHeader);
  const at = (key: string) => norm.indexOf(key);
  const idx = {
    date: at('datum'),
    time: at('uhrzeit'),
    name: at('produkt'),
    isin: at('isin'),
    refEx: at('referenzborse'),
    venue: at('ausfuhrungsort'),
    qty: at('anzahl'),
    price: at('kurs'),
    priceCcy: at('kurs') + 1,
    localVal: at('wertinlokalwahrung'),
    localCcy: at('wertinlokalwahrung') + 1,
    valueCHF: at('wertchf'),
    fx: at('wechselkurs'),
    autoFx: at('autofxgebuhr'),
    txFees: norm.findIndex((h) => h.startsWith('transaktionsgebuhren')),
    total: at('gesamtchf'),
    orderId: at('orderid'),
  };

  const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');

  const parsed: DegiroRow[] = sheet.rows.map((row, i) => {
    const priceCcyRaw = cell(row, idx.priceCcy);
    const rawPrice = parseNum(cell(row, idx.price)) ?? 0;
    const norm2 = normalizeCurrency(priceCcyRaw, rawPrice);
    return {
      i,
      date: parseDate(cell(row, idx.date), ['DD-MM-YYYY', 'D-M-YYYY', 'DD.MM.YYYY', 'YYYY-MM-DD']),
      time: cell(row, idx.time),
      name: cell(row, idx.name),
      isin: cell(row, idx.isin),
      refEx: cell(row, idx.refEx),
      venue: cell(row, idx.venue),
      qty: parseNum(cell(row, idx.qty)) ?? 0,
      price: norm2.price,
      priceCcy: norm2.ccy,
      localVal: parseNum(cell(row, idx.localVal)) ?? 0,
      localCcy: normalizeCurrency(cell(row, idx.localCcy), 0).ccy,
      valueCHF: parseNum(cell(row, idx.valueCHF)) ?? 0,
      fx: parseNum(cell(row, idx.fx)) ?? 0,
      autoFx: parseNum(cell(row, idx.autoFx)) ?? 0,
      txFees: parseNum(cell(row, idx.txFees)) ?? 0,
      totalCHF: parseNum(cell(row, idx.total)) ?? 0,
      orderId: cell(row, idx.orderId),
    };
  });

  // Detect corporate-action pairs: same date + base name, with both +/- quantities.
  const groups = new Map<string, DegiroRow[]>();
  for (const r of parsed) {
    if (!r.date) continue;
    const key = `${r.date}|${baseName(r.name)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const pairedInfo = new Map<number, string>(); // row index -> label
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const hasPos = g.some((r) => r.qty > 0);
    const hasNeg = g.some((r) => r.qty < 0);
    if (hasPos && hasNeg) {
      const isins = new Set(g.map((r) => r.isin));
      const label = isins.size > 1 ? 'ISIN change' : 'Class swap';
      for (const r of g) pairedInfo.set(r.i, label);
    }
  }

  // A single order can execute as several partial fills that share one Order-ID (some
  // identical to the second). Key on the fill details + a per-tuple occurrence counter so
  // every distinct fill survives, while re-importing the same file still dedupes cleanly.
  const occurrence = new Map<string, number>();

  return parsed.map((r) => {
    const errors: string[] = [];
    if (!r.date) errors.push('Unrecognised date');
    if (!r.isin && !r.name) errors.push('No instrument identifier');

    const zeroValue = r.price === 0 && r.valueCHF === 0;
    const paired = pairedInfo.get(r.i);
    const category: TxCategory = zeroValue || paired ? 'corporate_action' : 'trade';
    const action = r.qty >= 0 ? 'buy' : 'sell';
    const label = zeroValue ? 'Delisting' : paired ? paired : action === 'buy' ? 'Buy' : 'Sell';

    const qtyAbs = Math.abs(r.qty);
    const valueAbs = Math.abs(r.valueCHF);
    const fees = Math.abs(r.autoFx) + Math.abs(r.txFees);
    const unitPriceCHF = qtyAbs > 0 && valueAbs > 0 ? valueAbs / qtyAbs : 0;

    const baseKey = r.orderId
      ? `degiro:${r.orderId}:${r.time}:${r.qty}:${r.valueCHF}`
      : `degiro:${r.date}:${r.time}:${r.isin}:${r.qty}:${r.valueCHF}`;
    const seq = occurrence.get(baseKey) ?? 0;
    occurrence.set(baseKey, seq + 1);
    const dedupeKey = `${baseKey}#${seq}`;

    const tx: PreviewTx = {
      action,
      date: r.date ?? undefined,
      time: r.time,
      quantity: qtyAbs,
      unitPrice: unitPriceCHF, // CHF/share, using DeGiro's own conversion
      fees,
      currency: 'CHF',
      category,
      isin: r.isin || undefined,
      name: r.name || undefined,
      nativePrice: r.price,
      priceCurrency: r.priceCcy,
      localCurrency: r.localCcy,
      valueCHF: r.valueCHF,
      totalCHF: r.totalCHF,
      referenceExchange: r.refEx,
      executionVenue: r.venue,
      orderId: r.orderId || undefined,
      note: `DeGiro ${r.refEx}${r.venue ? '/' + r.venue : ''} · ${r.qty} @ ${r.price} ${r.priceCcy}${
        r.orderId ? '' : ' · corporate action'
      }`,
      // dedupeKey carried through commit via a side channel below
    };
    (tx as PreviewTx & { dedupeKey?: string }).dedupeKey = dedupeKey;

    return { ok: errors.length === 0, errors, category, label, tx };
  });
}

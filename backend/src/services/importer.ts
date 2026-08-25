import fs from 'node:fs';
import * as XLSX from 'xlsx';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import { nanoid } from 'nanoid';
import type {
  CanonicalField,
  ImportMapping,
  ImportPreviewRow,
  ParsedFile,
  ParsedSheet,
} from '@decisionguru/shared';

dayjs.extend(customParseFormat);

// In-memory store of parsed uploads for the current session.
const store = new Map<string, ParsedFile>();

const HEADER_PATTERNS: Array<[CanonicalField, RegExp]> = [
  ['date', /(trade|value|settle|booking)?\s*(date|datum)/i],
  ['action', /type|action|transaction|buchung|art|richtung|side|operation|vorgang/i],
  ['isin', /isin/i],
  ['symbol', /symbol|ticker|valor/i],
  ['name', /name|description|security|instrument|bezeichnung|titel/i],
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

function sheetToRows(ws: XLSX.WorkSheet): string[][] {
  const rows = XLSX.utils.sheet_to_json<string[]>(ws, {
    header: 1,
    blankrows: false,
    defval: '',
    raw: false,
  });
  return rows.map((r) => r.map((c) => (c == null ? '' : String(c).trim())));
}

/** Pick the most likely header row: the row with the most non-empty, text-ish cells. */
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
  const headers = (rows[headerRowIndex] ?? []).map((h, i) => (h === '' ? `Column ${i + 1}` : h));
  const dataRows = rows.slice(headerRowIndex + 1);
  return {
    name,
    headers,
    rows: dataRows,
    suggestedMapping: suggestMapping(headers),
  };
}

export function parseWorkbook(filePath: string, filename: string): ParsedFile {
  const buf = fs.readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const sheets: ParsedSheet[] = wb.SheetNames.map((n) => buildSheet(n, sheetToRows(wb.Sheets[n]))).filter(
    (s) => s.rows.length > 0,
  );
  const parsed: ParsedFile = { fileId: nanoid(10), filename, sheets };
  store.set(parsed.fileId, parsed);
  return parsed;
}

export async function parsePdf(filePath: string, filename: string): Promise<ParsedFile> {
  // pdf-parse ships CommonJS; import the inner module to avoid its debug harness.
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  const pdfParse = (mod.default ?? mod) as (b: Buffer) => Promise<{ text: string }>;
  const buf = fs.readFileSync(filePath);
  const { text } = await pdfParse(buf);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // Heuristic table reconstruction: split each line on runs of 2+ spaces or tabs.
  const rows = lines.map((l) => l.split(/\t|\s{2,}/).map((c) => c.trim()));
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const padded = rows.map((r) => [...r, ...Array(maxCols - r.length).fill('')]);
  const sheet = buildSheet('PDF', padded);
  const parsed: ParsedFile = { fileId: nanoid(10), filename, sheets: [sheet] };
  store.set(parsed.fileId, parsed);
  return parsed;
}

export function getParsed(fileId: string): ParsedFile | undefined {
  return store.get(fileId);
}

// ---- mapping application ------------------------------------------------

const DATE_FORMATS = [
  'YYYY-MM-DD',
  'DD.MM.YYYY',
  'D.M.YYYY',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'YYYY/MM/DD',
  'DD-MM-YYYY',
  'DD.MM.YY',
  'MMM D, YYYY',
  'D MMM YYYY',
];

export function parseDate(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  const iso = dayjs(cleaned);
  for (const fmt of DATE_FORMATS) {
    const d = dayjs(cleaned, fmt, true);
    if (d.isValid()) return d.format('YYYY-MM-DD');
  }
  if (iso.isValid() && /\d{4}/.test(cleaned)) return iso.format('YYYY-MM-DD');
  return null;
}

/** Parse a locale-flexible number: 1'234.50, 1.234,50, 1,234.50, (123) as negative. */
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
    // whichever is last is the decimal separator
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // comma only: treat as decimal if it looks like one
    const parts = s.split(',');
    if (parts[parts.length - 1].length <= 2) s = s.replace(/,/g, '.');
    else s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? sign * n : null;
}

function classifyAction(
  raw: string,
  actionMap: ImportMapping['actionMap'],
): 'buy' | 'sell' | 'dividend' | null {
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

  const headerIndex: Record<CanonicalField, number> = {} as any;
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
    if ((action === 'buy' || action === 'sell') && !(quantity > 0))
      errors.push('Quantity required for buy/sell');

    return {
      ok: errors.length === 0,
      errors,
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

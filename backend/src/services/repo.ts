import { db } from '../db/index.js';
import type { Instrument, Transaction, Note, Scenario } from '@decisionguru/shared';
import { countryFromSymbol } from '@decisionguru/shared';
import { searchSymbol, getQuote, getFundSummary } from './marketdata.js';

function rowToInstrument(r: any): Instrument {
  return {
    ...r,
    allocationOverride: r.allocationOverride ? JSON.parse(r.allocationOverride) : null,
  };
}

export function listInstruments(): Instrument[] {
  return (db.prepare('SELECT * FROM instruments ORDER BY name').all() as any[]).map(rowToInstrument);
}

export function getInstrument(id: number): Instrument | null {
  const r = db.prepare('SELECT * FROM instruments WHERE id = ?').get(id);
  return r ? rowToInstrument(r) : null;
}

export function getInstrumentBySymbol(symbol: string): Instrument | null {
  const r = db.prepare('SELECT * FROM instruments WHERE symbol = ?').get(symbol);
  return r ? rowToInstrument(r) : null;
}

export function getTransactions(instrumentId: number): Transaction[] {
  return db
    .prepare('SELECT * FROM transactions WHERE instrumentId = ? ORDER BY date, id')
    .all(instrumentId) as Transaction[];
}

export function allTransactions(): Transaction[] {
  return db.prepare('SELECT * FROM transactions ORDER BY date, id').all() as Transaction[];
}

export function insertInstrument(data: Partial<Instrument>): Instrument {
  const info = db
    .prepare(
      `INSERT INTO instruments (symbol, isin, name, kind, currency, domicile, exchange, country, sector, incomeYieldOverride, allocationOverride)
       VALUES (@symbol, @isin, @name, @kind, @currency, @domicile, @exchange, @country, @sector, @incomeYieldOverride, @allocationOverride)`,
    )
    .run({
      symbol: data.symbol,
      isin: data.isin ?? null,
      name: data.name ?? data.symbol,
      kind: data.kind ?? 'stock',
      currency: data.currency ?? 'USD',
      domicile: data.domicile ?? null,
      exchange: data.exchange ?? null,
      country: data.country ?? null,
      sector: data.sector ?? null,
      incomeYieldOverride: data.incomeYieldOverride ?? null,
      allocationOverride: data.allocationOverride ? JSON.stringify(data.allocationOverride) : null,
    });
  return getInstrument(Number(info.lastInsertRowid))!;
}

export function updateInstrument(id: number, patch: Partial<Instrument>): Instrument | null {
  const current = getInstrument(id);
  if (!current) return null;
  const merged = { ...current, ...patch };
  db.prepare(
    `UPDATE instruments SET symbol=@symbol, isin=@isin, name=@name, kind=@kind, currency=@currency,
      domicile=@domicile, exchange=@exchange, country=@country, sector=@sector,
      incomeYieldOverride=@incomeYieldOverride, allocationOverride=@allocationOverride WHERE id=@id`,
  ).run({
    id,
    symbol: merged.symbol,
    isin: merged.isin ?? null,
    name: merged.name,
    kind: merged.kind,
    currency: merged.currency,
    domicile: merged.domicile ?? null,
    exchange: merged.exchange ?? null,
    country: merged.country ?? null,
    sector: merged.sector ?? null,
    incomeYieldOverride: merged.incomeYieldOverride ?? null,
    allocationOverride: merged.allocationOverride ? JSON.stringify(merged.allocationOverride) : null,
  });
  return getInstrument(id);
}

export function deleteInstrument(id: number) {
  db.prepare('DELETE FROM instruments WHERE id = ?').run(id);
}

/** Find an existing instrument by symbol/isin, or create one (enriching via Yahoo). */
export async function resolveInstrument(ident: {
  symbol?: string;
  isin?: string;
  name?: string;
}): Promise<Instrument> {
  if (ident.symbol) {
    const bySym = getInstrumentBySymbol(ident.symbol);
    if (bySym) return bySym;
  }
  if (ident.isin) {
    const byIsin = db.prepare('SELECT * FROM instruments WHERE isin = ?').get(ident.isin);
    if (byIsin) return rowToInstrument(byIsin);
  }

  // Try to resolve a canonical symbol from Yahoo using the best identifier we have.
  const query = ident.symbol || ident.isin || ident.name || '';
  let symbol = ident.symbol;
  let kind: 'stock' | 'etf' = 'stock';
  let currency = 'USD';
  let name = ident.name;
  const results = await searchSymbol(query);
  if (results.length) {
    const best = results[0];
    symbol = symbol || best.symbol;
    kind = best.kind as 'stock' | 'etf';
    name = name || best.name;
  }
  if (!symbol) {
    // fall back to a slug so the row is still creatable
    symbol = (ident.isin || ident.name || 'UNKNOWN').replace(/\s+/g, '-').toUpperCase().slice(0, 24);
  }

  // enrich currency/domicile/country from quote + profile
  try {
    const q = await getQuote(symbol);
    currency = q.currency || currency;
    name = name || q.name;
  } catch {
    /* ignore */
  }
  let domicile: string | null = null;
  let country: string | null = countryFromSymbol(symbol);
  let sector: string | null = null;
  try {
    const summary = await getFundSummary(symbol);
    const profile = summary?.summaryProfile ?? summary?.assetProfile ?? {};
    sector = profile.sector ?? null;
    if (summary?.assetProfile?.country) country = null; // resolved later by allocation
    if (summary?.quoteType?.quoteType === 'ETF') kind = 'etf';
  } catch {
    /* ignore */
  }
  // Heuristic domicile: US-listed bare symbols -> US; .SW -> CH; .L UCITS -> often IE
  domicile = country;

  return insertInstrument({
    symbol,
    isin: ident.isin ?? null,
    name: name ?? symbol,
    kind,
    currency,
    domicile,
    country,
    sector,
  });
}

export function insertTransaction(
  tx: Partial<Transaction> & { instrumentId: number; dedupeKey?: string },
): Transaction {
  const dedupeKey = tx.dedupeKey ?? makeDedupeKey(tx);
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO transactions (instrumentId, action, date, quantity, unitPrice, fees, currency, grossAmount, netAmount, withholding, note, source, dedupeKey)
       VALUES (@instrumentId, @action, @date, @quantity, @unitPrice, @fees, @currency, @grossAmount, @netAmount, @withholding, @note, @source, @dedupeKey)`,
    )
    .run({
      instrumentId: tx.instrumentId,
      action: tx.action,
      date: tx.date,
      quantity: tx.quantity ?? 0,
      unitPrice: tx.unitPrice ?? 0,
      fees: tx.fees ?? 0,
      currency: tx.currency ?? 'USD',
      grossAmount: tx.grossAmount ?? null,
      netAmount: tx.netAmount ?? null,
      withholding: tx.withholding ?? null,
      note: tx.note ?? null,
      source: tx.source ?? 'manual',
      dedupeKey,
    });
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(info.lastInsertRowid)) as Transaction;
}

export function makeDedupeKey(
  tx: Partial<Transaction> & { instrumentId?: number; dedupeKey?: string },
): string {
  return [tx.instrumentId, tx.action, tx.date, tx.quantity, tx.unitPrice, tx.currency].join('|');
}

export function deleteTransaction(id: number) {
  db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
}

// ---- notes --------------------------------------------------------------

export function listNotes(target: string, targetId: number | null): Note[] {
  if (targetId == null) {
    return db.prepare('SELECT * FROM notes WHERE target = ? ORDER BY updatedAt DESC').all(target) as Note[];
  }
  return db
    .prepare('SELECT * FROM notes WHERE target = ? AND targetId = ? ORDER BY updatedAt DESC')
    .all(target, targetId) as Note[];
}

export function allNotes(): Note[] {
  return db.prepare('SELECT * FROM notes ORDER BY updatedAt DESC').all() as Note[];
}

export function insertNote(target: string, targetId: number | null, body: string): Note {
  const info = db
    .prepare('INSERT INTO notes (target, targetId, body) VALUES (?, ?, ?)')
    .run(target, targetId, body);
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(info.lastInsertRowid)) as Note;
}

export function updateNote(id: number, body: string): Note | null {
  db.prepare("UPDATE notes SET body = ?, updatedAt = datetime('now') WHERE id = ?").run(body, id);
  return (db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Note) ?? null;
}

export function deleteNote(id: number) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
}

// ---- scenarios ----------------------------------------------------------

function rowToScenario(r: any): Scenario {
  return { ...r, config: JSON.parse(r.config) };
}

export function listScenarios(): Scenario[] {
  return (db.prepare('SELECT * FROM scenarios ORDER BY updatedAt DESC').all() as any[]).map(rowToScenario);
}

export function getScenario(id: number): Scenario | null {
  const r = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id);
  return r ? rowToScenario(r) : null;
}

export function insertScenario(name: string, config: unknown): Scenario {
  const info = db
    .prepare('INSERT INTO scenarios (name, config) VALUES (?, ?)')
    .run(name, JSON.stringify(config));
  return getScenario(Number(info.lastInsertRowid))!;
}

export function updateScenario(id: number, name: string, config: unknown): Scenario | null {
  db.prepare("UPDATE scenarios SET name = ?, config = ?, updatedAt = datetime('now') WHERE id = ?").run(
    name,
    JSON.stringify(config),
    id,
  );
  return getScenario(id);
}

export function deleteScenario(id: number) {
  db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
}

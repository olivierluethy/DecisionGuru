import { db } from '../db/index.js';
import type { Instrument, Transaction, Note, Scenario } from '@decisionguru/shared';
import { resolveSymbol } from './resolution.js';

function rowToInstrument(r: any): Instrument {
  return {
    ...r,
    allocationOverride: r.allocationOverride ? JSON.parse(r.allocationOverride) : null,
    unresolved: !!r.unresolved,
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
      `INSERT INTO instruments (symbol, isin, name, kind, currency, domicile, exchange, country, sector, incomeYieldOverride, allocationOverride, resolutionSource, unresolved)
       VALUES (@symbol, @isin, @name, @kind, @currency, @domicile, @exchange, @country, @sector, @incomeYieldOverride, @allocationOverride, @resolutionSource, @unresolved)`,
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
      resolutionSource: data.resolutionSource ?? null,
      unresolved: data.unresolved ? 1 : 0,
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
      incomeYieldOverride=@incomeYieldOverride, allocationOverride=@allocationOverride,
      resolutionSource=@resolutionSource, unresolved=@unresolved WHERE id=@id`,
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
    resolutionSource: merged.resolutionSource ?? null,
    unresolved: merged.unresolved ? 1 : 0,
  });
  return getInstrument(id);
}

export function deleteInstrument(id: number) {
  db.prepare('DELETE FROM instruments WHERE id = ?').run(id);
}

/** Find an existing instrument by isin/symbol, or create one (resolving via the tiered resolver). */
export async function resolveInstrument(ident: {
  symbol?: string;
  isin?: string;
  name?: string;
}): Promise<Instrument> {
  // Prefer ISIN as the stable key (a broker's ISIN never changes; the symbol may).
  if (ident.isin) {
    const byIsin = db.prepare('SELECT * FROM instruments WHERE isin = ?').get(ident.isin);
    if (byIsin) return rowToInstrument(byIsin);
  }
  if (ident.symbol) {
    const bySym = getInstrumentBySymbol(ident.symbol);
    if (bySym) return bySym;
  }

  const r = await resolveSymbol(ident);
  return insertInstrument({
    symbol: r.symbol,
    isin: ident.isin ?? null,
    name: r.name ?? ident.name ?? r.symbol,
    kind: r.kind,
    currency: r.currency,
    domicile: r.country, // issuer domicile ≈ ISIN country for tax routing
    country: r.country,
    exchange: r.exchange ?? null,
    resolutionSource: r.source,
    unresolved: r.unresolved,
  });
}

/**
 * Re-resolve one instrument's symbol/metadata. Used to repair rows imported before the
 * resolver existed (symbol still equals the ISIN) or that were left unresolved.
 * Preserves any user edits by only overwriting when we get a confident (non-unresolved) hit.
 */
export async function reresolveInstrument(
  id: number,
  opts: { offline?: boolean } = {},
): Promise<Instrument | null> {
  const inst = getInstrument(id);
  if (!inst) return null;
  const r = await resolveSymbol({ isin: inst.isin, name: inst.name, symbol: null }, opts);
  if (r.unresolved) {
    // Couldn't resolve — just flag it so the UI can show the badge; keep existing fields.
    return updateInstrument(id, { unresolved: true, resolutionSource: 'unresolved' });
  }
  return updateInstrument(id, {
    symbol: r.symbol,
    kind: r.kind,
    currency: r.currency,
    domicile: r.country ?? inst.domicile,
    country: r.country ?? inst.country,
    exchange: r.exchange ?? inst.exchange,
    name: inst.name || r.name || r.symbol,
    resolutionSource: r.source,
    unresolved: false,
  });
}

/** Rows whose symbol was never resolved to a real ticker (symbol == ISIN or flagged). */
export function unresolvedInstruments(): Instrument[] {
  return listInstruments().filter(
    (i) => i.unresolved || (i.isin && i.symbol === i.isin),
  );
}

export function insertTransaction(
  tx: Partial<Transaction> & { instrumentId: number; dedupeKey?: string },
): Transaction {
  const dedupeKey = tx.dedupeKey ?? makeDedupeKey(tx);
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO transactions (instrumentId, action, date, quantity, unitPrice, fees, currency, grossAmount, netAmount, withholding, category, note, source, dedupeKey)
       VALUES (@instrumentId, @action, @date, @quantity, @unitPrice, @fees, @currency, @grossAmount, @netAmount, @withholding, @category, @note, @source, @dedupeKey)`,
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
      category: tx.category ?? 'trade',
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

import { Router } from 'express';
import dayjs from 'dayjs';
import {
  listInstruments,
  getInstrument,
  getTransactions,
  insertInstrument,
  updateInstrument,
  deleteInstrument,
  resolveInstrument,
  reresolveInstrument,
  unresolvedInstruments,
  insertTransaction,
} from '../services/repo.js';
import { searchSymbol, priceOn } from '../services/marketdata.js';
import { instrumentDataStatus } from '../services/datastatus.js';

export const instrumentsRouter = Router();

instrumentsRouter.get('/', (_req, res) => {
  res.json(listInstruments());
});

instrumentsRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json([]);
  res.json(await searchSymbol(q));
});

// Re-resolve every instrument still stuck on its ISIN / flagged unresolved.
instrumentsRouter.post('/reresolve-all', async (req, res) => {
  const offline = req.body?.offline === true;
  const pending = unresolvedInstruments();
  const results = [];
  for (const inst of pending) {
    const updated = await reresolveInstrument(inst.id, { offline });
    results.push({ id: inst.id, isin: inst.isin, symbol: updated?.symbol, unresolved: updated?.unresolved });
  }
  res.json({ attempted: pending.length, offline, results });
});

// Re-resolve a single instrument on demand.
instrumentsRouter.post('/:id/reresolve', async (req, res) => {
  const updated = await reresolveInstrument(Number(req.params.id), { offline: req.body?.offline === true });
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
});

// Per-instrument market-data health for the UI badge.
instrumentsRouter.get('/:id/status', (req, res) => {
  const inst = getInstrument(Number(req.params.id));
  if (!inst) return res.status(404).json({ error: 'Not found' });
  res.json(instrumentDataStatus(inst));
});

instrumentsRouter.get('/:id', (req, res) => {
  const inst = getInstrument(Number(req.params.id));
  if (!inst) return res.status(404).json({ error: 'Not found' });
  res.json(inst);
});

instrumentsRouter.get('/:id/transactions', (req, res) => {
  res.json(getTransactions(Number(req.params.id)));
});

// Create instrument explicitly (from a search pick)
instrumentsRouter.post('/', async (req, res) => {
  const body = req.body ?? {};
  if (!body.symbol && !body.isin && !body.name) {
    return res.status(400).json({ error: 'symbol, isin or name required' });
  }
  const inst = await resolveInstrument(body);
  const patched = updateInstrument(inst.id, {
    domicile: body.domicile ?? inst.domicile,
    kind: body.kind ?? inst.kind,
    incomeYieldOverride: body.incomeYieldOverride ?? inst.incomeYieldOverride,
  });
  res.json(patched ?? inst);
});

instrumentsRouter.patch('/:id', (req, res) => {
  const updated = updateInstrument(Number(req.params.id), req.body ?? {});
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
});

instrumentsRouter.delete('/:id', (req, res) => {
  deleteInstrument(Number(req.params.id));
  res.json({ ok: true });
});

/**
 * Manual position entry (no transaction history): identify instrument, then derive a
 * single buy from either an invested amount or a number of units at a given date.
 */
instrumentsRouter.post('/manual', async (req, res) => {
  const { symbol, isin, name, date, amount, units, currency, action = 'buy' } = req.body ?? {};
  if (!date) return res.status(400).json({ error: 'date required' });
  const inst = await resolveInstrument({ symbol, isin, name });
  const ccy = currency || inst.currency;

  const priceAtDate = await priceOn(inst.symbol, date);
  if (priceAtDate == null) {
    return res.status(422).json({ error: `No historical price for ${inst.symbol} near ${date}` });
  }

  let qty = units != null ? Number(units) : 0;
  if (!qty && amount != null) {
    // amount is given in `ccy`; derive units = amount / price
    qty = Number(amount) / priceAtDate;
  }
  if (!qty || qty <= 0) return res.status(400).json({ error: 'Provide amount or units' });

  const tx = insertTransaction({
    instrumentId: inst.id,
    action: action === 'sell' ? 'sell' : 'buy',
    date: dayjs(date).format('YYYY-MM-DD'),
    quantity: qty,
    unitPrice: priceAtDate,
    fees: 0,
    currency: ccy,
    source: 'manual',
  });
  res.json({ instrument: inst, transaction: tx, derivedPrice: priceAtDate });
});

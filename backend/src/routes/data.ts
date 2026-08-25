import { Router } from 'express';
import { db } from '../db/index.js';

export const dataRouter = Router();

/**
 * Wipe transactions, instruments and all market-data caches so an import can be
 * re-tested from a clean slate. Settings, benchmarks and import presets are kept.
 * `keepResolutions` (default true) preserves the ISIN→symbol map so a re-import
 * doesn't have to re-hit Yahoo's rate-limited search.
 */
dataRouter.post('/reset', (req, res) => {
  const keepResolutions = req.body?.keepResolutions !== false;
  const tables = [
    'transactions',
    'instruments',
    'price_cache',
    'quote_cache',
    'dividend_cache',
    'fund_cache',
  ];
  if (!keepResolutions) tables.push('symbol_map');
  const wipe = db.transaction(() => {
    for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
    // Instrument-scoped notes/scenarios reference ids that no longer exist.
    db.prepare("DELETE FROM notes WHERE target = 'instrument'").run();
  });
  wipe();
  db.prepare('VACUUM').run();
  res.json({ ok: true, cleared: tables, keptResolutions: keepResolutions });
});

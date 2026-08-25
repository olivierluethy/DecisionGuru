import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { UPLOAD_DIR } from '../config.js';
import { db } from '../db/index.js';
import {
  parseUpload,
  parsePdf,
  getParsed,
  applyMapping,
  transformDegiro,
  DEFAULT_ACTION_MAP,
} from '../services/importer.js';
import { resolveInstrument, insertTransaction, makeDedupeKey } from '../services/repo.js';
import type { ImportMapping, ImportPreviewRow } from '@decisionguru/shared';

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 25 * 1024 * 1024 } });
export const importsRouter = Router();

importsRouter.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  try {
    const parsed = ext === '.pdf' ? await parsePdf(req.file.path, req.file.originalname) : parseUpload(req.file.path, req.file.originalname);
    res.json({ ...parsed, defaultActionMap: DEFAULT_ACTION_MAP });
  } catch (err) {
    res.status(422).json({ error: `Could not parse file: ${(err as Error).message}` });
  }
});

importsRouter.get('/file/:fileId', (req, res) => {
  const parsed = getParsed(req.params.fileId);
  if (!parsed) return res.status(404).json({ error: 'File not found (re-upload)' });
  res.json(parsed);
});

/** Preview rows for either a broker preset or a manual column mapping. */
function buildPreviewRows(mapping: ImportMapping): ImportPreviewRow[] {
  if (mapping.broker === 'degiro') return transformDegiro(mapping.fileId, mapping.sheetName);
  return applyMapping(mapping);
}

importsRouter.post('/preview', (req, res) => {
  const mapping = req.body as ImportMapping;
  if (!mapping?.fileId) return res.status(400).json({ error: 'fileId required' });
  if (!getParsed(mapping.fileId)) return res.status(404).json({ error: 'File not found (re-upload)' });
  const rows = buildPreviewRows(mapping);
  const okCount = rows.filter((r) => r.ok).length;
  const corporateActions = rows.filter((r) => r.category === 'corporate_action').length;
  const trades = rows.filter((r) => r.ok && r.category !== 'corporate_action').length;
  res.json({ rows, okCount, total: rows.length, trades, corporateActions });
});

importsRouter.post('/commit', async (req, res) => {
  const mapping = req.body as ImportMapping;
  if (!mapping?.fileId) return res.status(400).json({ error: 'fileId required' });
  if (!getParsed(mapping.fileId)) return res.status(404).json({ error: 'File not found (re-upload)' });
  const rows = buildPreviewRows(mapping).filter((r) => r.ok);

  let imported = 0;
  let skipped = 0;
  let corporateActions = 0;
  const instrumentCache = new Map<string, number>();
  const touched = new Set<number>();

  for (const row of rows) {
    const t = row.tx;
    const key = (t.symbol || t.isin || t.name || '').toUpperCase();
    let instrumentId = instrumentCache.get(key);
    if (instrumentId === undefined) {
      const inst = await resolveInstrument({ symbol: t.symbol, isin: t.isin, name: t.name });
      instrumentId = inst.id;
      instrumentCache.set(key, instrumentId);
    }
    const dedupeKey = (t as { dedupeKey?: string }).dedupeKey ?? makeDedupeKey({ ...t, instrumentId });
    const before = db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number };
    insertTransaction({
      instrumentId,
      action: t.action!,
      date: t.date!,
      quantity: t.quantity ?? 0,
      unitPrice: t.unitPrice ?? 0,
      fees: t.fees ?? 0,
      currency: t.currency,
      grossAmount: t.grossAmount ?? null,
      netAmount: t.netAmount ?? null,
      withholding: t.withholding ?? null,
      category: row.category ?? 'trade',
      note: t.note ?? null,
      source: `import:${mapping.broker ?? mapping.fileId}`,
      dedupeKey,
    });
    const after = db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number };
    if (after.c > before.c) {
      imported += 1;
      if (row.category === 'corporate_action') corporateActions += 1;
      touched.add(instrumentId);
    } else {
      skipped += 1;
    }
  }

  res.json({ imported, skipped, corporateActions, instruments: [...touched] });
});

// ---- presets ------------------------------------------------------------

importsRouter.get('/presets', (_req, res) => {
  const rows = db.prepare('SELECT * FROM import_presets ORDER BY name').all() as any[];
  res.json(rows.map((r) => ({ ...r, mapping: JSON.parse(r.mapping) })));
});

importsRouter.post('/presets', (req, res) => {
  const { name, mapping } = req.body ?? {};
  if (!name || !mapping) return res.status(400).json({ error: 'name and mapping required' });
  db.prepare(
    'INSERT INTO import_presets (name, mapping) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET mapping = excluded.mapping',
  ).run(name, JSON.stringify(mapping));
  res.json({ ok: true });
});

importsRouter.delete('/presets/:id', (req, res) => {
  db.prepare('DELETE FROM import_presets WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

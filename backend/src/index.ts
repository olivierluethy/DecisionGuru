import express from 'express';
import cors from 'cors';
import { PORT } from './config.js';
import './db/index.js'; // initialise DB + schema on boot
import { instrumentsRouter } from './routes/instruments.js';
import { transactionsRouter } from './routes/transactions.js';
import { importsRouter } from './routes/imports.js';
import { marketRouter } from './routes/marketdata.js';
import { analysisRouter } from './routes/analysis.js';
import { scenariosRouter } from './routes/scenarios.js';
import { settingsRouter } from './routes/settings.js';
import { notesRouter } from './routes/notes.js';
import { exportRouter } from './routes/export.js';
import { dataRouter } from './routes/data.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'decisionguru', time: new Date().toISOString() }));

app.use('/api/instruments', instrumentsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/imports', importsRouter);
app.use('/api/market', marketRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/scenarios', scenariosRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/notes', notesRouter);
app.use('/api/export', exportRouter);
app.use('/api/data', dataRouter);

// Central error handler so a thrown async error returns JSON, not an HTML stack.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api] error:', err);
  res.status(500).json({ error: (err as Error)?.message ?? 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`\n  DecisionGuru API  →  http://localhost:${PORT}\n`);
});

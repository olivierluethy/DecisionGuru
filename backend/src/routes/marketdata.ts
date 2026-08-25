import { Router } from 'express';
import dayjs from 'dayjs';
import { getQuote, getHistory, getFundSummary, searchSymbol } from '../services/marketdata.js';
import { buildAllocation } from '../services/allocation.js';
import { getInstrument } from '../services/repo.js';
import { getFxRate } from '../services/fx.js';

export const marketRouter = Router();

marketRouter.get('/quote/:symbol', async (req, res) => {
  res.json(await getQuote(req.params.symbol));
});

marketRouter.get('/history/:symbol', async (req, res) => {
  const from = (req.query.from as string) || dayjs().subtract(10, 'year').format('YYYY-MM-DD');
  const to = req.query.to as string | undefined;
  res.json(await getHistory(req.params.symbol, from, to));
});

marketRouter.get('/fund/:symbol', async (req, res) => {
  res.json(await getFundSummary(req.params.symbol));
});

marketRouter.get('/search', async (req, res) => {
  res.json(await searchSymbol(String(req.query.q ?? '')));
});

marketRouter.get('/fx', async (req, res) => {
  const from = String(req.query.from ?? 'USD');
  const to = String(req.query.to ?? 'CHF');
  const date = String(req.query.date ?? dayjs().format('YYYY-MM-DD'));
  res.json({ from, to, date, rate: await getFxRate(from, to, date) });
});

marketRouter.get('/allocation/:instrumentId', async (req, res) => {
  const inst = getInstrument(Number(req.params.instrumentId));
  if (!inst) return res.status(404).json({ error: 'Instrument not found' });
  res.json(await buildAllocation(inst));
});

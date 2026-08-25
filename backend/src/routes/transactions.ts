import { Router } from 'express';
import dayjs from 'dayjs';
import { insertTransaction, deleteTransaction, getInstrument } from '../services/repo.js';

export const transactionsRouter = Router();

transactionsRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  if (!body.instrumentId || !getInstrument(Number(body.instrumentId))) {
    return res.status(400).json({ error: 'valid instrumentId required' });
  }
  if (!body.action || !body.date) return res.status(400).json({ error: 'action and date required' });
  const tx = insertTransaction({
    instrumentId: Number(body.instrumentId),
    action: body.action,
    date: dayjs(body.date).format('YYYY-MM-DD'),
    quantity: Number(body.quantity ?? 0),
    unitPrice: Number(body.unitPrice ?? 0),
    fees: Number(body.fees ?? 0),
    currency: body.currency,
    grossAmount: body.grossAmount ?? null,
    netAmount: body.netAmount ?? null,
    withholding: body.withholding ?? null,
    note: body.note ?? null,
    source: 'manual',
  });
  res.json(tx);
});

transactionsRouter.delete('/:id', (req, res) => {
  deleteTransaction(Number(req.params.id));
  res.json({ ok: true });
});

import { Router } from 'express';
import { getSettings, saveSettings } from '../db/index.js';
import { DEFAULT_SETTINGS } from '@decisionguru/shared';

export const settingsRouter = Router();

settingsRouter.get('/', (_req, res) => {
  res.json(getSettings());
});

settingsRouter.put('/', (req, res) => {
  const incoming = req.body ?? {};
  const current = getSettings();
  const merged = {
    ...current,
    ...incoming,
    tax: { ...current.tax, ...(incoming.tax ?? {}) },
    benchmarks: incoming.benchmarks ?? current.benchmarks,
  };
  saveSettings(merged);
  res.json(merged);
});

settingsRouter.post('/reset', (_req, res) => {
  saveSettings(DEFAULT_SETTINGS);
  res.json(DEFAULT_SETTINGS);
});

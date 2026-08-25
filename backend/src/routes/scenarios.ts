import { Router } from 'express';
import type { ScenarioConfig, ScenarioResult } from '@decisionguru/shared';
import { getSettings } from '../db/index.js';
import {
  listScenarios,
  getScenario,
  insertScenario,
  updateScenario,
  deleteScenario,
  getInstrument,
  getTransactions,
  listInstruments,
} from '../services/repo.js';
import { computeCounterfactual } from '../services/counterfactual.js';
import { aggregateCounterfactuals } from './analysis.js';

export const scenariosRouter = Router();

scenariosRouter.get('/', (_req, res) => res.json(listScenarios()));

scenariosRouter.get('/:id', (req, res) => {
  const s = getScenario(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

scenariosRouter.post('/', (req, res) => {
  const { name, config } = req.body ?? {};
  if (!name || !config) return res.status(400).json({ error: 'name and config required' });
  res.json(insertScenario(name, config));
});

scenariosRouter.put('/:id', (req, res) => {
  const { name, config } = req.body ?? {};
  const s = updateScenario(Number(req.params.id), name, config);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

scenariosRouter.delete('/:id', (req, res) => {
  deleteScenario(Number(req.params.id));
  res.json({ ok: true });
});

/** Run an ad-hoc config (not necessarily saved). */
scenariosRouter.post('/run', async (req, res) => {
  const config = req.body as ScenarioConfig;
  const result = await runScenario(config);
  res.json(result);
});

export async function runScenario(config: ScenarioConfig): Promise<ScenarioResult> {
  const settings = getSettings();
  const benchmark = config.benchmarkSymbol || settings.defaultBenchmarkSymbol;
  const preTax = config.preTax ?? false;

  let ids = config.includedInstrumentIds ?? [];
  if (config.sellAllToEtf || ids.length === 0) {
    ids = listInstruments().map((i) => i.id);
  }

  const perPosition: ScenarioResult['perPosition'] = [];
  for (const id of ids) {
    const inst = getInstrument(id);
    if (!inst) continue;
    const txs = getTransactions(id);
    if (!txs.length) continue;
    const cf = await computeCounterfactual(inst, txs, benchmark, settings, preTax);
    perPosition.push({ instrumentId: id, symbol: inst.symbol, counterfactual: cf });
  }

  const aggregate = aggregateCounterfactuals(perPosition.map((p) => p.counterfactual));
  return {
    scenario: { ...config, benchmarkSymbol: benchmark, preTax },
    perPosition,
    aggregate: {
      actualValueCHF: aggregate.actualValueCHF,
      counterfactualValueCHF: aggregate.counterfactualValueCHF,
      deltaCHF: aggregate.deltaCHF,
      deltaPct: aggregate.deltaPct,
      series: aggregate.series,
    },
  };
}

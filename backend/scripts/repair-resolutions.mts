/**
 * One-off data migration: repair instrument rows imported before the resolver existed
 * (symbol == ISIN). Runs the curated/offline resolver directly against the DB — no HTTP
 * server, no Yahoo — so it is instant and deterministic. Safe to re-run (idempotent).
 *
 *   npm --workspace backend run repair
 */
import { unresolvedInstruments, reresolveInstrument } from '../src/services/repo.js';

const pending = unresolvedInstruments();
console.log(`Repairing ${pending.length} unresolved instrument(s) (offline / curated)…\n`);

let fixed = 0;
let stillUnresolved = 0;
for (const inst of pending) {
  const updated = await reresolveInstrument(inst.id, { offline: true });
  const ok = updated && !updated.unresolved && updated.symbol !== updated.isin;
  if (ok) fixed++;
  else stillUnresolved++;
  console.log(
    `  ${(inst.isin ?? '—').padEnd(14)} ${ok ? '→ ' + updated!.symbol : '× unresolved'} ${
      ok ? `(${updated!.currency}, ${updated!.kind}, ${updated!.country ?? '—'})` : ''
    }`,
  );
}

console.log(`\nDone. ${fixed} resolved, ${stillUnresolved} left unresolved (delisted / unknown).`);
process.exit(0);

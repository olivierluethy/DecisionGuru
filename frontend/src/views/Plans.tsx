import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Plus, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { api, type DecisionPlan } from '../lib/api';
import { Spinner, EmptyState } from '../components/ui';
import { fmtCHF, fmtCHFSigned, fmtPctSigned, fmtDate, plClass } from '../lib/format';
import { useApp } from '../store';
import { ExportAction } from '../components/ExportAction';

function PlanComparison({ planId }: { planId: number }) {
  const { data, isLoading } = useQuery({ queryKey: ['plan-compare', planId], queryFn: () => api.comparePlan(planId) });
  if (isLoading) return <div className="mt-3"><Spinner label="Comparing plan vs holding…" /></div>;
  if (!data) return null;
  const ahead = data.deltaCHF >= 0;

  return (
    <div className="mt-4 pt-4 border-t border-hairline">
      <div className="grid sm:grid-cols-3 gap-4 mb-4">
        <div>
          <div className="eyebrow mb-1">Plan reinvested · now</div>
          <div className="font-mono text-lg tnum text-gold">{fmtCHF(data.plan.valueNowCHF)}</div>
          <div className="text-xs text-text-muted">{fmtPctSigned(data.plan.returnPct)} since {fmtDate(data.createdDate)}</div>
        </div>
        <div>
          <div className="eyebrow mb-1">Held instead · now</div>
          <div className="font-mono text-lg tnum text-azure">{fmtCHF(data.hold.valueNowCHF)}</div>
          <div className="text-xs text-text-muted">{fmtPctSigned(data.hold.returnPct)} since {fmtDate(data.createdDate)}</div>
        </div>
        <div>
          <div className="eyebrow mb-1">Plan vs holding</div>
          <div className={clsx('font-mono text-lg tnum font-semibold', plClass(data.deltaCHF))}>
            {fmtCHFSigned(data.deltaCHF)}
          </div>
          <div className="text-xs text-text-muted">{ahead ? 'the plan is ahead' : 'holding is ahead'}</div>
        </div>
      </div>
      {data.intendedOutcome && (
        <p className="text-[13px] text-text-faint italic">Intended: {data.intendedOutcome}</p>
      )}
    </div>
  );
}

function PlanCard({ plan }: { plan: DecisionPlan }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.deletePlan(plan.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plans'] }),
  });
  const setStatus = useMutation({
    mutationFn: (status: string) => api.updatePlan(plan.id, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plans'] }),
  });

  const targets = plan.config.targets ?? [];
  const executed = plan.status === 'executed';

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-4">
        <button className="flex items-start gap-2 text-left min-w-0" onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={16} className="text-text-faint mt-1 shrink-0" /> : <ChevronRight size={16} className="text-text-faint mt-1 shrink-0" />}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display text-base font-semibold">{plan.name}</span>
              <span className={clsx('chip !py-0.5', executed ? 'text-gain' : 'text-text-faint')}>{plan.status}</span>
            </div>
            <div className="text-[12px] text-text-muted mt-1">
              Sell {plan.config.sellInstrumentIds?.length ?? 0} · into{' '}
              {targets.map((t) => t.symbol).join(', ') || '—'} · created {fmtDate(plan.createdAt)}
            </div>
          </div>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {!executed && (
            <button className="btn-secondary h-8" onClick={() => setStatus.mutate('executed')}>
              Mark executed
            </button>
          )}
          <button className="btn-ghost h-8 !px-2 text-loss" onClick={() => del.mutate()} title="Delete plan">
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      {open && <PlanComparison planId={plan.id} />}
    </div>
  );
}

export function Plans() {
  const { data, isLoading } = useQuery({ queryKey: ['plans'], queryFn: api.listPlans });
  const { openModal } = useApp();

  return (
    <div id="view-plans" className="p-6 max-w-[1000px] mx-auto">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="eyebrow mb-1">Decision plans</div>
          <h1 className="font-display text-2xl font-semibold">Plans</h1>
          <p className="text-sm text-text-muted mt-1 max-w-2xl">
            Name a plan — which holdings to sell, where the proceeds go, the outcome you expect — and
            compare the plan against simply holding, measured from the day you made it.
          </p>
        </div>
        <button className="btn-primary shrink-0" onClick={() => openModal({ kind: 'create-plan' })}>
          <Plus size={15} /> New plan
        </button>
        <ExportAction target={() => document.getElementById('view-plans')} title="Plans" filename="plans" className="btn-secondary shrink-0" label="PDF / Word" />
      </header>

      {isLoading ? (
        <Spinner />
      ) : !data?.length ? (
        <EmptyState
          title="No plans yet"
          hint="Draft a sell-and-reinvest plan from a Sell recommendation, or start one here. Its baseline is snapshotted so you can hold it to account later."
          action={<button className="btn-primary" onClick={() => openModal({ kind: 'create-plan' })}><Plus size={15} /> New plan</button>}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {data.map((p) => <PlanCard key={p.id} plan={p} />)}
        </div>
      )}
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { useApp } from '../store';
import { fmtCHF, fmtMoney } from '../lib/format';

/** Per-currency breakdown of Kontoguthaben (cash), each converted to the CHF headline. */
export function CashDetailModal() {
  const { closeModal, benchmark, preTax } = useApp();
  const { data } = useQuery({ queryKey: ['portfolio', benchmark, preTax], queryFn: () => api.portfolio(benchmark, preTax) });
  const cash = data?.cash;
  const rows = Object.entries(cash?.byCurrency ?? {}).sort((a, b) => b[1].chf - a[1].chf);

  return (
    <Modal title="Kontoguthaben" subtitle="Cash balance per currency, converted to CHF." onClose={closeModal} size="md">
      {rows.length === 0 ? (
        <div className="text-sm text-text-muted py-6">
          No cash movements yet — import your DEGIRO account statement to see cash by currency.
        </div>
      ) : (
        <div className="border border-hairline rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="th">Currency</th>
                <th className="th text-right">Balance</th>
                <th className="th text-right">In CHF</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([ccy, v]) => (
                <tr key={ccy}>
                  <td className="td font-mono">{ccy}</td>
                  <td className="td text-right font-mono tnum">{fmtMoney(v.amount, ccy)}</td>
                  <td className="td text-right font-mono tnum">{fmtCHF(v.chf, true)}</td>
                </tr>
              ))}
              <tr>
                <td className="td font-medium">Total</td>
                <td className="td" />
                <td className="td text-right font-mono tnum font-medium">{fmtCHF(cash?.totalCHF, true)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

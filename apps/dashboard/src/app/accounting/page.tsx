import Link from 'next/link';
import { AccountingManager } from '@/components/AccountingManager';
import { Shell } from '@/components/Shell';
import { api, authed, type AccountingReports, type JournalView, type Me, type Outlet } from '@/lib/api';
import { RANGE_OPTIONS, rangeText, rp, type RangeValue } from '@/lib/format';

export const dynamic = 'force-dynamic';

const VIEWS = [['journal', 'Jurnal'], ['trial', 'Neraca saldo'], ['income', 'Laba rugi'], ['accounts', 'Bagan akun']] as const;
type View = (typeof VIEWS)[number][0];
const TYPE_LABEL: Record<string, string> = { ASSET: 'Aset', LIABILITY: 'Kewajiban', EQUITY: 'Ekuitas', REVENUE: 'Pendapatan', EXPENSE: 'Beban' };

export default async function AccountingPage({ searchParams }: { searchParams: Promise<{ outlet?: string; range?: string; view?: string }> }) {
  const sp = await searchParams;
  const range: RangeValue = RANGE_OPTIONS.some((o) => o.value === sp.range) ? (sp.range as RangeValue) : 'month';
  const view: View = VIEWS.some(([v]) => v === sp.view) ? (sp.view as View) : 'journal';
  const { me, outlets } = await authed(async () => ({ me: await api<Me>('/v1/me'), outlets: await api<Outlet[]>('/v1/outlets') }));
  if (me.role !== 'OWNER' && me.role !== 'MANAGER') return <Shell me={me}><div className="empty">Akuntansi hanya untuk owner dan manager.</div></Shell>;
  const outlet = outlets.find((o) => o.id === sp.outlet) ?? outlets[0];
  if (!outlet) return <Shell me={me}><div className="empty">Belum ada outlet.</div></Shell>;

  const base = `/v1/outlets/${encodeURIComponent(outlet.id)}/accounting`;
  const journal = await authed(() => api<JournalView>(`${base}/journal?range=${range}`));
  const reports = view === 'trial' || view === 'income' ? await authed(() => api<AccountingReports>(`${base}/reports?range=${range}`)) : null;
  const href = (o: string, rg: string, v: string) => `/accounting?outlet=${encodeURIComponent(o)}&range=${rg}&view=${v}`;
  const canWrite = me.role === 'OWNER';

  return (
    <Shell me={me}>
      <h1>Akuntansi</h1>
      <p className="sub">{outlet.name} · {rangeText(journal.range.from, journal.range.to)}</p>
      <div className="filters no-print">
        {outlets.length > 1 && (
          <nav className="tabs" aria-label="Outlet">
            {outlets.map((o) => <Link key={o.id} className="tab" href={href(o.id, range, view)} aria-current={o.id === outlet.id ? 'page' : undefined}>{o.name}</Link>)}
          </nav>
        )}
        <nav className="tabs" aria-label="Rentang waktu">
          {RANGE_OPTIONS.map((o) => <Link key={o.value} className="tab" href={href(outlet.id, o.value, view)} aria-current={o.value === range ? 'page' : undefined}>{o.label}</Link>)}
        </nav>
        <nav className="tabs" aria-label="Tampilan">
          {VIEWS.map(([v, l]) => <Link key={v} className="tab" href={href(outlet.id, range, v)} aria-current={v === view ? 'page' : undefined}>{l}</Link>)}
        </nav>
      </div>

      {view === 'trial' && reports && (
        <section className="panel">
          <h2>Neraca saldo</h2>
          <table className="table">
            <thead><tr><th>Akun</th><th>Jenis</th><th className="num">Debit</th><th className="num">Kredit</th><th className="num">Saldo</th></tr></thead>
            <tbody>
              {reports.trialBalance.rows.map((r) => (
                <tr key={r.account}>
                  <td data-label="Akun"><span className="mono">{r.account}</span> {r.name}</td>
                  <td data-label="Jenis">{TYPE_LABEL[r.type] ?? r.type}</td>
                  <td data-label="Debit" className="num">{r.debit ? rp(r.debit) : ''}</td>
                  <td data-label="Kredit" className="num">{r.credit ? rp(r.credit) : ''}</td>
                  <td data-label="Saldo" className="num">{rp(r.balance)}</td>
                </tr>
              ))}
              <tr><td><b>Total</b></td><td /><td className="num"><b>{rp(reports.trialBalance.totalDebit)}</b></td><td className="num"><b>{rp(reports.trialBalance.totalCredit)}</b></td><td /></tr>
            </tbody>
          </table>
          <p className="muted small" style={{ marginBottom: 0 }}>Mutasi pada rentang terpilih (bukan saldo kumulatif sejak awal). Jurnal penjualan POS dihitung dari data transaksi; jurnal manual dari pencatatan owner.</p>
        </section>
      )}

      {view === 'income' && reports && (
        <section className="panel">
          <h2>Laba rugi</h2>
          <table className="table">
            <tbody>
              <tr><th colSpan={2}>Pendapatan</th></tr>
              {reports.incomeStatement.revenue.map((r) => <tr key={r.account}><td><span className="mono">{r.account}</span> {r.name}</td><td className="num">{rp(r.balance)}</td></tr>)}
              <tr><td><b>Total pendapatan bersih</b></td><td className="num"><b>{rp(reports.incomeStatement.totalRevenue)}</b></td></tr>
              <tr><th colSpan={2}>Beban</th></tr>
              {reports.incomeStatement.expenses.map((r) => <tr key={r.account}><td><span className="mono">{r.account}</span> {r.name}</td><td className="num">{rp(r.balance)}</td></tr>)}
              {reports.incomeStatement.expenses.length === 0 && <tr><td className="muted" colSpan={2}>Belum ada beban tercatat. Catat biaya (sewa, gaji, bahan baku) lewat jurnal manual.</td></tr>}
              <tr><td><b>Total beban</b></td><td className="num"><b>{rp(reports.incomeStatement.totalExpenses)}</b></td></tr>
              <tr><td><b>Laba (rugi) bersih</b></td><td className={`num ${reports.incomeStatement.netIncome < 0 ? 'neg' : ''}`}><b>{rp(reports.incomeStatement.netIncome)}</b></td></tr>
            </tbody>
          </table>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Pajak restoran (PBJT) tidak termasuk pendapatan: dicatat sebagai kewajiban. Laba di sini belum memuat harga pokok bahan baku kecuali dicatat lewat jurnal manual.
          </p>
        </section>
      )}

      {(view === 'journal' || view === 'accounts') && (
        <AccountingManager view={view} outletId={outlet.id} range={range} canWrite={canWrite} data={journal} />
      )}
    </Shell>
  );
}

import Link from 'next/link';
import { AccountingManager } from '@/components/AccountingManager';
import { Shell } from '@/components/Shell';
import { FinancialStatementsView } from '@/components/FinancialStatementsView';
import { api, authed, type AccountingReports, type FinancialStatements, type JournalView, type Me, type Outlet } from '@/lib/api';
import { RANGE_OPTIONS, rangeText, rp, type RangeValue } from '@/lib/format';

export const dynamic = 'force-dynamic';

const VIEWS = [['journal', 'Jurnal'], ['trial', 'Neraca saldo'], ['income', 'Laba rugi'], ['statements', 'Laporan keuangan'], ['accounts', 'Bagan akun']] as const;
const PERIODS = [['this-month', 'Bulan ini'], ['last-month', 'Bulan lalu'], ['ytd', 'Tahun berjalan'], ['last-year', '12 bulan terakhir']] as const;

/** Periode laporan keuangan dari pilihan cepat (tanggal lokal WIB; tanggal sebenarnya diperiksa API sesuai zona outlet). */
function periodRange(p: string): { from: string; to: string } {
  const now = new Date(Date.now() + 7 * 3_600_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (p === 'last-month') return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
  if (p === 'ytd') return { from: `${y}-01-01`, to: iso(now) };
  if (p === 'last-year') return { from: iso(new Date(Date.UTC(y, m - 11, 1))), to: iso(now) };
  return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(now) };
}
type View = (typeof VIEWS)[number][0];
const TYPE_LABEL: Record<string, string> = { ASSET: 'Aset', LIABILITY: 'Kewajiban', EQUITY: 'Ekuitas', REVENUE: 'Pendapatan', EXPENSE: 'Beban' };

export default async function AccountingPage({ searchParams }: { searchParams: Promise<{ outlet?: string; range?: string; view?: string; period?: string }> }) {
  const sp = await searchParams;
  const range: RangeValue = RANGE_OPTIONS.some((o) => o.value === sp.range) ? (sp.range as RangeValue) : 'month';
  const view: View = VIEWS.some(([v]) => v === sp.view) ? (sp.view as View) : 'journal';
  const { me, outlets } = await authed(async () => ({ me: await api<Me>('/v1/me'), outlets: await api<Outlet[]>('/v1/outlets') }));
  if (me.role !== 'OWNER' && me.role !== 'MANAGER') return <Shell me={me}><div className="empty">Akuntansi hanya untuk owner dan manager.</div></Shell>;
  const consolidated = sp.outlet === 'all' && me.role === 'OWNER' && outlets.length > 1;
  const outlet = consolidated ? { ...outlets[0]!, id: 'all', name: 'Semua outlet (konsolidasi)' } : (outlets.find((o) => o.id === sp.outlet) ?? outlets[0]);
  if (!outlet) return <Shell me={me}><div className="empty">Belum ada outlet.</div></Shell>;
  const period = PERIODS.some(([v]) => v === sp.period) ? sp.period! : 'this-month';

  const base = `/v1/outlets/${encodeURIComponent(outlet.id)}/accounting`;
  // Jurnal dan neraca saldo memakai satu outlet; konsolidasi hanya untuk laporan keuangan.
  const journalOutlet = consolidated ? outlets[0]!.id : outlet.id;
  const journal = await authed(() => api<JournalView>(`/v1/outlets/${encodeURIComponent(journalOutlet)}/accounting/journal?range=${range}`));
  const pr = periodRange(period);
  const stmts = view === 'statements' ? await authed(() => api<FinancialStatements>(`${base}/statements?from=${pr.from}&to=${pr.to}`)) : null;
  const reports = view === 'trial' || view === 'income' ? await authed(() => api<AccountingReports>(`/v1/outlets/${encodeURIComponent(journalOutlet)}/accounting/reports?range=${range}`)) : null;
  const href = (o: string, rg: string, v: string, pe = period) => `/accounting?outlet=${encodeURIComponent(o)}&range=${rg}&view=${v}${v === 'statements' ? `&period=${pe}` : ''}`;
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
        {me.role === 'OWNER' && outlets.length > 1 && view === 'statements' && (
          <nav className="tabs" aria-label="Konsolidasi">
            <Link className="tab" href={href('all', range, view)} aria-current={consolidated ? 'page' : undefined}>Semua outlet</Link>
          </nav>
        )}
        {view === 'statements' ? (
          <nav className="tabs" aria-label="Periode">
            {PERIODS.map(([v, l]) => <Link key={v} className="tab" href={href(outlet.id, range, view, v)} aria-current={v === period ? 'page' : undefined}>{l}</Link>)}
          </nav>
        ) : (
        <nav className="tabs" aria-label="Rentang waktu">
          {RANGE_OPTIONS.map((o) => <Link key={o.value} className="tab" href={href(outlet.id, o.value, view)} aria-current={o.value === range ? 'page' : undefined}>{o.label}</Link>)}
        </nav>
        )}
        <nav className="tabs" aria-label="Tampilan">
          {VIEWS.map(([v, l]) => <Link key={v} className="tab" href={href(outlet.id, range, v)} aria-current={v === view ? 'page' : undefined}>{l}</Link>)}
        </nav>
      </div>

      {view === 'statements' && stmts && <FinancialStatementsView data={stmts} outletId={outlet.id} outletName={outlet.name} />}

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
        <AccountingManager view={view} outletId={journalOutlet} range={range} canWrite={canWrite} data={journal} />
      )}
    </Shell>
  );
}

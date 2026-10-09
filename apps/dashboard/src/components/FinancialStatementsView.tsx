import type { FinancialStatements, StmtRow, StmtSection } from '@/lib/api';
import { rp, shortDate } from '@/lib/format';
import { PrintButton } from './PrintButton';

const Rows = ({ rows }: { rows: StmtRow[] }) => <>{rows.map((r) => <tr key={`${r.account}${r.name}`}><td>{r.account && <span className="mono">{r.account} </span>}{r.name}</td><td className="num">{rp(r.amount)}</td></tr>)}</>;
const Section = ({ s }: { s: StmtSection }) => (
  <>
    <tr><th colSpan={2}>{s.label}</th></tr>
    <Rows rows={s.rows} />
    {s.rows.length === 0 && <tr><td className="muted" colSpan={2}>–</td></tr>}
    <tr><td><b>Total {s.label.toLowerCase()}</b></td><td className="num"><b>{rp(s.total)}</b></td></tr>
  </>
);
const Total = ({ label, amount, neg }: { label: string; amount: number; neg?: boolean }) => <tr><td><b>{label}</b></td><td className={`num ${neg && amount < 0 ? 'neg' : ''}`}><b>{rp(amount)}</b></td></tr>;

/** Neraca, laba rugi, arus kas, dan perubahan ekuitas dalam satu halaman cetak; angkanya saling cocok (diperiksa API). */
export function FinancialStatementsView({ data, outletId, outletName }: { data: FinancialStatements; outletId: string; outletName: string }) {
  const b = data.balanceSheet;
  const c = data.cashFlow;
  const dl = (k: string, l: string) => <a key={k} className="btn-like secondary" href={`/api/statements-export?outlet=${encodeURIComponent(outletId)}&statement=${k}&from=${data.period.from}&to=${data.period.to}`} download>{l}</a>;
  const checks = [['Neraca seimbang', b.difference === 0], ['Kas akhir sama dengan neraca', c.reconciles], ['Ekuitas akhir sama dengan neraca', data.equity.reconciles], ['Neraca saldo seimbang', data.trialBalanceBalanced]] as const;
  return (
    <>
      <section className="panel no-print">
        <h2>Laporan keuangan</h2>
        <p className="muted small" style={{ marginTop: 0 }}>{outletName} · periode {shortDate(data.period.from)} – {shortDate(data.period.to)} · neraca per {shortDate(data.asOf)}{data.booksStart ? ` · pembukuan sejak ${shortDate(data.booksStart)}` : ''}</p>
        <div className="export-links">{dl('balance', 'CSV Neraca')}{dl('income', 'CSV Laba rugi')}{dl('cashflow', 'CSV Arus kas')}{dl('equity', 'CSV Perubahan ekuitas')}<PrintButton /></div>
        <p style={{ marginBottom: 0 }}>{checks.map(([l, ok]) => <span key={l} className={`delta ${ok ? 'pos' : 'neg'}`} style={{ marginRight: 14 }}>{ok ? '✓' : '✗'} {l}</span>)}</p>
        {data.warnings.map((w) => <p key={w} className="notice" style={{ marginBottom: 0 }}>{w}</p>)}
      </section>

      <section className="panel">
        <h2>Neraca per {shortDate(data.asOf)}</h2>
        <table className="table">
          <tbody>
            <tr><th colSpan={2}>ASET</th></tr>
            <Section s={b.assets.current} />
            <Section s={b.assets.nonCurrent} />
            <Total label="TOTAL ASET" amount={b.assets.total} />
            <tr><th colSpan={2}>KEWAJIBAN DAN EKUITAS</th></tr>
            <Section s={b.liabilities.current} />
            <Section s={b.liabilities.longTerm} />
            <tr><th colSpan={2}>Ekuitas</th></tr>
            <Rows rows={b.equity.rows} />
            <Total label="Total ekuitas" amount={b.equity.total} neg />
            <Total label="TOTAL KEWAJIBAN DAN EKUITAS" amount={b.totalLiabilitiesAndEquity} />
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Laba rugi · {shortDate(data.period.from)} – {shortDate(data.period.to)}</h2>
        <table className="table">
          <tbody>
            <tr><th colSpan={2}>Pendapatan</th></tr>
            {data.incomeStatement.revenue.map((r) => <tr key={r.account}><td><span className="mono">{r.account}</span> {r.name}</td><td className="num">{rp(r.balance)}</td></tr>)}
            <Total label="Total pendapatan bersih" amount={data.incomeStatement.totalRevenue} />
            <tr><th colSpan={2}>Beban</th></tr>
            {data.incomeStatement.expenses.map((r) => <tr key={r.account}><td><span className="mono">{r.account}</span> {r.name}</td><td className="num">{rp(r.balance)}</td></tr>)}
            <Total label="Total beban" amount={data.incomeStatement.totalExpenses} />
            <Total label="LABA (RUGI) BERSIH" amount={data.incomeStatement.netIncome} neg />
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Arus kas · {shortDate(data.period.from)} – {shortDate(data.period.to)}</h2>
        <table className="table">
          <tbody>
            <tr><td><b>Kas dan bank awal</b></td><td className="num"><b>{rp(c.openingCash)}</b></td></tr>
            <tr><th colSpan={2}>Aktivitas operasi</th></tr><Rows rows={c.operating.rows} /><Total label="Kas bersih dari operasi" amount={c.operating.total} neg />
            <tr><th colSpan={2}>Aktivitas investasi</th></tr><Rows rows={c.investing.rows} /><Total label="Kas bersih dari investasi" amount={c.investing.total} neg />
            <tr><th colSpan={2}>Aktivitas pendanaan</th></tr><Rows rows={c.financing.rows} /><Total label="Kas bersih dari pendanaan" amount={c.financing.total} neg />
            <Total label="Kenaikan (penurunan) kas bersih" amount={c.netChange} neg />
            <Total label="Kas dan bank akhir" amount={c.closingCash} />
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>Metode langsung: dihitung dari jurnal yang menyentuh Kas dan Bank, dikelompokkan menurut akun lawannya. Penjualan lewat QRIS atau platform baru menjadi kas saat dana disetor ke bank.</p>
      </section>

      <section className="panel">
        <h2>Perubahan ekuitas · {shortDate(data.period.from)} – {shortDate(data.period.to)}</h2>
        <table className="table">
          <tbody>
            <tr><td>Ekuitas awal</td><td className="num">{rp(data.equity.opening)}</td></tr>
            <tr><td>Setoran modal (penarikan/prive)</td><td className="num">{rp(data.equity.contributions)}</td></tr>
            <tr><td>Laba (rugi) periode</td><td className={`num ${data.equity.netIncome < 0 ? 'neg' : ''}`}>{rp(data.equity.netIncome)}</td></tr>
            <Total label="Ekuitas akhir" amount={data.equity.closing} neg />
          </tbody>
        </table>
      </section>
    </>
  );
}

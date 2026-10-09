import { incomeStatement, SYSTEM, trialBalance, type Account, type AccountType, type IncomeStatement, type JournalEntry } from './accounting';
import { toCsv } from './sales-export';

/**
 * Laporan keuangan lengkap dari jurnal (otomatis dari POS + manual): neraca, laba rugi, arus kas (metode langsung), dan perubahan ekuitas.
 * Murni. Semua laporan dihitung dari SATU daftar jurnal sejak awal pembukuan sampai tanggal laporan, sehingga angkanya saling cocok:
 * aset = kewajiban + ekuitas, kas akhir arus kas = kas dan bank di neraca, ekuitas akhir = ekuitas awal + modal + laba.
 */

const CASH_CODE = /^1-13\d\d$/;
/** Kas dan setara kas: akun Kas, Bank, dan akun bank tambahan (1-13xx). Piutang pembayaran digital belum kas sampai disetor. */
export const isCashAccount = (code: string): boolean => code === SYSTEM.cash || code === SYSTEM.bank || CASH_CODE.test(code);

export interface StatementRow { account: string; name: string; amount: number }
export interface BalanceSection { label: string; rows: StatementRow[]; total: number }

export interface BalanceSheet {
  asOf: string;
  assets: { current: BalanceSection; nonCurrent: BalanceSection; total: number };
  liabilities: { current: BalanceSection; longTerm: BalanceSection; total: number };
  equity: { rows: StatementRow[]; total: number };
  totalLiabilitiesAndEquity: number;
  /** Selisih aset - (kewajiban + ekuitas). Nol bila semua jurnal seimbang. */
  difference: number;
}

const sum = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0);

interface Bal { debit: number; credit: number }
function balances(entries: JournalEntry[]): Map<string, Bal> {
  const m = new Map<string, Bal>();
  for (const e of entries) for (const l of e.lines) {
    const b = m.get(l.account) ?? { debit: 0, credit: 0 };
    b.debit += l.debit;
    b.credit += l.credit;
    m.set(l.account, b);
  }
  return m;
}

const nameOf = (accounts: Account[]) => { const by = new Map(accounts.map((a) => [a.code, a])); return (code: string) => by.get(code)?.name ?? `(akun ${code} tidak ada)`; };
const typeOf = (accounts: Account[]) => { const by = new Map(accounts.map((a) => [a.code, a])); return (code: string): AccountType => by.get(code)?.type ?? 'EXPENSE'; };

/** Laba (rugi) bersih dari jurnal pada filter tanggal. */
function profit(entries: JournalEntry[], accounts: Account[]): number {
  return incomeStatement(entries, accounts).netIncome;
}

/**
 * Neraca per tanggal. `fyStart` = awal tahun buku (1 Januari): laba sebelum tanggal itu menjadi "Laba ditahan", laba dari awal tahun sampai
 * tanggal laporan menjadi "Laba tahun berjalan" (belum ada penutupan buku, jadi keduanya dihitung dari jurnal pendapatan dan beban).
 */
export function balanceSheet(entries: JournalEntry[], accounts: Account[], asOf: string, fyStart: string): BalanceSheet {
  const upTo = entries.filter((e) => e.date <= asOf);
  const bal = balances(upTo);
  const name = nameOf(accounts);
  const type = typeOf(accounts);
  const rowsOf = (t: AccountType, sign: 1 | -1, pick: (code: string) => boolean): StatementRow[] =>
    [...bal].filter(([code]) => type(code) === t && pick(code)).map(([code, b]) => ({ account: code, name: name(code), amount: sign === 1 ? b.debit - b.credit : b.credit - b.debit }))
      .filter((r) => r.amount !== 0).sort((a, b) => a.account.localeCompare(b.account));
  const current = (c: string) => c.startsWith('1-1');
  const shortTerm = (c: string) => c.startsWith('2-1');
  const section = (label: string, rows: StatementRow[]): BalanceSection => ({ label, rows, total: sum(rows) });
  const assetsCurrent = section('Aset lancar', rowsOf('ASSET', 1, current));
  const assetsFixed = section('Aset tidak lancar', rowsOf('ASSET', 1, (c) => !current(c)));
  const liabShort = section('Kewajiban jangka pendek', rowsOf('LIABILITY', -1, shortTerm));
  const liabLong = section('Kewajiban jangka panjang', rowsOf('LIABILITY', -1, (c) => !shortTerm(c)));
  const equityRows = rowsOf('EQUITY', -1, () => true);
  const retained = profit(upTo.filter((e) => e.date < fyStart), accounts);
  const currentYear = profit(upTo.filter((e) => e.date >= fyStart), accounts);
  if (retained !== 0) equityRows.push({ account: '', name: 'Laba ditahan (tahun-tahun sebelumnya)', amount: retained });
  equityRows.push({ account: '', name: 'Laba (rugi) tahun berjalan', amount: currentYear });
  const equityTotal = sum(equityRows);
  const totalAssets = assetsCurrent.total + assetsFixed.total;
  const totalLiab = liabShort.total + liabLong.total;
  return {
    asOf,
    assets: { current: assetsCurrent, nonCurrent: assetsFixed, total: totalAssets },
    liabilities: { current: liabShort, longTerm: liabLong, total: totalLiab },
    equity: { rows: equityRows, total: equityTotal },
    totalLiabilitiesAndEquity: totalLiab + equityTotal,
    difference: totalAssets - (totalLiab + equityTotal),
  };
}

export interface CashFlow {
  from: string;
  to: string;
  openingCash: number;
  operating: { rows: StatementRow[]; total: number };
  investing: { rows: StatementRow[]; total: number };
  financing: { rows: StatementRow[]; total: number };
  netChange: number;
  closingCash: number;
  /** Kas akhir dari mutasi sama dengan saldo kas dan bank menurut neraca. */
  reconciles: boolean;
}

/**
 * Arus kas metode langsung. Untuk setiap jurnal yang menyentuh kas atau bank, pengaruh kas tiap baris lawan = (kredit − debit): jumlahnya persis
 * perubahan kas jurnal itu. Baris lawan dikelompokkan menurut akunnya: pendapatan, beban, aset lancar lain, dan kewajiban jangka pendek =
 * operasi; aset tidak lancar = investasi; ekuitas dan kewajiban jangka panjang = pendanaan. Pemindahan antar kas dan bank tidak muncul.
 */
export function cashFlow(entries: JournalEntry[], accounts: Account[], from: string, to: string): CashFlow {
  const name = nameOf(accounts);
  const type = typeOf(accounts);
  const op = new Map<string, number>(); const inv = new Map<string, number>(); const fin = new Map<string, number>();
  for (const e of entries) {
    if (e.date < from || e.date > to) continue;
    if (!e.lines.some((l) => isCashAccount(l.account))) continue;
    for (const l of e.lines) {
      if (isCashAccount(l.account)) continue;
      const effect = l.credit - l.debit;
      if (effect === 0) continue;
      const t = type(l.account);
      const bucket = t === 'REVENUE' || t === 'EXPENSE' ? op
        : t === 'ASSET' ? (l.account.startsWith('1-1') ? op : inv)
        : t === 'LIABILITY' ? (l.account.startsWith('2-1') ? op : fin)
        : fin;
      bucket.set(l.account, (bucket.get(l.account) ?? 0) + effect);
    }
  }
  const rows = (m: Map<string, number>): StatementRow[] => [...m].filter(([, a]) => a !== 0).map(([account, amount]) => ({ account, name: name(account), amount })).sort((a, b) => a.account.localeCompare(b.account));
  const section = (m: Map<string, number>) => { const r = rows(m); return { rows: r, total: sum(r) }; };
  const cashAt = (pick: (e: JournalEntry) => boolean) => entries.filter(pick).reduce((s, e) => s + e.lines.filter((l) => isCashAccount(l.account)).reduce((x, l) => x + l.debit - l.credit, 0), 0);
  const openingCash = cashAt((e) => e.date < from);
  const operating = section(op); const investing = section(inv); const financing = section(fin);
  const netChange = operating.total + investing.total + financing.total;
  const closingCash = openingCash + netChange;
  return { from, to, openingCash, operating, investing, financing, netChange, closingCash, reconciles: closingCash === cashAt((e) => e.date <= to) };
}

export interface EquityStatement {
  from: string;
  to: string;
  opening: number;
  /** Setoran modal (+) dan penarikan atau prive (−) lewat akun ekuitas pada periode. */
  contributions: number;
  netIncome: number;
  closing: number;
  reconciles: boolean;
}

/** Ekuitas = aset − kewajiban pada suatu tanggal; perubahannya = mutasi akun ekuitas + laba periode. */
export function equityStatement(entries: JournalEntry[], accounts: Account[], from: string, to: string, fyStart: string): EquityStatement {
  const type = typeOf(accounts);
  const equityAt = (d: string, fy: string) => balanceSheet(entries, accounts, d, fy).equity.total;
  const dayBefore = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const opening = equityAt(dayBefore, fyStart <= dayBefore ? fyStart : `${dayBefore.slice(0, 4)}-01-01`);
  const inPeriod = entries.filter((e) => e.date >= from && e.date <= to);
  const contributions = inPeriod.reduce((s, e) => s + e.lines.filter((l) => type(l.account) === 'EQUITY').reduce((x, l) => x + l.credit - l.debit, 0), 0);
  const netIncome = profit(inPeriod, accounts);
  const closing = opening + contributions + netIncome;
  return { from, to, opening, contributions, netIncome, closing, reconciles: closing === equityAt(to, fyStart) };
}

export interface FinancialStatements {
  asOf: string;
  period: { from: string; to: string };
  fiscalYearStart: string;
  booksStart: string | null;
  balanceSheet: BalanceSheet;
  incomeStatement: IncomeStatement;
  cashFlow: CashFlow;
  equity: EquityStatement;
  trialBalanceBalanced: boolean;
  warnings: string[];
}

export function buildStatements(entries: JournalEntry[], accounts: Account[], period: { from: string; to: string }, booksStart: string | null): FinancialStatements {
  const fyStart = `${period.to.slice(0, 4)}-01-01`;
  const tb = trialBalance(entries.filter((e) => e.date <= period.to), accounts);
  const bs = balanceSheet(entries, accounts, period.to, fyStart);
  const warnings: string[] = [];
  if (bs.difference !== 0) warnings.push(`Neraca tidak seimbang (selisih Rp ${bs.difference.toLocaleString('id-ID')}): ada jurnal yang tidak seimbang atau memakai akun yang tidak ada.`);
  if (entries.length === 0) warnings.push('Belum ada jurnal sampai tanggal ini.');
  const taxPayable = bs.liabilities.current.rows.find((r) => r.account === '2-1200');
  if (taxPayable && taxPayable.amount > 0) warnings.push(`Utang PBJT Rp ${taxPayable.amount.toLocaleString('id-ID')} masih tercatat; catat penyetorannya sebagai jurnal manual (Dr Utang Pajak Restoran, Cr Bank/Kas) agar neraca mencerminkan yang sudah disetor.`);
  warnings.push('Laporan mengikuti jurnal otomatis POS dan jurnal manual. Setoran ke bank, penyusutan, dan saldo awal yang tidak lewat POS harus dicatat sebagai jurnal manual. Belum ada penutupan buku; laba tahun berjalan dihitung dari jurnal.');
  return {
    asOf: period.to, period, fiscalYearStart: fyStart, booksStart, balanceSheet: bs, incomeStatement: incomeStatement(entries.filter((e) => e.date >= period.from && e.date <= period.to), accounts),
    cashFlow: cashFlow(entries, accounts, period.from, period.to), equity: equityStatement(entries, accounts, period.from, period.to, fyStart), trialBalanceBalanced: tb.totalDebit === tb.totalCredit, warnings,
  };
}

export const STATEMENT_KINDS = ['balance', 'income', 'cashflow', 'equity'] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

/** CSV satu laporan (UTF-8 dengan BOM, aman untuk Excel). */
export function statementCsv(s: FinancialStatements, kind: StatementKind): { slug: string; csv: string } {
  const row = (label: string, amount: number | string = ''): (string | number)[] => [label, amount];
  const lines = (title: string, rows: StatementRow[], total: number): (string | number)[][] => [row(title), ...rows.map((r) => [`  ${r.account ? `${r.account} ` : ''}${r.name}`, r.amount] as (string | number)[]), row(`Total ${title.toLowerCase()}`, total)];
  let rows: (string | number)[][] = [];
  let slug = '';
  if (kind === 'balance') {
    const b = s.balanceSheet; slug = 'neraca';
    rows = [row(`Neraca per ${b.asOf}`), ...lines(b.assets.current.label, b.assets.current.rows, b.assets.current.total), ...lines(b.assets.nonCurrent.label, b.assets.nonCurrent.rows, b.assets.nonCurrent.total), row('TOTAL ASET', b.assets.total),
      ...lines(b.liabilities.current.label, b.liabilities.current.rows, b.liabilities.current.total), ...lines(b.liabilities.longTerm.label, b.liabilities.longTerm.rows, b.liabilities.longTerm.total), ...lines('Ekuitas', b.equity.rows, b.equity.total), row('TOTAL KEWAJIBAN DAN EKUITAS', b.totalLiabilitiesAndEquity)];
  } else if (kind === 'income') {
    const i = s.incomeStatement; slug = 'laba-rugi';
    rows = [row(`Laba rugi ${s.period.from} s/d ${s.period.to}`), ...lines('Pendapatan', i.revenue.map((r) => ({ account: r.account, name: r.name, amount: r.balance })), i.totalRevenue), ...lines('Beban', i.expenses.map((r) => ({ account: r.account, name: r.name, amount: r.balance })), i.totalExpenses), row('LABA (RUGI) BERSIH', i.netIncome)];
  } else if (kind === 'cashflow') {
    const c = s.cashFlow; slug = 'arus-kas';
    rows = [row(`Arus kas ${c.from} s/d ${c.to}`), row('Kas dan bank awal', c.openingCash), ...lines('Aktivitas operasi', c.operating.rows, c.operating.total), ...lines('Aktivitas investasi', c.investing.rows, c.investing.total), ...lines('Aktivitas pendanaan', c.financing.rows, c.financing.total), row('Kenaikan (penurunan) kas bersih', c.netChange), row('Kas dan bank akhir', c.closingCash)];
  } else {
    const e = s.equity; slug = 'perubahan-ekuitas';
    rows = [row(`Perubahan ekuitas ${e.from} s/d ${e.to}`), row('Ekuitas awal', e.opening), row('Setoran modal (penarikan)', e.contributions), row('Laba (rugi) periode', e.netIncome), row('Ekuitas akhir', e.closing)];
  }
  return { slug, csv: toCsv({ header: ['Keterangan', 'Jumlah (Rp)'], rows }) };
}

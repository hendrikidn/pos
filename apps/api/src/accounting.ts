import { correctedTime, type EventOf, type PosEvent } from '@pos/events';
import { addDays, DAY_MS, localDate, type SalesReportInput } from './sales-report';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

export interface Account {
  code: string;
  name: string;
  type: AccountType;
  /** Sisi saldo normal. Akun kontra (diskon, retur) bertipe REVENUE tetapi bersaldo normal debit. */
  normal: 'DEBIT' | 'CREDIT';
}

/** Kode akun untuk jurnal otomatis dari POS. Bagan akun tenant boleh diubah, tetapi kode-kode ini harus tetap ada dan aktif. */
export const SYSTEM = {
  cash: '1-1100',
  digital: '1-1200',
  platform: '1-1210',
  bank: '1-1300',
  inventory: '1-1400',
  payable: '2-1100',
  commission: '6-5100',
  sales: '4-1000',
  service: '4-1100',
  discount: '4-2000',
  returns: '4-3000',
  rounding: '4-9000',
  taxPayable: '2-1200',
  cashShortage: '6-9000',
} as const;

export const DEFAULT_ACCOUNTS: Account[] = [
  { code: '1-1100', name: 'Kas', type: 'ASSET', normal: 'DEBIT' },
  { code: '1-1200', name: 'Piutang Pembayaran Digital (QRIS dan kartu)', type: 'ASSET', normal: 'DEBIT' },
  { code: '1-1210', name: 'Piutang Platform Pesan-Antar', type: 'ASSET', normal: 'DEBIT' },
  { code: '1-1300', name: 'Bank', type: 'ASSET', normal: 'DEBIT' },
  { code: '1-1400', name: 'Persediaan Bahan Baku', type: 'ASSET', normal: 'DEBIT' },
  { code: '2-1100', name: 'Utang Usaha', type: 'LIABILITY', normal: 'CREDIT' },
  { code: '2-1200', name: 'Utang Pajak Restoran (PBJT)', type: 'LIABILITY', normal: 'CREDIT' },
  { code: '3-1000', name: 'Modal Pemilik', type: 'EQUITY', normal: 'CREDIT' },
  { code: '3-2000', name: 'Laba Ditahan', type: 'EQUITY', normal: 'CREDIT' },
  { code: '4-1000', name: 'Penjualan', type: 'REVENUE', normal: 'CREDIT' },
  { code: '4-1100', name: 'Pendapatan Service Charge', type: 'REVENUE', normal: 'CREDIT' },
  { code: '4-2000', name: 'Diskon Penjualan', type: 'REVENUE', normal: 'DEBIT' },
  { code: '4-3000', name: 'Retur Penjualan', type: 'REVENUE', normal: 'DEBIT' },
  { code: '4-9000', name: 'Selisih Pembulatan', type: 'REVENUE', normal: 'CREDIT' },
  { code: '5-1000', name: 'Beban Bahan Baku (HPP)', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '6-1000', name: 'Beban Gaji dan Upah', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '6-2000', name: 'Beban Sewa', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '6-3000', name: 'Beban Listrik, Air, dan Gas', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '6-4000', name: 'Beban Operasional Lain', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '6-5100', name: 'Beban Komisi Platform Pesan-Antar', type: 'EXPENSE', normal: 'DEBIT' },
  { code: '6-9000', name: 'Selisih Kas', type: 'EXPENSE', normal: 'DEBIT' },
];

export interface JournalLine {
  account: string;
  debit: number;
  credit: number;
}

export interface JournalEntry {
  /** Nomor bukti: JU-POS-<outlet>-<tanggal> untuk jurnal otomatis, JM-<n> untuk manual. */
  ref: string;
  date: string;
  memo: string;
  source: 'POS' | 'MANUAL';
  lines: JournalLine[];
  /** Catatan yang perlu diketahui pembaca (mis. order tanpa rincian pajak). */
  notes?: string[];
}

export const sumDebit = (lines: JournalLine[]) => lines.reduce((s, l) => s + l.debit, 0);
export const sumCredit = (lines: JournalLine[]) => lines.reduce((s, l) => s + l.credit, 0);

/** Memeriksa jurnal manual: pesan kesalahan atau null. Jurnal harus seimbang dan setiap baris tepat satu sisi bernilai bulat positif. */
export function checkJournalLines(lines: unknown, accounts: Map<string, { active: boolean }>): string | null {
  if (!Array.isArray(lines) || lines.length < 2) return 'jurnal minimal dua baris';
  if (lines.length > 30) return 'jurnal maksimal 30 baris';
  let d = 0;
  let c = 0;
  for (const [i, raw] of lines.entries()) {
    const l = raw as Partial<JournalLine> | null;
    if (typeof l !== 'object' || l === null) return `baris ${i + 1} tidak valid`;
    const acc = typeof l.account === 'string' ? accounts.get(l.account) : undefined;
    if (!acc) return `baris ${i + 1}: akun ${String(l.account)} tidak ada`;
    if (!acc.active) return `baris ${i + 1}: akun ${l.account} tidak aktif`;
    const debit = l.debit ?? 0;
    const credit = l.credit ?? 0;
    if (!Number.isInteger(debit) || !Number.isInteger(credit) || debit < 0 || credit < 0 || debit > 100_000_000_000 || credit > 100_000_000_000) return `baris ${i + 1}: nominal harus bilangan bulat rupiah ≥ 0`;
    if ((debit > 0) === (credit > 0)) return `baris ${i + 1}: isi salah satu, debit atau kredit`;
    d += debit;
    c += credit;
  }
  if (d !== c) return `jurnal tidak seimbang: debit ${d}, kredit ${c}`;
  return null;
}

const METHOD_ACCOUNT = { CASH: SYSTEM.cash, QRIS: SYSTEM.digital, EDC_DEBIT: SYSTEM.digital, EDC_CREDIT: SYSTEM.digital, PLATFORM: SYSTEM.platform } as const;

/** Jenis event yang dibutuhkan jurnal penjualan. */
export const JOURNAL_EVENT_TYPES = ['payment.received', 'refund.created', 'order.created', 'bill.printed', 'cash.counted'];

/**
 * Jurnal penjualan harian dari event POS (satu jurnal per hari yang ada kejadiannya), memakai aturan yang sama dengan laporan penjualan:
 * order karyawan dan order yang di-void tidak dihitung; satu order dibukukan pada hari pembayaran pertamanya.
 *  - Order dengan rincian tagihan lengkap dan lunas: Dr Kas/Piutang digital; Cr Penjualan (subtotal), Cr Service, Cr Utang PBJT; Dr Diskon;
 *    selisih pembulatan ke akun pembulatan.
 *  - Order tanpa rincian (terminal lama) atau baru terbayar sebagian: seluruh penerimaan dibukukan sebagai Penjualan dan diberi catatan.
 *  - Refund: Dr Retur Penjualan, Cr Kas/Piutang digital menurut metodenya.
 *  - Hitung kas saat tutup shift: kekurangan Dr Selisih Kas / Cr Kas; kelebihan sebaliknya (angka server bila terverifikasi).
 * Murni dan selalu seimbang.
 */
export function buildSalesJournal(input: SalesReportInput & { outletId: string }): JournalEntry[] {
  const { fromMs, toMs, utcOffsetMinutes: off, now } = input;
  const t = correctedTime;
  const events = input.events.filter((e) => t(e) <= now + DAY_MS);
  const inRange = (e: PosEvent) => t(e) >= fromMs && t(e) < toMs;
  const sorted = [...events].sort((a, b) => t(a) - t(b) || a.deviceId.localeCompare(b.deviceId) || a.seq - b.seq);

  const employee = new Set<string>();
  const voided = new Set<string>();
  const bill = new Map<string, EventOf<'bill.printed'>>();
  const payments = new Map<string, EventOf<'payment.received'>[]>();
  for (const e of sorted) {
    if (e.type === 'order.created' && e.payload.orderType === 'EMPLOYEE') employee.add(e.payload.orderId);
    else if (e.type === 'void.approved') voided.add(e.payload.orderId);
    else if (e.type === 'bill.printed') bill.set(e.payload.orderId, e);
    else if (e.type === 'payment.received') (payments.get(e.payload.orderId) ?? payments.set(e.payload.orderId, []).get(e.payload.orderId)!).push(e);
  }
  const counts = (id: string) => !employee.has(id) && !voided.has(id);

  const days = new Map<string, { lines: Map<string, JournalLine>; notes: Set<string> }>();
  const day = (date: string) => {
    let d = days.get(date);
    if (!d) days.set(date, (d = { lines: new Map(), notes: new Set() }));
    return d;
  };
  const post = (date: string, account: string, debit: number, credit: number) => {
    if (debit === 0 && credit === 0) return;
    const d = day(date);
    const l = d.lines.get(account) ?? { account, debit: 0, credit: 0 };
    l.debit += debit;
    l.credit += credit;
    d.lines.set(account, l);
  };

  // ---- penjualan: order terhitung pada hari pembayaran pertamanya di rentang ----
  for (const [id, list] of payments) {
    const first = list.find(inRange);
    if (!first || !counts(id)) continue;
    const date = localDate(t(first), off);
    const paid = list.reduce((s, p) => s + p.payload.amount, 0);
    for (const p of list) post(date, METHOD_ACCOUNT[p.payload.method], p.payload.amount, 0);
    const b = bill.get(id)?.payload;
    const bd = b?.breakdown;
    if (bd && b && paid === b.total) {
      post(date, SYSTEM.sales, 0, bd.subtotal);
      post(date, SYSTEM.discount, bd.discount, 0);
      post(date, SYSTEM.service, 0, bd.service);
      post(date, SYSTEM.taxPayable, 0, bd.tax);
      post(date, SYSTEM.rounding, bd.rounding < 0 ? -bd.rounding : 0, bd.rounding > 0 ? bd.rounding : 0);
    } else {
      post(date, SYSTEM.sales, 0, paid);
      day(date).notes.add(bd ? 'ada order yang baru terbayar sebagian: seluruh penerimaan dibukukan sebagai Penjualan' : 'ada order tanpa rincian tagihan (terminal versi lama): pajak dan service tidak dipisah');
    }
  }

  // ---- refund dan selisih kas ----
  const checks = new Map((input.cashChecks ?? []).map((c) => [`${c.deviceId}#${c.seq}`, c]));
  for (const e of sorted) {
    if (!inRange(e)) continue;
    const date = localDate(t(e), off);
    if (e.type === 'refund.created' && counts(e.payload.originalOrderId)) {
      post(date, SYSTEM.returns, e.payload.amount, 0);
      post(date, METHOD_ACCOUNT[e.payload.method], 0, e.payload.amount);
    } else if (e.type === 'cash.counted') {
      const c = checks.get(`${e.deviceId}#${e.seq}`);
      const diff = e.payload.counted - (c ? c.serverExpected : e.payload.expected);
      if (diff < 0) { post(date, SYSTEM.cashShortage, -diff, 0); post(date, SYSTEM.cash, 0, -diff); }
      else if (diff > 0) { post(date, SYSTEM.cash, diff, 0); post(date, SYSTEM.cashShortage, 0, diff); }
    }
  }

  const out: JournalEntry[] = [];
  for (let d = input.from; d <= input.to; d = addDays(d, 1)) {
    const x = days.get(d);
    if (!x) continue;
    const lines = [...x.lines.values()].sort((a, b) => a.account.localeCompare(b.account));
    // Pembulatan yang saling meniadakan dan baris nol tidak perlu tampil.
    const nonZero = lines.filter((l) => l.debit !== 0 || l.credit !== 0);
    if (nonZero.length === 0) continue;
    out.push({ ref: `JU-POS-${input.outletId}-${d.replace(/-/g, '')}`, date: d, memo: `Penjualan POS ${d}`, source: 'POS', lines: nonZero, ...(x.notes.size > 0 ? { notes: [...x.notes] } : {}) });
  }
  return out;
}

/**
 * Jurnal penyelesaian platform pesan-antar dari laporan platform yang diunggah, per hari pesanan: piutang platform dilunasi (Cr) oleh dana
 * bersih yang diterima di bank (Dr) dan komisi (Dr beban). Pesanan online di POS sudah menambah piutang platform lewat pembayaran "Platform".
 */
export function buildChannelJournal(rows: { date: string; gross: number; commission: number; net: number }[], outletId: string): JournalEntry[] {
  const byDay = new Map<string, { gross: number; commission: number; net: number; n: number }>();
  for (const r of rows) {
    const d = byDay.get(r.date) ?? { gross: 0, commission: 0, net: 0, n: 0 };
    d.gross += r.gross; d.commission += r.commission; d.net += r.net; d.n++;
    byDay.set(r.date, d);
  }
  return [...byDay].sort((a, b) => a[0].localeCompare(b[0])).map(([date, d]) => {
    // Bila gross ≠ net + komisi (potongan lain dari platform), selisihnya ikut sebagai beban komisi agar jurnal tetap seimbang.
    const fee = d.gross - d.net;
    const lines: JournalLine[] = [
      { account: SYSTEM.platform, debit: 0, credit: d.gross },
      { account: SYSTEM.bank, debit: d.net, credit: 0 },
      { account: SYSTEM.commission, debit: fee, credit: 0 },
    ].filter((l) => l.debit !== 0 || l.credit !== 0);
    return { ref: `JU-PLT-${outletId}-${date.replace(/-/g, '')}`, date, memo: `Penyelesaian platform pesan-antar ${date} (${d.n} pesanan)`, source: 'POS' as const, lines, ...(fee !== d.commission ? { notes: ['potongan platform tidak sama dengan komisi yang tercantum; selisihnya dibukukan sebagai beban komisi'] } : {}) };
  });
}

/**
 * Jurnal pengadaan: penerimaan barang menambah persediaan dan utang usaha (Dr Persediaan, Cr Utang Usaha); pembayaran supplier melunasi utang
 * (Dr Utang Usaha, Cr Kas untuk tunai atau Bank untuk transfer). Satu jurnal per penerimaan dan per pembayaran.
 */
export function buildPurchaseJournal(
  receipts: { id: number; date: string; amount: number; invoiceRef: string | null; supplier: string }[],
  payments: { id: number; date: string; amount: number; method: 'TUNAI' | 'TRANSFER'; supplier: string }[],
): JournalEntry[] {
  return [
    ...receipts.filter((r) => r.amount > 0).map((r): JournalEntry => ({
      ref: `JU-BELI-${r.id}`, date: r.date, memo: `Pembelian dari ${r.supplier}${r.invoiceRef ? ` (faktur ${r.invoiceRef})` : ''}`, source: 'POS',
      lines: [{ account: SYSTEM.inventory, debit: r.amount, credit: 0 }, { account: SYSTEM.payable, debit: 0, credit: r.amount }],
    })),
    ...payments.map((p): JournalEntry => ({
      ref: `JU-BAYAR-${p.id}`, date: p.date, memo: `Pembayaran ke ${p.supplier}`, source: 'POS',
      lines: [{ account: SYSTEM.payable, debit: p.amount, credit: 0 }, { account: p.method === 'TUNAI' ? SYSTEM.cash : SYSTEM.bank, debit: 0, credit: p.amount }],
    })),
  ];
}

export interface TrialRow {
  account: string;
  name: string;
  type: AccountType;
  debit: number;
  credit: number;
  /** Saldo menurut sisi normal akun (negatif bila berlawanan). */
  balance: number;
}

/** Neraca saldo: total debit dan kredit per akun sampai semua jurnal yang diberikan. Akun tanpa mutasi tidak ditampilkan. */
export function trialBalance(entries: JournalEntry[], accounts: Account[]): { rows: TrialRow[]; totalDebit: number; totalCredit: number } {
  const by = new Map(accounts.map((a) => [a.code, a]));
  const tot = new Map<string, { debit: number; credit: number }>();
  for (const e of entries) for (const l of e.lines) {
    const t = tot.get(l.account) ?? { debit: 0, credit: 0 };
    t.debit += l.debit;
    t.credit += l.credit;
    tot.set(l.account, t);
  }
  const rows = [...tot].map(([code, t]) => {
    const a = by.get(code) ?? { code, name: `(akun ${code} tidak ada)`, type: 'EXPENSE' as AccountType, normal: 'DEBIT' as const };
    return { account: code, name: a.name, type: a.type, debit: t.debit, credit: t.credit, balance: a.normal === 'DEBIT' ? t.debit - t.credit : t.credit - t.debit };
  }).sort((a, b) => a.account.localeCompare(b.account));
  return { rows, totalDebit: rows.reduce((s, r) => s + r.debit, 0), totalCredit: rows.reduce((s, r) => s + r.credit, 0) };
}

export interface IncomeStatement {
  revenue: TrialRow[];
  expenses: TrialRow[];
  totalRevenue: number;
  totalExpenses: number;
  netIncome: number;
}

/** Laba rugi dari mutasi akun pendapatan dan beban (akun kontra seperti diskon dan retur mengurangi pendapatan lewat saldo normalnya). */
export function incomeStatement(entries: JournalEntry[], accounts: Account[]): IncomeStatement {
  const { rows } = trialBalance(entries, accounts);
  // Pendapatan: saldo kredit bersih; akun kontra debit-normal mengurangi, jadi pakai (kredit − debit) untuk semuanya.
  const revenue = rows.filter((r) => r.type === 'REVENUE').map((r) => ({ ...r, balance: r.credit - r.debit }));
  const expenses = rows.filter((r) => r.type === 'EXPENSE').map((r) => ({ ...r, balance: r.debit - r.credit }));
  const totalRevenue = revenue.reduce((s, r) => s + r.balance, 0);
  const totalExpenses = expenses.reduce((s, r) => s + r.balance, 0);
  return { revenue, expenses, totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses };
}

export interface LedgerLine {
  date: string;
  ref: string;
  memo: string;
  debit: number;
  credit: number;
  balance: number;
}

/** Buku besar satu akun: mutasi berurutan tanggal dengan saldo berjalan menurut sisi normal akun. */
export function ledger(entries: JournalEntry[], account: Account): LedgerLine[] {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  let bal = 0;
  const out: LedgerLine[] = [];
  for (const e of sorted) {
    for (const l of e.lines) {
      if (l.account !== account.code) continue;
      bal += account.normal === 'DEBIT' ? l.debit - l.credit : l.credit - l.debit;
      out.push({ date: e.date, ref: e.ref, memo: e.memo, debit: l.debit, credit: l.credit, balance: bal });
    }
  }
  return out;
}

/** CSV jurnal dalam bentuk umum untuk diimpor ke perangkat lunak akuntansi: satu baris per baris jurnal. */
export function journalCsvRows(entries: JournalEntry[], accounts: Account[]): { header: string[]; rows: (string | number)[][] } {
  const names = new Map(accounts.map((a) => [a.code, a.name]));
  return {
    header: ['Tanggal', 'No Bukti', 'Kode Akun', 'Nama Akun', 'Debit', 'Kredit', 'Memo'],
    rows: [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref)).flatMap((e) =>
      e.lines.map((l) => [e.date, e.ref, l.account, names.get(l.account) ?? '', l.debit, l.credit, e.memo]),
    ),
  };
}

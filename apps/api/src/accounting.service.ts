import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiAuth } from './auth';
import {
  buildChannelJournal, buildCogsJournal, buildDepositJournal, buildPayrollJournal, buildPurchaseJournal, buildSalesJournal, checkJournalLines, DEFAULT_ACCOUNTS, incomeStatement, JOURNAL_EVENT_TYPES, journalCsvRows, ledger, SYSTEM, trialBalance,
  type Account, type AccountType, type JournalEntry,
} from './accounting';
import { loadCashChecks, verifyPendingCashCounts } from './cash-check';
import { buildStatements, statementCsv, STATEMENT_KINDS, type FinancialStatements, type StatementKind } from './financial-statements';
import { Database } from './db/database';
import { ReservationService } from './reservation.service';
import type { Queryable } from './db/driver';
import { EVENT_COLUMNS, rowToEvent, type EventRow } from './guard.service';
import { resolveRange } from './report-range';
import { toCsv } from './sales-export';
import { addDays, DAY_MS, localDate, startOfLocalDay } from './sales-report';
import { StockService } from './stock.service';

const CODE_RE = /^[0-9]-[0-9]{4}$/;
const TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];
const SYSTEM_CODES = new Set<string>(Object.values(SYSTEM));
const DEFAULT_NORMAL: Record<AccountType, 'DEBIT' | 'CREDIT'> = { ASSET: 'DEBIT', EXPENSE: 'DEBIT', LIABILITY: 'CREDIT', EQUITY: 'CREDIT', REVENUE: 'CREDIT' };

interface Range { from?: string; to?: string; range?: string }

@Injectable()
export class AccountingService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(ReservationService) private readonly reservations: ReservationService,
  ) {}

  /** Bagan akun tenant; diisi dari bawaan pada pemakaian pertama. */
  private async accounts(q: Queryable, tenantId: string): Promise<(Account & { active: boolean })[]> {
    const read = async () => (await q.query<Account & { active: boolean }>('select code, name, type, normal, active from account order by code')).rows;
    let rows = await read();
    if (rows.length === 0) {
      for (const a of DEFAULT_ACCOUNTS) {
        await q.query('insert into account (tenant_id, code, name, type, normal) values ($1, $2, $3, $4, $5) on conflict do nothing', [tenantId, a.code, a.name, a.type, a.normal]);
      }
      rows = await read();
    }
    // Akun sistem yang ditambahkan setelah bagan akun tenant dibuat (mis. piutang platform) dilengkapi otomatis.
    const have = new Set(rows.map((r) => r.code));
    const missing = DEFAULT_ACCOUNTS.filter((a) => SYSTEM_CODES.has(a.code) && !have.has(a.code));
    if (missing.length > 0) {
      for (const a of missing) await q.query('insert into account (tenant_id, code, name, type, normal) values ($1, $2, $3, $4, $5) on conflict do nothing', [tenantId, a.code, a.name, a.type, a.normal]);
      rows = await read();
    }
    return rows;
  }

  listAccounts(auth: ApiAuth) {
    return this.db.tenantTx(auth.tenantId, (q) => this.accounts(q, auth.tenantId));
  }

  async createAccount(auth: ApiAuth, input: { code?: unknown; name?: unknown; type?: unknown; normal?: unknown }): Promise<void> {
    if (typeof input.code !== 'string' || !CODE_RE.test(input.code)) throw new BadRequestException('kode akun berbentuk 1-1100 (satu digit, tanda hubung, empat digit)');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 2 || name.length > 80) throw new BadRequestException('nama akun wajib (2–80 karakter)');
    if (typeof input.type !== 'string' || !TYPES.includes(input.type as AccountType)) throw new BadRequestException(`jenis akun harus salah satu dari ${TYPES.join(', ')}`);
    const type = input.type as AccountType;
    if (input.normal !== undefined && input.normal !== 'DEBIT' && input.normal !== 'CREDIT') throw new BadRequestException('saldo normal harus DEBIT atau CREDIT');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      await this.accounts(q, auth.tenantId);
      if ((await q.query('select 1 from account where code = $1', [input.code])).rowCount > 0) throw new ConflictException('kode akun sudah dipakai');
      await q.query('insert into account (tenant_id, code, name, type, normal) values ($1, $2, $3, $4, $5)', [auth.tenantId, input.code, name, type, input.normal ?? DEFAULT_NORMAL[type]]);
      await this.audit(q, auth, 'account.create', { code: input.code, type });
    });
  }

  async updateAccount(auth: ApiAuth, code: string, input: { name?: unknown; active?: unknown }): Promise<void> {
    const name = input.name === undefined ? null : typeof input.name === 'string' && input.name.trim().length >= 2 && input.name.length <= 80 ? input.name.trim() : (() => { throw new BadRequestException('nama akun wajib (2–80 karakter)'); })();
    if (input.active !== undefined && typeof input.active !== 'boolean') throw new BadRequestException('active harus true atau false');
    if (input.active === false && SYSTEM_CODES.has(code)) throw new ConflictException('akun ini dipakai jurnal otomatis POS dan tidak boleh dinonaktifkan');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      await this.accounts(q, auth.tenantId);
      const r = await q.query('update account set name = coalesce($2, name), active = coalesce($3, active) where code = $1', [code, name, input.active ?? null]);
      if (r.rowCount === 0) throw new NotFoundException('akun tidak ditemukan');
      await this.audit(q, auth, 'account.update', { code, fields: Object.keys(input) });
    });
  }

  async createEntry(auth: ApiAuth, outletId: string, input: { date?: unknown; memo?: unknown; lines?: unknown }, now: number): Promise<{ id: number; ref: string }> {
    const memo = typeof input.memo === 'string' ? input.memo.trim() : '';
    if (memo.length < 3 || memo.length > 120) throw new BadRequestException('keterangan jurnal wajib (3–120 karakter)');
    const { today } = await this.outletRange(auth, outletId, {}, now);
    if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(`${input.date}T00:00:00Z`))) throw new BadRequestException('tanggal harus YYYY-MM-DD');
    if (input.date > today) throw new BadRequestException('tanggal jurnal tidak boleh di masa depan');
    if (input.date < '2020-01-01') throw new BadRequestException('tanggal jurnal terlalu lama');
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const accs = new Map((await this.accounts(q, auth.tenantId)).map((a) => [a.code, a]));
      const err = checkJournalLines(input.lines, accs);
      if (err) throw new BadRequestException(err);
      const lines = input.lines as { account: string; debit?: number; credit?: number }[];
      const id = Number((await q.query<{ id: string }>('insert into journal_entry (tenant_id, outlet_id, date, memo, created_by) values ($1, $2, $3, $4, $5) returning id', [auth.tenantId, outletId, input.date, memo, auth.userId])).rows[0]!.id);
      for (const [i, l] of lines.entries()) {
        await q.query('insert into journal_line (tenant_id, entry_id, line_no, account, debit, credit) values ($1, $2, $3, $4, $5, $6)', [auth.tenantId, id, i + 1, l.account, l.debit ?? 0, l.credit ?? 0]);
      }
      await this.audit(q, auth, 'journal.create', { id, outletId, date: input.date, total: lines.reduce((s, l) => s + (l.debit ?? 0), 0) });
      return { id, ref: `JM-${id}` };
    });
  }

  async voidEntry(auth: ApiAuth, outletId: string, id: number, reason: unknown): Promise<void> {
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (why.length < 3 || why.length > 200) throw new BadRequestException('alasan pembatalan wajib (3–200 karakter)');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const e = (await q.query<{ voided_at: string | null }>('select voided_at from journal_entry where id = $1 and outlet_id = $2', [id, outletId])).rows[0];
      if (!e) throw new NotFoundException('jurnal tidak ditemukan');
      if (e.voided_at) throw new ConflictException('jurnal ini sudah dibatalkan');
      await q.query('update journal_entry set voided_at = now(), void_reason = $2 where id = $1', [id, why]);
      await this.audit(q, auth, 'journal.void', { id, outletId, reason: why });
    });
  }

  private audit(q: Queryable, auth: ApiAuth, action: string, detail: object) {
    return q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [auth.tenantId, auth.userId, action, JSON.stringify(detail)]);
  }

  private async outletRange(auth: ApiAuth, outletId: string, params: Range, now: number) {
    const o = (await this.db.tenantTx(auth.tenantId, (q) => q.query<{ utc_offset_minutes: number }>('select utc_offset_minutes from outlet where id = $1', [outletId]))).rows[0];
    if (!o) throw new NotFoundException('outlet tidak ditemukan');
    return { off: o.utc_offset_minutes, ...resolveRange(o.utc_offset_minutes, params, now) };
  }

  /** Semua jurnal outlet pada rentang: jurnal penjualan POS (dihitung dari event) dan jurnal manual yang tidak dibatalkan. */
  private async entries(q: Queryable, auth: ApiAuth, outletId: string, r: { off: number; from: string; to: string }, now: number): Promise<JournalEntry[]> {
    const fromMs = startOfLocalDay(r.from, r.off);
    const toMs = startOfLocalDay(r.to, r.off) + DAY_MS;
    const rows = (
      await q.query<EventRow>(
        `select ${EVENT_COLUMNS} from event where outlet_id = $1 and device_time_ms >= $2 and device_time_ms < $3 and type = any($4::text[]) order by device_id, seq`,
        [outletId, fromMs - 2 * DAY_MS, toMs + DAY_MS, JOURNAL_EVENT_TYPES],
      )
    ).rows;
    const voids = (
      await q.query<EventRow>(
        `select ${EVENT_COLUMNS} from event where outlet_id = $1 and type = 'void.approved' and device_time_ms >= $2 and device_time_ms < $3 order by device_id, seq`,
        [outletId, fromMs - DAY_MS, Math.max(toMs, now) + DAY_MS],
      )
    ).rows;
    await verifyPendingCashCounts(q, auth.tenantId, outletId, fromMs - 2 * DAY_MS, now);
    const auto = buildSalesJournal({
      events: [...rows, ...voids].map(rowToEvent), from: r.from, to: r.to, utcOffsetMinutes: r.off, now, fromMs, toMs, outletId, cashChecks: await loadCashChecks(q, outletId),
    });
    const manual = (
      await q.query<{ id: string; date: string; memo: string; account: string; debit: string; credit: string }>(
        `select e.id, e.date, e.memo, l.account, l.debit, l.credit from journal_entry e join journal_line l on l.entry_id = e.id
         where e.outlet_id = $1 and e.voided_at is null and e.date >= $2 and e.date <= $3 order by e.id, l.line_no`,
        [outletId, r.from, r.to],
      )
    ).rows;
    const byId = new Map<string, JournalEntry>();
    for (const m of manual) {
      const e = byId.get(m.id) ?? { ref: `JM-${m.id}`, date: m.date, memo: m.memo, source: 'MANUAL' as const, lines: [] };
      e.lines.push({ account: m.account, debit: Number(m.debit), credit: Number(m.credit) });
      byId.set(m.id, e);
    }
    const platform = (
      await q.query<{ date: string; gross: number; commission: number; net: number }>('select date, gross, commission, net from channel_order where outlet_id = $1 and date >= $2 and date <= $3', [outletId, r.from, r.to])
    ).rows;
    const receipts = (
      await q.query<{ id: string; received_at_ms: number; amount: string; invoice_ref: string | null; supplier: string }>(
        `select r.id, r.received_at_ms, r.amount, r.invoice_ref, s.name as supplier from purchase_receipt r join supplier s on s.tenant_id = r.tenant_id and s.id = r.supplier_id
         where r.outlet_id = $1 and r.received_at_ms >= $2 and r.received_at_ms < $3`, [outletId, fromMs, toMs],
      )
    ).rows.map((x) => ({ id: Number(x.id), date: localDate(Number(x.received_at_ms), r.off), amount: Number(x.amount), invoiceRef: x.invoice_ref, supplier: x.supplier }));
    const payments = (
      await q.query<{ id: string; paid_date: string; amount: string; method: 'TUNAI' | 'TRANSFER'; supplier: string }>(
        `select p.id, p.paid_date, p.amount, p.method, s.name as supplier from supplier_payment p join supplier s on s.tenant_id = p.tenant_id and s.id = p.supplier_id
         where p.outlet_id = $1 and p.paid_date >= $2 and p.paid_date <= $3`, [outletId, r.from, r.to],
      )
    ).rows.map((x) => ({ id: Number(x.id), date: x.paid_date, amount: Number(x.amount), method: x.method, supplier: x.supplier }));
    // HPP: pemakaian bahan menurut resep (hanya outlet yang sudah punya hitung fisik awal, seperti modul stok).
    const dayStarts: { date: string; fromMs: number; toMs: number }[] = [];
    for (let d = r.from; d <= r.to; d = addDays(d, 1)) dayStarts.push({ date: d, fromMs: startOfLocalDay(d, r.off) - 1, toMs: startOfLocalDay(d, r.off) + DAY_MS - 1 });
    const cogs = await this.stock.cogsByDay(q, outletId, dayStarts, now);
    const payroll = (
      await q.query<{ id: string; paid_date: string; pay_method: 'TUNAI' | 'TRANSFER'; period_start: string; period_end: string; total: string; pph21: string; bpjs_emp: string; bpjs_er: string }>(
        `select r.id, r.paid_date, r.pay_method, r.period_start, r.period_end,
                coalesce((select sum(net) from payroll_line l where l.run_id = r.id), 0) as total,
                coalesce((select sum(pph21) from payroll_line l where l.run_id = r.id), 0) as pph21,
                coalesce((select sum(bpjs_jht_employee + bpjs_jp_employee + bpjs_kes_employee) from payroll_line l where l.run_id = r.id), 0) as bpjs_emp,
                coalesce((select sum(bpjs_jht_employer + bpjs_jp_employer + bpjs_jkk_employer + bpjs_jkm_employer + bpjs_kes_employer) from payroll_line l where l.run_id = r.id), 0) as bpjs_er
         from payroll_run r where r.outlet_id = $1 and r.status = 'PAID' and r.paid_date >= $2 and r.paid_date <= $3`, [outletId, r.from, r.to],
      )
    ).rows.map((x) => ({ id: Number(x.id), paidDate: x.paid_date, total: Number(x.total), method: x.pay_method, from: x.period_start, to: x.period_end, pph21: Number(x.pph21), bpjsEmployee: Number(x.bpjs_emp), bpjsEmployer: Number(x.bpjs_er) }));
    const deposits = buildDepositJournal(
      (await this.reservations.journalRows(q, outletId, fromMs, toMs)).map((d) => ({
        id: d.id, guest: d.guest, deposit: d.deposit, method: d.method,
        depositAt: localDate(d.depositAt, r.off), settle: d.settle ? { kind: d.settle.kind, amount: d.settle.amount, at: localDate(d.settle.at, r.off) } : null,
      })),
    ).filter((e) => e.date >= r.from && e.date <= r.to);
    return [...auto, ...deposits, ...buildPayrollJournal(payroll), ...buildCogsJournal(cogs.days, outletId, cogs.missing), ...buildChannelJournal(platform, outletId), ...buildPurchaseJournal(receipts, payments), ...byId.values()].sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  }

  /** Jurnal outlet pada rentang, ditambah daftar jurnal manual (termasuk yang dibatalkan) untuk pengelolaan. */
  async journal(auth: ApiAuth, outletId: string, params: Range, now: number) {
    const r = await this.outletRange(auth, outletId, params, now);
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const accounts = await this.accounts(q, auth.tenantId);
      const entries = await this.entries(q, auth, outletId, r, now);
      const manual = (
        await q.query<{ id: string; date: string; memo: string; created_by: string; voided_at: string | null; void_reason: string | null }>(
          'select id, date, memo, created_by, voided_at, void_reason from journal_entry where outlet_id = $1 and date >= $2 and date <= $3 order by id desc', [outletId, r.from, r.to],
        )
      ).rows.map((m) => ({ id: Number(m.id), ref: `JM-${m.id}`, date: m.date, memo: m.memo, createdBy: m.created_by, voided: m.voided_at !== null, voidReason: m.void_reason }));
      return { range: { from: r.from, to: r.to }, accounts, entries, manual };
    });
  }

  async reports(auth: ApiAuth, outletId: string, params: Range, now: number) {
    const r = await this.outletRange(auth, outletId, params, now);
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const accounts = await this.accounts(q, auth.tenantId);
      const entries = await this.entries(q, auth, outletId, r, now);
      return { range: { from: r.from, to: r.to }, trialBalance: trialBalance(entries, accounts), incomeStatement: incomeStatement(entries, accounts) };
    });
  }

  async ledger(auth: ApiAuth, outletId: string, code: string, params: Range, now: number) {
    const r = await this.outletRange(auth, outletId, params, now);
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const account = (await this.accounts(q, auth.tenantId)).find((a) => a.code === code);
      if (!account) throw new NotFoundException('akun tidak ditemukan');
      return { range: { from: r.from, to: r.to }, account, lines: ledger(await this.entries(q, auth, outletId, r, now), account) };
    });
  }

  async exportCsv(auth: ApiAuth, outletId: string, params: Range, now: number): Promise<{ filename: string; csv: string }> {
    const r = await this.outletRange(auth, outletId, params, now);
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const accounts = await this.accounts(q, auth.tenantId);
      const table = journalCsvRows(await this.entries(q, auth, outletId, r, now), accounts);
      await this.audit(q, auth, 'export.journal', { outletId, from: r.from, to: r.to, rows: table.rows.length });
      return { filename: `${outletId}-jurnal-${r.from}_${r.to}.csv`, csv: toCsv(table) };
    });
  }

  /** Awal pembukuan satu outlet: tanggal lokal tertua di antara event penjualan, jurnal manual, pesanan platform, pembelian, dan penggajian. */
  private async booksStart(q: Queryable, outletId: string, off: number): Promise<string | null> {
    const dates: string[] = [];
    const ev = (await q.query<{ t: number | null }>('select min(device_time_ms) as t from event where outlet_id = $1 and type = any($2::text[])', [outletId, JOURNAL_EVENT_TYPES])).rows[0]?.t;
    if (ev !== null && ev !== undefined) dates.push(localDate(Number(ev), off));
    const one = async (sql: string) => { const v = (await q.query<{ d: string | null }>(sql, [outletId])).rows[0]?.d; if (v) dates.push(v); };
    await one('select min(date) as d from journal_entry where outlet_id = $1 and voided_at is null');
    await one('select min(date) as d from channel_order where outlet_id = $1');
    await one('select min(paid_date) as d from supplier_payment where outlet_id = $1');
    await one("select min(paid_date) as d from payroll_run where outlet_id = $1 and status = 'PAID'");
    const rc = (await q.query<{ t: number | null }>('select min(received_at_ms) as t from purchase_receipt where outlet_id = $1', [outletId])).rows[0]?.t;
    if (rc !== null && rc !== undefined) dates.push(localDate(Number(rc), off));
    return dates.length ? dates.sort()[0]! : null;
  }

  /**
   * Laporan keuangan lengkap (neraca, laba rugi, arus kas, perubahan ekuitas) untuk satu outlet, atau `all` = konsolidasi semua outlet (hanya OWNER).
   * Periode `from`..`to` (maks. 366 hari; bawaan awal bulan sampai hari ini); neraca per tanggal `to`. Jurnal dihitung sejak awal pembukuan dalam
   * potongan 31 hari, jadi saldo kumulatif (kas, persediaan, utang) benar. Pembukuan lebih lama dari 48 bulan sebelum `to` tidak dibaca (diberi peringatan).
   */
  async statements(auth: ApiAuth, outletId: string, params: { from?: string; to?: string }, now: number): Promise<FinancialStatements> {
    const MAX_BOOK_DAYS = 1460;
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const outlets = outletId === 'all'
        ? (await q.query<{ id: string; utc_offset_minutes: number }>('select id, utc_offset_minutes from outlet order by id')).rows
        : (await q.query<{ id: string; utc_offset_minutes: number }>('select id, utc_offset_minutes from outlet where id = $1', [outletId])).rows;
      if (outlets.length === 0) throw new NotFoundException('outlet tidak ditemukan');
      const off = outlets[0]!.utc_offset_minutes;
      const today = localDate(now, off);
      const to = params.to ?? today;
      const dateOk = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
      if (!dateOk(to) || (params.from !== undefined && !dateOk(params.from))) throw new BadRequestException('tanggal harus berformat YYYY-MM-DD');
      if (to > today) throw new BadRequestException('tanggal akhir tidak boleh di masa depan');
      const from = params.from ?? `${to.slice(0, 8)}01`;
      if (from > to) throw new BadRequestException('tanggal awal tidak boleh setelah tanggal akhir');
      if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS > 365) throw new BadRequestException('periode maksimal 366 hari');
      const accounts = await this.accounts(q, auth.tenantId);
      const all: JournalEntry[] = [];
      let start: string | null = null;
      const warnings: string[] = [];
      const earliestAllowed = addDays(to, -MAX_BOOK_DAYS);
      for (const o of outlets) {
        let bs = await this.booksStart(q, o.id, o.utc_offset_minutes);
        if (bs === null) continue;
        if (bs > to) continue;
        if (bs < earliestAllowed) { warnings.push(`Pembukuan ${o.id} lebih lama dari 48 bulan; hanya dibaca sejak ${earliestAllowed}, jadi saldo awal bisa tidak lengkap. Catat saldo awal sebagai jurnal manual.`); bs = earliestAllowed; }
        if (start === null || bs < start) start = bs;
        for (let a = bs; a <= to; a = addDays(a, 31)) {
          const b = addDays(a, 30) > to ? to : addDays(a, 30);
          all.push(...(await this.entries(q, auth, o.id, { off: o.utc_offset_minutes, from: a, to: b }, now)));
        }
      }
      const st = buildStatements(all, accounts, { from, to }, start);
      st.warnings.unshift(...warnings);
      if (outletId === 'all') st.warnings.push(`Konsolidasi ${outlets.length} outlet: transaksi antar-outlet tidak dieliminasi.`);
      await this.audit(q, auth, 'report.statements', { outletId, from, to });
      return st;
    });
  }

  async statementsCsv(auth: ApiAuth, outletId: string, kind: unknown, params: { from?: string; to?: string }, now: number): Promise<{ filename: string; csv: string }> {
    if (typeof kind !== 'string' || !(STATEMENT_KINDS as readonly string[]).includes(kind)) throw new BadRequestException(`statement harus salah satu dari ${STATEMENT_KINDS.join(', ')}`);
    const st = await this.statements(auth, outletId, params, now);
    const out = statementCsv(st, kind as StatementKind);
    return { filename: `${outletId}-${out.slug}-${st.period.from}_${st.period.to}.csv`, csv: out.csv };
  }
}

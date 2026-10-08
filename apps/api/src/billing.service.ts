import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiAuth, AdminAuth } from './auth';
import { addDays, billingDate, dueDateFor, invoiceNumber, periodOf, periodsToIssue, subscriptionStatus, TRIAL_DAYS, type InvoiceLite, type SubscriptionStatus } from './billing';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { CLOCK, type Clock } from './pipeline.service';

export interface InvoiceView {
  id: string;
  periodStart: string;
  periodEnd: string;
  outlets: number;
  unitPrice: number;
  amount: number;
  status: 'ISSUED' | 'PAID' | 'VOID';
  issuedAt: string;
  dueDate: string;
  paidAt: string | null;
  payMethod: string | null;
  payRef: string | null;
}

export interface BillingView {
  /** null = tenant belum memakai penagihan (pilot): tidak ada tagihan. */
  subscription: null | {
    planId: string;
    planName: string;
    pricePerOutlet: number;
    status: SubscriptionStatus;
    trialEnd: string;
    /** Sisa hari uji coba (0 bila sudah selesai). */
    trialDaysLeft: number;
    outlets: number;
    /** Perkiraan tagihan per bulan dengan jumlah outlet saat ini. */
    monthlyAmount: number;
    /** Hari terakhir periode berbayar yang tercakup; null bila belum ada. */
    paidThrough: string | null;
  };
  invoices: InvoiceView[];
  /** Petunjuk pembayaran dari penyedia layanan (rekening dan sebagainya). */
  paymentInfo: string;
}

const METHODS = ['TRANSFER', 'QRIS', 'TUNAI', 'LAINNYA'] as const;

interface SubRow { tenant_id: string; plan_id: string; status: 'TRIAL' | 'ACTIVE' | 'CANCELED'; trial_end: string }
interface InvRow {
  id: string; tenant_id: string; period_start: string; period_end: string; outlets: number; unit_price: number; amount: number; status: 'ISSUED' | 'PAID' | 'VOID';
  issued_at: string; due_date: string; paid_at: string | null; pay_method: string | null; pay_ref: string | null;
}
const toInvoice = (r: InvRow): InvoiceView => ({
  id: r.id, periodStart: r.period_start, periodEnd: r.period_end, outlets: r.outlets, unitPrice: r.unit_price, amount: r.amount, status: r.status,
  issuedAt: r.issued_at, dueDate: r.due_date, paidAt: r.paid_at, payMethod: r.pay_method, payRef: r.pay_ref,
});
const lite = (r: InvRow): InvoiceLite => ({ status: r.status, periodStart: r.period_start, periodEnd: r.period_end, dueDate: r.due_date });

@Injectable()
export class BillingService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject('BILLING_PAYMENT_INFO') private readonly paymentInfo: string,
  ) {}

  /** Memulai uji coba untuk tenant baru (pendaftaran mandiri) atau tenant yang baru dimasukkan ke penagihan. Idempoten: tidak menimpa yang ada. */
  async startTrial(tenantId: string, planId = 'standard', q: Queryable = this.db.admin): Promise<void> {
    const today = billingDate(this.clock());
    await q.query(
      `insert into subscription (tenant_id, plan_id, status, trial_end) values ($1, $2, 'TRIAL', $3) on conflict (tenant_id) do nothing`,
      [tenantId, planId, addDays(today, TRIAL_DAYS - 1)],
    );
  }

  /**
   * Menerbitkan tagihan periode yang sudah waktunya (7 hari sebelum periode mulai). Idempoten: periode yang sudah punya tagihan hidup
   * dilewati. Dipanggil saat owner membuka halaman tagihan dan saat admin menjalankan penagihan; tidak butuh penjadwal.
   */
  async ensureInvoices(tenantId: string, q: Queryable = this.db.admin): Promise<number> {
    const sub = (await q.query<SubRow>('select * from subscription where tenant_id = $1', [tenantId])).rows[0];
    if (!sub || sub.status === 'CANCELED') return 0;
    const now = this.clock();
    const today = billingDate(now);
    const anchor = addDays(sub.trial_end, 1);
    const plan = (await q.query<{ price_per_outlet: number }>('select price_per_outlet from plan where id = $1', [sub.plan_id])).rows[0]!;
    const have = new Set((await q.query<{ period_start: string }>("select period_start from invoice where tenant_id = $1 and status <> 'VOID'", [tenantId])).rows.map((r) => r.period_start));
    const outlets = Number((await q.query<{ n: string }>('select count(*) as n from outlet where tenant_id = $1', [tenantId])).rows[0]!.n);
    let issued = 0;
    for (const k of periodsToIssue(anchor, today, 0)) {
      const p = periodOf(anchor, k);
      if (have.has(p.start)) continue;
      const amount = outlets * plan.price_per_outlet;
      if (amount === 0) continue;
      const seq = Number((await q.query<{ n: string }>("select nextval('invoice_seq') as n")).rows[0]!.n);
      await q.query(
        `insert into invoice (id, tenant_id, period_start, period_end, outlets, unit_price, amount, status, due_date) values ($1, $2, $3, $4, $5, $6, $7, 'ISSUED', $8)`,
        [invoiceNumber(today, seq), tenantId, p.start, p.end, outlets, plan.price_per_outlet, amount, dueDateFor(p.start, today)],
      );
      await q.query("insert into audit_log (tenant_id, actor, action, detail) values ($1, 'system', 'billing.issued', $2::jsonb)", [tenantId, JSON.stringify({ period: p.start, amount })]);
      issued++;
    }
    return issued;
  }

  /** Tampilan tagihan untuk owner tenant. Menerbitkan tagihan yang sudah waktunya lebih dulu. */
  async view(auth: ApiAuth): Promise<BillingView> {
    await this.ensureInvoices(auth.tenantId);
    return this.build(auth.tenantId);
  }

  private async build(tenantId: string): Promise<BillingView> {
    const sub = (await this.db.admin.query<SubRow & { plan_name: string; price: number }>(
      'select s.*, p.name as plan_name, p.price_per_outlet as price from subscription s join plan p on p.id = s.plan_id where s.tenant_id = $1', [tenantId],
    )).rows[0];
    const invoices = (await this.db.admin.query<InvRow>('select * from invoice where tenant_id = $1 order by period_start desc, id desc', [tenantId])).rows;
    if (!sub) return { subscription: null, invoices: [], paymentInfo: this.paymentInfo };
    const today = billingDate(this.clock());
    const outlets = Number((await this.db.admin.query<{ n: string }>('select count(*) as n from outlet where tenant_id = $1', [tenantId])).rows[0]!.n);
    const live = invoices.filter((i) => i.status !== 'VOID');
    const paid = live.filter((i) => i.status === 'PAID').map((i) => i.period_end).sort();
    return {
      subscription: {
        planId: sub.plan_id, planName: sub.plan_name, pricePerOutlet: sub.price,
        status: subscriptionStatus({ status: sub.status, trialEnd: sub.trial_end }, invoices.map(lite), today),
        trialEnd: sub.trial_end, trialDaysLeft: Math.max(0, Math.round((Date.parse(`${sub.trial_end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) + 1),
        outlets, monthlyAmount: outlets * sub.price, paidThrough: paid.length > 0 ? paid[paid.length - 1]! : null,
      },
      invoices: invoices.map(toInvoice),
      paymentInfo: this.paymentInfo,
    };
  }

  async invoice(auth: ApiAuth, id: string): Promise<{ invoice: InvoiceView; tenantName: string; paymentInfo: string }> {
    const r = (await this.db.admin.query<InvRow & { tenant_name: string }>('select i.*, t.name as tenant_name from invoice i join tenant t on t.id = i.tenant_id where i.id = $1 and i.tenant_id = $2', [id, auth.tenantId])).rows[0];
    if (!r) throw new NotFoundException('tagihan tidak ditemukan');
    return { invoice: toInvoice(r), tenantName: r.tenant_name, paymentInfo: this.paymentInfo };
  }

  // ---------- admin platform ----------

  async adminOverview() {
    const today = billingDate(this.clock());
    const tenants = (await this.db.admin.query<{ id: string; name: string; plan_id: string; status: 'TRIAL' | 'ACTIVE' | 'CANCELED'; trial_end: string }>(
      'select t.id, t.name, s.plan_id, s.status, s.trial_end from subscription s join tenant t on t.id = s.tenant_id order by t.name',
    )).rows;
    const invoices = (await this.db.admin.query<InvRow>("select * from invoice where status <> 'VOID'")).rows;
    const plans = (await this.db.admin.query<{ id: string; name: string; price_per_outlet: number; active: boolean }>('select * from plan order by id')).rows;
    return {
      plans: plans.map((p) => ({ id: p.id, name: p.name, pricePerOutlet: p.price_per_outlet, active: p.active })),
      tenants: tenants.map((t) => {
        const mine = invoices.filter((i) => i.tenant_id === t.id);
        const open = mine.filter((i) => i.status === 'ISSUED');
        return {
          tenantId: t.id, tenantName: t.name, planId: t.plan_id, trialEnd: t.trial_end,
          status: subscriptionStatus({ status: t.status, trialEnd: t.trial_end }, mine.map(lite), today),
          outstanding: open.reduce((s, i) => s + i.amount, 0), openInvoices: open.length,
        };
      }),
      openInvoices: invoices.filter((i) => i.status === 'ISSUED').sort((a, b) => a.due_date.localeCompare(b.due_date)).map((i) => ({ ...toInvoice(i), tenantId: i.tenant_id })),
    };
  }

  /** Menerbitkan tagihan yang sudah waktunya untuk semua tenant. Mengembalikan jumlah tagihan baru. */
  async runAll(admin: AdminAuth): Promise<{ issued: number }> {
    const ids = (await this.db.admin.query<{ tenant_id: string }>("select tenant_id from subscription where status <> 'CANCELED'")).rows.map((r) => r.tenant_id);
    let issued = 0;
    for (const id of ids) issued += await this.ensureInvoices(id);
    void admin;
    return { issued };
  }

  async markPaid(admin: AdminAuth, id: string, input: { method?: unknown; reference?: unknown; note?: unknown }): Promise<void> {
    if (typeof input.method !== 'string' || !(METHODS as readonly string[]).includes(input.method)) throw new BadRequestException(`metode harus salah satu dari ${METHODS.join(', ')}`);
    const ref = typeof input.reference === 'string' ? input.reference.trim().slice(0, 80) : '';
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : null;
    const r = (await this.db.admin.query<InvRow>('select * from invoice where id = $1', [id])).rows[0];
    if (!r) throw new NotFoundException('tagihan tidak ditemukan');
    if (r.status === 'PAID') throw new ConflictException('tagihan ini sudah lunas');
    if (r.status === 'VOID') throw new ConflictException('tagihan ini sudah dibatalkan');
    await this.db.admin.query("update invoice set status = 'PAID', paid_at = now(), pay_method = $2, pay_ref = $3, note = coalesce($4, note) where id = $1", [id, input.method, ref || null, note]);
    await this.db.admin.query("insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, 'billing.paid', $3::jsonb)", [r.tenant_id, `admin:${admin.adminId}`, JSON.stringify({ invoice: id, amount: r.amount, method: input.method, ref })]);
  }

  async voidInvoice(admin: AdminAuth, id: string, reason: unknown): Promise<void> {
    const why = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
    if (why.length < 3) throw new BadRequestException('alasan pembatalan wajib diisi');
    const r = (await this.db.admin.query<InvRow>('select * from invoice where id = $1', [id])).rows[0];
    if (!r) throw new NotFoundException('tagihan tidak ditemukan');
    if (r.status !== 'ISSUED') throw new ConflictException('hanya tagihan yang belum dibayar yang bisa dibatalkan');
    await this.db.admin.query("update invoice set status = 'VOID', note = $2 where id = $1", [id, why]);
    await this.db.admin.query("insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, 'billing.void', $3::jsonb)", [r.tenant_id, `admin:${admin.adminId}`, JSON.stringify({ invoice: id, reason: why })]);
  }

  /** Mengatur langganan tenant: memasukkan tenant pilot ke penagihan (uji coba), mengganti paket, memperpanjang uji coba, atau menghentikan. */
  async setSubscription(admin: AdminAuth, tenantId: string, input: { planId?: unknown; status?: unknown; trialEnd?: unknown }): Promise<void> {
    if ((await this.db.admin.query('select 1 from tenant where id = $1', [tenantId])).rowCount === 0) throw new NotFoundException('tenant tidak ditemukan');
    if (input.planId !== undefined && (typeof input.planId !== 'string' || (await this.db.admin.query('select 1 from plan where id = $1 and active', [input.planId])).rowCount === 0)) throw new BadRequestException('paket tidak dikenal atau tidak aktif');
    if (input.status !== undefined && input.status !== 'CANCELED' && input.status !== 'TRIAL') throw new BadRequestException('status hanya boleh CANCELED atau TRIAL');
    if (input.trialEnd !== undefined && (typeof input.trialEnd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.trialEnd) || Number.isNaN(Date.parse(`${input.trialEnd}T00:00:00Z`)))) throw new BadRequestException('trialEnd harus YYYY-MM-DD');
    const have = (await this.db.admin.query('select 1 from subscription where tenant_id = $1', [tenantId])).rowCount > 0;
    if (!have) await this.startTrial(tenantId, typeof input.planId === 'string' ? input.planId : 'standard');
    await this.db.admin.query(
      `update subscription set plan_id = coalesce($2, plan_id), trial_end = coalesce($3, trial_end),
              status = case when $4::text = 'CANCELED' then 'CANCELED' when $4::text = 'TRIAL' then 'TRIAL' else status end,
              canceled_at = case when $4::text = 'CANCELED' then now() when $4::text = 'TRIAL' then null else canceled_at end
       where tenant_id = $1`,
      [tenantId, input.planId ?? null, input.trialEnd ?? null, input.status ?? null],
    );
    await this.db.admin.query("insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, 'billing.subscription', $3::jsonb)", [tenantId, `admin:${admin.adminId}`, JSON.stringify(input)]);
  }

  async setPlanPrice(admin: AdminAuth, planId: string, price: unknown): Promise<void> {
    if (!Number.isInteger(price) || (price as number) < 0 || (price as number) > 100_000_000) throw new BadRequestException('harga harus bilangan bulat rupiah ≥ 0');
    const r = await this.db.admin.query('update plan set price_per_outlet = $2 where id = $1', [planId, price]);
    if (r.rowCount === 0) throw new NotFoundException('paket tidak ditemukan');
    // Berlaku untuk tagihan yang terbit sesudahnya (tagihan lama menyimpan harga saat terbit); dicatat di setiap tenant yang memakai paket ini.
    await this.db.admin.query("insert into audit_log (tenant_id, actor, action, detail) select tenant_id, $2, 'billing.plan_price', $3::jsonb from subscription where plan_id = $1", [planId, `admin:${admin.adminId}`, JSON.stringify({ planId, price })]);
  }
}

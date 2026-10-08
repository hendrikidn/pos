import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiAuth } from './auth';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { CLOCK, type Clock } from './pipeline.service';
import { checkPoLines, lineAmount, priceExceeds, weightedAvgCost } from './procurement';
import { localDate } from './sales-report';
import { StockService } from './stock.service';

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const need = (ok: unknown, message: string): void => {
  if (!ok) throw new BadRequestException(message);
};
const num = (v: unknown) => Number(v);

export interface SupplierInput { id?: unknown; name?: unknown; phone?: unknown; note?: unknown; active?: unknown }
export interface PoInput { outletId?: unknown; supplierId?: unknown; expectedDate?: unknown; note?: unknown; lines?: unknown }
export interface ReceiveInput { invoiceRef?: unknown; note?: unknown; lines?: unknown }
export interface PaymentInput { amount?: unknown; date?: unknown; method?: unknown; ref?: unknown; outletId?: unknown }

type PoStatus = 'DRAFT' | 'ORDERED' | 'PARTIAL' | 'RECEIVED' | 'CANCELED';

@Injectable()
export class PurchaseService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(StockService) private readonly stock: StockService,
  ) {}

  private audit(q: Queryable, auth: ApiAuth, action: string, detail: object) {
    return q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [auth.tenantId, auth.userId, action, JSON.stringify(detail)]);
  }

  // ---------- supplier ----------

  listSuppliers(auth: ApiAuth) {
    return this.db.tenantTx(auth.tenantId, async (q) =>
      (await q.query<{ id: string; name: string; phone: string | null; note: string | null; active: boolean }>('select id, name, phone, note, active from supplier order by active desc, name')).rows,
    );
  }

  private text(label: string, v: unknown, max: number, required = false): string | null {
    const s = typeof v === 'string' ? v.trim() : '';
    if (required) need(s.length >= 2 && s.length <= max, `${label} wajib (2–${max} karakter)`);
    else need(s.length <= max, `${label} maksimal ${max} karakter`);
    return s === '' ? null : s;
  }

  async createSupplier(auth: ApiAuth, input: SupplierInput): Promise<void> {
    need(typeof input.id === 'string' && ID.test(input.id), 'id: huruf kecil, angka, - atau _ (maks. 32)');
    const name = this.text('nama supplier', input.name, 80, true)!;
    const phone = this.text('telepon', input.phone, 30);
    const note = this.text('catatan', input.note, 200);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      if ((await q.query('select 1 from supplier where id = $1', [input.id])).rowCount > 0) throw new ConflictException('id supplier sudah dipakai');
      await q.query('insert into supplier (tenant_id, id, name, phone, note) values ($1, $2, $3, $4, $5)', [auth.tenantId, input.id, name, phone, note]);
      await this.audit(q, auth, 'supplier.create', { id: input.id });
    });
  }

  async updateSupplier(auth: ApiAuth, id: string, input: SupplierInput): Promise<void> {
    need(input.active === undefined || typeof input.active === 'boolean', 'active harus true atau false');
    const name = input.name === undefined ? null : this.text('nama supplier', input.name, 80, true);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await q.query('update supplier set name = coalesce($2, name), phone = case when $3::boolean then $4 else phone end, note = case when $5::boolean then $6 else note end, active = coalesce($7, active) where id = $1', [
        id, name, input.phone !== undefined, this.text('telepon', input.phone, 30), input.note !== undefined, this.text('catatan', input.note, 200), input.active ?? null,
      ]);
      if (r.rowCount === 0) throw new NotFoundException('supplier tidak ditemukan');
      await this.audit(q, auth, 'supplier.update', { id, fields: Object.keys(input) });
    });
  }

  // ---------- pesanan pembelian ----------

  private async assertOutlet(q: Queryable, outletId: unknown) {
    need(typeof outletId === 'string', 'outletId wajib');
    if ((await q.query('select 1 from outlet where id = $1', [outletId])).rowCount === 0) throw new NotFoundException('outlet tidak ditemukan');
  }

  private async ingredientMap(q: Queryable) {
    return new Map((await q.query<{ id: string; active: boolean }>("select id, active from ingredient where kind = 'RAW'")).rows.map((r) => [r.id, r]));
  }

  async createPo(auth: ApiAuth, input: PoInput): Promise<{ id: number }> {
    const note = this.text('catatan', input.note, 200);
    need(input.expectedDate === undefined || input.expectedDate === null || (typeof input.expectedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.expectedDate)), 'expectedDate harus YYYY-MM-DD');
    return this.db.tenantTx(auth.tenantId, async (q) => {
      await this.assertOutlet(q, input.outletId);
      need(typeof input.supplierId === 'string', 'supplierId wajib');
      const sup = (await q.query<{ active: boolean }>('select active from supplier where id = $1', [input.supplierId])).rows[0];
      if (!sup) throw new NotFoundException('supplier tidak ditemukan');
      need(sup.active, 'supplier nonaktif');
      const err = checkPoLines(input.lines, await this.ingredientMap(q));
      if (err) throw new BadRequestException(err);
      const id = num((await q.query<{ id: string }>(
        "insert into purchase_order (tenant_id, outlet_id, supplier_id, status, expected_date, note, created_by) values ($1, $2, $3, 'DRAFT', $4, $5, $6) returning id",
        [auth.tenantId, input.outletId, input.supplierId, input.expectedDate ?? null, note, auth.userId],
      )).rows[0]!.id);
      await this.writeLines(q, auth.tenantId, id, input.lines as { ingredientId: string; qty: number; unitCost: number }[]);
      await this.audit(q, auth, 'po.create', { id, outletId: input.outletId, supplierId: input.supplierId });
      return { id };
    });
  }

  private async writeLines(q: Queryable, tenantId: string, id: number, lines: { ingredientId: string; qty: number; unitCost: number }[]) {
    for (const [i, l] of lines.entries()) {
      await q.query('insert into purchase_line (tenant_id, po_id, line_no, ingredient_id, qty, unit_cost) values ($1, $2, $3, $4, $5, $6)', [tenantId, id, i + 1, l.ingredientId, l.qty, l.unitCost]);
    }
  }

  private async getPo(q: Queryable, id: number) {
    const po = (await q.query<{ id: string; outlet_id: string; supplier_id: string; status: PoStatus }>('select id, outlet_id, supplier_id, status from purchase_order where id = $1 for update', [id])).rows[0];
    if (!po) throw new NotFoundException('pesanan pembelian tidak ditemukan');
    return po;
  }

  /** Mengubah PO yang masih draf: supplier, tanggal, catatan, dan seluruh barisnya. */
  async updatePo(auth: ApiAuth, id: number, input: PoInput): Promise<void> {
    const note = input.note === undefined ? undefined : this.text('catatan', input.note, 200);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const po = await this.getPo(q, id);
      if (po.status !== 'DRAFT') throw new ConflictException('hanya pesanan draf yang bisa diubah');
      if (input.supplierId !== undefined) {
        need(typeof input.supplierId === 'string', 'supplierId tidak valid');
        const sup = (await q.query<{ active: boolean }>('select active from supplier where id = $1', [input.supplierId])).rows[0];
        if (!sup) throw new NotFoundException('supplier tidak ditemukan');
        need(sup.active, 'supplier nonaktif');
      }
      if (input.lines !== undefined) {
        const err = checkPoLines(input.lines, await this.ingredientMap(q));
        if (err) throw new BadRequestException(err);
        await q.query('delete from purchase_line where po_id = $1', [id]);
        await this.writeLines(q, auth.tenantId, id, input.lines as { ingredientId: string; qty: number; unitCost: number }[]);
      }
      await q.query('update purchase_order set supplier_id = coalesce($2, supplier_id), note = case when $3::boolean then $4 else note end, expected_date = case when $5::boolean then $6 else expected_date end where id = $1', [
        id, input.supplierId ?? null, note !== undefined, note ?? null, input.expectedDate !== undefined, input.expectedDate ?? null,
      ]);
      await this.audit(q, auth, 'po.update', { id, fields: Object.keys(input) });
    });
  }

  async orderPo(auth: ApiAuth, id: number): Promise<void> {
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const po = await this.getPo(q, id);
      if (po.status !== 'DRAFT') throw new ConflictException('pesanan ini sudah dipesan atau selesai');
      await q.query("update purchase_order set status = 'ORDERED', ordered_at = now() where id = $1", [id]);
      await this.audit(q, auth, 'po.order', { id });
    });
  }

  async cancelPo(auth: ApiAuth, id: number, reason: unknown): Promise<void> {
    const why = typeof reason === 'string' ? reason.trim() : '';
    need(why.length >= 3 && why.length <= 200, 'alasan pembatalan wajib (3–200 karakter)');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const po = await this.getPo(q, id);
      if (po.status !== 'DRAFT' && po.status !== 'ORDERED') throw new ConflictException('pesanan yang sudah diterima (sebagian atau seluruhnya) tidak bisa dibatalkan');
      await q.query("update purchase_order set status = 'CANCELED', canceled_at = now(), cancel_reason = $2 where id = $1", [id, why]);
      await this.audit(q, auth, 'po.cancel', { id, reason: why });
    });
  }

  /**
   * Menerima barang. Jumlah per baris tidak boleh melebihi sisa pesanan. Setiap baris menambah stok outlet (PURCHASE), memperbarui harga pokok
   * rata-rata bahan, dan menambah utang ke supplier sebesar nilai faktur. Harga faktur yang melebihi harga PO lebih dari 5% menandai penerimaan
   * (`priceFlag`) agar pembelian dengan harga dinaikkan terlihat.
   */
  async receive(auth: ApiAuth, id: number, input: ReceiveInput): Promise<{ receiptId: number; amount: number; priceFlag: boolean; status: PoStatus }> {
    const invoiceRef = this.text('nomor faktur', input.invoiceRef, 40);
    const note = this.text('catatan', input.note, 200);
    need(Array.isArray(input.lines) && input.lines.length >= 1 && input.lines.length <= 100, 'penerimaan minimal satu baris');
    const now = this.clock();
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const po = await this.getPo(q, id);
      if (po.status !== 'ORDERED' && po.status !== 'PARTIAL') throw new ConflictException(po.status === 'DRAFT' ? 'pesanan belum dipesan' : 'pesanan ini sudah selesai atau dibatalkan');
      const lines = (await q.query<{ line_no: number; ingredient_id: string; qty: number; unit_cost: string; received_qty: number }>('select line_no, ingredient_id, qty, unit_cost, received_qty from purchase_line where po_id = $1', [id])).rows;
      const byNo = new Map(lines.map((l) => [l.line_no, l]));
      const seen = new Set<number>();
      const take: { line: (typeof lines)[number]; qty: number; cost: number }[] = [];
      for (const [i, raw] of (input.lines as { lineNo?: unknown; qty?: unknown; unitCost?: unknown }[]).entries()) {
        const line = typeof raw?.lineNo === 'number' ? byNo.get(raw.lineNo) : undefined;
        need(line, `baris ${i + 1}: nomor baris pesanan tidak ada`);
        need(!seen.has(line!.line_no), `baris ${i + 1}: baris pesanan ${line!.line_no} muncul dua kali`);
        seen.add(line!.line_no);
        need(Number.isInteger(raw.qty) && (raw.qty as number) >= 1, `baris ${i + 1}: jumlah harus bilangan bulat ≥ 1`);
        const remaining = line!.qty - line!.received_qty;
        need((raw.qty as number) <= remaining, `baris ${i + 1}: melebihi sisa pesanan (${remaining})`);
        const cost = raw.unitCost === undefined ? num(line!.unit_cost) : raw.unitCost;
        need(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && cost <= 100_000_000 && Math.abs(Math.round(cost * 10_000) - cost * 10_000) < 1e-6, `baris ${i + 1}: harga satuan tidak valid`);
        take.push({ line: line!, qty: raw.qty as number, cost: cost as number });
      }
      const amount = take.reduce((s, t) => s + lineAmount(t.qty, t.cost), 0);
      const priceFlag = take.some((t) => priceExceeds(num(t.line.unit_cost), t.cost));
      const receiptId = num((await q.query<{ id: string }>(
        `insert into purchase_receipt (tenant_id, po_id, outlet_id, supplier_id, received_at_ms, received_by, invoice_ref, amount, price_flag, note)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [auth.tenantId, id, po.outlet_id, po.supplier_id, now, auth.userId, invoiceRef, amount, priceFlag, note],
      )).rows[0]!.id);
      for (const [i, t] of take.entries()) {
        await q.query('insert into purchase_receipt_line (tenant_id, receipt_id, line_no, ingredient_id, qty, unit_cost, po_unit_cost) values ($1, $2, $3, $4, $5, $6, $7)', [auth.tenantId, receiptId, i + 1, t.line.ingredient_id, t.qty, t.cost, t.line.unit_cost]);
        await q.query('update purchase_line set received_qty = received_qty + $3 where po_id = $1 and line_no = $2', [id, t.line.line_no, t.qty]);
        await q.query("insert into stock_movement (tenant_id, outlet_id, ingredient_id, kind, qty, note, user_id, at_ms) values ($1, $2, $3, 'PURCHASE', $4, $5, $6, $7)", [auth.tenantId, po.outlet_id, t.line.ingredient_id, t.qty, `PO-${id}${invoiceRef ? ` ${invoiceRef}` : ''}`.slice(0, 140), auth.userId, now]);
        // Harga rata-rata ditimbang dengan stok sebelum penerimaan ini (pergerakan di atas baru saja ditambahkan, jadi kurangi kembali).
        const onHandAfter = await this.stock.onHand(q, po.outlet_id, t.line.ingredient_id, now);
        const before = onHandAfter === null ? null : onHandAfter - t.qty;
        const avg = num((await q.query<{ avg_cost: string }>('select avg_cost from ingredient where id = $1', [t.line.ingredient_id])).rows[0]!.avg_cost);
        await q.query('update ingredient set avg_cost = $2 where id = $1', [t.line.ingredient_id, weightedAvgCost(before, avg, t.qty, t.cost)]);
      }
      const left = (await q.query<{ n: string }>('select count(*) as n from purchase_line where po_id = $1 and received_qty < qty', [id])).rows[0]!.n;
      const status: PoStatus = num(left) === 0 ? 'RECEIVED' : 'PARTIAL';
      await q.query('update purchase_order set status = $2 where id = $1', [id, status]);
      await this.audit(q, auth, 'po.receive', { id, receiptId, amount, priceFlag, invoiceRef });
      return { receiptId, amount, priceFlag, status };
    });
  }

  async listPos(auth: ApiAuth, filter: { outletId?: string; status?: string }) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const rows = (await q.query<{ id: string; outlet_id: string; supplier_id: string; supplier_name: string; status: PoStatus; expected_date: string | null; note: string | null; created_by: string; created_at: string; total: string; received: string }>(
        `select p.id, p.outlet_id, p.supplier_id, s.name as supplier_name, p.status, p.expected_date, p.note, p.created_by, p.created_at,
                coalesce((select sum(round(l.qty * l.unit_cost)) from purchase_line l where l.po_id = p.id), 0) as total,
                coalesce((select sum(r.amount) from purchase_receipt r where r.po_id = p.id), 0) as received
         from purchase_order p join supplier s on s.tenant_id = p.tenant_id and s.id = p.supplier_id
         where ($1::text is null or p.outlet_id = $1) and ($2::text is null or p.status = $2) order by p.id desc limit 200`,
        [filter.outletId ?? null, filter.status ?? null],
      )).rows;
      return rows.map((r) => ({ id: num(r.id), outletId: r.outlet_id, supplierId: r.supplier_id, supplierName: r.supplier_name, status: r.status, expectedDate: r.expected_date, note: r.note, createdBy: r.created_by, createdAt: r.created_at, total: num(r.total), receivedAmount: num(r.received) }));
    });
  }

  async getPoDetail(auth: ApiAuth, id: number) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const po = (await q.query<{ id: string; outlet_id: string; supplier_id: string; status: PoStatus; expected_date: string | null; note: string | null; created_by: string; cancel_reason: string | null }>('select id, outlet_id, supplier_id, status, expected_date, note, created_by, cancel_reason from purchase_order where id = $1', [id])).rows[0];
      if (!po) throw new NotFoundException('pesanan pembelian tidak ditemukan');
      const lines = (await q.query<{ line_no: number; ingredient_id: string; name: string; unit: string; qty: number; unit_cost: string; received_qty: number }>(
        'select l.line_no, l.ingredient_id, i.name, i.unit, l.qty, l.unit_cost, l.received_qty from purchase_line l join ingredient i on i.tenant_id = l.tenant_id and i.id = l.ingredient_id where l.po_id = $1 order by l.line_no', [id],
      )).rows.map((l) => ({ lineNo: l.line_no, ingredientId: l.ingredient_id, name: l.name, unit: l.unit, qty: l.qty, unitCost: num(l.unit_cost), receivedQty: l.received_qty }));
      const receipts = (await q.query<{ id: string; received_at_ms: number; received_by: string; invoice_ref: string | null; amount: string; price_flag: boolean }>('select id, received_at_ms, received_by, invoice_ref, amount, price_flag from purchase_receipt where po_id = $1 order by id', [id])).rows
        .map((r) => ({ id: num(r.id), receivedAt: num(r.received_at_ms), receivedBy: r.received_by, invoiceRef: r.invoice_ref, amount: num(r.amount), priceFlag: r.price_flag }));
      return { id: num(po.id), outletId: po.outlet_id, supplierId: po.supplier_id, status: po.status, expectedDate: po.expected_date, note: po.note, createdBy: po.created_by, cancelReason: po.cancel_reason, lines, receipts };
    });
  }

  // ---------- utang supplier ----------

  async payables(auth: ApiAuth) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const rows = (await q.query<{ id: string; name: string; billed: string; paid: string; flagged: string; last_paid: string | null }>(
        `select s.id, s.name,
                coalesce((select sum(amount) from purchase_receipt r where r.tenant_id = s.tenant_id and r.supplier_id = s.id), 0) as billed,
                coalesce((select sum(amount) from supplier_payment p where p.tenant_id = s.tenant_id and p.supplier_id = s.id), 0) as paid,
                (select count(*) from purchase_receipt r where r.tenant_id = s.tenant_id and r.supplier_id = s.id and r.price_flag) as flagged,
                (select max(paid_date) from supplier_payment p where p.tenant_id = s.tenant_id and p.supplier_id = s.id) as last_paid
         from supplier s order by s.name`,
      )).rows;
      return rows.map((r) => ({ supplierId: r.id, name: r.name, billed: num(r.billed), paid: num(r.paid), owed: num(r.billed) - num(r.paid), flaggedReceipts: num(r.flagged), lastPaidDate: r.last_paid }));
    });
  }

  async pay(auth: ApiAuth, supplierId: string, input: PaymentInput): Promise<{ id: number }> {
    need(Number.isInteger(input.amount) && (input.amount as number) >= 1 && (input.amount as number) <= 100_000_000_000, 'nominal harus bilangan bulat rupiah ≥ 1');
    need(input.method === 'TUNAI' || input.method === 'TRANSFER', 'metode harus TUNAI atau TRANSFER');
    need(typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) && !Number.isNaN(Date.parse(`${input.date}T00:00:00Z`)), 'tanggal harus YYYY-MM-DD');
    const ref = this.text('referensi', input.ref, 60);
    return this.db.tenantTx(auth.tenantId, async (q) => {
      await this.assertOutlet(q, input.outletId);
      const off = (await q.query<{ utc_offset_minutes: number }>('select utc_offset_minutes from outlet where id = $1', [input.outletId])).rows[0]!.utc_offset_minutes;
      need((input.date as string) <= localDate(this.clock(), off), 'tanggal pembayaran tidak boleh di masa depan');
      if ((await q.query('select 1 from supplier where id = $1', [supplierId])).rowCount === 0) throw new NotFoundException('supplier tidak ditemukan');
      const owed = (await q.query<{ owed: string }>(
        `select coalesce((select sum(amount) from purchase_receipt where supplier_id = $1), 0) - coalesce((select sum(amount) from supplier_payment where supplier_id = $1), 0) as owed`, [supplierId],
      )).rows[0]!.owed;
      need((input.amount as number) <= num(owed), `pembayaran melebihi utang (Rp ${num(owed).toLocaleString('id-ID')})`);
      const id = num((await q.query<{ id: string }>(
        'insert into supplier_payment (tenant_id, outlet_id, supplier_id, amount, paid_date, method, ref, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id',
        [auth.tenantId, input.outletId, supplierId, input.amount, input.date, input.method, ref, auth.userId],
      )).rows[0]!.id);
      await this.audit(q, auth, 'supplier.pay', { id, supplierId, amount: input.amount, method: input.method });
      return { id };
    });
  }
}

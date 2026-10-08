import type { KitchenStatus, OrderType, PaymentMethod, PosEvent, PrinterState } from '@pos/events';
import { decideDiscount, decideEmployeeMeal, decideRefund, decideVoid, reduceOrder, type Ctx } from '@pos/order';
import { Directory } from './directory';
import type { Printer } from './printer';
import type { Recorder } from './recorder';
import type { KeyValueStore } from './store';
import { computeTotals, paidTotal, renderBill, renderKitchenTicket, renderReceipt, type Totals } from './totals';
import {
  fail, ok, type OrderRecord, type PosConfig, type Result, type ShiftRecord, type StaffPublic,
} from './types';

export interface EngineDeps {
  config: PosConfig;
  recorder: Recorder;
  store: KeyValueStore;
  printer: Printer;
  now: () => number;
}

export interface ApproverInput {
  userId: string;
  pin: string;
}

export const VOID_REASONS = [
  { code: 'CUSTOMER_CANCEL', label: 'Customer membatalkan' },
  { code: 'WRONG_ORDER', label: 'Salah input pesanan' },
  { code: 'OUT_OF_STOCK', label: 'Stok habis' },
  { code: 'DUPLICATE', label: 'Order ganda' },
  { code: 'KITCHEN_ERROR', label: 'Kesalahan dapur' },
] as const;

const ACTIVE = new Set(['DRAFT', 'SENT', 'BILLED']);

/**
 * Logika POS di atas event log: setiap tindakan kasir menjadi event yang ditandatangani rantai hash perangkat,
 * dan tindakan sensitif (void, diskon, refund) dikunci oleh aturan dari @pos/order sebelum event dibuat.
 * Tidak ada akses DOM sehingga bisa diuji di Node dan dijalankan di browser maupun pembungkus Android.
 */
export class PosEngine {
  private readonly dir: Directory;
  private cfg: PosConfig;
  private readonly orders = new Map<string, OrderRecord>();
  private shift: ShiftRecord | null = null;
  private counter = 0;
  private lastPrinter: PrinterState | undefined;
  private claim = false;
  private user: string | null = null;

  constructor(private readonly d: EngineDeps) {
    this.cfg = d.config;
    this.dir = new Directory(d.config.staff, d.now);
  }

  get config(): PosConfig {
    return this.cfg;
  }

  /**
   * Menerapkan konfigurasi baru dari server (menu, staf, pajak, EDC). Order yang sedang berjalan tidak berubah;
   * identitas perangkat tidak boleh berubah di tengah jalan.
   */
  setConfig(next: PosConfig): void {
    if (next.deviceId !== this.cfg.deviceId || next.outletId !== this.cfg.outletId) {
      throw new Error('identitas perangkat berubah; muat ulang aplikasi');
    }
    this.cfg = next;
    this.dir.setStaff(next.staff);
  }

  async init(): Promise<void> {
    await this.d.recorder.init();
    this.shift = (await this.d.store.get<ShiftRecord>('shift')) ?? null;
    this.counter = (await this.d.store.get<number>('counter')) ?? 0;
    this.claim = (await this.d.store.get<boolean>('paperClaim')) ?? false;
    for (const key of await this.d.store.keys('order:')) {
      const o = await this.d.store.get<OrderRecord>(key);
      if (o) this.orders.set(o.id, o);
    }
  }

  // ---------- sesi ----------

  staff(): StaffPublic[] {
    return this.dir.list();
  }

  currentUser(): StaffPublic | null {
    return this.user ? (this.dir.get(this.user) ?? null) : null;
  }

  async login(userId: string, pin: string): Promise<Result<StaffPublic>> {
    const v = await this.dir.verify(userId, pin);
    if (v === 'LOCKED') return fail('PIN_LOCKED', 'Terlalu banyak PIN salah. Coba lagi sebentar lagi.');
    if (v === 'WRONG') return fail('PIN_WRONG', 'PIN salah.');
    this.user = userId;
    return ok(this.dir.get(userId)!);
  }

  logout(): void {
    this.user = null;
  }

  private who(): Result<string> {
    return this.user ? ok(this.user) : fail('NOT_LOGGED_IN', 'Masuk dengan PIN terlebih dahulu.');
  }

  private ctx(): Ctx {
    return { roleOf: this.dir.roleOf, policy: this.cfg.policy };
  }

  /** Memverifikasi PIN approver. Approver adalah orang lain, bukan sesi yang sedang aktif. */
  private async checkApprovers(list: ApproverInput[]): Promise<Result<string[]>> {
    const ids: string[] = [];
    for (const a of list) {
      const v = await this.dir.verify(a.userId, a.pin);
      if (v === 'LOCKED') return fail('PIN_LOCKED', 'PIN approver terkunci sementara.');
      if (v === 'WRONG') return fail('PIN_WRONG', 'PIN approver salah.');
      ids.push(a.userId);
    }
    return ok(ids);
  }

  // ---------- pencatatan ----------

  private async emit(body: Parameters<Recorder['record']>[0]): Promise<PosEvent> {
    return this.d.recorder.record(body, this.user);
  }

  private async apply(o: OrderRecord, e: PosEvent): Promise<void> {
    o.state = reduceOrder(o.state, e) ?? o.state;
    await this.save(o);
  }

  private async save(o: OrderRecord): Promise<void> {
    this.orders.set(o.id, o);
    await this.d.store.write({ [`order:${o.id}`]: o });
  }

  private order(id: string): Result<OrderRecord> {
    const o = this.orders.get(id);
    return o ? ok(o) : fail('ORDER_NOT_FOUND', 'Order tidak ditemukan.');
  }

  // ---------- shift ----------

  currentShift(): ShiftRecord | null {
    return this.shift;
  }

  async openShift(openingCash: number): Promise<Result<ShiftRecord>> {
    const w = this.who();
    if (!w.ok) return w;
    if (this.shift) return fail('SHIFT_OPEN', 'Shift sudah dibuka.');
    if (!Number.isInteger(openingCash) || openingCash < 0) return fail('AMOUNT_INVALID', 'Modal awal tidak valid.');
    this.shift = { id: `${this.cfg.deviceId}-S${this.d.now()}`, userId: w.value, openedAt: this.d.now(), openingCash };
    await this.d.store.write({ shift: this.shift });
    await this.emit({ type: 'shift.opened', payload: { shiftId: this.shift.id, openingCash } });
    return ok(this.shift);
  }

  /**
   * Tutup shift dengan hitungan buta: kasir hanya memasukkan uang yang dihitung. Angka yang diharapkan sistem
   * dicatat di event untuk audit tetapi tidak dikembalikan, agar tidak bisa disesuaikan.
   */
  async closeShift(counted: number): Promise<Result<void>> {
    const w = this.who();
    if (!w.ok) return w;
    if (!this.shift) return fail('NO_SHIFT', 'Tidak ada shift yang terbuka.');
    if (!Number.isInteger(counted) || counted < 0) return fail('AMOUNT_INVALID', 'Jumlah uang tidak valid.');
    const open = this.listOrders().filter((o) => o.shiftId === this.shift!.id && ACTIVE.has(o.state.status));
    if (open.length > 0) return fail('OPEN_ORDERS', `Masih ada ${open.length} order yang belum selesai atau dibatalkan.`);

    const mine = this.listOrders().filter((o) => o.shiftId === this.shift!.id);
    const cashIn = mine.flatMap((o) => o.payments).filter((p) => p.method === 'CASH').reduce((s, p) => s + p.amount, 0);
    const cashOut = mine.flatMap((o) => o.refunds).filter((r) => r.method === 'CASH').reduce((s, r) => s + r.amount, 0);
    const expected = this.shift.openingCash + cashIn - cashOut;

    await this.emit({ type: 'cash.counted', payload: { shiftId: this.shift.id, counted, expected } });
    await this.emit({ type: 'shift.closed', payload: { shiftId: this.shift.id } });
    this.shift = null;
    await this.d.store.write({}, ['shift']);
    return ok(undefined);
  }

  // ---------- order ----------

  listOrders(): OrderRecord[] {
    return [...this.orders.values()].sort((a, b) => b.number - a.number);
  }

  getOrder(id: string): OrderRecord | undefined {
    return this.orders.get(id);
  }

  totals(o: OrderRecord): Totals {
    return computeTotals(o.items, o.discount, this.cfg.taxPercent);
  }

  outstanding(o: OrderRecord): number {
    return Math.max(0, this.totals(o).total - paidTotal(o));
  }

  /** Makan karyawan penerima yang sudah dibuat di terminal ini hari ini (hari menurut jam perangkat), tidak termasuk yang di-void. */
  private mealsToday(employeeId: string): number {
    const day = (ms: number) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    };
    const today = day(this.d.now());
    return this.listOrders().filter(
      (o) => o.type === 'EMPLOYEE' && o.employeeId === employeeId && o.state.status !== 'VOIDED' && day(o.createdAt) === today,
    ).length;
  }

  /**
   * Membuat order. Order karyawan di luar kuota harian, atau untuk diri sendiri, memerlukan `approver` (supervisor ke atas
   * yang bukan pembuat dan bukan penerima); tanpa itu hasilnya `MEAL_APPROVAL_REQUIRED` dan tidak ada yang dicatat.
   */
  async createOrder(
    type: OrderType,
    opts: { tableNo?: string; employeeId?: string; approver?: ApproverInput } = {},
  ): Promise<Result<OrderRecord>> {
    const w = this.who();
    if (!w.ok) return w;
    if (!this.shift) return fail('NO_SHIFT', 'Buka shift terlebih dahulu.');
    if (type === 'EMPLOYEE' && !opts.employeeId) return fail('EMPLOYEE_REQUIRED', 'Pilih karyawan penerima.');

    let approverId: string | undefined;
    if (type === 'EMPLOYEE') {
      let supplied: string | undefined;
      if (opts.approver) {
        const a = await this.checkApprovers([opts.approver]);
        if (!a.ok) return a;
        supplied = a.value[0];
      }
      const decision = decideEmployeeMeal(
        { actorId: w.value, employeeId: opts.employeeId!, mealsToday: this.mealsToday(opts.employeeId!), approverId: supplied },
        this.ctx(),
      );
      if (!decision.ok) return fail(decision.code, decision.message);
      approverId = decision.approverId;
    }

    this.counter += 1;
    await this.d.store.write({ counter: this.counter });
    const id = `${this.cfg.deviceId}-${this.counter}`;
    const e = await this.emit({
      type: 'order.created',
      payload: {
        orderId: id, orderType: type,
        ...(opts.employeeId ? { employeeId: opts.employeeId } : {}),
        ...(approverId ? { approverId } : {}),
      },
    });
    const o: OrderRecord = {
      id, number: this.counter, type, tableNo: opts.tableNo, employeeId: opts.employeeId, creatorId: w.value,
      createdAt: this.d.now(), shiftId: this.shift.id, items: [], discount: 0, payments: [], refunds: [], receipt: 'NONE',
      kitchen: null, state: reduceOrder(undefined, e)!,
    };
    await this.save(o);
    return ok(o);
  }

  async addItem(orderId: string, itemId: string, qty = 1): Promise<Result<OrderRecord>> {
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.state.status !== 'DRAFT' && o.state.status !== 'SENT') return fail('ORDER_LOCKED', 'Order sudah ditagih atau selesai; item tidak bisa diubah.');
    const item = this.cfg.menu.find((m) => m.id === itemId);
    if (!item) return fail('ITEM_NOT_FOUND', 'Menu tidak ditemukan.');
    if (!Number.isInteger(qty) || qty < 1) return fail('QTY_INVALID', 'Jumlah tidak valid.');
    const line = o.items.find((l) => l.itemId === itemId);
    if (line) line.qty += qty;
    else o.items.push({ itemId, name: item.name, qty, unitPrice: item.price, sentQty: 0 });
    await this.save(o);
    return ok(o);
  }

  /** Mengubah jumlah. Item yang sudah dikirim ke dapur tidak boleh dikurangi di bawah jumlah yang terkirim. */
  async setQty(orderId: string, itemId: string, qty: number): Promise<Result<OrderRecord>> {
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.state.status !== 'DRAFT' && o.state.status !== 'SENT') return fail('ORDER_LOCKED', 'Order sudah ditagih atau selesai; item tidak bisa diubah.');
    const line = o.items.find((l) => l.itemId === itemId);
    if (!line) return fail('ITEM_NOT_FOUND', 'Item tidak ada di order.');
    if (!Number.isInteger(qty) || qty < 0) return fail('QTY_INVALID', 'Jumlah tidak valid.');
    if (qty < line.sentQty) return fail('ITEM_SENT', 'Item sudah dikirim ke dapur. Gunakan void dengan persetujuan.');
    if (qty === 0) o.items = o.items.filter((l) => l !== line);
    else line.qty = qty;
    await this.save(o);
    return ok(o);
  }

  async sendToKitchen(orderId: string): Promise<Result<OrderRecord>> {
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.state.status !== 'DRAFT' && o.state.status !== 'SENT') return fail('ORDER_LOCKED', 'Order sudah ditagih atau selesai.');
    const fresh = o.items.filter((l) => l.qty > l.sentQty);
    if (fresh.length === 0) return fail('NOTHING_TO_SEND', 'Tidak ada item baru untuk dikirim.');
    await this.d.printer.print(renderKitchenTicket({ ...o, items: fresh.map((l) => ({ ...l, qty: l.qty - l.sentQty })) }));
    const e = await this.emit({
      type: 'order.sent_to_kitchen',
      payload: { orderId, items: fresh.map((l) => ({ itemId: l.itemId, name: l.name, qty: l.qty - l.sentQty, unitPrice: l.unitPrice })) },
    });
    for (const l of o.items) l.sentQty = l.qty;
    await this.apply(o, e);
    return ok(o);
  }

  async setKitchenStatus(orderId: string, status: KitchenStatus): Promise<Result<OrderRecord>> {
    const w = this.who();
    if (!w.ok) return w;
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.state.status === 'DRAFT') return fail('NOT_SENT', 'Order belum dikirim ke dapur.');
    const e = await this.emit({ type: 'kitchen.status_changed', payload: { orderId, status } });
    o.kitchen = status;
    await this.apply(o, e);
    return ok(o);
  }

  /**
   * Mencetak bill. Bila printer gagal, bill dapat ditampilkan di layar customer (`onScreen`) dan tetap tercatat,
   * karena sejak itu diskon dan perubahan nominal harus melalui persetujuan.
   */
  async printBill(orderId: string, opts: { onScreen?: boolean } = {}): Promise<Result<OrderRecord>> {
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.state.status === 'VOIDED' || o.state.status === 'PAID') return fail('ORDER_LOCKED', 'Order sudah selesai.');
    if (o.items.length === 0) return fail('EMPTY_ORDER', 'Order masih kosong.');
    const printed = await this.d.printer.print(renderBill(o, this.cfg));
    if (!printed && !opts.onScreen) return fail('PRINT_FAILED', 'Bill gagal dicetak. Tampilkan di layar customer atau periksa printer.');
    const e = await this.emit({
      type: 'bill.printed',
      payload: {
        orderId, total: this.totals(o).total,
        items: o.items.map((l) => ({ itemId: l.itemId, name: l.name, qty: l.qty, unitPrice: l.unitPrice })),
      },
    });
    await this.apply(o, e);
    return ok(o);
  }

  async applyDiscount(
    orderId: string,
    cmd: { kind: 'MANUAL' | 'MEMBER' | 'COUPON'; percent?: number; amount?: number; verified: boolean; approver?: ApproverInput },
  ): Promise<Result<OrderRecord>> {
    const w = this.who();
    if (!w.ok) return w;
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    const subtotal = this.totals(o).subtotal;
    if (subtotal === 0) return fail('EMPTY_ORDER', 'Order masih kosong.');

    const amount = cmd.percent !== undefined ? Math.round((subtotal * cmd.percent) / 100) : (cmd.amount ?? 0);
    if (!Number.isInteger(amount) || amount <= 0 || o.discount + amount > subtotal) return fail('AMOUNT_INVALID', 'Nominal diskon tidak valid.');
    const percent = cmd.percent ?? Math.round((amount / subtotal) * 1000) / 10;

    let approverId: string | undefined;
    if (cmd.approver) {
      const a = await this.checkApprovers([cmd.approver]);
      if (!a.ok) return a;
      approverId = a.value[0];
    }
    const decision = decideDiscount(o.state, { actorId: w.value, kind: cmd.kind, amount, percent, verified: cmd.verified, approverId }, this.ctx());
    if (!decision.ok) return fail(decision.code, decision.message);

    const e = await this.emit(decision.body);
    o.discount += amount;
    await this.apply(o, e);
    return ok(o);
  }

  async pay(
    orderId: string,
    p: { method: PaymentMethod; amount?: number; tendered?: number; tid?: string; approvalCode?: string },
  ): Promise<Result<{ order: OrderRecord; change: number }>> {
    const w = this.who();
    if (!w.ok) return w;
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.state.status === 'VOIDED' || o.state.status === 'PAID') return fail('ORDER_LOCKED', 'Order sudah selesai.');
    if (!o.state.billPrinted) return fail('BILL_REQUIRED', 'Tagihan harus dicetak atau ditampilkan sebelum pembayaran.');

    const due = this.outstanding(o);
    let amount = p.amount ?? due;
    let change = 0;
    if (p.method === 'CASH') {
      const tendered = p.tendered ?? amount;
      if (tendered < Math.min(amount, due)) return fail('TENDERED_TOO_LOW', 'Uang diterima kurang dari tagihan.');
      amount = Math.min(amount, due);
      change = Math.max(0, tendered - amount);
    } else if (amount > due) {
      return fail('AMOUNT_INVALID', 'Nominal melebihi sisa tagihan.');
    }
    if (!Number.isInteger(amount) || amount <= 0) return fail('AMOUNT_INVALID', 'Nominal tidak valid.');

    let tid = p.tid;
    if (p.method !== 'CASH') {
      tid ??= this.cfg.edcs.length === 1 ? this.cfg.edcs[0]!.tid : undefined;
      if (!tid) return fail('EDC_REQUIRED', 'Pilih mesin EDC yang dipakai.');
      if (!this.cfg.edcs.some((x) => x.tid === tid)) return fail('EDC_UNKNOWN', 'Mesin EDC tidak terdaftar di outlet ini.');
    }

    const e = await this.emit({
      type: 'payment.received',
      payload: {
        orderId, method: p.method, amount,
        ...(tid ? { tid } : {}), ...(p.approvalCode ? { approvalCode: p.approvalCode } : {}),
      },
    });
    o.payments.push({ method: p.method, amount, tid, approvalCode: p.approvalCode, at: this.d.now() });
    await this.apply(o, e);
    return ok({ order: o, change });
  }

  async printReceipt(orderId: string): Promise<Result<OrderRecord>> {
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.state.status !== 'PAID') return fail('NOT_PAID', 'Struk hanya untuk order yang sudah lunas.');
    if (o.receipt !== 'NONE') return fail('RECEIPT_DONE', 'Struk sudah diproses.');
    if (!(await this.d.printer.print(renderReceipt(o, this.cfg)))) {
      return fail('PRINT_FAILED', 'Struk gagal dicetak. Periksa kertas, atau catat bahwa customer menolak struk.');
    }
    await this.emit({ type: 'receipt.printed', payload: { orderId } });
    o.receipt = 'PRINTED';
    await this.save(o);
    return ok(o);
  }

  async declineReceipt(orderId: string, reason: 'CUSTOMER_DECLINED' | 'NO_PAPER' | 'NO_PHONE'): Promise<Result<OrderRecord>> {
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.state.status !== 'PAID') return fail('NOT_PAID', 'Struk hanya untuk order yang sudah lunas.');
    if (o.receipt !== 'NONE') return fail('RECEIPT_DONE', 'Struk sudah diproses.');
    await this.emit({ type: 'receipt.declined', payload: { orderId, reason } });
    o.receipt = 'DECLINED';
    await this.save(o);
    return ok(o);
  }

  async voidOrder(orderId: string, reasonCode: string, approvers: ApproverInput[]): Promise<Result<OrderRecord>> {
    const w = this.who();
    if (!w.ok) return w;
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    const a = await this.checkApprovers(approvers);
    if (!a.ok) return a;
    const amount = paidTotal(o) > 0 ? paidTotal(o) : this.totals(o).total;
    const decision = decideVoid(o.state, { actorId: w.value, approverIds: a.value, reasonCode, amount }, this.ctx());
    if (!decision.ok) return fail(decision.code, decision.message);
    const e = await this.emit(decision.body);
    await this.apply(o, e);
    return ok(o);
  }

  async refund(orderId: string, amount: number, method: PaymentMethod, approver: ApproverInput): Promise<Result<OrderRecord>> {
    const w = this.who();
    if (!w.ok) return w;
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    const a = await this.checkApprovers([approver]);
    if (!a.ok) return a;
    const refundId = `${o.id}-R${o.refunds.length + 1}`;
    const decision = decideRefund(o.state, { actorId: w.value, refundId, approverId: a.value[0]!, amount, method }, this.ctx());
    if (!decision.ok) return fail(decision.code, decision.message);
    await this.emit(decision.body);
    o.refunds.push({ amount, method });
    await this.save(o);
    return ok(o);
  }

  // ---------- printer dan perangkat ----------

  paperClaimActive(): boolean {
    return this.claim;
  }

  /** Tombol "kertas habis" dari kasir. Selama aktif, tampilan menawarkan struk digital. */
  async setPaperClaim(active: boolean): Promise<Result<void>> {
    const w = this.who();
    if (!w.ok) return w;
    if (active === this.claim) return ok(undefined);
    this.claim = active;
    await this.d.store.write({ paperClaim: active });
    await this.emit({ type: 'printer.paper_claim', payload: { active } });
    return ok(undefined);
  }

  /** Membaca status printer; mencatat event hanya saat status berubah. */
  async pollPrinter(): Promise<PrinterState | null> {
    if (!this.d.printer.capabilities.reportsPaperStatus) return null;
    const s = await this.d.printer.status();
    if (s !== this.lastPrinter) {
      this.lastPrinter = s;
      await this.d.recorder.record({ type: 'printer.status', payload: { state: s, source: 'device' } }, this.user);
    }
    return s;
  }

  /** Melaporkan postur keamanan perangkat (waktu otomatis, ADB, kios, root) sebagai event. */
  async reportPosture(p: { autoTime: boolean; adb: boolean; devOptions: boolean; kiosk: boolean; rooted: boolean; appVersion: string }): Promise<void> {
    await this.d.recorder.record({ type: 'device.posture', payload: p }, null);
  }

  async heartbeat(): Promise<void> {
    await this.d.recorder.record({ type: 'device.heartbeat', payload: { kind: 'terminal' } }, null);
  }

  /** Tampilan untuk layar customer. */
  customerView(orderId: string | null): { merchantName: string; lines: { name: string; qty: number; amount: number }[]; totals: Totals; status: string } | null {
    const o = orderId ? this.orders.get(orderId) : undefined;
    if (!o) return null;
    return {
      merchantName: this.cfg.merchantName,
      lines: o.items.map((l) => ({ name: l.name, qty: l.qty, amount: l.qty * l.unitPrice })),
      totals: this.totals(o),
      status: o.state.status,
    };
  }
}

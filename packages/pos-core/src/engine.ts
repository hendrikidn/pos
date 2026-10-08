import { MAX_EVENT_LINES, MAX_LINE_QTY, type KitchenStatus, type LineItem, type OrderType, type PaymentMethod, type PosEvent, type PrinterState } from '@pos/events';
import { DEFAULT_POLICY, decideDiscount, decideEmployeeMeal, decideRefund, decideVoid, isHoldReason, MAX_NOTE_LENGTH, reduceOrder, resolveSelection, type Ctx } from '@pos/order';
import { Directory } from './directory';
import type { Printer } from './printer';
import type { Recorder } from './recorder';
import type { KeyValueStore } from './store';
import { computeTotals, lineLabel, paidTotal, renderBill, renderKitchenTicket, renderReceipt, type Totals } from './totals';
import {
  fail, lineKey, ok, type CartLine, type OrderRecord, type PosConfig, type Result, type ShiftRecord, type StaffPublic,
} from './types';

export interface EngineDeps {
  config: PosConfig;
  recorder: Recorder;
  store: KeyValueStore;
  printer: Printer;
  now: () => number;
  /** Pembuat token struk digital (22 karakter base64url). Bawaan: 128 bit acak dari WebCrypto. */
  randomToken?: () => string;
}

/** 128 bit acak sebagai base64url tanpa padding (22 karakter). */
export function randomReceiptToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

/** Dua baris sama bila menu, himpunan opsi, dan catatannya sama. */
const signature = (itemId: string, optionIds: string[], note: string | undefined) =>
  JSON.stringify([itemId, [...optionIds].sort(), note ?? '']);

/**
 * Menaruh baris ke order: digabung ke baris yang sama (menu, opsi, dan catatan sama) atau menjadi baris baru. Baris pertama
 * sebuah menu memakai itemId sebagai lineId (sama dengan order lama); berikutnya diberi nomor.
 */
function placeLine(o: OrderRecord, l: CartLine): void {
  placeLineIn(o.items, l);
}

/** Batas isi order yang sama dengan yang ditegakkan server pada event (jika dilanggar, sinkronisasi terminal macet): 100 baris, 999 per baris. */
function fitsOrder(items: CartLine[], l: CartLine): { code: 'TOO_MANY_LINES' | 'QTY_TOO_LARGE'; message: string } | null {
  const sig = signature(l.itemId, (l.options ?? []).map((x) => x.optionId), l.note);
  const same = items.find((x) => signature(x.itemId, (x.options ?? []).map((y) => y.optionId), x.note) === sig);
  if (same ? same.qty + l.qty > MAX_LINE_QTY : l.qty > MAX_LINE_QTY) return { code: 'QTY_TOO_LARGE', message: `Jumlah per baris maksimal ${MAX_LINE_QTY}.` };
  if (!same && items.length >= MAX_EVENT_LINES) return { code: 'TOO_MANY_LINES', message: `Satu order maksimal ${MAX_EVENT_LINES} baris berbeda. Bayar atau pisahkan order ini dulu.` };
  return null;
}

function placeLineIn(items: CartLine[], l: CartLine): void {
  const sig = signature(l.itemId, (l.options ?? []).map((x) => x.optionId), l.note);
  const same = items.find((x) => signature(x.itemId, (x.options ?? []).map((y) => y.optionId), x.note) === sig);
  if (same) {
    same.qty += l.qty;
    same.sentQty += l.sentQty;
    return;
  }
  const taken = new Set(items.map(lineKey));
  let lineId = l.itemId;
  for (let n = 2; taken.has(lineId); n++) lineId = `${l.itemId}#${n}`;
  items.push({ ...l, lineId });
}

const KITCHEN_RANK: Record<KitchenStatus, number> = { COOKING: 1, READY: 2, SERVED: 3 };
const furthest = (a: KitchenStatus | null, b: KitchenStatus | null): KitchenStatus | null =>
  !a ? b : !b ? a : KITCHEN_RANK[a] >= KITCHEN_RANK[b] ? a : b;

/** Baris pesanan untuk payload event: nama dan harga disalin saat kejadian. */
const eventLine = (l: CartLine, qty: number, sentQty?: number): LineItem => ({
  itemId: l.itemId, name: l.name, qty, unitPrice: l.unitPrice,
  ...(sentQty !== undefined ? { sentQty } : {}),
  ...(l.options ? { options: l.options.map((x) => ({ id: x.optionId, group: x.group, name: x.name, price: x.price })) } : {}),
  ...(l.note ? { note: l.note } : {}),
});

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

  /** Mencatat uang tunai yang masuk/keluar laci pada shift berjalan (hanya metode TUNAI). */
  private async trackCash(dir: 'in' | 'out', method: PaymentMethod, amount: number): Promise<void> {
    if (method !== 'CASH' || !this.shift || this.shift.cashIn === undefined || this.shift.cashOut === undefined) return;
    if (dir === 'in') this.shift.cashIn += amount;
    else this.shift.cashOut += amount;
    await this.d.store.write({ shift: this.shift });
  }

  async openShift(openingCash: number): Promise<Result<ShiftRecord>> {
    const w = this.who();
    if (!w.ok) return w;
    if (this.shift) return fail('SHIFT_OPEN', 'Shift sudah dibuka.');
    if (!Number.isInteger(openingCash) || openingCash < 0) return fail('AMOUNT_INVALID', 'Modal awal tidak valid.');
    this.shift = { id: `${this.cfg.deviceId}-S${this.d.now()}`, userId: w.value, openedAt: this.d.now(), openingCash, cashIn: 0, cashOut: 0 };
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

    // Shift baru melacak kas sendiri (sama dengan hitungan ulang server); shift lama (sebelum pelacakan) dihitung dari order-nya.
    let { cashIn, cashOut } = this.shift;
    const tracked = cashIn !== undefined && cashOut !== undefined;
    if (cashIn === undefined || cashOut === undefined) {
      const mine = this.listOrders().filter((o) => o.shiftId === this.shift!.id);
      cashIn = mine.flatMap((o) => o.payments).filter((p) => p.method === 'CASH').reduce((s, p) => s + p.amount, 0);
      cashOut = mine.flatMap((o) => o.refunds).filter((r) => r.method === 'CASH').reduce((s, r) => s + r.amount, 0);
    }
    const expected = this.shift.openingCash + cashIn - cashOut;

    await this.emit({ type: 'cash.counted', payload: { shiftId: this.shift.id, counted, expected, ...(tracked ? { tracked: true } : {}) } });
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
        ...(type === 'DINE_IN' && opts.tableNo ? { tableNo: opts.tableNo } : {}),
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

  /**
   * Menambah menu ke order. Menu dengan varian/tambahan memerlukan `options` (id opsi) sesuai batas tiap grup; harga satuan
   * akhir = harga menu + harga opsi. Baris dengan menu, opsi, dan catatan yang sama digabung; selain itu menjadi baris baru.
   */
  async addItem(orderId: string, itemId: string, qty = 1, opts: { options?: string[]; note?: string } = {}): Promise<Result<OrderRecord>> {
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.state.status !== 'DRAFT' && o.state.status !== 'SENT') return fail('ORDER_LOCKED', 'Order sudah ditagih atau selesai; item tidak bisa diubah.');
    const item = this.cfg.menu.find((m) => m.id === itemId);
    if (!item) return fail('ITEM_NOT_FOUND', 'Menu tidak ditemukan.');
    if (!Number.isInteger(qty) || qty < 1) return fail('QTY_INVALID', 'Jumlah tidak valid.');
    const note = opts.note?.trim() || undefined;
    if (note && note.length > MAX_NOTE_LENGTH) return fail('NOTE_TOO_LONG', `Catatan maksimal ${MAX_NOTE_LENGTH} karakter.`);
    const sel = resolveSelection(item.modifierGroups, opts.options ?? []);
    if (!sel.ok) return fail(sel.code, sel.message);

    const fresh: CartLine = { itemId, name: item.name, qty, unitPrice: item.price + sel.extra, sentQty: 0 };
    if (sel.options.length > 0) fresh.options = sel.options;
    if (note) fresh.note = note;
    const over = fitsOrder(o.items, fresh);
    if (over) return fail(over.code, over.message);
    placeLine(o, fresh);
    await this.save(o);
    return ok(o);
  }

  /** Mengubah jumlah baris (`lineId`; untuk order lama sama dengan itemId). Baris yang sudah dikirim ke dapur tidak boleh dikurangi di bawah jumlah terkirim. */
  async setQty(orderId: string, lineId: string, qty: number): Promise<Result<OrderRecord>> {
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.state.status !== 'DRAFT' && o.state.status !== 'SENT') return fail('ORDER_LOCKED', 'Order sudah ditagih atau selesai; item tidak bisa diubah.');
    const line = o.items.find((l) => lineKey(l) === lineId);
    if (!line) return fail('ITEM_NOT_FOUND', 'Item tidak ada di order.');
    if (!Number.isInteger(qty) || qty < 0) return fail('QTY_INVALID', 'Jumlah tidak valid.');
    if (qty > MAX_LINE_QTY) return fail('QTY_TOO_LARGE', `Jumlah per baris maksimal ${MAX_LINE_QTY}.`);
    if (qty < line.sentQty) return fail('ITEM_SENT', 'Item sudah dikirim ke dapur. Gunakan void dengan persetujuan.');
    if (qty === 0) o.items = o.items.filter((l) => l !== line);
    else line.qty = qty;
    await this.save(o);
    return ok(o);
  }

  /** Mengubah catatan baris. Hanya untuk baris yang belum dikirim ke dapur (catatan sesudahnya tidak akan terbaca dapur). */
  async setNote(orderId: string, lineId: string, note: string): Promise<Result<OrderRecord>> {
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.state.status !== 'DRAFT' && o.state.status !== 'SENT') return fail('ORDER_LOCKED', 'Order sudah ditagih atau selesai; item tidak bisa diubah.');
    const line = o.items.find((l) => lineKey(l) === lineId);
    if (!line) return fail('ITEM_NOT_FOUND', 'Item tidak ada di order.');
    if (line.sentQty > 0) return fail('ITEM_SENT', 'Item sudah dikirim ke dapur; catatan tidak bisa diubah.');
    const next = note.trim();
    if (next.length > MAX_NOTE_LENGTH) return fail('NOTE_TOO_LONG', `Catatan maksimal ${MAX_NOTE_LENGTH} karakter.`);
    const sig = signature(line.itemId, (line.options ?? []).map((x) => x.optionId), next || undefined);
    if (o.items.some((l) => l !== line && signature(l.itemId, (l.options ?? []).map((x) => x.optionId), l.note) === sig)) {
      return fail('LINE_DUPLICATE', 'Sudah ada baris yang sama dengan catatan itu; ubah jumlahnya di baris tersebut.');
    }
    if (next) line.note = next;
    else delete line.note;
    await this.save(o);
    return ok(o);
  }

  // ---------- meja, pisah bill, gabung order ----------

  /** Memindahkan order dine-in ke meja lain. Tercatat sebagai event agar perpindahan meja bisa ditelusuri. */
  async moveTable(orderId: string, tableNo: string): Promise<Result<OrderRecord>> {
    const w = this.who();
    if (!w.ok) return w;
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.type !== 'DINE_IN') return fail('NOT_DINE_IN', 'Hanya order dine-in yang punya meja.');
    if (!ACTIVE.has(o.state.status)) return fail('ORDER_LOCKED', 'Order sudah selesai.');
    const to = tableNo.trim();
    if (to === '' || to.length > 10) return fail('TABLE_INVALID', 'Nomor meja wajib diisi (maksimal 10 karakter).');
    if (to === o.tableNo) return fail('TABLE_SAME', 'Order sudah berada di meja itu.');
    await this.emit({ type: 'order.table_changed', payload: { orderId, ...(o.tableNo ? { from: o.tableNo } : {}), to } });
    o.tableNo = to;
    await this.save(o);
    return ok(o);
  }

  /**
   * Memisahkan sebagian item ke bill baru (order baru dengan jenis dan meja yang sama) agar dibayar terpisah. Hanya sebelum
   * tagihan dicetak: tagihan yang sudah dicetak berisi total lama. Minimal satu item tetap di bill awal. Item yang sudah dikirim
   * ke dapur tetap tercatat terkirim di bill baru, sehingga tidak dikirim dua kali.
   */
  async splitOrder(orderId: string, picks: { lineId: string; qty: number }[]): Promise<Result<OrderRecord>> {
    const w = this.who();
    if (!w.ok) return w;
    if (!this.shift) return fail('NO_SHIFT', 'Buka shift terlebih dahulu.');
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.type === 'EMPLOYEE') return fail('SPLIT_EMPLOYEE', 'Order makan karyawan tidak bisa dipisah.');
    if (o.state.status !== 'DRAFT' && o.state.status !== 'SENT') {
      return fail('SPLIT_LOCKED', 'Tagihan sudah dicetak atau order sudah selesai. Pisahkan item sebelum mencetak tagihan.');
    }
    if (picks.length === 0) return fail('SPLIT_EMPTY', 'Pilih item yang akan dipisah.');
    if (new Set(picks.map((p) => p.lineId)).size !== picks.length) return fail('SPLIT_INVALID', 'Baris dipilih lebih dari sekali.');
    let moving = 0;
    for (const p of picks) {
      const l = o.items.find((x) => lineKey(x) === p.lineId);
      if (!l) return fail('ITEM_NOT_FOUND', 'Item tidak ada di order.');
      if (!Number.isInteger(p.qty) || p.qty < 1 || p.qty > l.qty) return fail('QTY_INVALID', `Jumlah ${l.name} tidak valid.`);
      moving += p.qty;
    }
    if (moving >= o.items.reduce((s, l) => s + l.qty, 0)) {
      return fail('SPLIT_ALL', 'Sisakan minimal satu item di bill awal. Untuk memindahkan semuanya, gabungkan order.');
    }

    this.counter += 1;
    await this.d.store.write({ counter: this.counter });
    const id = `${this.cfg.deviceId}-${this.counter}`;
    const created = await this.emit({ type: 'order.created', payload: { orderId: id, orderType: o.type, ...(o.tableNo ? { tableNo: o.tableNo } : {}) } });
    const dest: OrderRecord = {
      id, number: this.counter, type: o.type, tableNo: o.tableNo, creatorId: w.value, createdAt: this.d.now(), shiftId: this.shift.id,
      items: [], discount: 0, payments: [], refunds: [], receipt: 'NONE', kitchen: null, splitFrom: o.id,
      state: reduceOrder(undefined, created)!,
    };
    const moved: LineItem[] = [];
    let sent = false;
    for (const p of picks) {
      const l = o.items.find((x) => lineKey(x) === p.lineId)!;
      const unsent = l.qty - l.sentQty;
      const movedSent = Math.max(0, p.qty - unsent);
      sent ||= movedSent > 0;
      placeLine(dest, { itemId: l.itemId, name: l.name, qty: p.qty, unitPrice: l.unitPrice, sentQty: movedSent, ...(l.options ? { options: l.options } : {}), ...(l.note ? { note: l.note } : {}) });
      moved.push(eventLine(l, p.qty, movedSent));
      l.qty -= p.qty;
      l.sentQty -= movedSent;
    }
    o.items = o.items.filter((l) => l.qty > 0);
    const kitchen = sent ? o.kitchen : null;
    const e = await this.emit({
      type: 'order.items_moved',
      payload: { fromOrderId: o.id, toOrderId: id, kind: 'SPLIT', items: moved, sent, ...(kitchen ? { kitchen } : {}) },
    });
    dest.state = reduceOrder(dest.state, e) ?? dest.state;
    dest.kitchen = dest.state.kitchen;
    // Order asal masih berstatus "di dapur" hanya bila masih punya item terkirim.
    if (o.state.status === 'SENT' && !o.items.some((l) => l.sentQty > 0)) o.state = { ...o.state, status: 'DRAFT' };
    await this.save(dest);
    await this.save(o);
    return ok(dest);
  }

  /**
   * Menggabungkan order lain (`fromId`) ke order ini (`intoId`): seluruh item pindah dan order asal ditutup (MERGED). Syaratnya
   * kedua order sejenis (dine-in atau take-away), belum ditagih, dan bukan makan karyawan. Status dapur order gabungan mengikuti
   * yang paling maju, sehingga kunci void tetap memperlakukan makanan yang sudah disajikan sebagai sudah disajikan.
   */
  async mergeOrders(intoId: string, fromId: string): Promise<Result<OrderRecord>> {
    const w = this.who();
    if (!w.ok) return w;
    if (intoId === fromId) return fail('MERGE_SAME', 'Pilih order yang berbeda.');
    const a = this.order(intoId);
    if (!a.ok) return a;
    const b = this.order(fromId);
    if (!b.ok) return b;
    const into = a.value;
    const from = b.value;
    if (into.type === 'EMPLOYEE' || from.type === 'EMPLOYEE') return fail('MERGE_EMPLOYEE', 'Order makan karyawan tidak bisa digabung.');
    if (into.type !== from.type) return fail('MERGE_TYPE', 'Hanya order sejenis (dine-in dengan dine-in, take-away dengan take-away) yang bisa digabung.');
    for (const o of [into, from]) {
      if (o.state.status !== 'DRAFT' && o.state.status !== 'SENT') {
        return fail('MERGE_LOCKED', `Order #${o.number} sudah ditagih atau selesai. Gabungkan sebelum mencetak tagihan.`);
      }
    }
    if (from.items.length === 0) return fail('EMPTY_ORDER', `Order #${from.number} masih kosong.`);

    // Hasil gabungan harus muat dalam batas event; diperiksa pada salinan sebelum ada yang diubah.
    const trial = into.items.map((l) => ({ ...l }));
    for (const l of from.items) {
      const over = fitsOrder(trial, l);
      if (over) return fail(over.code, `Tidak bisa digabung: ${over.message}`);
      placeLineIn(trial, { ...l });
    }
    const moved = from.items.map((l) => eventLine(l, l.qty, l.sentQty));
    const sent = from.items.some((l) => l.sentQty > 0);
    const kitchen = furthest(into.kitchen, from.kitchen);
    for (const l of from.items) placeLine(into, { ...l });
    from.items = [];
    from.mergedInto = into.id;
    const e = await this.emit({
      type: 'order.items_moved',
      payload: { fromOrderId: from.id, toOrderId: into.id, kind: 'MERGE', items: moved, sent, ...(kitchen ? { kitchen } : {}) },
    });
    from.state = reduceOrder(from.state, e) ?? from.state;
    into.state = reduceOrder(into.state, e) ?? into.state;
    into.kitchen = into.state.kitchen;
    await this.save(from);
    await this.save(into);
    return ok(into);
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
      payload: { orderId, items: fresh.map((l) => eventLine(l, l.qty - l.sentQty)) },
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
    o.billedAt ??= this.d.now();
    const e = await this.emit({
      type: 'bill.printed',
      payload: {
        orderId, total: this.totals(o).total,
        items: o.items.map((l) => eventLine(l, l.qty)),
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

  /**
   * Berapa menit bill tunai ini sudah ditahan bila melewati batas kebijakan dan alasannya belum dicatat; selain itu null.
   * Dipakai tampilan untuk meminta alasan sebelum kasir membayar.
   */
  holdRequiredMinutes(o: OrderRecord): number | null {
    const limit = (this.cfg.policy ?? DEFAULT_POLICY).holdBillMinutes;
    if (!limit || limit <= 0 || o.billedAt === undefined || o.holdLogged || o.state.status === 'PAID' || o.state.status === 'VOIDED') return null;
    const minutes = Math.floor((this.d.now() - o.billedAt) / 60_000);
    return minutes >= limit ? minutes : null;
  }

  /**
   * Menerima pembayaran. Pembayaran TUNAI untuk bill yang sudah ditahan melewati batas (`holdBillMinutes`) memerlukan
   * `holdReason` dari daftar baku; alasan dicatat sebagai event `bill.hold_reason` sebelum pembayarannya (kontrol bill recycling).
   */
  async pay(
    orderId: string,
    p: { method: PaymentMethod; amount?: number; tendered?: number; tid?: string; approvalCode?: string; holdReason?: string },
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

    const held = p.method === 'CASH' ? this.holdRequiredMinutes(o) : null;
    if (held !== null) {
      if (!isHoldReason(p.holdReason)) {
        return fail('HOLD_REASON_REQUIRED', `Bill ini sudah ${held} menit terbuka. Pilih alasan sebelum menerima pembayaran tunai.`);
      }
      await this.emit({ type: 'bill.hold_reason', payload: { orderId, reason: p.holdReason, heldMinutes: held } });
      o.holdLogged = true;
    }
    const e = await this.emit({
      type: 'payment.received',
      payload: {
        orderId, method: p.method, amount,
        ...(tid ? { tid } : {}), ...(p.approvalCode ? { approvalCode: p.approvalCode } : {}),
      },
    });
    o.payments.push({ method: p.method, amount, tid, approvalCode: p.approvalCode, at: this.d.now() });
    await this.trackCash('in', p.method, amount);
    await this.apply(o, e);
    return ok({ order: o, change });
  }

  /**
   * Struk digital (QR) untuk order lunas. Idempoten: satu order satu token dan satu event; memanggilnya lagi hanya mengembalikan
   * token yang sama. Struk digital dihitung sebagai struk yang diberikan (kecuali sudah dicetak), dan tidak memerlukan nomor HP.
   */
  digitalReceipt(orderId: string): Promise<Result<{ token: string; order: OrderRecord }>> {
    // Panggilan bersamaan (mis. render ulang saat event masih ditulis) berbagi satu pekerjaan: tanpa ini keduanya melihat "belum ada
    // token" dan mencatat dua event dengan token berbeda.
    const running = this.receiptJobs.get(orderId);
    if (running) return running;
    const job = this.makeDigitalReceipt(orderId).finally(() => this.receiptJobs.delete(orderId));
    this.receiptJobs.set(orderId, job);
    return job;
  }

  private readonly receiptJobs = new Map<string, Promise<Result<{ token: string; order: OrderRecord }>>>();

  private async makeDigitalReceipt(orderId: string): Promise<Result<{ token: string; order: OrderRecord }>> {
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.state.status !== 'PAID') return fail('NOT_PAID', 'Struk hanya untuk order yang sudah lunas.');
    if (o.receipt === 'DECLINED') return fail('RECEIPT_DONE', 'Struk sudah dicatat tidak diberikan.');
    if (!o.receiptToken) {
      const token = (this.d.randomToken ?? randomReceiptToken)();
      await this.emit({ type: 'receipt.digital', payload: { orderId, token } });
      o.receiptToken = token;
      if (o.receipt === 'NONE') o.receipt = 'DIGITAL';
      await this.save(o);
    }
    return ok({ token: o.receiptToken, order: o });
  }

  async printReceipt(orderId: string): Promise<Result<OrderRecord>> {
    const r = this.order(orderId);
    if (!r.ok) return r;
    const o = r.value;
    if (o.state.status !== 'PAID') return fail('NOT_PAID', 'Struk hanya untuk order yang sudah lunas.');
    if (o.receipt === 'PRINTED' || o.receipt === 'DECLINED') return fail('RECEIPT_DONE', 'Struk sudah diproses.');
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
    await this.trackCash('out', method, amount);
    o.refunds.push({ amount, method });
    await this.save(o);
    return ok(o);
  }

  /**
   * Menerapkan status dapur yang diketahui server (dari layar dapur). Terminal hanya tahu status yang ia ubah sendiri; tanpa ini,
   * kunci void ("sudah disajikan → owner") tidak berlaku bila status SERVED dicatat dari layar dapur. Status hanya dimajukan.
   */
  async applyKitchenStatuses(statuses: Record<string, KitchenStatus>): Promise<number> {
    let changed = 0;
    for (const [id, st] of Object.entries(statuses)) {
      const o = this.orders.get(id);
      if (!o || o.state.status === 'VOIDED' || o.state.status === 'MERGED' || o.kitchen === st) continue;
      // Hanya maju: event status dari terminal ini mungkin belum sampai ke server, dan papan yang tertinggal tidak boleh membatalkan
      // "sudah disajikan" (kunci void: owner). Item susulan yang membuka tiket lagi justru membuat kunci lebih ketat, bukan lebih longgar.
      if (o.kitchen && KITCHEN_RANK[o.kitchen] >= KITCHEN_RANK[st]) continue;
      o.kitchen = st;
      o.state = { ...o.state, kitchen: st };
      await this.save(o);
      changed++;
    }
    return changed;
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
      lines: o.items.map((l) => ({ name: lineLabel(l), qty: l.qty, amount: l.qty * l.unitPrice })),
      totals: this.totals(o),
      status: o.state.status,
    };
  }
}

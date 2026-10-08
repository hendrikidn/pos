import {
  ConfigClient, demoConfig, EscPosPrinter, PosEngine, Recorder, STALE_AFTER_MS, SyncClient, toPosConfig, WebCryptoSigner,
  type Handoff, type KeyPairHolder, type OrderRecord, type Printer, type PosConfig, type Result, type Signer, type SyncResult,
} from '@pos/pos-core';
import type { KitchenStatus, PrinterState } from '@pos/events';
import type { KdsBoard, TableBoard } from '@pos/order';
import { IdbStore } from './idb-store';
import { createKdsRuntime, type KdsRuntime } from './kds-runtime';
import {
  hardware, isNative, kioskWanted, loadPrinterSetting, NativeSigner, TcpTransport, UsbTransport, type Posture,
} from './native';

export interface Settings {
  apiUrl: string;
  token: string;
}

export const loadSettings = (): Settings => {
  try {
    const raw = JSON.parse(localStorage.getItem('pos.settings') ?? '{}') as Partial<Settings>;
    return { apiUrl: raw.apiUrl ?? 'http://localhost:3000', token: raw.token ?? '' };
  } catch {
    return { apiUrl: 'http://localhost:3000', token: '' };
  }
};
export const saveSettings = (s: Settings) => localStorage.setItem('pos.settings', JSON.stringify(s));

/**
 * Printer simulasi untuk demo di browser: hasil cetak muncul di "Struk" dan kertas bisa dihabiskan dari Pengaturan.
 * Ganti dengan adapter perangkat (ESC/POS atau SDK printer) saat hardware ditentukan.
 */
export class BrowserPrinter implements Printer {
  readonly capabilities = { reportsPaperStatus: true };
  readonly tray: string[] = [];
  private listeners = new Set<() => void>();

  get paper(): boolean {
    return localStorage.getItem('pos.paper') !== '0';
  }
  setPaper(v: boolean): void {
    localStorage.setItem('pos.paper', v ? '1' : '0');
    this.emit();
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }
  async status(): Promise<PrinterState> {
    return this.paper ? 'ok' : 'paperOut';
  }
  async print(text: string): Promise<boolean> {
    if (!this.paper) return false;
    this.tray.unshift(text);
    this.tray.length = Math.min(this.tray.length, 20);
    this.emit();
    return true;
  }
}

export interface SyncStatus {
  configured: boolean;
  online: boolean;
  pending: number;
  lastError: string | null;
  lastOkAt: number | null;
}

export interface ConfigStatus {
  mode: 'server' | 'demo';
  version: string | null;
  fetchedAt: number | null;
  stale: boolean;
  lastError: string | null;
}

/** Satu pesanan toko web yang menunggu kasir (dari server). `options` = id opsi; `optionNames` hanya untuk tampilan. */
export interface WebPending {
  id: number;
  code: string;
  name: string;
  phone: string;
  type: 'TAKE_AWAY' | 'DINE_IN';
  tableNo: string | null;
  note: string | null;
  total: number;
  createdAt: number;
  items: { itemId: string; name: string; qty: number; unitPrice: number; options: string[]; optionNames: string[]; note: string | null }[];
}

/** Satu reservasi di papan kasir (tanpa nomor telepon). `depositRemaining` = uang muka yang masih bisa dipakai sebagai pembayaran. */
export interface ReservationItem {
  id: number;
  guestName: string;
  partySize: number;
  start: number;
  durationMin: number;
  tableNo: string | null;
  status: 'BOOKED' | 'SEATED';
  depositRemaining: number;
}

export interface Runtime {
  engine: PosEngine;
  /** Printer yang dipakai engine (simulasi, atau ESC/POS lewat jaringan/USB). */
  printer: Printer;
  /** Hanya ada bila printer simulasi dipakai (demo di browser). */
  sim: BrowserPrinter | null;
  escpos: EscPosPrinter | null;
  /** Status kertas terakhir menurut printer; null bila printer tidak melaporkan. */
  printerState(): PrinterState | null;
  /** true bila perangkat punya penandatangan berbasis perangkat keras (hanya Android). */
  keyInfo(): { native: boolean; hardwareBacked: boolean | null };
  posture(): Posture | null;
  config: PosConfig & { demoPins?: Record<string, string> };
  settings: Settings;
  /**
   * Order dine-in terbuka di semua terminal outlet (denah meja). Null selama belum pernah berhasil diunduh (offline atau mode demo);
   * `at` = kapan terakhir berhasil, agar UI bisa menandai data usang.
   */
  tableBoard(): { board: TableBoard; at: number } | null;
  /** Reservasi hari ini dan sebentar lagi dari server (tanpa nomor telepon); null bila belum pernah berhasil diunduh atau mode demo. */
  reservations(): { items: ReservationItem[]; at: number } | null;
  /** Pesanan toko web yang menunggu kasir; null bila belum pernah berhasil diunduh atau mode demo. */
  webOrders(): { orders: WebPending[]; at: number } | null;
  /** Menerima pesanan web: periksa menu terminal, klaim di server (hanya satu terminal berhasil), lalu buat order kasir yang tertaut. */
  acceptWebOrder(id: number): Promise<Result<OrderRecord>>;
  rejectWebOrder(id: number, reason: string): Promise<Result<true>>;
  /** Mendudukkan tamu yang datang (butuh koneksi); mengembalikan meja yang dipesan bila ada. */
  seatReservation(id: number): Promise<Result<{ tableNo: string | null; guestName: string }>>;
  /** Foto menu sebagai data URL (sudah diunduh dan tersimpan di terminal); null bila menu tanpa foto atau belum terunduh. */
  menuImage(id: string): string | null;
  /** Cari member lewat nomor HP di server (butuh koneksi). Tidak tersedia di mode demo. */
  memberLookup(phone: string): Promise<Result<{ id: string; name: string; points: number }>>;
  /** Mendaftarkan member baru dari kasir (dibatasi server per jam). */
  memberRegister(phone: string, name: string): Promise<Result<{ id: string; name: string; points: number }>>;
  /** Serah-terima order antar-terminal. Tidak tersedia di mode demo (perlu server). */
  handoffs(): { available: boolean; incoming: Handoff[] };
  /** Menyerahkan order ke terminal lain; event disinkronkan segera supaya terminal lain bisa melihatnya. */
  handOff(orderId: string): Promise<Result<OrderRecord>>;
  /** Mengambil order yang diserahkan: klaim atomik ke server dulu, baru order dibuat di terminal ini. */
  takeHandoff(orderId: string): Promise<Result<OrderRecord>>;
  /** Menarik kembali order yang diserahkan, selama belum diambil terminal lain (klaim ke server dulu). */
  reclaimHandoff(orderId: string): Promise<Result<OrderRecord>>;
  /**
   * Alamat struk digital untuk QR; null bila server belum memberi alamat dasarnya (`DASHBOARD_URL` belum diatur) atau terminal
   * dalam mode demo. API sendiri tidak menyajikan halaman struk, jadi alamat tebakan hanya akan menghasilkan 404 bagi customer.
   */
  receiptUrl(token: string): string | null;
  configStatus(): ConfigStatus;
  refreshConfig(): Promise<void>;
  syncStatus(): SyncStatus;
  onSyncChange(fn: () => void): () => void;
  syncNow(): Promise<SyncResult | null>;
}

export type Boot =
  | { kind: 'setup'; settings: Settings; error: string | null }
  | { kind: 'ready'; runtime: Runtime }
  | { kind: 'kds'; runtime: KdsRuntime };

export const isDemo = () => localStorage.getItem('pos.demo') === '1';
export const setDemo = (on: boolean) => (on ? localStorage.setItem('pos.demo', '1') : localStorage.removeItem('pos.demo'));

/**
 * Memulai terminal. Konfigurasi (staf, menu, pajak, EDC) selalu berasal dari server dan disimpan untuk dipakai offline.
 * Tanpa konfigurasi tersimpan dan tanpa server yang terjangkau, aplikasi menampilkan layar pengaturan awal.
 */
export async function createRuntime(): Promise<Boot> {
  const settings = loadSettings();
  const store = await IdbStore.open();
  const baseUrl = settings.apiUrl.replace(/\/$/, '');
  const demo = isDemo();

  const cc = settings.token ? new ConfigClient(store, { baseUrl, token: settings.token, now: Date.now }) : null;
  let config: (PosConfig & { demoPins?: Record<string, string> }) | null = null;
  let version: string | null = null;
  let fetchedAt: number | null = null;
  let configError: string | null = null;

  if (demo) {
    config = await demoConfig('senopati', 'pos-1');
    config.tables = [
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ no: String(n), area: 'Indoor', seats: n <= 4 ? 4 : 2 })),
      ...['T1', 'T2', 'T3'].map((no) => ({ no, area: 'Teras', seats: 6 })),
    ];
  } else if (cc) {
    let cached = await cc.cached();
    if (!cached) {
      const r = await cc.refresh();
      if (r.status === 'updated') cached = await cc.cached();
      else configError = r.status === 'unchanged' ? null : r.message;
    }
    // Perangkat layar dapur: bukan terminal kasir, tidak ada engine, staf, atau printer.
    if (cached?.config.deviceKind === 'kds') return { kind: 'kds', runtime: await createKdsRuntime(settings, store, cached.config) };
    if (cached) {
      config = toPosConfig(cached.config);
      version = cached.config.version;
      fetchedAt = cached.fetchedAt;
    }
  }
  if (!config) return { kind: 'setup', settings, error: configError };

  // ---- printer: ESC/POS lewat jaringan/USB bila dikonfigurasi dan berjalan di Android; selain itu simulasi ----
  const ps = loadPrinterSetting();
  let sim: BrowserPrinter | null = null;
  let escpos: EscPosPrinter | null = null;
  let printer: Printer;
  if (isNative && ps.kind === 'lan' && ps.host) escpos = new EscPosPrinter(new TcpTransport(ps.host, ps.port));
  else if (isNative && ps.kind === 'usb') escpos = new EscPosPrinter(new UsbTransport());
  if (escpos) {
    await escpos.probe();
    printer = escpos;
  } else {
    sim = new BrowserPrinter();
    printer = sim;
  }

  // ---- penandatangan: Keystore di Android, WebCrypto (kunci tidak dapat diekspor) di browser ----
  const holder: KeyPairHolder = {
    load: async () => store.get<CryptoKeyPair>('device-keypair'),
    save: (pair) => store.write({ 'device-keypair': pair }),
  };
  const nativeSigner = isNative ? new NativeSigner() : null;
  const signer: Signer = nativeSigner ?? (await WebCryptoSigner.create(holder));
  if (nativeSigner) await nativeSigner.publicKey(); // membuat kunci bila belum ada dan mengetahui apakah berbasis perangkat keras

  const recorder = new Recorder({ deviceId: config.deviceId, outletId: config.outletId, store, now: Date.now, signer });
  const engine = new PosEngine({ config, recorder, store, printer, now: Date.now });
  await engine.init();

  const sync = settings.token ? new SyncClient(recorder, { baseUrl, token: settings.token, now: Date.now }) : null;
  const status: SyncStatus = { configured: !!sync, online: false, pending: await recorder.pendingCount(), lastError: null, lastOkAt: null };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  const syncNow = async (): Promise<SyncResult | null> => {
    status.pending = await recorder.pendingCount();
    if (!sync) return (notify(), null);
    const r = await sync.flush();
    status.pending = await recorder.pendingCount();
    status.online = r.ok;
    status.lastError = r.ok ? null : r.message;
    if (r.ok) status.lastOkAt = Date.now();
    notify();
    return r;
  };

  const refreshConfig = async (): Promise<void> => {
    if (demo || !cc) return;
    const r = await cc.refresh();
    if (r.status === 'updated') {
      engine.setConfig(toPosConfig(r.config));
      version = r.config.version;
      fetchedAt = Date.now();
      configError = null;
      void syncImages();
    } else if (r.status === 'unchanged') {
      fetchedAt = Date.now();
      configError = null;
    } else {
      configError = r.message;
    }
    notify();
  };

  // Status dapur dari layar dapur (KDS): hanya dibaca bila ada order yang sudah dikirim ke dapur dan belum selesai.
  const pollKitchen = async () => {
    if (demo || !settings.token || !engine.listOrders().some((o) => ['SENT', 'BILLED'].includes(o.state.status) && o.items.some((l) => l.sentQty > 0))) return;
    try {
      const res = await fetch(`${baseUrl}/v1/kds/board`, { headers: { authorization: `Bearer ${settings.token}` } });
      if (!res.ok) return;
      const board = (await res.json()) as KdsBoard;
      const statuses: Record<string, KitchenStatus> = {};
      for (const t of board.tickets) if (t.status !== 'NEW') statuses[t.orderId] = t.status;
      for (const id of board.served) statuses[id] = 'SERVED';
      if ((await engine.applyKitchenStatuses(statuses)) > 0) notify();
    } catch {
      /* offline: status dapur yang diketahui terminal tetap yang terakhir */
    }
  };

  // Denah meja: order terbuka dari terminal lain. Hanya dibaca bila outlet punya denah; offline = papan terakhir yang diketahui.
  let tableBoard: { board: TableBoard; at: number } | null = null;
  const pollTables = async () => {
    if (demo || !settings.token || !engine.config.tables?.length) return;
    try {
      const res = await fetch(`${baseUrl}/v1/tables/board`, { headers: { authorization: `Bearer ${settings.token}` } });
      if (!res.ok) return;
      tableBoard = { board: (await res.json()) as TableBoard, at: Date.now() };
      notify();
    } catch {
      /* offline: denah memakai papan terakhir dan order lokal */
    }
  };

  // Reservasi: papan dari server untuk kasir, dan mendudukkan tamu.
  let reservationBoard: { items: ReservationItem[]; at: number } | null = null;
  const pollReservations = async () => {
    if (demo || !settings.token) return;
    try {
      const res = await fetch(`${baseUrl}/v1/reservations/board`, { headers: { authorization: `Bearer ${settings.token}` } });
      if (!res.ok) return;
      reservationBoard = { items: ((await res.json()) as { reservations: ReservationItem[] }).reservations, at: Date.now() };
      notify();
    } catch {
      /* offline: papan terakhir tetap dipakai */
    }
  };
  const seatReservation = async (id: number): Promise<Result<{ tableNo: string | null; guestName: string }>> => {
    if (demo || !settings.token) return { ok: false, code: 'NO_SERVER', message: 'Mendudukkan tamu memerlukan koneksi ke server.' };
    try {
      const res = await fetch(`${baseUrl}/v1/reservations/${id}/seat-device`, { method: 'POST', headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' }, body: '{}' });
      const body = (await res.json().catch(() => ({}))) as { tableNo?: string | null; guestName?: string; message?: string | string[] };
      if (!res.ok) return { ok: false, code: `RESERVATION_${res.status}`, message: (Array.isArray(body.message) ? body.message.join('; ') : body.message) ?? `Server menjawab ${res.status}.` };
      void pollReservations();
      return { ok: true, value: { tableNo: body.tableNo ?? null, guestName: body.guestName ?? '' } };
    } catch {
      return { ok: false, code: 'OFFLINE', message: 'Tidak terhubung ke server.' };
    }
  };

  // Pesanan toko web: daftar yang menunggu, menerima (klaim lalu buat order), dan menolak.
  let webBoard: { orders: WebPending[]; at: number } | null = null;
  const pollWeb = async () => {
    if (demo || !settings.token) return;
    try {
      const res = await fetch(`${baseUrl}/v1/web-orders/pending`, { headers: { authorization: `Bearer ${settings.token}` } });
      if (!res.ok) return;
      webBoard = { orders: ((await res.json()) as { orders: WebPending[] }).orders, at: Date.now() };
      notify();
    } catch {
      /* offline: daftar terakhir tetap dipakai */
    }
  };
  const webCall = async (path: string, body: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown> & { message?: string | string[] };
    return { ok: res.ok, status: res.status, body: j, message: (Array.isArray(j.message) ? j.message.join('; ') : j.message) ?? `Server menjawab ${res.status}.` };
  };
  const acceptWebOrder = async (id: number): Promise<Result<OrderRecord>> => {
    if (demo || !settings.token) return { ok: false, code: 'NO_SERVER', message: 'Pesanan web memerlukan koneksi ke server.' };
    const pending = webBoard?.orders.find((o) => o.id === id);
    if (!pending) return { ok: false, code: 'WEB_UNKNOWN', message: 'Pesanan tidak ada di daftar; muat ulang.' };
    if (!engine.currentShift()) return { ok: false, code: 'NO_SHIFT', message: 'Buka shift terlebih dahulu.' };
    // Periksa dulu terhadap menu terminal ini: klaim di server tidak bisa dibatalkan.
    const bad = engine.checkWebOrderItems(pending.items.map((i) => ({ itemId: i.itemId, name: i.name, qty: i.qty, options: i.options, ...(i.note ? { note: i.note } : {}) })));
    if (bad) return { ok: false, code: 'WEB_ITEM_UNAVAILABLE', message: bad };
    try {
      const c = await webCall(`/v1/web-orders/${id}/accept`, {});
      if (!c.ok) {
        void pollWeb();
        return { ok: false, code: `WEB_${c.status}`, message: c.message };
      }
      const r = await engine.createWebOrder(c.body as unknown as Parameters<typeof engine.createWebOrder>[0]);
      if (r.ok) {
        webBoard = webBoard ? { ...webBoard, orders: webBoard.orders.filter((o) => o.id !== id) } : null;
        void syncNow();
      }
      notify();
      return r;
    } catch {
      return { ok: false, code: 'OFFLINE', message: 'Tidak terhubung ke server.' };
    }
  };
  const rejectWebOrder = async (id: number, reason: string): Promise<Result<true>> => {
    if (demo || !settings.token) return { ok: false, code: 'NO_SERVER', message: 'Pesanan web memerlukan koneksi ke server.' };
    try {
      const c = await webCall(`/v1/web-orders/${id}/reject`, { reason });
      if (!c.ok) return { ok: false, code: `WEB_${c.status}`, message: c.message };
      webBoard = webBoard ? { ...webBoard, orders: webBoard.orders.filter((o) => o.id !== id) } : null;
      notify();
      return { ok: true, value: true };
    } catch {
      return { ok: false, code: 'OFFLINE', message: 'Tidak terhubung ke server.' };
    }
  };

  // Foto menu: versi di konfigurasi menentukan perlu-tidaknya mengunduh; hasilnya disimpan agar tampil juga saat offline.
  const images = new Map<string, { v: string; url: string }>();
  for (const key of await store.keys('img:')) {
    const v = await store.get<{ v: string; url: string }>(key);
    if (v) images.set(key.slice(4), v);
  }
  let syncingImages = false;
  const syncImages = async () => {
    if (demo || !settings.token || syncingImages) return;
    syncingImages = true;
    try {
      const wanted = new Map(engine.config.menu.filter((m) => m.image).map((m) => [m.id, m.image!]));
      const stale = [...images.keys()].filter((id) => !wanted.has(id));
      if (stale.length > 0) {
        await store.write({}, stale.map((id) => `img:${id}`));
        for (const id of stale) images.delete(id);
        notify();
      }
      for (const [id, version] of wanted) {
        if (images.get(id)?.v === version) continue;
        const res = await fetch(`${baseUrl}/v1/menu/${encodeURIComponent(id)}/image`, { headers: { authorization: `Bearer ${settings.token}` } });
        if (!res.ok) continue;
        const img = (await res.json()) as { contentType: string; version: string; data: string };
        const entry = { v: img.version, url: `data:${img.contentType};base64,${img.data}` };
        await store.write({ [`img:${id}`]: entry });
        images.set(id, entry);
        notify();
      }
    } catch {
      /* offline: foto yang sudah tersimpan tetap dipakai; dicoba lagi pada pembaruan konfigurasi berikutnya */
    } finally {
      syncingImages = false;
    }
  };

  const memberCall = async (path: string, init?: RequestInit): Promise<Result<{ id: string; name: string; points: number }>> => {
    if (demo || !settings.token) return { ok: false, code: 'NO_SERVER', message: 'Member memerlukan koneksi ke server.' };
    try {
      const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' } });
      const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; points?: number; message?: string | string[] };
      if (!res.ok) return { ok: false, code: `MEMBER_${res.status}`, message: (Array.isArray(body.message) ? body.message.join('; ') : body.message) ?? `Server menjawab ${res.status}.` };
      return { ok: true, value: { id: body.id!, name: body.name!, points: body.points ?? 0 } };
    } catch {
      return { ok: false, code: 'OFFLINE', message: 'Tidak terhubung ke server. Member perlu koneksi.' };
    }
  };

  // Serah-terima order: daftar order terminal lain yang bisa diambil, dan hasil order yang diserahkan terminal ini.
  let incoming: Handoff[] = [];
  const pollHandoffs = async () => {
    if (demo || !settings.token) return;
    try {
      const res = await fetch(`${baseUrl}/v1/handoffs`, { headers: { authorization: `Bearer ${settings.token}` } });
      if (!res.ok) return;
      const body = (await res.json()) as { incoming: Handoff[]; outgoing: { orderId: string; state: string; by?: string }[] };
      incoming = body.incoming;
      for (const o of body.outgoing) if (o.state === 'ACCEPTED' && o.by) await engine.finishHandoff(o.orderId, o.by);
      notify();
    } catch {
      /* offline: daftar terakhir tetap ditampilkan */
    }
  };
  const claim = async (orderId: string): Promise<Result<Handoff>> => {
    if (demo || !settings.token) return { ok: false, code: 'NO_SERVER', message: 'Serah-terima order memerlukan koneksi ke server.' };
    try {
      const res = await fetch(`${baseUrl}/v1/handoffs/${encodeURIComponent(orderId)}/claim`, { method: 'POST', headers: { authorization: `Bearer ${settings.token}` } });
      const body = (await res.json().catch(() => ({}))) as Partial<Handoff> & { message?: string };
      if (!res.ok) return { ok: false, code: `HANDOFF_${res.status}`, message: body.message ?? `Server menjawab ${res.status}.` };
      return { ok: true, value: body as Handoff };
    } catch {
      return { ok: false, code: 'OFFLINE', message: 'Tidak terhubung ke server. Serah-terima order perlu koneksi.' };
    }
  };

  let printerState: PrinterState | null = null;
  const poll = async () => {
    printerState = await engine.pollPrinter();
    notify();
  };

  // Postur keamanan: dilaporkan saat mulai, saat berubah, dan sekali sehari.
  let posture: Posture | null = null;
  const reportPosture = async () => {
    if (!isNative) return;
    try {
      posture = await hardware.getPosture();
    } catch {
      return;
    }
    const key = JSON.stringify(posture);
    const last = await store.get<{ key: string; at: number }>('posture-last');
    if (!last || last.key !== key || Date.now() - last.at > 24 * 3_600_000) {
      await engine.reportPosture(posture);
      await store.write({ 'posture-last': { key, at: Date.now() } });
    }
  };
  if (isNative && kioskWanted()) void hardware.enterKiosk().catch(() => undefined);

  void engine.heartbeat().then(() => reportPosture()).then(syncNow);
  setInterval(() => void engine.heartbeat(), 60_000);
  setInterval(() => void poll(), 10_000);
  setInterval(() => void pollKitchen(), 10_000);
  setInterval(() => void pollTables(), 10_000);
  setInterval(() => void pollHandoffs(), 8_000);
  void pollHandoffs();
  void syncImages();
  void pollTables();
  setInterval(() => void pollWeb(), 10_000);
  void pollWeb();
  setInterval(() => void pollReservations(), 30_000);
  void pollReservations();
  setInterval(() => void reportPosture(), 10 * 60_000);
  void poll();
  setInterval(() => void syncNow(), 5_000);
  setInterval(() => void refreshConfig(), 60_000);
  void refreshConfig();
  window.addEventListener('online', () => void (syncNow(), refreshConfig()));

  const runtime: Runtime = {
    engine, printer, sim, escpos, config: engine.config, settings,
    receiptUrl: (token) => (engine.config.receiptBaseUrl ? `${engine.config.receiptBaseUrl}${token}` : null),
    printerState: () => (sim ? (sim.paper ? 'ok' : 'paperOut') : printerState),
    keyInfo: () => ({ native: !!nativeSigner, hardwareBacked: nativeSigner?.hardwareBacked ?? null }),
    posture: () => posture,
    tableBoard: () => tableBoard,
    webOrders: () => webBoard,
    acceptWebOrder,
    rejectWebOrder,
    reservations: () => reservationBoard,
    seatReservation,
    memberLookup: (phone) => memberCall(`/v1/members/lookup?phone=${encodeURIComponent(phone)}`),
    memberRegister: (phone, name) => memberCall('/v1/members', { method: 'POST', body: JSON.stringify({ phone, name }) }),
    menuImage: (id) => images.get(id)?.url ?? null,
    handoffs: () => ({ available: !demo && !!settings.token, incoming }),
    handOff: async (orderId) => {
      const r = await engine.handOff(orderId);
      if (r.ok) void syncNow().then(() => pollHandoffs());
      notify();
      return r;
    },
    takeHandoff: async (orderId) => {
      if (!engine.currentShift()) return { ok: false, code: 'NO_SHIFT', message: 'Buka shift terlebih dahulu.' };
      const c = await claim(orderId);
      if (!c.ok) return c;
      const r = await engine.acceptHandoff(c.value);
      if (r.ok) {
        incoming = incoming.filter((h) => h.orderId !== orderId);
        void syncNow();
      }
      notify();
      return r;
    },
    reclaimHandoff: async (orderId) => {
      const c = await claim(orderId);
      if (!c.ok) return { ...c, message: c.code === 'HANDOFF_409' ? 'Order ini sudah diambil terminal lain.' : c.message };
      const r = await engine.reclaimHandoff(orderId);
      if (r.ok) void syncNow();
      notify();
      return r;
    },
    syncStatus: () => ({ ...status }),
    configStatus: () => ({
      mode: demo ? 'demo' : 'server', version, fetchedAt,
      stale: !demo && (fetchedAt === null || Date.now() - fetchedAt > STALE_AFTER_MS), lastError: configError,
    }),
    refreshConfig,
    onSyncChange: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    syncNow,
  };
  return { kind: 'ready', runtime };
}

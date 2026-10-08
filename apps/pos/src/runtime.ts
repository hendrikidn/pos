import {
  ConfigClient, demoConfig, EscPosPrinter, PosEngine, Recorder, STALE_AFTER_MS, SyncClient, toPosConfig, WebCryptoSigner,
  type KeyPairHolder, type Printer, type PosConfig, type Signer, type SyncResult,
} from '@pos/pos-core';
import type { KitchenStatus, PrinterState } from '@pos/events';
import type { KdsBoard } from '@pos/order';
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
  /** Alamat struk digital untuk QR: alamat dasar dari server (dashboard publik), atau alamat API terminal bila belum ada. */
  receiptUrl(token: string): string;
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
  setInterval(() => void reportPosture(), 10 * 60_000);
  void poll();
  setInterval(() => void syncNow(), 5_000);
  setInterval(() => void refreshConfig(), 60_000);
  void refreshConfig();
  window.addEventListener('online', () => void (syncNow(), refreshConfig()));

  const runtime: Runtime = {
    engine, printer, sim, escpos, config: engine.config, settings,
    receiptUrl: (token) => `${engine.config.receiptBaseUrl ?? `${baseUrl}/r/`}${token}`,
    printerState: () => (sim ? (sim.paper ? 'ok' : 'paperOut') : printerState),
    keyInfo: () => ({ native: !!nativeSigner, hardwareBacked: nativeSigner?.hardwareBacked ?? null }),
    posture: () => posture,
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

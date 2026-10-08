import { Recorder, SyncClient, type DeviceConfig, type KeyValueStore } from '@pos/pos-core';
import type { KitchenStatus } from '@pos/events';
import type { KdsBoard, KdsTicket } from '@pos/order';
import type { Settings } from './runtime';

export interface KdsState {
  board: KdsBoard | null;
  /** Selisih jam perangkat terhadap server saat papan terakhir diambil (ms); dipakai agar timer tiket tidak bergantung jam perangkat. */
  offsetMs: number;
  error: string | null;
  lastOkAt: number | null;
  pending: number;
}

export interface KdsRuntime {
  outletName: string;
  deviceId: string;
  /** Papan dengan perubahan lokal yang belum terlihat di server sudah diterapkan, dan peringatan batal yang sudah dibaca disaring. */
  view(): { tickets: KdsTicket[]; voided: KdsBoard['voided'] };
  state(): KdsState;
  subscribe(fn: () => void): () => void;
  setStatus(orderId: string, status: KitchenStatus): Promise<void>;
  dismissVoided(orderId: string): void;
}

const POLL_MS = 3_000;
const OVERRIDE_TTL_MS = 120_000;
const DISMISSED_KEY = 'kds.dismissed';

/**
 * Runtime layar dapur. Layar ini tidak punya staf, menu, atau kunci tanda tangan: ia hanya membaca papan tiket dari server dan
 * mengirim `kitchen.status_changed` lewat rantai event perangkatnya sendiri (server hanya menerima jenis event itu dari KDS).
 * Perubahan status diterapkan di layar seketika (optimistis) dan dikirim di latar; bila offline, antreannya tetap tersimpan.
 */
export async function createKdsRuntime(settings: Settings, store: KeyValueStore, cfg: DeviceConfig): Promise<KdsRuntime> {
  const baseUrl = settings.apiUrl.replace(/\/$/, '');
  const recorder = new Recorder({ deviceId: cfg.deviceId, outletId: cfg.outlet.id, store, now: Date.now });
  await recorder.init();
  const sync = new SyncClient(recorder, { baseUrl, token: settings.token, now: Date.now });

  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const state: KdsState = { board: null, offsetMs: 0, error: null, lastOkAt: null, pending: await recorder.pendingCount() };
  const overrides = new Map<string, { status: KitchenStatus; at: number }>();
  let dismissed = new Set<string>();
  try {
    dismissed = new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as string[]);
  } catch {
    /* penyimpanan tidak tersedia: peringatan batal muncul lagi setelah muat ulang */
  }

  const flush = async () => {
    const r = await sync.flush();
    state.pending = await recorder.pendingCount();
    if (!r.ok) state.error = r.message;
    notify();
  };

  const poll = async () => {
    try {
      const res = await fetch(`${baseUrl}/v1/kds/board`, { headers: { authorization: `Bearer ${settings.token}` } });
      if (res.status === 401 || res.status === 403) throw new Error('Token perangkat ditolak. Minta owner memasang ulang layar ini.');
      if (!res.ok) throw new Error(`Server menjawab ${res.status}`);
      const board = (await res.json()) as KdsBoard;
      state.board = board;
      state.offsetMs = Date.now() - board.generatedAt;
      state.error = null;
      state.lastOkAt = Date.now();
      // Perubahan lokal yang sudah tercermin di server (atau sudah terlalu lama) dilepas.
      for (const [id, o] of overrides) {
        const t = board.tickets.find((x) => x.orderId === id);
        const reflected = o.status === 'SERVED' ? !t : t?.status === o.status;
        if (reflected || Date.now() - o.at > OVERRIDE_TTL_MS) overrides.delete(id);
      }
    } catch (e) {
      state.error = e instanceof Error ? e.message : 'Tidak dapat terhubung ke server.';
    }
    notify();
  };

  void poll();
  setInterval(() => void poll(), POLL_MS);
  setInterval(() => void flush(), 5_000);
  const beat = () => void recorder.record({ type: 'device.heartbeat', payload: { kind: 'kds' } }).then(flush);
  beat();
  setInterval(beat, 60_000);
  window.addEventListener('online', () => void (poll(), flush()));

  return {
    outletName: cfg.outlet.merchantName,
    deviceId: cfg.deviceId,
    state: () => ({ ...state }),
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    view: () => {
      const board = state.board;
      if (!board) return { tickets: [], voided: [] };
      const tickets = board.tickets
        .map((t) => {
          const o = overrides.get(t.orderId);
          return o ? { ...t, status: o.status === 'SERVED' ? t.status : o.status, hasNew: false } : t;
        })
        .filter((t) => overrides.get(t.orderId)?.status !== 'SERVED');
      return { tickets, voided: board.voided.filter((v) => !dismissed.has(v.orderId)) };
    },
    setStatus: async (orderId, status) => {
      overrides.set(orderId, { status, at: Date.now() });
      notify();
      await recorder.record({ type: 'kitchen.status_changed', payload: { orderId, status } });
      state.pending = await recorder.pendingCount();
      notify();
      void flush();
    },
    dismissVoided: (orderId) => {
      dismissed.add(orderId);
      try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed].slice(-200)));
      } catch {
        /* abaikan */
      }
      notify();
    },
  };
}

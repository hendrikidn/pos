import type { Policy } from '@pos/order';
import { DEFAULT_POLICY } from '@pos/order';
import type { KeyValueStore } from './store';
import type { MenuItem, PosConfig, Staff } from './types';

/** Bentuk konfigurasi dari GET /v1/device/config. */
export interface DeviceConfig {
  version: string;
  serverTime: number;
  deviceId: string;
  /** Tidak ada pada konfigurasi lama: dianggap terminal. Layar dapur menerima staf dan menu kosong. */
  deviceKind?: 'terminal' | 'sensor' | 'kds';
  outlet: {
    id: string;
    merchantName: string;
    taxPercent: number;
    edcs: { tid: string; bank: string; label: string }[];
    policy: Partial<Policy> | null;
  };
  staff: Staff[];
  menu: MenuItem[];
}

export function toPosConfig(c: DeviceConfig): PosConfig {
  return {
    outletId: c.outlet.id,
    deviceId: c.deviceId,
    merchantName: c.outlet.merchantName,
    taxPercent: c.outlet.taxPercent,
    edcs: c.outlet.edcs,
    staff: c.staff,
    menu: c.menu,
    policy: { ...DEFAULT_POLICY, ...(c.outlet.policy ?? {}) },
  };
}

export type RefreshResult =
  | { status: 'updated'; config: DeviceConfig }
  | { status: 'unchanged' }
  | { status: 'offline' | 'unauthorized' | 'error'; message: string };

interface Cached {
  config: DeviceConfig;
  /** epoch ms perangkat saat terakhir berhasil mengunduh */
  fetchedAt: number;
}

/** Konfigurasi lebih tua dari ini ditandai usang di UI: staf yang dinonaktifkan mungkin masih bisa masuk di perangkat offline. */
export const STALE_AFTER_MS = 24 * 3_600_000;

export class ConfigClient {
  constructor(
    private readonly store: KeyValueStore,
    private readonly cfg: { baseUrl: string; token: string; fetchImpl?: typeof fetch; now: () => number },
  ) {}

  async cached(): Promise<Cached | undefined> {
    return this.store.get<Cached>('device-config');
  }

  /** Mengunduh konfigurasi bila berubah; menyimpannya agar terminal tetap bisa dipakai saat offline. */
  async refresh(): Promise<RefreshResult> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const cached = await this.cached();
    const q = cached ? `?version=${encodeURIComponent(cached.config.version)}` : '';
    let res: Response;
    try {
      res = await fetchImpl(`${this.cfg.baseUrl}/v1/device/config${q}`, { headers: { authorization: `Bearer ${this.cfg.token}` } });
    } catch (e) {
      return { status: 'offline', message: e instanceof Error ? e.message : 'tidak dapat terhubung' };
    }
    if (res.status === 401 || res.status === 403) return { status: 'unauthorized', message: 'token perangkat ditolak' };
    if (!res.ok) return { status: 'error', message: `server menjawab ${res.status}` };
    const body = (await res.json()) as DeviceConfig | { unchanged: true };
    if ('unchanged' in body) {
      if (cached) await this.store.write({ 'device-config': { ...cached, fetchedAt: this.cfg.now() } });
      return { status: 'unchanged' };
    }
    await this.store.write({ 'device-config': { config: body, fetchedAt: this.cfg.now() } satisfies Cached });
    return { status: 'updated', config: body };
  }
}

import { describe, expect, it } from 'vitest';
import { pbkdf2Sync } from 'node:crypto';
import { ConfigClient, demoConfig, derivePin, Directory, MemoryStore, safeEqual, toPosConfig, type DeviceConfig } from '../src';

const T0 = Date.parse('2026-10-02T10:00:00+07:00');

const serverConfig = (over: Partial<DeviceConfig> = {}): DeviceConfig => ({
  version: 'v1', serverTime: T0, deviceId: 'pos-1',
  outlet: { id: 'o1', merchantName: 'Kopi Senopati', taxPercent: 10, edcs: [{ tid: '12345678', bank: 'Mandiri', label: 'EDC' }], policy: { secondApprovalAbove: 75_000 } },
  staff: [], menu: [{ id: 'teh', name: 'Teh', price: 18_000, category: 'Non-kopi' }], ...over,
});

function client(handler: (url: string, init: RequestInit) => Response | Promise<Response>, store = new MemoryStore()) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push(url);
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { store, calls, client: new ConfigClient(store, { baseUrl: 'http://api', token: 'dev_x', fetchImpl, now: () => T0 }) };
}

describe('derivePin', () => {
  it('sama persis dengan PBKDF2-HMAC-SHA256 milik Node (server dan terminal sepakat)', async () => {
    const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const expected = pbkdf2Sync('4827', Buffer.from(salt, 'hex'), 2_000, 32, 'sha256').toString('hex');
    expect(await derivePin('4827', salt, 2_000)).toBe(expected);
  });

  it('implementasi JS cadangan (tanpa WebCrypto) menghasilkan nilai yang sama', async () => {
    const real = globalThis.crypto;
    const salt = '00112233445566778899aabbccddeeff';
    const withSubtle = await derivePin('9051', salt, 1_500);
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(await derivePin('9051', salt, 1_500)).toBe(withSubtle);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
    }
  });

  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('Directory', () => {
  it('memverifikasi PIN dari hash, menolak yang salah dan pengguna tidak dikenal', async () => {
    const cfg = await demoConfig();
    const dir = new Directory(cfg.staff, () => T0);
    expect(await dir.verify('budi', cfg.demoPins.budi)).toBe('OK');
    expect(await dir.verify('budi', '0000')).toBe('WRONG');
    expect(await dir.verify('hantu', '1111')).toBe('WRONG');
    expect(dir.list().every((s) => !('hash' in s) && !('salt' in s))).toBe(true);
  });

  it('daftar staf baru berlaku segera, staf yang dihapus tidak bisa masuk lagi', async () => {
    const cfg = await demoConfig();
    const dir = new Directory(cfg.staff, () => T0);
    expect(await dir.verify('sari', cfg.demoPins.sari)).toBe('OK');
    dir.setStaff(cfg.staff.filter((s) => s.id !== 'sari'));
    expect(await dir.verify('sari', cfg.demoPins.sari)).toBe('WRONG');
  });
});

describe('ConfigClient', () => {
  it('mengunduh dan menyimpan konfigurasi pertama kali', async () => {
    const t = client(() => Response.json(serverConfig()));
    const r = await t.client.refresh();
    expect(r).toMatchObject({ status: 'updated' });
    expect(t.calls[0]).toBe('http://api/v1/device/config');
    expect((await t.client.cached())?.config.version).toBe('v1');
  });

  it('kedua kalinya mengirim versi dan menerima "unchanged" tanpa mengganti isi', async () => {
    const t = client((url) => (url.includes('version=v1') ? Response.json({ unchanged: true, version: 'v1' }) : Response.json(serverConfig())));
    await t.client.refresh();
    expect(await t.client.refresh()).toEqual({ status: 'unchanged' });
    expect(t.calls[1]).toContain('?version=v1');
  });

  it('offline: konfigurasi tersimpan tetap dipakai', async () => {
    const store = new MemoryStore();
    await client(() => Response.json(serverConfig()), store).client.refresh();
    const off = client(() => { throw new TypeError('fetch failed'); }, store);
    expect(await off.client.refresh()).toMatchObject({ status: 'offline' });
    expect((await off.client.cached())?.config.menu).toHaveLength(1);
  });

  it('token ditolak tidak menghapus konfigurasi tersimpan', async () => {
    const store = new MemoryStore();
    await client(() => Response.json(serverConfig()), store).client.refresh();
    const bad = client(() => new Response('', { status: 401 }), store);
    expect(await bad.client.refresh()).toMatchObject({ status: 'unauthorized' });
    expect(await bad.client.cached()).toBeDefined();
  });

  it('toPosConfig menggabungkan kebijakan server dengan bawaan', () => {
    const cfg = toPosConfig(serverConfig());
    expect(cfg).toMatchObject({ deviceId: 'pos-1', outletId: 'o1', merchantName: 'Kopi Senopati', taxPercent: 10 });
    expect(cfg.policy).toMatchObject({ secondApprovalAbove: 75_000, manualDiscountMaxPercent: 15 });
  });

  it('toPosConfig meneruskan denah meja hanya bila ada', () => {
    const base = serverConfig();
    expect(toPosConfig(base)).not.toHaveProperty('tables');
    expect(toPosConfig({ ...base, outlet: { ...base.outlet, tables: [] } })).not.toHaveProperty('tables');
    const tables = [{ no: '1', area: 'Indoor', seats: 4 }];
    expect(toPosConfig({ ...base, outlet: { ...base.outlet, tables } }).tables).toEqual(tables);
  });
});

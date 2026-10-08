import { pbkdf2Sync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

describe('konfigurasi terminal: staf, menu, pengaturan', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let manager: string;
  let term: string;
  let sensor: string;
  let ownerB: string;

  const post = (path: string, token: string, body: unknown) => h.http('POST', path, token, body);
  const put = (path: string, token: string, body: unknown) => h.http('PUT', path, token, body);

  beforeAll(async () => {
    h = await createHarness(Date.parse('2026-10-02T10:00:00+07:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Kopi Senopati');
    await h.admin.createOutlet('t1', 'o2', 'Kopi Kemang');
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'pos-1', 'terminal');
    sensor = await h.admin.createDevice('t1', 'o1', 'sensor-1', 'sensor');
  });
  afterAll(() => h.close());

  describe('staf', () => {
    it('hanya OWNER yang boleh mengelola staf', async () => {
      const body = { id: 'budi', name: 'Budi', role: 'CASHIER', pin: '4827' };
      expect((await post('/v1/staff', ops, body)).status).toBe(403);
      expect((await post('/v1/staff', manager, body)).status).toBe(403);
      expect((await post('/v1/staff', term, body)).status).toBe(403);
      expect((await post('/v1/staff', undefined as never, body)).status).toBe(401);
      expect((await post('/v1/staff', owner, body)).status).toBe(201);
    });

    it.each([
      ['123', 'PIN harus 4–6 digit'],
      ['12ab', 'PIN harus 4–6 digit'],
      ['1234567', 'PIN harus 4–6 digit'],
      ['1111', 'angka sama semua'],
      ['1234', 'angka berurutan'],
      ['9876', 'angka berurutan'],
    ])('PIN %s ditolak', async (pin, msg) => {
      const r = await post('/v1/staff', owner, { id: `x${pin}`.toLowerCase().replace(/[^a-z0-9]/g, ''), name: 'X', role: 'CASHIER', pin });
      expect(r.status).toBe(400);
      expect(r.body.message).toContain(msg);
    });

    it('validasi id, nama, role, dan duplikat', async () => {
      const ok = { name: 'Y', role: 'CASHIER', pin: '4827' };
      expect((await post('/v1/staff', owner, { ...ok, id: 'Huruf Besar' })).status).toBe(400);
      expect((await post('/v1/staff', owner, { ...ok, id: 'y1', role: 'BOSS' })).status).toBe(400);
      expect((await post('/v1/staff', owner, { ...ok, id: 'y1', name: '' })).status).toBe(400);
      expect((await post('/v1/staff', owner, { ...ok, id: 'budi' })).body.message).toMatch(/sudah dipakai/);
    });

    it('PIN tidak pernah disimpan atau dikembalikan: hanya hash PBKDF2 berasin', async () => {
      const list = await h.http('GET', '/v1/staff', owner);
      expect(JSON.stringify(list.body)).not.toMatch(/4827|pin_hash|pin_salt/);
      const row = (await h.db.admin.query<{ pin_salt: string; pin_hash: string; pin_iterations: number }>("select pin_salt, pin_hash, pin_iterations from staff where id = 'budi'")).rows[0]!;
      expect(row.pin_hash).not.toContain('4827');
      expect(row.pin_iterations).toBe(1_000);
      expect(pbkdf2Sync('4827', Buffer.from(row.pin_salt, 'hex'), row.pin_iterations, 32, 'sha256').toString('hex')).toBe(row.pin_hash);
    });

    it('dua staf dengan PIN sama mendapat hash berbeda (garam acak)', async () => {
      await post('/v1/staff', owner, { id: 'sari', name: 'Sari', role: 'CASHIER', pin: '4827' });
      const rows = (await h.db.admin.query<{ pin_hash: string }>("select pin_hash from staff where id in ('budi', 'sari')")).rows;
      expect(new Set(rows.map((r) => r.pin_hash)).size).toBe(2);
    });

    it('PIN dapat diganti, dan perubahan tercatat di audit tanpa PIN-nya', async () => {
      expect((await put('/v1/staff/sari', owner, { pin: '5930' })).status).toBe(200);
      expect((await put('/v1/staff/sari', owner, { pin: '1111' })).status).toBe(400);
      expect((await put('/v1/staff/tidak-ada', owner, { name: 'Z' })).status).toBe(404);
      const audit = (await h.db.admin.query<{ action: string; detail: object }>("select action, detail from audit_log where action = 'staff.update'")).rows;
      expect(audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit)).not.toMatch(/5930|4827/);
      expect(audit.find((a) => (a.detail as { pinChanged?: boolean }).pinChanged)).toBeDefined();
    });

    it('audit_log append-only', async () => {
      await expect(h.db.admin.query("update audit_log set actor = 'x'")).rejects.toThrow(/append-only/);
      await expect(h.db.admin.query('delete from audit_log')).rejects.toThrow(/append-only/);
    });

    it('tenant lain tidak melihat atau mengubah staf', async () => {
      expect((await h.http('GET', '/v1/staff', ownerB)).body).toEqual([]);
      expect((await put('/v1/staff/budi', ownerB, { name: 'Peretas' })).status).toBe(404);
    });
  });

  describe('menu', () => {
    it('OPS dan OWNER boleh menulis, MANAGER hanya membaca', async () => {
      const item = { id: 'kopi-susu', name: 'Kopi Susu', price: 22_000, category: 'Kopi' };
      expect((await post('/v1/menu', manager, item)).status).toBe(403);
      expect((await post('/v1/menu', ops, item)).status).toBe(201);
      expect((await h.http('GET', '/v1/menu', manager)).body).toHaveLength(1);
    });

    it('memvalidasi harga bilangan bulat rupiah, nama, kategori, dan id ganda', async () => {
      const base = { id: 'x', name: 'X', price: 1000, category: 'K' };
      expect((await post('/v1/menu', owner, { ...base, price: 12.5 })).status).toBe(400);
      expect((await post('/v1/menu', owner, { ...base, price: -1 })).status).toBe(400);
      expect((await post('/v1/menu', owner, { ...base, name: '' })).status).toBe(400);
      expect((await post('/v1/menu', owner, { ...base, id: 'kopi-susu' })).body.message).toMatch(/sudah dipakai/);
      expect((await post('/v1/menu', owner, { ...base, outletId: 'tidak-ada' })).status).toBe(404);
    });

    it('perubahan harga tercatat di audit dengan harga lama dan baru', async () => {
      await put('/v1/menu/kopi-susu', owner, { price: 24_000 });
      const a = (await h.db.admin.query<{ detail: { priceFrom: number; priceTo: number } }>("select detail from audit_log where action = 'menu.update'")).rows;
      expect(a[0]!.detail).toMatchObject({ priceFrom: 22_000, priceTo: 24_000 });
    });
  });

  describe('varian dan tambahan menu', () => {
    const size = { id: 'ukuran', name: 'Ukuran', min: 1, max: 1, options: [{ id: 'reg', name: 'Regular', price: 0 }, { id: 'lrg', name: 'Large', price: 6_000 }] };
    const topping = { id: 'topping', name: 'Topping', min: 0, max: 2, options: [{ id: 'boba', name: 'Boba', price: 6_000 }, { id: 'oat', name: 'Oat Milk', price: 8_000 }] };
    const base = { id: 'matcha', name: 'Matcha', price: 28_000, category: 'Non-kopi' };

    it('menu dibuat dengan grup opsi, tersimpan utuh, dan ikut dalam konfigurasi terminal', async () => {
      expect((await post('/v1/menu', ops, { ...base, modifierGroups: [size, topping] })).status).toBe(201);
      const row = (await h.http('GET', '/v1/menu', ops)).body.find((m: { id: string }) => m.id === 'matcha');
      expect(row.modifierGroups).toEqual([size, topping]);
      const cfg = (await h.http('GET', '/v1/device/config', term)).body;
      expect(cfg.menu.find((m: { id: string }) => m.id === 'matcha')).toEqual({ ...base, modifierGroups: [size, topping] });
    });

    it('menu tanpa opsi tidak memuat kunci modifierGroups di konfigurasi terminal (versi konfigurasi lama tidak berubah)', async () => {
      const cfg = (await h.http('GET', '/v1/device/config', term)).body;
      expect(cfg.menu.find((m: { id: string }) => m.id === 'kopi-susu')).not.toHaveProperty('modifierGroups');
    });

    it('mengubah opsi mengganti versi konfigurasi; mengosongkan dengan [] menghapus semuanya; field lain tidak disentuh', async () => {
      const v1 = (await h.http('GET', '/v1/device/config', term)).body.version;
      expect((await put('/v1/menu/matcha', owner, { modifierGroups: [size] })).status).toBe(200);
      const v2 = (await h.http('GET', '/v1/device/config', term)).body.version;
      expect(v2).not.toBe(v1);
      expect((await put('/v1/menu/matcha', owner, { price: 29_000 })).status).toBe(200);
      expect((await h.http('GET', '/v1/menu', ops)).body.find((m: { id: string }) => m.id === 'matcha').modifierGroups).toEqual([size]);
      expect((await put('/v1/menu/matcha', owner, { modifierGroups: [] })).status).toBe(200);
      expect((await h.http('GET', '/v1/menu', ops)).body.find((m: { id: string }) => m.id === 'matcha').modifierGroups).toEqual([]);
    });

    it('id opsi harus unik di seluruh menu: "sedang" di grup ukuran dan grup level pedas ditolak', async () => {
      const g = (id: string, optId: string) => ({ id, name: id, min: 1, max: 1, options: [{ id: optId, name: optId, price: 0 }, { id: `${optId}-2`, name: 'x', price: 0 }] });
      const r = await post('/v1/menu', owner, { ...base, id: 'dup', modifierGroups: [g('ukuran', 'sedang'), g('pedas', 'sedang')] });
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/id opsi ganda pada menu ini/);
      expect((await post('/v1/menu', owner, { ...base, id: 'dup', modifierGroups: [g('ukuran', 'sedang'), g('pedas', 'pedas-sedang')] })).status).toBe(201);
      await put('/v1/menu/dup', owner, { active: false });
    });

    it('menolak definisi yang cacat dengan pesan yang menjelaskan', async () => {
      const cases: [string, unknown, RegExp][] = [
        ['bukan daftar', 'x', /daftar/],
        ['id grup ganda', [size, size], /id grup ganda/],
        ['id opsi ganda', [{ ...size, options: [size.options[0], size.options[0]] }], /id opsi ganda/],
        ['tanpa opsi', [{ ...size, options: [] }], /1–20 opsi/],
        ['min > max', [{ ...size, min: 2, max: 1 }], /batas pilihan/],
        ['max > jumlah opsi', [{ ...size, max: 3 }], /batas pilihan/],
        ['max 0', [{ ...topping, max: 0 }], /batas pilihan/],
        ['harga negatif', [{ ...size, options: [{ id: 'a', name: 'A', price: -1 }] }], /harga opsi/],
        ['harga pecahan', [{ ...size, options: [{ id: 'a', name: 'A', price: 1.5 }] }], /harga opsi/],
        ['nama kosong', [{ ...size, name: ' ' }], /nama grup/],
        ['id tidak sah', [{ ...size, id: 'Ukuran Besar' }], /id grup/],
        ['terlalu banyak grup', Array.from({ length: 9 }, (_, i) => ({ ...size, id: `g${i}` })), /maksimal 8/],
      ];
      for (const [label, groups, msg] of cases) {
        const r = await post('/v1/menu', owner, { ...base, id: 'bad', modifierGroups: groups });
        expect(r.status, label).toBe(400);
        expect(r.body.message, label).toMatch(msg);
      }
      expect((await put('/v1/menu/matcha', owner, { modifierGroups: 'x' })).status).toBe(400);
      expect((await h.http('GET', '/v1/menu', ops)).body.some((m: { id: string }) => m.id === 'bad')).toBe(false);
    });

    it('dinonaktifkan agar tidak mengganggu pemeriksaan berikutnya', async () => {
      expect((await put('/v1/menu/matcha', owner, { active: false })).status).toBe(200);
    });
  });

  describe('pengaturan outlet', () => {
    it('hanya OWNER; memvalidasi EDC, pajak, dan kebijakan', async () => {
      const path = '/v1/outlets/o1/settings';
      expect((await put(path, ops, { taxPercent: 11 })).status).toBe(403);
      expect((await put(path, owner, { taxPercent: 150 })).status).toBe(400);
      expect((await put(path, owner, { edcs: [{ tid: 'abc', bank: 'Mandiri', label: 'EDC' }] })).status).toBe(400);
      const dup = { tid: '12345678', bank: 'Mandiri', label: 'EDC' };
      expect((await put(path, owner, { edcs: [dup, dup] })).body.message).toMatch(/ganda/);
      expect((await put(path, owner, { policy: { sembarang: 5 } })).status).toBe(400);
      expect((await put(path, owner, { policy: { secondApprovalAbove: -1 } })).status).toBe(400);
      expect((await put(path, owner, { merchantName: 'Kopi Senopati', taxPercent: 10, edcs: [dup], policy: { secondApprovalAbove: 75_000 } })).status).toBe(200);
      expect((await h.http('GET', path, owner)).body).toMatchObject({ merchant_name: 'Kopi Senopati', tax_percent: 10 });
    });

    it('batas tahan bill tunai: 0 (nonaktif) sampai 1440 menit diterima, di luar itu atau pecahan ditolak, dan sampai ke terminal', async () => {
      const path = '/v1/outlets/o1/settings';
      for (const bad of [-1, 1441, 30.5, '60']) {
        const r = await put(path, owner, { policy: { secondApprovalAbove: 75_000, holdBillMinutes: bad } });
        expect(r.status, String(bad)).toBe(400);
        expect(r.body.message).toMatch(/holdBillMinutes/);
      }
      expect((await put(path, owner, { policy: { secondApprovalAbove: 75_000, holdBillMinutes: 0 } })).status).toBe(200);
      expect((await put(path, owner, { policy: { secondApprovalAbove: 75_000, holdBillMinutes: 45 } })).status).toBe(200);
      expect((await h.http('GET', '/v1/device/config', term)).body.outlet.policy).toMatchObject({ holdBillMinutes: 45 });
      // kembalikan agar pemeriksaan berikutnya tidak berubah
      expect((await put(path, owner, { policy: { secondApprovalAbove: 75_000 } })).status).toBe(200);
    });

    it('outlet tenant lain tidak dapat diubah', async () => {
      expect((await put('/v1/outlets/ox/settings', owner, { taxPercent: 5 })).status).toBe(404);
    });
  });

  describe('unduhan konfigurasi oleh terminal', () => {
    it('sensor dan pengguna tidak boleh; terminal boleh', async () => {
      expect((await h.http('GET', '/v1/device/config', sensor)).status).toBe(403);
      expect((await h.http('GET', '/v1/device/config', owner)).status).toBe(403);
      expect((await h.http('GET', '/v1/device/config')).status).toBe(401);
      expect((await h.http('GET', '/v1/device/config', term)).status).toBe(200);
    });

    it('memuat pengaturan outlet, staf aktif (hash, bukan PIN), dan menu aktif', async () => {
      const cfg = (await h.http('GET', '/v1/device/config', term)).body;
      expect(cfg.outlet).toMatchObject({ id: 'o1', merchantName: 'Kopi Senopati', taxPercent: 10, policy: { secondApprovalAbove: 75_000 } });
      expect(cfg.outlet.edcs).toEqual([{ tid: '12345678', bank: 'Mandiri', label: 'EDC' }]);
      expect(cfg.staff.map((s: { id: string }) => s.id)).toEqual(['budi', 'sari']);
      expect(JSON.stringify(cfg)).not.toMatch(/4827|5930|"pin"/);
      const budi = cfg.staff[0];
      expect(pbkdf2Sync('4827', Buffer.from(budi.salt, 'hex'), budi.iterations, 32, 'sha256').toString('hex')).toBe(budi.hash);
      expect(cfg.menu).toEqual([{ id: 'kopi-susu', name: 'Kopi Susu', price: 24_000, category: 'Kopi' }]);
    });

    it('staf dan menu nonaktif tidak ikut; staf per outlet hanya untuk outletnya', async () => {
      await post('/v1/staff', owner, { id: 'hendra', name: 'Hendra', role: 'SUPERVISOR', pin: '7351', outletIds: ['o2'] });
      await post('/v1/menu', owner, { id: 'teh', name: 'Teh', price: 18_000, category: 'Non-kopi' });
      await post('/v1/menu', owner, { id: 'khas-kemang', name: 'Khas Kemang', price: 30_000, category: 'Kopi', outletId: 'o2' });
      let cfg = (await h.http('GET', '/v1/device/config', term)).body;
      expect(cfg.staff.map((s: { id: string }) => s.id)).not.toContain('hendra');
      expect(cfg.menu.map((m: { id: string }) => m.id).sort()).toEqual(['kopi-susu', 'teh']);

      await put('/v1/staff/sari', owner, { active: false });
      await put('/v1/menu/teh', owner, { active: false });
      cfg = (await h.http('GET', '/v1/device/config', term)).body;
      expect(cfg.staff.map((s: { id: string }) => s.id)).toEqual(['budi']);
      expect(cfg.menu.map((m: { id: string }) => m.id)).toEqual(['kopi-susu']);
    });

    it('versi berubah bila isi berubah, dan permintaan dengan versi sama menjawab "unchanged"', async () => {
      const a = (await h.http('GET', '/v1/device/config', term)).body;
      const same = await h.http('GET', `/v1/device/config?version=${a.version}`, term);
      expect(same.body).toMatchObject({ unchanged: true, version: a.version });
      expect(same.body.staff).toBeUndefined();

      await put('/v1/menu/kopi-susu', owner, { price: 25_000 });
      const b = (await h.http('GET', `/v1/device/config?version=${a.version}`, term)).body;
      expect(b.unchanged).toBeUndefined();
      expect(b.version).not.toBe(a.version);
      expect(b.menu[0].price).toBe(25_000);
    });
  });
});

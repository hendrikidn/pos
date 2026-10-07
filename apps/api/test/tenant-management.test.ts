import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformAdmin } from '../src/onboard';
import { createHarness, type Harness } from './harness';

const NOW = Date.parse('2026-10-07T10:00:00+07:00');

describe('admin mengelola tenant: ganti nama dan penangguhan', () => {
  let h: Harness;
  let admin: string;
  let owner: string;
  let ownerB: string;
  let sensor: string;

  beforeAll(async () => {
    h = await createHarness(NOW);
    admin = (await createPlatformAdmin(h.db, { id: 'adm', name: 'Adm' })).token;
    const mk = async (tenantId: string) =>
      (await h.http('POST', '/v1/admin/tenants', admin, { tenantId, tenantName: tenantId.toUpperCase(), outletId: `${tenantId}-o`, outletName: 'O', terminals: ['pos-1'] })).body.ownerToken;
    owner = await mk('ta');
    ownerB = await mk('tb');
    sensor = await h.admin.createDevice('ta', 'ta-o', 'sensor-ta', 'sensor');
  });
  afterAll(() => h.close());

  const adm = (method: string, path: string, body?: unknown) => h.http(method, `/v1/admin${path}`, admin, body);

  it('mengganti nama tenant dan mencatatnya', async () => {
    expect((await adm('PUT', '/tenants/ta', { name: '  Toko A Baru  ' })).status).toBe(200);
    expect((await adm('GET', '/tenants/ta')).body.tenant.name).toBe('Toko A Baru');
    expect((await adm('PUT', '/tenants/ta', { name: '   ' })).status).toBe(400);
    expect((await adm('PUT', '/tenants/tidak-ada', { name: 'X' })).status).toBe(404);
    expect((await h.http('PUT', '/v1/admin/tenants/ta', owner, { name: 'Curang' })).status).toBe(403);
  });

  it('tenant ditangguhkan: token pengguna dan perangkat langsung ditolak (403), tenant lain tidak terpengaruh', async () => {
    expect((await h.http('GET', '/v1/me', owner)).status).toBe(200);
    expect((await h.http('POST', '/v1/events', sensor, { events: [] })).status).toBe(201);

    expect((await adm('POST', '/tenants/ta/suspend', { reason: 'tagihan belum dibayar' })).status).toBe(201);

    const me = await h.http('GET', '/v1/me', owner);
    expect(me.status).toBe(403);
    expect(me.body.message).toMatch(/ditangguhkan/);
    expect((await h.http('POST', '/v1/events', sensor, { events: [] })).status).toBe(403);
    expect((await h.http('GET', '/v1/outlets', owner)).status).toBe(403);
    expect((await h.http('GET', '/v1/me', ownerB)).status).toBe(200);

    // Admin tetap bisa melihat dan mengelola tenant yang ditangguhkan.
    const d = (await adm('GET', '/tenants/ta')).body;
    expect(d.tenant.suspended_at).not.toBeNull();
    expect(d.tenant.suspended_reason).toBe('tagihan belum dibayar');
    const row = (await adm('GET', '/tenants')).body.find((t: { id: string }) => t.id === 'ta');
    expect(row.suspended_at).not.toBeNull();
    expect((await adm('GET', '/overview')).body.tenants).toMatchObject({ active: 1, suspended: 1 });
  });

  it('kode pairing yang belum dipakai tidak bisa ditukar saat tenant ditangguhkan', async () => {
    await adm('POST', '/tenants/ta/reactivate');
    const p = await h.http('POST', '/v1/devices/pairing', owner, { outletId: 'ta-o', kind: 'sensor', deviceId: 'sensor-baru' });
    expect(p.status).toBe(201);
    await adm('POST', '/tenants/ta/suspend', { reason: 'uji' });
    const e = await h.http('POST', '/v1/device/enroll', undefined, { code: p.body.code });
    expect(e.status).toBe(403);
    // Kode tidak hangus oleh percobaan yang ditolak: setelah diaktifkan lagi kode yang sama masih bisa dipakai.
    await adm('POST', '/tenants/ta/reactivate');
    expect((await h.http('POST', '/v1/device/enroll', undefined, { code: p.body.code })).status).toBe(201);
  });

  it('mengaktifkan kembali memulihkan semuanya apa adanya; status ganda ditolak', async () => {
    expect((await adm('POST', '/tenants/ta/reactivate')).status).toBe(409); // sudah aktif
    await adm('POST', '/tenants/ta/suspend', {});
    expect((await adm('POST', '/tenants/ta/suspend', {})).status).toBe(409); // sudah ditangguhkan
    expect((await adm('POST', '/tenants/ta/reactivate')).status).toBe(201);
    expect((await h.http('GET', '/v1/me', owner)).status).toBe(200);
    expect((await h.http('POST', '/v1/events', sensor, { events: [] })).status).toBe(201);
    expect((await adm('GET', '/tenants/ta')).body.tenant.suspended_reason).toBeNull();
    expect((await adm('POST', '/tenants/tidak-ada/suspend', {})).status).toBe(404);
  });

  it('tindakan tercatat di audit_log', async () => {
    const r = await h.db.admin.query<{ action: string }>("select distinct action from audit_log where action like 'platform.tenant.%'");
    expect(r.rows.map((x) => x.action).sort()).toEqual(['platform.tenant.create', 'platform.tenant.reactivate', 'platform.tenant.rename', 'platform.tenant.suspend']);
  });
});

describe('owner tenant mengelola outlet sendiri', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let other: string;

  beforeAll(async () => {
    h = await createHarness(NOW);
    const admin = (await createPlatformAdmin(h.db, { id: 'adm', name: 'Adm' })).token;
    const mk = async (tenantId: string) =>
      (await h.http('POST', '/v1/admin/tenants', admin, { tenantId, tenantName: tenantId, outletId: `${tenantId}-pusat`, outletName: 'Pusat', terminals: ['pos-1'] })).body.ownerToken;
    owner = await mk('kopi');
    other = await mk('teh');
    ops = await h.admin.createApiToken('kopi', 'ops', 'OPS');
  });
  afterAll(() => h.close());

  it('membuat outlet: ID dibuat server dari ID tenant + nama, dan langsung terlihat', async () => {
    const r = await h.http('POST', '/v1/outlets', owner, { name: 'Palmerah Barat', terminals: ['pos-1', 'pos-2'] });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: 'kopi-palmerah-barat', name: 'Palmerah Barat', terminals: ['pos-1', 'pos-2'] });

    const list = (await h.http('GET', '/v1/outlets', owner)).body.map((o: { id: string }) => o.id).sort();
    expect(list).toEqual(['kopi-palmerah-barat', 'kopi-pusat']);
    expect((await h.http('GET', '/v1/outlets/kopi-palmerah-barat/settings', owner)).status).toBe(200);
    // Outlet baru langsung bisa dipasangi sensor.
    expect((await h.http('POST', '/v1/devices/pairing', owner, { outletId: 'kopi-palmerah-barat', kind: 'sensor', terminalId: 'pos-1' })).status).toBe(201);
  });

  it('nama yang sudah diawali ID tenant tidak mengulang awalan itu', async () => {
    const r = await h.http('POST', '/v1/outlets', owner, { name: 'Kopi Senopati' });
    expect(r.body.id).toBe('kopi-senopati');
    expect((await h.http('POST', '/v1/outlets', owner, { name: 'Kopi' })).body.id).toBe('kopi');
  });

  it('nama kembar mendapat ID berbeda; karakter khusus dan nama kosong ditangani', async () => {
    const a = await h.http('POST', '/v1/outlets', owner, { name: 'Palmerah Barat' });
    expect(a.status).toBe(201);
    expect(a.body.id).toBe('kopi-palmerah-barat-2');
    const b = await h.http('POST', '/v1/outlets', owner, { name: 'Kafé  Ünik!!' });
    expect(b.body.id).toMatch(/^kopi-[a-z0-9-]+$/);
    expect((await h.http('POST', '/v1/outlets', owner, { name: '!!!' })).body.id).toBe('kopi-outlet');
    expect((await h.http('POST', '/v1/outlets', owner, { name: '   ' })).status).toBe(400);
    expect((await h.http('POST', '/v1/outlets', owner, { name: 'x'.repeat(81) })).status).toBe(400);
  });

  it('tenant lain dengan nama sama tidak bentrok, dan tidak bisa melihat atau mengubah outlet orang lain', async () => {
    const t = await h.http('POST', '/v1/outlets', other, { name: 'Palmerah Barat' });
    expect(t.status).toBe(201);
    expect(t.body.id).toBe('teh-palmerah-barat');
    expect((await h.http('GET', '/v1/outlets', other)).body.map((o: { id: string }) => o.id).sort()).toEqual(['teh-palmerah-barat', 'teh-pusat']);
    expect((await h.http('PUT', '/v1/outlets/kopi-pusat', other, { name: 'Dibajak' })).status).toBe(404);
    expect((await h.http('GET', '/v1/outlets/kopi-pusat/settings', other)).status).toBe(404);
  });

  it('mengubah nama dan daftar terminal; masukan tidak valid ditolak', async () => {
    expect((await h.http('PUT', '/v1/outlets/kopi-pusat', owner, { name: 'Pusat Utama', terminals: ['pos-1', 'pos-2', 'pos-3'] })).status).toBe(200);
    const s = (await h.http('GET', '/v1/outlets/kopi-pusat/settings', owner)).body;
    expect(s.name).toBe('Pusat Utama');
    const row = (await h.db.admin.query<{ terminals: string[] }>("select terminals from outlet where id = 'kopi-pusat'")).rows[0]!;
    expect(row.terminals).toEqual(['pos-1', 'pos-2', 'pos-3']);

    expect((await h.http('PUT', '/v1/outlets/kopi-pusat', owner, { terminals: [] })).status).toBe(200); // boleh tanpa terminal
    expect((await h.http('PUT', '/v1/outlets/kopi-pusat', owner, {})).status).toBe(400);
    expect((await h.http('PUT', '/v1/outlets/kopi-pusat', owner, { terminals: ['POS 1'] })).status).toBe(400);
    expect((await h.http('PUT', '/v1/outlets/kopi-pusat', owner, { terminals: ['a1', 'a1'] })).status).toBe(400);
    expect((await h.http('PUT', '/v1/outlets/kopi-pusat', owner, { terminals: 'pos-1' })).status).toBe(400);
    expect((await h.http('PUT', '/v1/outlets/tidak-ada', owner, { name: 'X' })).status).toBe(404);
  });

  it('hanya OWNER yang boleh membuat atau mengubah outlet', async () => {
    expect((await h.http('POST', '/v1/outlets', ops, { name: 'Gelap' })).status).toBe(403);
    expect((await h.http('PUT', '/v1/outlets/kopi-pusat', ops, { name: 'Gelap' })).status).toBe(403);
    expect((await h.http('POST', '/v1/outlets', undefined, { name: 'Gelap' })).status).toBe(401);
  });

  it('jumlah outlet per tenant dibatasi', async () => {
    for (let i = 0; i < 100; i++) {
      await h.db.admin.query('insert into outlet (id, tenant_id, name) values ($1, $2, $3) on conflict do nothing', [`teh-bulk-${i}`, 'teh', `Bulk ${i}`]);
    }
    const r = await h.http('POST', '/v1/outlets', other, { name: 'Terlalu banyak' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/maksimal/);
  });

  it('pembuatan dan perubahan tercatat di audit_log', async () => {
    const r = await h.db.admin.query<{ action: string }>("select distinct action from audit_log where action like 'outlet.%'");
    expect(r.rows.map((x) => x.action).sort()).toEqual(['outlet.create', 'outlet.update']);
  });
});

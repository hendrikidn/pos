import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

// Gambar sungguhan terkecil: 1x1 PNG, dan kepala berkas JPEG/WebP yang cukup untuk pemeriksaan tanda pengenal.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(40, 2)]);
const b64 = (b: Buffer) => b.toString('base64');

describe('foto menu', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let manager: string;
  let ownerB: string;
  let term: string;
  let termO2: string;
  let sensor: string;
  let kds: string;

  const put = (tok: string | undefined, id: string, body: unknown) => h.http('PUT', `/v1/menu/${id}/image`, tok, body);
  const get = (tok: string | undefined, id: string) => h.http('GET', `/v1/menu/${id}/image`, tok);
  const cfg = async (tok: string) => (await h.http('GET', '/v1/device/config', tok)).body;

  beforeAll(async () => {
    h = await createHarness(Date.parse('2026-10-02T10:00:00+07:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1');
    await h.admin.createOutlet('t1', 'o2', 'Outlet 2');
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'pos-1', 'terminal');
    termO2 = await h.admin.createDevice('t1', 'o2', 'pos-2', 'terminal');
    sensor = await h.admin.createDevice('t1', 'o1', 'sensor-1', 'sensor');
    kds = await h.admin.createDevice('t1', 'o1', 'kds-1', 'kds');
    expect((await h.http('POST', '/v1/menu', owner, { id: 'kopi', name: 'Kopi', price: 20_000, category: 'Kopi' })).status).toBe(201);
    expect((await h.http('POST', '/v1/menu', owner, { id: 'teh', name: 'Teh', price: 15_000, category: 'Teh', outletId: 'o2' })).status).toBe(201);
  });
  afterAll(() => h.close());

  it('unggah: OWNER dan OPS boleh, MANAGER dan terminal tidak; tercatat di audit; menu tak dikenal 404', async () => {
    const body = { contentType: 'image/png', data: b64(PNG) };
    expect((await put(manager, 'kopi', body)).status).toBe(403);
    expect((await put(term, 'kopi', body)).status).toBe(403);
    expect((await put(undefined, 'kopi', body)).status).toBe(401);
    expect((await put(owner, 'tidak-ada', body)).status).toBe(404);
    expect((await put(ops, 'kopi', body)).status).toBeLessThan(300);
    const audit = (await h.db.admin.query<{ detail: { id: string } }>("select detail from audit_log where action = 'menu.image'")).rows;
    expect(audit.map((a) => a.detail.id)).toEqual(['kopi']);
  });

  it('validasi: jenis, base64, tanda pengenal isi, dan ukuran', async () => {
    const bad = (body: unknown) => put(owner, 'kopi', body);
    expect((await bad({ contentType: 'image/svg+xml', data: b64(Buffer.from('<svg onload=alert(1)/>')) })).status).toBe(400);
    expect((await bad({ contentType: 'image/png', data: b64(JPEG) })).status).toBe(400); // jenis tidak cocok dengan isi
    expect((await bad({ contentType: 'image/jpeg', data: b64(PNG) })).status).toBe(400);
    expect((await bad({ contentType: 'image/webp', data: b64(JPEG) })).status).toBe(400);
    expect((await bad({ contentType: 'image/png', data: 'bukan base64!!' })).status).toBe(400);
    expect((await bad({ contentType: 'image/png', data: '' })).status).toBe(400);
    expect((await bad({ contentType: 'image/png' })).status).toBe(400);
    const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(151 * 1024)]);
    expect((await bad({ contentType: 'image/png', data: b64(big) })).status).toBe(400);
    const edge = Buffer.concat([JPEG.subarray(0, 4), Buffer.alloc(150 * 1024 - 4)]);
    expect((await bad({ contentType: 'image/jpeg', data: b64(edge) })).status).toBeLessThan(300);
    expect((await put(owner, 'kopi', { contentType: 'image/png', data: b64(PNG) })).status).toBeLessThan(300);
  });

  it('versi gambar ikut konfigurasi terminal; gambar sama tidak mengubah versi, gambar baru mengubahnya', async () => {
    const before = await cfg(term);
    const v1 = before.menu.find((m: { id: string }) => m.id === 'kopi').image;
    expect(v1).toMatch(/^[0-9a-f]{12}$/);
    expect(before.menu.find((m: { id: string }) => m.id === 'kopi')).not.toHaveProperty('imageData');
    expect((await put(owner, 'kopi', { contentType: 'image/png', data: b64(PNG) })).body.version).toBe(v1);
    expect((await cfg(term)).version).toBe(before.version);
    const v2 = (await put(owner, 'kopi', { contentType: 'image/webp', data: b64(WEBP) })).body.version;
    expect(v2).not.toBe(v1);
    const after = await cfg(term);
    expect(after.version).not.toBe(before.version);
    expect(after.menu.find((m: { id: string }) => m.id === 'kopi').image).toBe(v2);
    expect(JSON.stringify(after)).not.toContain(b64(WEBP)); // isi gambar tidak ikut konfigurasi
  });

  it('terminal mengunduh foto menu yang berlaku di outletnya; menu outlet lain, sensor, dan layar dapur ditolak', async () => {
    const r = await get(term, 'kopi');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ contentType: 'image/webp' });
    expect(Buffer.from(r.body.data, 'base64').equals(WEBP)).toBe(true);
    expect(r.body.version).toMatch(/^[0-9a-f]{12}$/);
    expect((await put(owner, 'teh', { contentType: 'image/jpeg', data: b64(JPEG) })).status).toBeLessThan(300);
    expect((await get(term, 'teh')).status).toBe(404); // menu khusus outlet o2
    expect((await get(termO2, 'teh')).status).toBe(200);
    expect((await get(sensor, 'kopi')).status).toBe(403);
    expect((await get(kds, 'kopi')).status).toBe(403);
    expect((await get(undefined, 'kopi')).status).toBe(401);
    expect((await get(ownerB, 'kopi')).status).toBe(404); // tenant lain
    expect((await get(manager, 'kopi')).status).toBe(200); // dashboard
  });

  it('menu nonaktif tidak disajikan ke terminal; daftar menu dashboard menandai yang punya foto', async () => {
    expect((await h.http('PUT', '/v1/menu/kopi', owner, { active: false })).status).toBeLessThan(300);
    expect((await get(term, 'kopi')).status).toBe(404);
    expect((await get(owner, 'kopi')).status).toBe(200);
    const list = (await h.http('GET', '/v1/menu', owner)).body as { id: string; image: string | null }[];
    expect(list.find((m) => m.id === 'kopi')!.image).toMatch(/^[0-9a-f]{12}$/);
    expect(list.find((m) => m.id === 'teh')!.image).toMatch(/^[0-9a-f]{12}$/);
    expect((await h.http('PUT', '/v1/menu/kopi', owner, { active: true })).status).toBeLessThan(300);
  });

  it('hapus foto: hanya OWNER/OPS, versi hilang dari konfigurasi, unduhan 404', async () => {
    expect((await h.http('DELETE', '/v1/menu/kopi/image', manager)).status).toBe(403);
    expect((await h.http('DELETE', '/v1/menu/kopi/image', ownerB)).status).toBe(404);
    expect((await h.http('DELETE', '/v1/menu/kopi/image', ops)).status).toBeLessThan(300);
    expect((await cfg(term)).menu.find((m: { id: string }) => m.id === 'kopi')).not.toHaveProperty('image');
    expect((await get(term, 'kopi')).status).toBe(404);
    expect((await h.http('DELETE', '/v1/menu/tidak-ada/image', owner)).status).toBe(404);
  });
});

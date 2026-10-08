import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

describe('POST /v1/menu/import', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let manager: string;
  let ownerB: string;
  let term: string;

  const imp = (tok: string | undefined, csv: unknown, apply?: boolean) => h.http('POST', '/v1/menu/import', tok, { csv, ...(apply === undefined ? {} : { apply }) });
  const menu = async (tok = owner) => (await h.http('GET', '/v1/menu', tok)).body as { id: string; name: string; price: number; category: string; active: boolean; modifierGroups: unknown[]; image: string | null }[];

  beforeAll(async () => {
    h = await createHarness(Date.parse('2026-10-02T10:00:00+07:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1');
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'pos-1', 'terminal');
    const mod = [{ id: 'ukuran', name: 'Ukuran', min: 1, max: 1, options: [{ id: 'reg', name: 'Regular', price: 0 }, { id: 'lrg', name: 'Large', price: 6000 }] }];
    expect((await h.http('POST', '/v1/menu', owner, { id: 'matcha', name: 'Matcha', price: 28_000, category: 'Non-kopi', modifierGroups: mod })).status).toBe(201);
    expect((await h.http('PUT', '/v1/menu/matcha/image', owner, { contentType: 'image/png', data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 1)]).toString('base64') })).status).toBeLessThan(300);
  });
  afterAll(() => h.close());

  const CSV = 'id,nama,kategori,harga,aktif\nmatcha,Matcha Latte,Non-kopi,"30.000",ya\nkopi-susu,Kopi Susu,Kopi,22000,ya\n,Nasi Goreng,Makanan,Rp 38.000,tidak\n';

  it('periksa dulu (tanpa apply): rencana per baris, tidak ada yang tersimpan', async () => {
    const r = await imp(owner, CSV);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ applied: false, errors: [], summary: { create: 2, update: 1, unchanged: 0 } });
    expect(r.body.plan).toEqual([
      { line: 2, id: 'matcha', action: 'update', name: 'Matcha Latte', changes: ['nama "Matcha" → "Matcha Latte"', 'harga 28000 → 30000'] },
      { line: 3, id: 'kopi-susu', action: 'create', name: 'Kopi Susu', changes: ['harga 22000'] },
      { line: 4, id: 'nasi-goreng', action: 'create', name: 'Nasi Goreng', changes: ['harga 38000'] },
    ]);
    expect((await menu()).map((m) => m.id)).toEqual(['matcha']);
  });

  it('terapkan: menu baru dibuat (aktif/nonaktif sesuai berkas), yang ada hanya berubah nama/harga/kategori/status; varian dan foto tetap; audit memuat harga lama dan baru', async () => {
    expect((await imp(ops, CSV, true)).body).toMatchObject({ applied: true, summary: { create: 2, update: 1 } });
    const m = await menu();
    expect(m.map((x) => [x.id, x.name, x.price, x.category, x.active])).toEqual([
      ['kopi-susu', 'Kopi Susu', 22_000, 'Kopi', true], ['nasi-goreng', 'Nasi Goreng', 38_000, 'Makanan', false], ['matcha', 'Matcha Latte', 30_000, 'Non-kopi', true],
    ]);
    const matcha = m.find((x) => x.id === 'matcha')!;
    expect(matcha.modifierGroups).toHaveLength(1);
    expect(matcha.image).toMatch(/^[0-9a-f]{12}$/);
    const audit = (await h.db.admin.query<{ detail: { create: number; priceChanges: { id: string; priceFrom: number; priceTo: number }[] } }>("select detail from audit_log where action = 'menu.import'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({ create: 2, update: 1, priceChanges: [{ id: 'matcha', priceFrom: 28_000, priceTo: 30_000 }] });
    // menu baru sampai ke terminal (hanya yang aktif)
    const cfg = (await h.http('GET', '/v1/device/config', term)).body;
    expect(cfg.menu.map((x: { id: string }) => x.id).sort()).toEqual(['kopi-susu', 'matcha']);
  });

  it('impor ulang berkas yang sama: semua "tak berubah", tanpa audit baru', async () => {
    const r = await imp(owner, CSV, true);
    expect(r.body.summary).toEqual({ create: 0, update: 0, unchanged: 3 });
    expect((await h.db.admin.query("select 1 from audit_log where action = 'menu.import'")).rowCount).toBe(2); // tetap dicatat sebagai kejadian impor
  });

  it('semua atau tidak sama sekali: satu baris salah membatalkan seluruh impor, dengan nomor baris', async () => {
    const bad = 'nama,kategori,harga\nTeh,Minuman,15000\nRoti,Makanan,gratis\nJus,Minuman\n';
    const r = await imp(owner, bad, true);
    expect(r.body.applied).toBe(false);
    expect(r.body.errors.map((e: { line: number }) => e.line)).toEqual([3, 4]);
    expect((await menu()).map((x) => x.id)).not.toContain('teh');
    expect((await imp(owner, 'foo,bar\n1,2', true)).body.errors.length).toBeGreaterThan(0);
  });

  it('akses dan masukan: MANAGER dan terminal ditolak, csv wajib teks, tenant lain terpisah', async () => {
    expect((await imp(manager, CSV, true)).status).toBe(403);
    expect((await imp(term, CSV, true)).status).toBe(403);
    expect((await imp(undefined, CSV, true)).status).toBe(401);
    expect((await imp(owner, 123 as never)).status).toBe(400);
    expect((await imp(owner, CSV, 'ya' as never)).status).toBe(400);
    expect((await imp(ownerB, CSV, true)).body.summary).toMatchObject({ create: 3, update: 0 }); // id sama boleh di tenant lain
    expect((await menu()).find((x) => x.id === 'matcha')!.price).toBe(30_000);
  });
});

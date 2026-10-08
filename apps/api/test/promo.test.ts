import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const T0 = Date.parse('2026-10-02T10:00:00+07:00');

describe('promo', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let manager: string;
  let ownerB: string;
  let term1: string;
  let term2: string;
  let kds: string;

  const post = (tok: string | undefined, body: unknown) => h.http('POST', '/v1/promos', tok, body);
  const put = (tok: string, id: string, body: unknown) => h.http('PUT', `/v1/promos/${id}`, tok, body);
  const list = async (tok = owner) => (await h.http('GET', '/v1/promos', tok)).body as { id: string; active: boolean; outletId: string | null; [k: string]: unknown }[];
  const cfg = async (tok: string) => (await h.http('GET', '/v1/device/config', tok)).body;

  beforeAll(async () => {
    h = await createHarness(T0);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t1', 'o2', 'Outlet 2', { terminals: ['term-2'] });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term1 = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    term2 = await h.admin.createDevice('t1', 'o2', 'term-2', 'terminal');
    kds = await h.admin.createDevice('t1', 'o1', 'kds-1', 'kds');
  });
  afterAll(() => h.close());

  it('tanpa promo, konfigurasi terminal tidak memuat kunci promos maupun utcOffsetMinutes', async () => {
    const c = await cfg(term1);
    expect(c).not.toHaveProperty('promos');
    expect(c.outlet).not.toHaveProperty('utcOffsetMinutes');
  });

  it('OWNER dan OPS boleh membuat; MANAGER hanya membaca; terminal dan tanpa token ditolak', async () => {
    const body = { id: 'hemat10', name: 'Hemat 10%', kind: 'PERCENT', value: 10, maxDiscount: 20_000 };
    expect((await post(manager, body)).status).toBe(403);
    expect((await post(term1, body)).status).toBe(403);
    expect((await post(undefined, body)).status).toBe(401);
    expect((await post(ops, body)).status).toBe(201);
    expect((await post(owner, body)).status).toBe(400); // id ganda
    expect((await list(manager)).map((p) => p.id)).toEqual(['hemat10']);
    expect((await h.http('GET', '/v1/promos', term1)).status).toBe(403);
    const audit = (await h.db.admin.query<{ detail: { id: string } }>("select detail from audit_log where action = 'promo.create'")).rows;
    expect(audit.map((a) => a.detail.id)).toEqual(['hemat10']);
  });

  it('validasi: setiap pelanggaran aturan promo ditolak dengan 400, dan tidak ada yang tersimpan', async () => {
    const ok = { name: 'X', kind: 'PERCENT', value: 10 };
    for (const bad of [
      { id: 'Besar', ...ok }, { id: 'a', ...ok, value: 150 }, { id: 'b', ...ok, kind: 'LAIN' }, { id: 'c', ...ok, days: [9] },
      { id: 'd', ...ok, startHour: 20, endHour: 10 }, { id: 'e', ...ok, startDate: '2026-13-01' }, { id: 'f', kind: 'AMOUNT', name: 'X', value: 5_000, maxDiscount: 1_000 },
      { id: 'g', ...ok, outletId: 'tidak-ada' },
    ]) expect((await post(owner, bad)).status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
    expect(await list()).toHaveLength(1);
  });

  it('terminal menerima promo aktif outletnya (khusus outlet atau semua), lengkap dengan zona waktu outlet; layar dapur tidak', async () => {
    expect((await post(owner, { id: 'happy', name: 'Happy hour', kind: 'PERCENT', value: 20, days: [1, 2, 3], startHour: 14, endHour: 17, minSubtotal: 30_000 })).status).toBe(201);
    expect((await post(owner, { id: 'o2-only', name: 'Khusus O2', kind: 'AMOUNT', value: 5_000, outletId: 'o2' })).status).toBe(201);
    const c1 = await cfg(term1);
    expect(c1.promos.map((p: { id: string }) => p.id)).toEqual(['happy', 'hemat10']);
    expect(c1.promos.find((p: { id: string }) => p.id === 'happy')).toEqual({ id: 'happy', name: 'Happy hour', kind: 'PERCENT', value: 20, minSubtotal: 30_000, days: [1, 2, 3], startHour: 14, endHour: 17 });
    expect(c1.promos.find((p: { id: string }) => p.id === 'hemat10')).toEqual({ id: 'hemat10', name: 'Hemat 10%', kind: 'PERCENT', value: 10, maxDiscount: 20_000 });
    expect(c1.outlet.utcOffsetMinutes).toBe(420);
    expect((await cfg(term2)).promos.map((p: { id: string }) => p.id)).toEqual(['happy', 'hemat10', 'o2-only']);
    expect(await cfg(kds)).not.toHaveProperty('promos');
  });

  it('ubah: nilai digabung dengan yang lama, null menghapus batasan, id tidak bisa diganti; nonaktif keluar dari konfigurasi dan versi berubah', async () => {
    const v0 = (await cfg(term1)).version;
    expect((await put(ops, 'happy', { value: 25, minSubtotal: null, startHour: null, endHour: null })).status).toBe(200);
    expect((await cfg(term1)).promos.find((p: { id: string }) => p.id === 'happy')).toEqual({ id: 'happy', name: 'Happy hour', kind: 'PERCENT', value: 25, days: [1, 2, 3] });
    expect((await cfg(term1)).version).not.toBe(v0);
    expect((await put(owner, 'happy', { startHour: 10 })).status).toBe(400); // jam mulai tanpa jam akhir
    expect((await put(owner, 'happy', { id: 'lain' })).status).toBe(400);
    expect((await put(owner, 'tidak-ada', { value: 5 })).status).toBe(404);
    expect((await put(manager, 'happy', { value: 5 })).status).toBe(403);
    expect((await put(owner, 'happy', { active: false })).status).toBe(200);
    expect((await cfg(term1)).promos.map((p: { id: string }) => p.id)).toEqual(['hemat10']);
    expect((await list()).find((p) => p.id === 'happy')).toMatchObject({ active: false, value: 25 }); // tetap ada untuk audit diskon lama
    expect((await put(owner, 'happy', { active: 'ya' })).status).toBe(400);
  });

  it('tenant lain tidak melihat atau mengubah promo ini', async () => {
    expect(await list(ownerB)).toEqual([]);
    expect((await put(ownerB, 'hemat10', { value: 1 })).status).toBe(404);
    expect((await post(ownerB, { id: 'hemat10', name: 'Milik B', kind: 'AMOUNT', value: 1_000 })).status).toBe(201); // id sama boleh di tenant lain
    expect((await list()).find((p) => p.id === 'hemat10')).toMatchObject({ name: 'Hemat 10%' });
  });

  it('ingest: diskon PROMO wajib membawa promoId, dan promoId hanya untuk PROMO', async () => {
    const send = (payload: unknown) => {
      const s = new Sim('o1', '2026-10-02', 'term-1', 'sensor-1');
      return h.postEvents(term1, [s.pos({ type: 'discount.applied', payload } as never, '10:00:00', 'budi')]);
    };
    const base = { orderId: 'term-1-1', amount: 7_400, percent: 10, verified: true };
    expect((await send({ ...base, kind: 'PROMO', promoId: 'hemat10' })).status).toBe(201);
    expect((await send({ ...base, kind: 'PROMO' })).status).toBe(400);
    expect((await send({ ...base, kind: 'PROMO', promoId: 'x'.repeat(33) })).status).toBe(400);
    expect((await send({ ...base, kind: 'MANUAL', promoId: 'hemat10' })).status).toBe(400);
  });

  it('evaluasi: diskon dengan promo karangan atau melebihi aturan menjadi temuan R32; promo sah dan promo yang kemudian dinonaktifkan tidak', async () => {
    h.setNow(Date.parse('2026-10-02T12:00:00+07:00'));
    const s = new Sim('o1', '2026-10-02', 'term-1', 'sensor-1');
    const disc = (orderId: string, at: string, d: Record<string, unknown>) => {
      s.pos({ type: 'order.created', payload: { orderId, orderType: 'TAKE_AWAY' } }, at, 'budi');
      s.pos({ type: 'discount.applied', payload: { orderId, kind: 'PROMO', verified: true, ...d } } as never, at, 'budi');
    };
    disc('ok-1', '10:00:00', { promoId: 'hemat10', amount: 5_000, percent: 7 });
    disc('palsu', '10:10:00', { promoId: 'gratis-semua', amount: 60_000, percent: 100 });
    disc('gelembung', '10:20:00', { promoId: 'hemat10', amount: 30_000, percent: 40 });
    disc('lama', '10:30:00', { promoId: 'happy', amount: 5_000, percent: 20 }); // 'happy' sudah dinonaktifkan tetapi tetap dikenal
    expect((await h.postEvents(term1, s.events)).status).toBe(201);
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    const incidents = (await h.http('GET', '/v1/outlets/o1/incidents', owner)).body as { hits: { rule: string; orderId: string | null; note: string }[] }[];
    const r32 = incidents.flatMap((i) => i.hits).filter((x) => x.rule === 'R32');
    expect(r32.map((x) => x.orderId).sort()).toEqual(['gelembung', 'palsu']);
    expect(r32.find((x) => x.orderId === 'palsu')!.note).toContain('tidak dikenal');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventChain } from '@pos/events';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const DAY = '2026-10-02';
const T0 = Date.parse(`${DAY}T12:00:00+07:00`);
const MIN = 60_000;

describe('layar dapur (KDS)', () => {
  let h: Harness;
  let owner: string;
  let ownerB: string;
  let term: string;
  let sensor: string;
  let kds: string;
  let kdsB: string;
  let kdsChain: EventChain;

  const pair = async (token: string, outletId: string, deviceId: string) => {
    const p = await h.http('POST', '/v1/devices/pairing', token, { outletId, kind: 'kds', deviceId });
    expect(p.status).toBe(201);
    const e = await h.http('POST', '/v1/device/enroll', undefined, { code: p.body.code });
    expect(e.status).toBe(201);
    return e.body.token as string;
  };
  const caps = async (outletId: string) =>
    (await h.db.admin.query<{ capabilities: { kds: boolean } }>('select capabilities from outlet where id = $1', [outletId])).rows[0]!.capabilities.kds;
  const board = (token: string) => h.http('GET', '/v1/kds/board', token);
  const status = (min: number, orderId: string, st: 'COOKING' | 'READY' | 'SERVED') =>
    kdsChain.append({ type: 'kitchen.status_changed', payload: { orderId, status: st }, deviceTime: T0 + min * MIN, actorId: null });

  beforeAll(async () => {
    h = await createHarness(T0 + 10 * MIN);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ownerB = await h.admin.createApiToken('t2', 'owner-2', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    sensor = await h.admin.createDevice('t1', 'o1', 'sensor-1', 'sensor');
    expect((await h.http('POST', '/v1/staff', owner, { id: 'budi', name: 'Budi', role: 'CASHIER', pin: '4827' })).status).toBe(201);
    expect((await h.http('POST', '/v1/menu', owner, { id: 'kopi', name: 'Kopi', price: 22_000, category: 'Kopi' })).status).toBe(201);
  });
  afterAll(() => h.close());

  it('kapabilitas kds outlet mengikuti perangkat layar dapur: aktif saat dipasang, mati saat yang terakhir dicabut, tercatat di audit', async () => {
    expect(await caps('o1')).toBe(false);
    kds = await pair(owner, 'o1', 'kds-1');
    expect(await caps('o1')).toBe(true);
    kdsB = await pair(owner, 'o1', 'kds-2');
    expect((await h.http('POST', '/v1/devices/kds-1/revoke', owner)).status).toBe(201);
    expect(await caps('o1')).toBe(true); // kds-2 masih aktif
    expect((await h.http('POST', '/v1/devices/kds-2/revoke', owner)).status).toBe(201);
    expect(await caps('o1')).toBe(false);
    const audit = (await h.db.admin.query<{ detail: { kds: boolean } }>("select detail from audit_log where action = 'outlet.capability.kds' order by id")).rows;
    expect(audit.map((a) => a.detail.kds)).toEqual([true, false]); // dua perubahan nyata, bukan tiap pairing
    // perangkat baru setelah yang lama dicabut
    kds = await pair(owner, 'o1', 'kds-3');
    kdsChain = new EventChain('kds-3', 'o1');
    expect(await caps('o1')).toBe(true);
  });

  it('pairing terminal biasa tidak mengubah kapabilitas', async () => {
    const before = await caps('o1');
    const p = await h.http('POST', '/v1/devices/pairing', owner, { outletId: 'o1', kind: 'terminal', deviceId: 'pos-9' });
    await h.http('POST', '/v1/device/enroll', undefined, { code: p.body.code });
    expect(await caps('o1')).toBe(before);
  });

  it('papan: tiket muncul dengan item, opsi, catatan, meja, dan status NEW; yang belum dikirim ke dapur tidak', async () => {
    const s = new Sim('o1', DAY, 'term-1', 'sensor-1');
    s.pos({ type: 'order.created', payload: { orderId: 'term-1-1', orderType: 'DINE_IN', tableNo: '7' } }, '12:01:00', 'budi');
    s.pos({
      type: 'order.sent_to_kitchen',
      payload: { orderId: 'term-1-1', items: [{ itemId: 'matcha', name: 'Matcha', qty: 2, unitPrice: 34_000, note: 'es sedikit', options: [{ group: 'Ukuran', name: 'Large', price: 6_000 }] }] },
    }, '12:02:00', 'budi');
    s.pos({ type: 'order.created', payload: { orderId: 'term-1-2', orderType: 'TAKE_AWAY' } }, '12:03:00', 'budi'); // belum dikirim
    expect((await h.postEvents(term, s.events)).status).toBe(201);

    const r = await board(kds);
    expect(r.status).toBe(200);
    expect(r.body.tickets).toHaveLength(1);
    expect(r.body.tickets[0]).toMatchObject({
      orderId: 'term-1-1', ref: '1', type: 'DINE_IN', table: '7', status: 'NEW',
      lines: [{ name: 'Matcha', options: ['Large'], note: 'es sedikit', qty: 2 }],
    });
    expect(r.body.generatedAt).toBe(T0 + 10 * MIN);
  });

  it('layar dapur mengubah status lewat event; papan berubah, dan hanya status/heartbeat yang boleh dikirim', async () => {
    const ok = await h.postEvents(kds, [status(5, 'term-1-1', 'COOKING')]);
    expect(ok.status).toBe(201);
    expect((await board(kds)).body.tickets[0]).toMatchObject({ status: 'COOKING' });

    const hb = kdsChain.append({ type: 'device.heartbeat', payload: { kind: 'kds' }, deviceTime: T0 + 6 * MIN, actorId: null });
    expect((await h.postEvents(kds, [hb])).status).toBe(201);

    const forged = new EventChain('kds-3', 'o1').append({ type: 'payment.received', payload: { orderId: 'term-1-1', method: 'CASH', amount: 1 }, deviceTime: T0 + 7 * MIN, actorId: null });
    const bad = await h.postEvents(kds, [forged]);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/layar dapur hanya boleh mengirim/);
  });

  it('SERVED menutup tiket dari papan', async () => {
    expect((await h.postEvents(kds, [status(8, 'term-1-1', 'SERVED')])).status).toBe(201);
    expect((await board(kds)).body.tickets).toEqual([]);
  });

  it('akses: sensor 403, pengguna dashboard 403, tanpa token 401; tenant lain tidak melihat tiket outlet ini', async () => {
    expect((await board(sensor)).status).toBe(403);
    expect((await board(owner)).status).toBe(403);
    expect((await h.http('GET', '/v1/device/config', sensor)).status).toBe(403);
    expect((await h.http('GET', '/v1/kds/board')).status).toBe(401);
    expect((await board(term)).status).toBe(200); // terminal boleh membaca papan
    kdsB = await h.admin.createDevice('t2', 'ox', 'kds-x', 'kds');
    expect((await board(kdsB)).body.tickets).toEqual([]);
    expect(ownerB).toBeTruthy();
  });

  it('konfigurasi layar dapur tanpa staf dan menu; terminal tetap menerima keduanya dan jenis perangkatnya', async () => {
    const k = (await h.http('GET', '/v1/device/config', kds)).body;
    expect(k).toMatchObject({ deviceKind: 'kds', staff: [], menu: [] });
    expect(k.outlet).toMatchObject({ id: 'o1' });
    expect(JSON.stringify(k)).not.toMatch(/"salt"|"hash"|4827/);
    const t = (await h.http('GET', '/v1/device/config', term)).body;
    expect(t.deviceKind).toBe('terminal');
    expect(t.staff.map((x: { id: string }) => x.id)).toEqual(['budi']);
    expect(t.menu.map((x: { id: string }) => x.id)).toEqual(['kopi']);
  });
});

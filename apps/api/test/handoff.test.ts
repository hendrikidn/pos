import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LineItem } from '@pos/events';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const DAY = '2026-10-02';
const T0 = Date.parse(`${DAY}T12:00:00+07:00`);
const MIN = 60_000;
const items: LineItem[] = [{ itemId: 'kopi', name: 'Kopi', qty: 2, unitPrice: 20_000, sentQty: 1 }, { itemId: 'latte', name: 'Latte', qty: 1, unitPrice: 26_000, sentQty: 0 }];

describe('serah-terima order antar-terminal (server)', () => {
  let h: Harness;
  let owner: string;
  let t1: string;
  let t2: string;
  let t3: string;
  let sensor: string;
  let tx: string;
  // Sim per terminal: nomor urut event dan rantai hash dijaga sendiri-sendiri
  let s1: Sim;
  let s2: Sim;

  const list = (tok: string) => h.http('GET', '/v1/handoffs', tok);
  const claim = (tok: string, orderId: string) => h.http('POST', `/v1/handoffs/${orderId}/claim`, tok);
  const handOff = (s: Sim, orderId: string, hms: string, type: 'DINE_IN' | 'TAKE_AWAY' = 'DINE_IN') => {
    s.pos({ type: 'order.created', payload: { orderId, orderType: type, ...(type === 'DINE_IN' ? { tableNo: '3' } : {}) } }, hms, 'sari');
    return s.pos({ type: 'order.handed_off', payload: { orderId, orderType: type, ...(type === 'DINE_IN' ? { tableNo: '3' } : {}), items } }, hms, 'sari');
  };
  const sync = async (tok: string, s: Sim) => expect((await h.postEvents(tok, s.events.filter((e) => e.deviceId === s.terminalId))).status).toBe(201);

  beforeAll(async () => {
    h = await createHarness(T0 + 10 * MIN);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1', 'term-2', 'term-3'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X', { terminals: ['term-x'] });
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    t1 = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    t2 = await h.admin.createDevice('t1', 'o1', 'term-2', 'terminal');
    t3 = await h.admin.createDevice('t1', 'o1', 'term-3', 'terminal');
    sensor = await h.admin.createDevice('t1', 'o1', 'sensor-1', 'sensor');
    tx = await h.admin.createDevice('t2', 'ox', 'term-x', 'terminal');
    s1 = new Sim('o1', DAY, 'term-1', 'sensor-1');
    s2 = new Sim('o1', DAY, 'term-2', 'sensor-1');
  });
  afterAll(() => h.close());

  it('sebelum event sampai ke server, order tidak bisa diklaim (404)', async () => {
    handOff(s1, 'term-1-1', '12:01:00');
    expect((await claim(t2, 'term-1-1')).status).toBe(404);
    expect((await list(t2)).body.incoming).toEqual([]);
  });

  it('setelah tersinkron: terminal lain melihatnya lengkap dengan isi; terminal asal melihatnya menunggu, bukan masuk', async () => {
    await sync(t1, s1);
    for (const tok of [t2, t3]) {
      const r = await list(tok);
      expect(r.status).toBe(200);
      expect(r.body.incoming).toMatchObject([{ orderId: 'term-1-1', fromDeviceId: 'term-1', orderType: 'DINE_IN', tableNo: '3', items }]);
      expect(r.body.outgoing).toEqual([]);
    }
    const own = await list(t1);
    expect(own.body.incoming).toEqual([]);
    expect(own.body.outgoing).toEqual([{ orderId: 'term-1-1', state: 'PENDING' }]);
  });

  it('dua terminal mengklaim bersamaan: tepat satu menang, yang lain 409; yang kalah tidak lagi melihatnya', async () => {
    const [a, b] = await Promise.all([claim(t2, 'term-1-1'), claim(t3, 'term-1-1')]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const [win, lose] = a.status === 201 ? [t2, t3] : [t3, t2];
    expect(a.status === 201 ? a.body : b.body).toMatchObject({ orderId: 'term-1-1', fromDeviceId: 'term-1', items });
    expect((await list(lose)).body.incoming).toEqual([]);
    expect((await list(win)).body.incoming).toHaveLength(1); // pemenang tetap melihatnya sampai selesai
    expect((await claim(win, 'term-1-1')).status).toBe(201); // klaim ulang oleh pemenang aman
    expect((await claim(lose, 'term-1-1')).status).toBe(409);
    expect((await claim(t1, 'term-1-1')).status).toBe(409); // terminal asal pun tidak bisa menarik yang sudah diklaim
    expect((await h.http('GET', '/v1/handoffs', t1)).body.outgoing).toEqual([{ orderId: 'term-1-1', state: 'PENDING' }]);
  });

  it('klaim yang tidak diselesaikan dilepas setelah 10 menit; terminal lain bisa mengambil', async () => {
    const holder = (await claim(t2, 'term-1-1')).status === 201 ? t2 : t3;
    const other = holder === t2 ? t3 : t2;
    expect((await claim(other, 'term-1-1')).status).toBe(409);
    h.setNow(T0 + 21 * MIN);
    expect((await claim(other, 'term-1-1')).status).toBe(201);
    h.setNow(T0 + 22 * MIN);
    expect((await claim(holder, 'term-1-1')).status).toBe(409); // sekarang pemegang lama yang kalah
  });

  it('setelah pengambil mencatat MERGE: terminal asal melihat ACCEPTED dan nama pengambil; klaim berikutnya 409', async () => {
    const taker = (await claim(t2, 'term-1-1')).status === 201 ? { tok: t2, sim: s2 } : { tok: t3, sim: new Sim('o1', DAY, 'term-3', 'sensor-1') };
    const id = `${taker.sim.terminalId}-1`;
    taker.sim.pos({ type: 'order.created', payload: { orderId: id, orderType: 'DINE_IN', tableNo: '3' } }, '12:25:00', 'budi');
    taker.sim.pos({ type: 'order.items_moved', payload: { fromOrderId: 'term-1-1', toOrderId: id, kind: 'MERGE', items, sent: true } }, '12:25:01', 'budi');
    await sync(taker.tok, taker.sim);
    expect((await list(t1)).body.outgoing).toEqual([{ orderId: 'term-1-1', state: 'ACCEPTED', by: taker.sim.terminalId }]);
    expect((await claim(t3, 'term-1-1')).status).toBe(409);
    expect((await list(t2)).body.incoming).toEqual([]);
    expect((await list(t3)).body.incoming).toEqual([]);
  });

  it('tarik kembali: terminal asal mengklaim miliknya sendiri lalu mencatat reclaimed; terminal lain tidak bisa lagi mengambil', async () => {
    handOff(s1, 'term-1-2', '12:30:00', 'TAKE_AWAY');
    await sync(t1, s1);
    expect((await claim(t1, 'term-1-2')).status).toBe(201);
    s1.pos({ type: 'order.handoff_reclaimed', payload: { orderId: 'term-1-2' } }, '12:31:00', 'sari');
    await sync(t1, s1);
    expect((await list(t1)).body.outgoing).toContainEqual({ orderId: 'term-1-2', state: 'RECLAIMED' });
    expect((await claim(t2, 'term-1-2')).status).toBe(409);
    expect((await list(t2)).body.incoming).toEqual([]);
  });

  it('serah-terima baru untuk order yang sama setelah ditarik membuka klaim baru', async () => {
    s1.pos({ type: 'order.handed_off', payload: { orderId: 'term-1-2', orderType: 'TAKE_AWAY', items } }, '12:35:00', 'sari');
    await sync(t1, s1);
    expect((await list(t2)).body.incoming.map((x: { orderId: string }) => x.orderId)).toEqual(['term-1-2']);
    expect((await claim(t2, 'term-1-2')).status).toBe(201);
  });

  it('akses: sensor 403, pengguna dashboard 403, tanpa token 401; terminal outlet lain tidak melihat atau mengklaim', async () => {
    for (const tok of [sensor, owner]) {
      expect((await list(tok)).status).toBe(403);
      expect((await claim(tok, 'term-1-2')).status).toBe(403);
    }
    expect((await h.http('GET', '/v1/handoffs')).status).toBe(401);
    expect((await list(tx)).body).toEqual({ incoming: [], outgoing: [] });
    expect((await claim(tx, 'term-1-2')).status).toBe(404);
  });

  it('validasi event: order karyawan tidak bisa diserahkan, isi wajib dan dibatasi seperti event lain', async () => {
    const bad = (payload: unknown) => {
      const s = new Sim('o1', DAY, 'term-3', 'sensor-1');
      return h.postEvents(t3, [s.pos({ type: 'order.handed_off', payload } as never, '13:00:00', 'sari')]);
    };
    expect((await bad({ orderId: 'x-1', orderType: 'EMPLOYEE', items })).status).toBe(400);
    expect((await bad({ orderId: 'x-1', orderType: 'DINE_IN' })).status).toBe(400);
    expect((await bad({ orderId: 'x-1', orderType: 'DINE_IN', items: [] })).status).toBe(400);
    expect((await bad({ orderId: 'x-1', orderType: 'DINE_IN', tableNo: 'terlalu-panjang-banget', items })).status).toBe(400);
    expect((await bad({ orderId: 'x-1', orderType: 'DINE_IN', items: [{ ...items[0], qty: 0 }] })).status).toBe(400);
  });
});

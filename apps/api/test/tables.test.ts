import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const DAY = '2026-10-02';
const T0 = Date.parse(`${DAY}T12:00:00+07:00`);
const MIN = 60_000;

describe('denah meja dan papan meja lintas-terminal', () => {
  let h: Harness;
  let owner: string;
  let t1: string;
  let t2: string;
  let sensor: string;
  let tx: string;

  const settings = (token: string, body: unknown, outlet = 'o1') => h.http('PUT', `/v1/outlets/${outlet}/settings`, token, body);
  const board = (token: string) => h.http('GET', '/v1/tables/board', token);

  beforeAll(async () => {
    h = await createHarness(T0 + 30 * MIN);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1', 'term-2'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X', { terminals: ['term-x'] });
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    t1 = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    t2 = await h.admin.createDevice('t1', 'o1', 'term-2', 'terminal');
    sensor = await h.admin.createDevice('t1', 'o1', 'sensor-1', 'sensor');
    tx = await h.admin.createDevice('t2', 'ox', 'term-x', 'terminal');
  });
  afterAll(() => h.close());

  it('denah disimpan, tercatat di audit, dan sampai ke konfigurasi terminal (versi berubah); tanpa denah tidak ada kuncinya', async () => {
    const before = (await h.http('GET', '/v1/device/config', t1)).body;
    expect(before.outlet).not.toHaveProperty('tables');
    const tables = [{ no: '1', area: 'Indoor', seats: 4 }, { no: '2', area: 'Indoor', seats: 2 }, { no: 'T1', area: 'Teras', seats: 6 }];
    expect((await settings(owner, { tables })).status).toBeLessThan(300);
    const after = (await h.http('GET', '/v1/device/config', t1)).body;
    expect(after.outlet.tables).toEqual(tables);
    expect(after.version).not.toBe(before.version);
    expect((await h.http('GET', '/v1/outlets/o1/settings', owner)).body.tables).toEqual(tables);
    const audit = (await h.db.admin.query<{ detail: { fields: string[] } }>("select detail from audit_log where action = 'outlet.settings' order by id desc limit 1")).rows[0]!;
    expect(audit.detail.fields).toContain('tables');
  });

  it('validasi denah: nomor ganda (tanpa peduli huruf besar), format, area, kursi, dan jumlah', async () => {
    const bad = (tables: unknown) => settings(owner, { tables });
    expect((await bad([{ no: 'a1', area: 'X', seats: 2 }, { no: 'A1', area: 'X', seats: 2 }])).status).toBe(400);
    expect((await bad([{ no: 'meja satu', area: 'X', seats: 2 }])).status).toBe(400);
    expect((await bad([{ no: '12345678901', area: 'X', seats: 2 }])).status).toBe(400);
    expect((await bad([{ no: '1', area: '  ', seats: 2 }])).status).toBe(400);
    expect((await bad([{ no: '1', area: 'X', seats: 0 }])).status).toBe(400);
    expect((await bad([{ no: '1', area: 'X', seats: 2.5 }])).status).toBe(400);
    expect((await bad(Array.from({ length: 201 }, (_, i) => ({ no: String(i), area: 'X', seats: 2 })))).status).toBe(400);
    expect((await bad('bukan daftar')).status).toBe(400);
    expect((await h.http('GET', '/v1/outlets/o1/settings', owner)).body.tables).toHaveLength(3); // tidak berubah oleh yang ditolak
  });

  it('papan: order terbuka dari dua terminal tampil dengan terminal asal; pembayaran lunas membebaskan meja', async () => {
    const a = new Sim('o1', DAY, 'term-1', 'sensor-1');
    a.pos({ type: 'order.created', payload: { orderId: 'term-1-1', orderType: 'DINE_IN', tableNo: '1' } }, '12:01:00', 'budi');
    a.pos({ type: 'order.sent_to_kitchen', payload: { orderId: 'term-1-1' } }, '12:02:00', 'budi');
    a.pos({ type: 'order.created', payload: { orderId: 'term-1-2', orderType: 'DINE_IN', tableNo: '2' } }, '12:03:00', 'budi');
    a.pos({ type: 'bill.printed', payload: { orderId: 'term-1-2', total: 40_000 } }, '12:04:00', 'budi');
    a.pos({ type: 'payment.received', payload: { orderId: 'term-1-2', method: 'CASH', amount: 40_000 } }, '12:05:00', 'budi');
    expect((await h.postEvents(t1, a.events)).status).toBe(201);
    const b = new Sim('o1', DAY, 'term-2', 'sensor-1');
    b.pos({ type: 'order.created', payload: { orderId: 'term-2-1', orderType: 'DINE_IN', tableNo: 'T1' } }, '12:06:00', 'sari');
    b.pos({ type: 'bill.printed', payload: { orderId: 'term-2-1', total: 90_000 } }, '12:07:00', 'sari');
    expect((await h.postEvents(t2, b.events)).status).toBe(201);

    // kedua terminal melihat papan yang sama
    for (const tok of [t1, t2]) {
      const r = await board(tok);
      expect(r.status).toBe(200);
      expect(r.body.generatedAt).toBe(T0 + 30 * MIN);
      expect(r.body.orders.map((o: { orderId: string; deviceId: string; tableNo: string; status: string; total: number | null }) => [o.orderId, o.deviceId, o.tableNo, o.status, o.total])).toEqual([
        ['term-1-1', 'term-1', '1', 'SENT', null],
        ['term-2-1', 'term-2', 'T1', 'BILLED', 90_000],
      ]);
    }
  });

  it('akses: sensor 403, pengguna dashboard 403, tanpa token 401; outlet lain tidak melihat order ini', async () => {
    expect((await board(sensor)).status).toBe(403);
    expect((await board(owner)).status).toBe(403);
    expect((await h.http('GET', '/v1/tables/board')).status).toBe(401);
    expect((await board(tx)).body.orders).toEqual([]);
  });

  it('denah dikosongkan dengan []; konfigurasi kembali tanpa kunci tables', async () => {
    expect((await settings(owner, { tables: [] })).status).toBeLessThan(300);
    expect((await h.http('GET', '/v1/device/config', t1)).body.outlet).not.toHaveProperty('tables');
    expect((await settings('bukan-token', { tables: [] })).status).toBe(401);
  });
});

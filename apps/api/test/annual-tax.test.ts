import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);

describe('ringkasan pajak tahunan: PBJT bulanan dan PPh Final UMKM', () => {
  let h: Harness;
  let owner: string;
  let manager: string;
  let ownerB: string;
  const get = (path: string, tok: string | null = owner) => h.http('GET', path, tok);
  const put = (path: string, tok: string, body: unknown) => h.http('PUT', path, tok, body);

  /** Satu order tunai tanpa diskon/service: PBJT 10% di atas subtotal. */
  function sale(s: Sim, id: string, day: string, subtotal: number) {
    const tax = subtotal / 10;
    s.pos({ type: 'order.created', payload: { orderId: id, orderType: 'DINE_IN' } } as never, WIB(`${day}T10:00:00`), 'budi');
    s.pos({ type: 'bill.printed', payload: { orderId: id, total: subtotal + tax, breakdown: { subtotal, discount: 0, service: 0, tax, rounding: 0 } } }, WIB(`${day}T10:01:00`), 'budi');
    s.pos({ type: 'payment.received', payload: { orderId: id, method: 'CASH', amount: subtotal + tax } }, WIB(`${day}T10:02:00`), 'budi');
  }

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-09T12:00:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    for (const o of ['o1', 'o2']) await h.admin.createOutlet('t1', o, o, { terminals: [`term-${o}`], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    const s1 = new Sim('o1', '2026-01-10', 'term-o1', 'sensor-1');
    const s2 = new Sim('o2', '2026-01-10', 'term-o2', 'sensor-2');
    sale(s1, 'j1', '2026-01-10', 300_000_000);
    sale(s2, 'f1', '2026-02-10', 300_000_000);
    sale(s1, 'm1', '2026-03-10', 100_000_000);
    for (const [o, s] of [['o1', s1], ['o2', s2]] as const) {
      const dev = await h.admin.createDevice('t1', o, `term-${o}`, 'terminal');
      expect((await h.postEvents(dev, s.events)).status).toBe(201);
    }
  });
  afterAll(() => h.close());

  it('satu outlet: PBJT dan omzet per bulan sampai bulan berjalan; tanpa profil tidak ada PPh Final', async () => {
    const r = await get('/v1/outlets/o1/reports/annual-tax?year=2026');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.months).toHaveLength(10); // Januari-Oktober (sekarang 9 Oktober)
    expect(r.body.months[0]).toMatchObject({ month: '2026-01', orders: 1, omzet: 300_000_000, pbjt: 30_000_000, pphFinal: 0 });
    expect(r.body.months[1]).toMatchObject({ month: '2026-02', orders: 0, omzet: 0 });
    expect(r.body.months[2]).toMatchObject({ month: '2026-03', omzet: 100_000_000, cumulativeOmzet: 400_000_000 });
    expect(r.body.totals).toEqual({ omzet: 400_000_000, pbjt: 40_000_000, pphFinal: 0 });
    expect(r.body.umkmFinal).toBe(false);
  });

  it('semua outlet menjumlahkan omzet; PPh Final OP: 0,5% atas omzet kumulatif di atas Rp500 juta, per bulan selisih kumulatif', async () => {
    expect((await put('/v1/hr/employer-tax', owner, { npwp: '029482015507000', legalName: 'PT Kopi', umkmFinal: true, taxpayerType: 'OP' })).status).toBe(200);
    const r = await get('/v1/outlets/all/reports/annual-tax?year=2026');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.months.slice(0, 3).map((m: { pphFinal: number }) => m.pphFinal)).toEqual([0, 500_000, 500_000]); // kumulatif 300/600/700 jt
    expect(r.body.months[1].cumulativeOmzet).toBe(600_000_000);
    expect(r.body.totals).toEqual({ omzet: 700_000_000, pbjt: 70_000_000, pphFinal: 1_000_000 });
    expect(r.body.notes.join(' ')).toContain('Rp500 juta');
  });

  it('badan usaha tidak mendapat batas bebas Rp500 juta', async () => {
    expect((await put('/v1/hr/employer-tax', owner, { npwp: '029482015507000', legalName: 'PT Kopi', umkmFinal: true, taxpayerType: 'BADAN' })).status).toBe(200);
    const r = await get('/v1/outlets/all/reports/annual-tax?year=2026');
    expect(r.body.months.slice(0, 3).map((m: { pphFinal: number }) => m.pphFinal)).toEqual([1_500_000, 1_500_000, 500_000]);
    expect(r.body.totals.pphFinal).toBe(3_500_000);
  });

  it('akses dan validasi: all hanya OWNER; manager boleh per outlet; tahun salah 400; outlet asing 404/400; tenant lain terpisah', async () => {
    expect((await get('/v1/outlets/all/reports/annual-tax?year=2026', manager)).status).toBe(403);
    expect((await get('/v1/outlets/o1/reports/annual-tax?year=2026', manager)).status).toBe(200);
    expect((await get('/v1/outlets/o1/reports/annual-tax?year=2026', null)).status).toBe(401);
    for (const y of ['', '26', '2023', '2027', 'abcd']) expect((await get(`/v1/outlets/o1/reports/annual-tax?year=${y}`)).status, y).toBe(400);
    expect([400, 403, 404]).toContain((await get('/v1/outlets/ox/reports/annual-tax?year=2026')).status);
    const b = await get('/v1/outlets/all/reports/annual-tax?year=2026', ownerB);
    expect(b.status).toBe(200);
    expect(b.body.totals.omzet).toBe(0);
    expect(b.body.umkmFinal).toBe(false);
  });
});

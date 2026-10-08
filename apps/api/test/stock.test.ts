import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LineItem } from '@pos/events';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const DAY = '2026-10-01';
const T = (hms: string) => Date.parse(`${DAY}T${hms}+07:00`);

describe('inventori dan stok', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let manager: string;
  let supervisor: string;
  let ownerB: string;
  let term: string;
  const sim = new Sim('o1', DAY, 'term-1', 'sensor-1');
  let posted = 0;
  const flush = async () => {
    const batch = sim.events.slice(posted);
    posted = sim.events.length;
    expect((await h.postEvents(term, batch)).status).toBe(201);
  };
  const shot: LineItem['options'] = [{ id: 'shot', group: 'Tambahan', name: 'Extra shot', price: 5_000 }];
  const kopi = (qty: number, options?: LineItem['options']): LineItem => ({ itemId: 'kopi', name: 'Kopi', qty, unitPrice: 22_000, ...(options ? { options } : {}) });
  /** Order lengkap: dikirim ke dapur, ditagih, dibayar. */
  const sale = (id: string, hms: string, items: LineItem[]) => {
    sim.pos({ type: 'order.created', payload: { orderId: id, orderType: 'TAKE_AWAY' } }, T(hms), 'budi');
    sim.pos({ type: 'order.sent_to_kitchen', payload: { orderId: id, items } }, T(hms) + 1_000, 'budi');
    sim.pos({ type: 'bill.printed', payload: { orderId: id, total: 1, items } }, T(hms) + 2_000, 'budi');
    sim.pos({ type: 'payment.received', payload: { orderId: id, method: 'CASH', amount: 1 } }, T(hms) + 3_000, 'budi');
  };
  const at = (hms: string) => h.setNow(T(hms));
  const move = (token: string, body: object, outlet = 'o1') => h.http('POST', `/v1/outlets/${outlet}/stock/movements`, token, body);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- baris stok dibaca apa adanya dari respons JSON
  const stock = async (outlet = 'o1', token = owner): Promise<Record<string, any>> => {
    const r = await h.http('GET', `/v1/outlets/${outlet}/stock`, token);
    expect(r.status).toBe(200);
    return Object.fromEntries((r.body as { ingredientId: string }[]).map((x) => [x.ingredientId, x]));
  };

  beforeAll(async () => {
    h = await createHarness(T('08:00:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    supervisor = await h.admin.createApiToken('t1', 'hendra', 'SUPERVISOR');
    ownerB = await h.admin.createApiToken('t2', 'owner-2', 'OWNER');

    const p = (path: string, body: object) => h.http('POST', path, owner, body);
    expect((await p('/v1/menu', {
      id: 'kopi', name: 'Kopi', price: 22_000, category: 'Kopi',
      modifierGroups: [{ id: 'tambahan', name: 'Tambahan', min: 0, max: 1, options: [{ id: 'shot', name: 'Extra shot', price: 5_000 }, { id: 'oat', name: 'Oat', price: 8_000 }] }],
    })).status).toBe(201);
    for (const [id, name, unit, minStock] of [['biji', 'Biji kopi', 'g', 300], ['susu', 'Susu', 'ml', 1000], ['oat', 'Susu oat', 'ml', 0]] as const) {
      expect((await p('/v1/ingredients', { id, name, unit, minStock })).status).toBe(201);
    }
  });
  afterAll(() => h.close());

  describe('bahan dan resep', () => {
    it('hanya OWNER/OPS mengubah; MANAGER membaca; SUPERVISOR dan tenant lain ditolak', async () => {
      expect((await h.http('GET', '/v1/ingredients', manager)).status).toBe(200);
      expect((await h.http('POST', '/v1/ingredients', manager, { id: 'x', name: 'X', unit: 'g' })).status).toBe(403);
      expect((await h.http('GET', '/v1/ingredients', supervisor)).status).toBe(403);
      expect((await h.http('POST', '/v1/ingredients', ops, { id: 'gula', name: 'Gula', unit: 'g' })).status).toBe(201);
      expect((await h.http('GET', '/v1/ingredients', ownerB)).body).toEqual([]);
    });

    it('validasi bahan: id, nama, satuan, stok minimum, id ganda; satuan tidak bisa diubah', async () => {
      const bad: [object, RegExp][] = [
        [{ id: 'Besar', name: 'X', unit: 'g' }, /id/], [{ id: 'x1', name: '', unit: 'g' }, /nama/], [{ id: 'x1', name: 'X', unit: 'kg' }, /satuan/],
        [{ id: 'x1', name: 'X', unit: 'g', minStock: -1 }, /stok minimum/], [{ id: 'x1', name: 'X', unit: 'g', minStock: 1.5 }, /stok minimum/], [{ id: 'biji', name: 'X', unit: 'g' }, /sudah dipakai/],
      ];
      for (const [body, msg] of bad) {
        const r = await h.http('POST', '/v1/ingredients', owner, body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.body.message).toMatch(msg);
      }
      expect((await h.http('PUT', '/v1/ingredients/biji', owner, { unit: 'ml' })).status).toBe(400);
      expect((await h.http('PUT', '/v1/ingredients/tidak-ada', owner, { name: 'X' })).status).toBe(404);
      expect((await h.http('PUT', '/v1/ingredients/gula', owner, { name: 'Gula pasir', minStock: 500 })).status).toBe(200);
    });

    it('resep: diganti utuh per lingkup, dibaca per menu, opsi dan bahan divalidasi, daftar kosong menghapus', async () => {
      const set = (body: object, menu = 'kopi') => h.http('PUT', `/v1/menu/${menu}/recipe`, owner, body);
      expect((await set({ lines: [{ ingredientId: 'biji', qty: 18 }, { ingredientId: 'susu', qty: 150 }] })).status).toBe(200);
      expect((await set({ optionId: 'shot', lines: [{ ingredientId: 'biji', qty: 9 }] })).status).toBe(200);
      expect((await set({ optionId: 'oat', lines: [{ ingredientId: 'oat', qty: 200 }] })).status).toBe(200);
      expect((await h.http('GET', '/v1/recipes', manager)).body).toEqual({
        kopi: { base: { biji: 18, susu: 150 }, options: { shot: { biji: 9 }, oat: { oat: 200 } } },
      });
      // validasi
      const bad: [object, string, RegExp][] = [
        [{ lines: [{ ingredientId: 'tidak-ada', qty: 1 }] }, 'kopi', /bahan tidak ditemukan/],
        [{ lines: [{ ingredientId: 'biji', qty: 0 }] }, 'kopi', /qty/],
        [{ lines: [{ ingredientId: 'biji', qty: 1.5 }] }, 'kopi', /qty/],
        [{ lines: [{ ingredientId: 'biji', qty: 1 }, { ingredientId: 'biji', qty: 2 }] }, 'kopi', /ganda/],
        [{ optionId: 'tidak-ada', lines: [] }, 'kopi', /opsi tidak ada/],
        [{ lines: 'x' }, 'kopi', /lines/],
      ];
      for (const [body, menu, msg] of bad) {
        const r = await set(body, menu);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.body.message).toMatch(msg);
      }
      expect((await set({ lines: [] }, 'tidak-ada')).status).toBe(404);
      // penggantian utuh: resep dasar baru menghapus yang lama
      expect((await set({ lines: [{ ingredientId: 'biji', qty: 18 }, { ingredientId: 'susu', qty: 150 }] })).status).toBe(200);
      expect((await h.http('GET', '/v1/recipes', owner)).body.kopi.base).toEqual({ biji: 18, susu: 150 });
    });
  });

  describe('stok: perkiraan, pembelian, pembuangan, dan opname', () => {
    it('tanpa hitung awal: tidak ada perkiraan (NO_BASELINE), pembelian tercatat saja', async () => {
      at('09:00:00');
      const s = await stock();
      expect(s['biji']).toMatchObject({ status: 'NO_BASELINE', expected: null, baseline: null });
    });

    it('hitung awal: pertama kali tidak punya perkiraan sehingga tanpa selisih; stok = hasil hitung', async () => {
      at('09:00:00');
      const a = await move(owner, { ingredientId: 'biji', kind: 'COUNT', qty: 1000 });
      expect(a.status).toBe(201);
      expect(a.body).toMatchObject({ kind: 'COUNT', qty: 1000, expected: null, variance: null, userId: 'owner-1' });
      expect((await move(owner, { ingredientId: 'susu', kind: 'COUNT', qty: 5000 })).status).toBe(201);
      expect((await move(owner, { ingredientId: 'oat', kind: 'COUNT', qty: 2000 })).status).toBe(201);
      const s = await stock();
      expect(s['biji']).toMatchObject({ expected: 1000, status: 'OK', used: 0 });
    });

    it('penjualan mengurangi stok menurut resep: 10 kopi (1 dengan extra shot) = biji 189 g, susu 1.500 ml', async () => {
      sale('a1', '10:00:00', [kopi(9)]);
      sale('a2', '11:00:00', [kopi(1, shot)]);
      await flush();
      at('12:00:00');
      const s = await stock();
      // biji: 10×18 + 1×9 = 189; susu: 10×150 = 1.500
      expect(s['biji']).toMatchObject({ used: 189, expected: 811, baseline: { counted: 1000 } });
      expect(s['susu']).toMatchObject({ used: 1500, expected: 3500 });
      expect(s['oat']).toMatchObject({ used: 0, expected: 2000 });
    });

    it('pembelian menambah, pembuangan mengurangi dan wajib beralasan', async () => {
      at('12:10:00');
      expect((await move(manager, { ingredientId: 'biji', kind: 'PURCHASE', qty: 500, note: 'supplier A' })).status).toBe(201);
      expect((await move(manager, { ingredientId: 'susu', kind: 'WASTE', qty: 200 })).status).toBe(400); // tanpa alasan
      expect((await move(manager, { ingredientId: 'susu', kind: 'WASTE', qty: 200, note: 'tumpah' })).status).toBe(201);
      const s = await stock();
      expect(s['biji']).toMatchObject({ purchased: 500, expected: 1311 });
      expect(s['susu']).toMatchObject({ wasted: 200, expected: 3300 });
    });

    it('opname: menyimpan perkiraan, selisih, dan pemakaian periode; selisih besar ditandai, selisih nol tidak', async () => {
      at('13:00:00');
      const biji = await move(owner, { ingredientId: 'biji', kind: 'COUNT', qty: 1200 });
      expect(biji.body).toMatchObject({ expected: 1311, variance: -111, periodUsed: 189 });
      const susu = await move(owner, { ingredientId: 'susu', kind: 'COUNT', qty: 3300 });
      expect(susu.body).toMatchObject({ expected: 3300, variance: 0, periodUsed: 1500 });
      const counts = (await h.http('GET', '/v1/outlets/o1/stock/counts', manager)).body;
      // terbaru dulu: ambil opname paling baru per bahan
      const flagged: Record<string, boolean> = {};
      for (const c of counts as { ingredientId: string; flagged: boolean }[]) flagged[c.ingredientId] ??= c.flagged;
      // toleransi 5% × pemakaian 189 = 10 g → selisih −111 g ditandai; susu pas
      expect(flagged).toMatchObject({ biji: true, susu: false });
      expect(counts[0]).toHaveProperty('name');
    });

    it('setelah opname hitungan mulai dari hasil hitung: 2 kopi lagi → biji 1.200 − 36 = 1.164', async () => {
      sale('a3', '13:30:00', [kopi(2)]);
      await flush();
      at('14:00:00');
      const s = await stock();
      expect(s['biji']).toMatchObject({ baseline: { counted: 1200 }, purchased: 0, used: 36, expected: 1164 });
    });

    it('void sesudah dikirim tetap memakai bahan; void sebelum dikirim tidak; makan karyawan memakai bahan', async () => {
      // v1: dikirim ke dapur lalu di-void (3 kopi terpakai); v2: ditagih lalu di-void tanpa dikirim (tidak terpakai); m1: makan karyawan 1 kopi
      sim.pos({ type: 'order.created', payload: { orderId: 'v1', orderType: 'TAKE_AWAY' } }, T('14:10:00'), 'budi');
      sim.pos({ type: 'order.sent_to_kitchen', payload: { orderId: 'v1', items: [kopi(3)] } }, T('14:10:00') + 1000, 'budi');
      sim.pos({ type: 'void.approved', payload: { orderId: 'v1', reasonCode: 'WRONG_ORDER', approverIds: ['hendra'], amount: 1 } }, T('14:12:00'), 'budi');
      sim.pos({ type: 'order.created', payload: { orderId: 'v2', orderType: 'TAKE_AWAY' } }, T('14:15:00'), 'budi');
      sim.pos({ type: 'bill.printed', payload: { orderId: 'v2', total: 1, items: [kopi(5)] } }, T('14:15:00') + 1000, 'budi');
      sim.pos({ type: 'void.approved', payload: { orderId: 'v2', reasonCode: 'WRONG_ORDER', approverIds: ['hendra'], amount: 1 } }, T('14:16:00'), 'budi');
      sim.pos({ type: 'order.created', payload: { orderId: 'm1', orderType: 'EMPLOYEE', employeeId: 'andi' } }, T('14:20:00'), 'budi');
      sim.pos({ type: 'order.sent_to_kitchen', payload: { orderId: 'm1', items: [kopi(1)] } }, T('14:20:00') + 1000, 'budi');
      await flush();
      at('15:00:00');
      const s = await stock();
      expect(s['biji']).toMatchObject({ used: 36 + 54 + 18, expected: 1200 - 108 });
    });

    it('status: menipis (≤ stok minimum) dan habis (≤ 0)', async () => {
      at('15:30:00');
      // biji 1.092 g, minimum 300 → hitung ulang 250 g: LOW; lalu 0: EMPTY
      expect((await move(owner, { ingredientId: 'biji', kind: 'COUNT', qty: 250 })).status).toBe(201);
      expect((await stock())['biji']).toMatchObject({ status: 'LOW', expected: 250 });
      at('15:31:00');
      expect((await move(owner, { ingredientId: 'biji', kind: 'COUNT', qty: 0 })).status).toBe(201);
      expect((await stock())['biji']).toMatchObject({ status: 'EMPTY', expected: 0 });
    });

    it('pergerakan terbaru (maks. 10) ikut, yang terbaru dulu', async () => {
      const s = await stock();
      expect(s['biji'].recent.length).toBeLessThanOrEqual(10);
      expect(s['biji'].recent[0]).toMatchObject({ kind: 'COUNT', qty: 0 });
    });
  });

  describe('validasi dan isolasi', () => {
    it('pergerakan: jenis, jumlah bulat, catatan panjang, bahan tidak ada atau nonaktif, outlet tidak ada', async () => {
      at('16:00:00');
      const bad: [object, number, RegExp][] = [
        [{ ingredientId: 'biji', kind: 'SALAH', qty: 1 }, 400, /kind/],
        [{ ingredientId: 'biji', kind: 'PURCHASE', qty: 0 }, 400, /lebih dari 0/],
        [{ ingredientId: 'biji', kind: 'PURCHASE', qty: 1.5 }, 400, /bilangan bulat/],
        [{ ingredientId: 'biji', kind: 'PURCHASE', qty: -5 }, 400, /bilangan bulat/],
        [{ ingredientId: 'biji', kind: 'COUNT', qty: 5, note: 'x'.repeat(141) }, 400, /catatan/],
        [{ ingredientId: 'tidak-ada', kind: 'COUNT', qty: 5 }, 404, /bahan/],
      ];
      for (const [body, status, msg] of bad) {
        const r = await move(owner, body);
        expect(r.status, JSON.stringify(body)).toBe(status);
        expect(r.body.message).toMatch(msg);
      }
      expect((await move(owner, { ingredientId: 'biji', kind: 'COUNT', qty: 5 }, 'tidak-ada')).status).toBe(404);
      await h.http('PUT', '/v1/ingredients/oat', owner, { active: false });
      expect((await move(owner, { ingredientId: 'oat', kind: 'COUNT', qty: 5 })).body.message).toMatch(/nonaktif/);
      expect(Object.keys(await stock())).not.toContain('oat'); // nonaktif tidak tampil
    });

    it('SUPERVISOR ditolak; tenant lain tidak bisa membaca atau menulis stok outlet ini', async () => {
      expect((await h.http('GET', '/v1/outlets/o1/stock', supervisor)).status).toBe(403);
      expect((await move(supervisor, { ingredientId: 'biji', kind: 'COUNT', qty: 1 })).status).toBe(403);
      expect((await h.http('GET', '/v1/outlets/o1/stock', ownerB)).status).toBe(404);
      expect((await move(ownerB, { ingredientId: 'biji', kind: 'COUNT', qty: 1 })).status).toBe(404);
      expect((await h.http('GET', '/v1/outlets/ox/stock', ownerB)).body).toEqual([]);
    });
  });
});

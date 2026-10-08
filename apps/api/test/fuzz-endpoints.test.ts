import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

/** Endpoint yang dibuat belakangan (SDM, reservasi, toko web, antrian, BOM): input aneh harus menghasilkan 4xx yang rapi, tidak pernah 5xx. */
describe('ketahanan endpoint terhadap input aneh', () => {
  let h: Harness;
  let owner: string;
  let term: string;
  const NOW = Date.parse('2026-10-08T12:00:00+07:00');

  beforeAll(async () => {
    h = await createHarness(NOW);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    await h.http('PUT', '/v1/outlets/o1/web-shop', owner, { enabled: true, slug: 'toko-uji' });
    await h.http('PUT', '/v1/outlets/o1/queue-settings', owner, { enabled: true });
    await h.http('POST', '/v1/menu', owner, { id: 'kopi', name: 'Kopi', price: 20_000, category: 'Kopi' });
  });
  afterAll(() => h.close());

  const BODIES: unknown[] = [undefined, null, [], 'x', 123, true, {}, { a: 1 }, [{}], { items: 'x' }, { items: [null] }, { lines: 'x' }, { lines: [null, 1, 'x'] }, { start: 'x', end: {} }, { amount: {}, method: [] },
    { name: 5, phone: [], partySize: 'x' }, { reason: {}, kind: [] }, { enabled: 'x', slug: {} }, { guestName: 'x'.repeat(100_000) }, { items: [{ menuId: {}, qty: [] }] }, { tableNo: {}, staffId: [] }];
  const BIG = ['0', '-1', '99999999999999999999', '1e3', 'abc', '%00'];

  const routes: [string, string, 'owner' | 'term' | 'none'][] = [
    ['POST', '/v1/outlets/o1/reservations', 'owner'], ['PUT', '/v1/reservations/ID', 'owner'], ['POST', '/v1/reservations/ID/deposit', 'owner'], ['POST', '/v1/reservations/ID/seat', 'owner'],
    ['POST', '/v1/reservations/ID/no-show', 'owner'], ['POST', '/v1/reservations/ID/cancel', 'owner'], ['POST', '/v1/reservations/ID/settle', 'owner'], ['POST', '/v1/reservations/ID/seat-device', 'term'],
    ['POST', '/v1/public/shop/toko-uji/orders', 'none'], ['POST', '/v1/web-orders/ID/accept', 'term'], ['POST', '/v1/web-orders/ID/reject', 'term'], ['POST', '/v1/outlets/o1/web-orders/ID/reject', 'owner'],
    ['PUT', '/v1/outlets/o1/web-shop', 'owner'], ['PUT', '/v1/outlets/o1/queue-settings', 'owner'],
    ['POST', '/v1/public/queue/toko-uji/tickets', 'none'], ['POST', '/v1/queue/tickets', 'term'], ['POST', '/v1/queue/ID/call', 'term'], ['POST', '/v1/queue/ID/recall', 'term'], ['POST', '/v1/queue/ID/seat', 'term'],
    ['POST', '/v1/queue/ID/no-show', 'term'], ['POST', '/v1/queue/ID/cancel', 'term'],
    ['POST', '/v1/outlets/o1/hr/attendance', 'owner'], ['POST', '/v1/outlets/o1/hr/attendance/ID/void', 'owner'], ['POST', '/v1/outlets/o1/payroll-runs', 'owner'], ['PUT', '/v1/payroll-runs/ID/lines/budi', 'owner'],
    ['POST', '/v1/payroll-runs/ID/finalize', 'owner'], ['POST', '/v1/payroll-runs/ID/pay', 'owner'], ['POST', '/v1/payroll-runs/ID/cancel', 'owner'], ['PUT', '/v1/hr/pay/budi', 'owner'],
    ['PUT', '/v1/ingredients/kopi/bom', 'owner'], ['POST', '/v1/bom/calc', 'owner'], ['POST', '/v1/ingredients', 'owner'],
  ];

  it('tidak ada 5xx untuk body aneh pada semua endpoint baru', async () => {
    const bad: string[] = [];
    for (const [method, path, who] of routes) {
      for (const body of BODIES) {
        const tok = who === 'owner' ? owner : who === 'term' ? term : undefined;
        const r = await h.http(method, path.replace('ID', '1'), tok, body);
        if (r.status >= 500) bad.push(`${method} ${path} ${JSON.stringify(body)?.slice(0, 60)} → ${r.status}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('tidak ada 5xx untuk id aneh (negatif, di luar rentang bigint, bukan angka) di jalur dan query', async () => {
    const bad: string[] = [];
    for (const [method, path, who] of routes) {
      if (!path.includes('ID')) continue;
      for (const id of BIG) {
        const tok = who === 'owner' ? owner : who === 'term' ? term : undefined;
        const r = await h.http(method, path.replace('ID', id), tok, { reason: 'uji', amount: 1, method: 'CASH', kind: 'REFUND', tableNo: '1', partySize: 2 });
        if (r.status >= 500) bad.push(`${method} ${path.replace('ID', id)} → ${r.status}`);
      }
    }
    for (const q of ['days=x', 'days=-1', 'days=99999999999999999999', 'history=1e3', 'from=%00', 'to=x', 'day=2026-13-45', 'range=x']) {
      for (const p of ['/v1/outlets/o1/bom/plan', '/v1/outlets/o1/hr/attendance', '/v1/outlets/o1/reservations', '/v1/outlets/o1/queue', '/v1/outlets/o1/web-orders', '/v1/outlets/o1/web-orders']) {
        const r = await h.http('GET', `${p}?${q}`, owner);
        if (r.status >= 500) bad.push(`GET ${p}?${q} → ${r.status}`);
      }
    }
    for (const p of ['/v1/public/web-orders/%00', '/v1/public/queue-tickets/%00', '/v1/public/shop/%00', '/v1/public/queue/%00', '/v1/payroll-runs/99999999999999999999', '/v1/payroll-runs/99999999999999999999/export']) {
      const r = await h.http('GET', p, p.startsWith('/v1/public') ? undefined : owner);
      if (r.status >= 500) bad.push(`GET ${p} → ${r.status}`);
    }
    expect(bad).toEqual([]);
  });
});

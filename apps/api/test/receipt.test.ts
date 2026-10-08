import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter, SyncClient } from '@pos/pos-core';
import { createHarness, type Harness } from './harness';

const WIB = (hms: string) => Date.parse(`2026-10-01T${hms}+07:00`);

/** Struk digital (QR) dari terminal POS sungguhan sampai halaman publik di server. */
describe('struk digital', () => {
  let h: Harness;
  let now: number;
  let engine: PosEngine;
  let sync: SyncClient;
  let termToken: string;
  let pins: Awaited<ReturnType<typeof demoConfig>>['demoPins'];
  const must = <T>(r: { ok: boolean; value?: T; code?: string; message?: string }): T => {
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    return r.value as T;
  };
  const at = (hms: string) => { now = WIB(hms); h.setNow(now); };
  const get = (token: string) => h.http('GET', `/v1/receipts/${token}`);

  let token = '';
  let orderId = '';

  beforeAll(async () => {
    now = WIB('12:00:00');
    h = await createHarness(now);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createOutlet('t1', 'o1', 'Kopi Senopati', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    termToken = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    const config = await demoConfig('o1', 'term-1');
    pins = config.demoPins;
    const store = new MemoryStore();
    const rec = new Recorder({ deviceId: 'term-1', outletId: 'o1', store, now: () => now });
    engine = new PosEngine({ config, recorder: rec, store, printer: new SimPrinter(), now: () => now });
    await engine.init();
    sync = new SyncClient(rec, { baseUrl: `http://127.0.0.1:${(h.app.getHttpServer().address() as { port: number }).port}`, token: termToken, now: () => now });
    await engine.login('budi', pins.budi);
    must(await engine.openShift(100_000));

    at('12:05:00');
    orderId = must<{ id: string }>(await engine.createOrder('DINE_IN', { tableNo: '5' })).id;
    must(await engine.addItem(orderId, 'matcha', 1, { options: ['large'], note: 'es sedikit' }));
    must(await engine.addItem(orderId, 'kopi-susu', 2));
    must(await engine.printBill(orderId));
    must(await engine.pay(orderId, { method: 'CASH', amount: 30_000, tendered: 30_000 }));
    must(await engine.pay(orderId, { method: 'QRIS', tid: '12345678', approvalCode: '998877' }));
    token = must<{ token: string }>(await engine.digitalReceipt(orderId)).token;
    expect(await sync.flush()).toMatchObject({ ok: true, remaining: 0, issues: [] });
  });
  afterAll(() => h.close());

  it('token: 22 karakter base64url; memanggil lagi mengembalikan token yang sama tanpa event baru', async () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const again = must<{ token: string }>(await engine.digitalReceipt(orderId));
    expect(again.token).toBe(token);
    expect(engine.getOrder(orderId)!.receipt).toBe('DIGITAL');
    const n = (await h.db.admin.query<{ n: number }>("select count(*)::int as n from event where type = 'receipt.digital'")).rows[0]!.n;
    expect(n).toBe(1);
  });

  it('halaman publik tanpa login: isi struk benar (item, opsi, pajak, total, pembayaran per metode, nama merchant)', async () => {
    const r = await get(token);
    expect(r.status).toBe(200);
    // matcha Large 34.000 + 2 kopi 44.000 = 78.000; PBJT 10% = 7.800; total 85.800 = tunai 30.000 + QRIS 55.800
    expect(r.body.merchantName).toBe('Kopi Senopati');
    expect(r.body.receipt).toMatchObject({ ref: orderId.split('-').pop(), type: 'DINE_IN', table: '5', status: 'PAID', subtotal: 78_000, discount: 0, tax: 7_800, total: 85_800, paid: 85_800 });
    expect(r.body.receipt.items).toEqual([
      { name: 'Matcha Latte', options: ['Large'], qty: 1, unitPrice: 34_000, amount: 34_000 },
      { name: 'Kopi Susu', options: [], qty: 2, unitPrice: 22_000, amount: 44_000 },
    ]);
    expect(r.body.receipt.payments.map((p: { method: string; amount: number }) => [p.method, p.amount])).toEqual([['CASH', 30_000], ['QRIS', 55_800]]);
  });

  it('tanpa data pribadi atau internal: kasir, TID, kode approval, id order lengkap, tenant', async () => {
    const json = JSON.stringify((await get(token)).body);
    for (const secret of ['budi', '12345678', '998877', orderId, 't1', 'term-1', 'es sedikit']) expect(json, secret).not.toContain(secret);
  });

  it('token tidak dikenal atau berbentuk salah dijawab sama (404); tidak membedakan keduanya', async () => {
    const unknown = await get('A'.repeat(22));
    const malformed = await get('pendek');
    const injection = await get(encodeURIComponent("x' or '1'='1"));
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(injection.status).toBe(404);
    expect(unknown.body.message).toBe(malformed.body.message);
  });

  it('struk mengikuti keadaan terkini: order yang kemudian di-void tampil DIBATALKAN', async () => {
    at('12:30:00');
    must(await engine.voidOrder(orderId, 'CUSTOMER_CANCEL', [{ userId: 'hendra', pin: pins.hendra }, { userId: 'owner', pin: pins.owner }]));
    await sync.flush();
    const r = await get(token);
    expect(r.body.receipt).toMatchObject({ status: 'VOIDED', voidedAt: WIB('12:30:00'), paid: 85_800 });
  });

  it('dibatasi laju per alamat: lewat 60 permintaan per menit dijawab 429, lalu pulih setelah jendela berlalu', async () => {
    at('13:00:00');
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await get('B'.repeat(22))).status;
    expect(last).toBe(429);
    at('13:01:01');
    expect((await get('B'.repeat(22))).status).toBe(404);
  });

  it('terminal menerima alamat dasar struk dari konfigurasi', async () => {
    const cfg = (await h.http('GET', '/v1/device/config', termToken)).body;
    expect(cfg.receiptBaseUrl).toBe('https://guard.example/r/');
  });

  it('struk hanya untuk order lunas; yang sudah dicatat "tidak diberikan" tidak bisa diberi QR', async () => {
    at('13:10:00');
    const o = must<{ id: string }>(await engine.createOrder('TAKE_AWAY'));
    must(await engine.addItem(o.id, 'kopi-susu', 1));
    expect(await engine.digitalReceipt(o.id)).toMatchObject({ ok: false, code: 'NOT_PAID' });
    must(await engine.printBill(o.id));
    must(await engine.pay(o.id, { method: 'CASH' }));
    must(await engine.declineReceipt(o.id, 'CUSTOMER_DECLINED'));
    expect(await engine.digitalReceipt(o.id)).toMatchObject({ ok: false, code: 'RECEIPT_DONE' });
  });
});

describe('struk digital: pembatas laju per alamat klien', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(WIB('12:00:00'), { trustProxy: 1 }); });
  afterAll(() => h.close());
  const getFrom = async (ip: string) => {
    const res = await fetch(`http://127.0.0.1:${(h.app.getHttpServer().address() as { port: number }).port}/v1/receipts/${'C'.repeat(22)}`, { headers: { 'x-forwarded-for': ip } });
    return res.status;
  };

  it('satu alamat yang melewati batas tidak menghalangi alamat lain (diteruskan lewat X-Forwarded-For, seperti dari dashboard)', async () => {
    let last = 0;
    for (let i = 0; i < 61; i++) last = await getFrom('203.0.113.7');
    expect(last).toBe(429);
    expect(await getFrom('203.0.113.7')).toBe(429);
    expect(await getFrom('198.51.100.20')).toBe(404); // alamat lain: ember sendiri
  });
});


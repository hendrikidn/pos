import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter, SyncClient } from '@pos/pos-core';
import { createHarness, type Harness } from './harness';

const WIB = (hms: string) => Date.parse(`2026-10-01T${hms}+07:00`);

/**
 * Terminal POS sungguhan (PosEngine) dan layar dapur sungguhan (Recorder + SyncClient tanpa tanda tangan) terhadap API sungguhan.
 * Menguji alur utuh: kirim ke dapur → tiket → status dari layar dapur → item susulan → pisah bill → void → aturan R2 versi KDS.
 */
describe('terminal POS → API ← layar dapur', () => {
  let h: Harness;
  let now: number;
  let engine: PosEngine;
  let owner: string;
  let kdsToken: string;
  let termToken: string;
  let kdsRec: Recorder;
  let kdsSync: SyncClient;
  let termSync: SyncClient;
  let pins: Awaited<ReturnType<typeof demoConfig>>['demoPins'];

  const at = (hms: string) => { now = WIB(hms); h.setNow(now); };
  const must = <T>(r: { ok: boolean; value?: T; code?: string; message?: string }): T => {
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    return r.value as T;
  };
  const board = async () => (await h.http('GET', '/v1/kds/board', kdsToken)).body as {
    tickets: { orderId: string; table: string | null; status: string; hasNew: boolean; firstSentAt: number; lines: { name: string; options: string[]; note?: string; qty: number; fresh: boolean }[] }[];
    voided: { orderId: string }[];
  };
  const kdsStatus = async (orderId: string, status: 'COOKING' | 'READY' | 'SERVED') => {
    await kdsRec.record({ type: 'kitchen.status_changed', payload: { orderId, status } });
    expect(await kdsSync.flush()).toMatchObject({ ok: true, remaining: 0, issues: [] });
  };

  beforeAll(async () => {
    now = WIB('12:00:00');
    h = await createHarness(now);
    await h.admin.createTenant('t1', 'Tenant 1');
    // Outlet dengan layar dapur: R2 memakai versi KDS (status dapur), bukan proksi waktu.
    await h.admin.createOutlet('t1', 'o1', 'Kopi Senopati', { terminals: ['term-1'], capabilities: { sensor: false, kds: true, printerReportsStatus: false } });
    termToken = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    kdsToken = await h.admin.createDevice('t1', 'o1', 'kds-1', 'kds');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');

    const port = (h.app.getHttpServer().address() as { port: number }).port;
    const config = await demoConfig('o1', 'term-1');
    pins = config.demoPins;
    const store = new MemoryStore();
    const rec = new Recorder({ deviceId: 'term-1', outletId: 'o1', store, now: () => now });
    engine = new PosEngine({ config, recorder: rec, store, printer: new SimPrinter(), now: () => now });
    await engine.init();
    termSync = new SyncClient(rec, { baseUrl: `http://127.0.0.1:${port}`, token: termToken, now: () => now });

    kdsRec = new Recorder({ deviceId: 'kds-1', outletId: 'o1', store: new MemoryStore(), now: () => now });
    await kdsRec.init();
    kdsSync = new SyncClient(kdsRec, { baseUrl: `http://127.0.0.1:${port}`, token: kdsToken, now: () => now });

    await engine.login('budi', pins.budi);
    must(await engine.openShift(100_000));
  });
  afterAll(() => h.close());

  let a = '';

  it('kirim ke dapur: tiket muncul dengan meja, opsi, dan catatan; yang belum dikirim tidak', async () => {
    at('12:05:00');
    a = must<{ id: string }>(await engine.createOrder('DINE_IN', { tableNo: '5' })).id;
    must(await engine.addItem(a, 'matcha', 2, { options: ['large'], note: 'es sedikit' }));
    must(await engine.addItem(a, 'kopi-susu', 1));
    must(await engine.addItem(a, 'latte', 1)); // akan dikirim, lalu ditambah di bawah
    expect((await board()).tickets).toEqual([]); // belum dikirim
    at('12:06:00');
    must(await engine.sendToKitchen(a));
    expect(await termSync.flush()).toMatchObject({ ok: true, remaining: 0, issues: [] });

    const t = (await board()).tickets;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ orderId: a, table: '5', status: 'NEW', hasNew: false, firstSentAt: WIB('12:06:00') });
    expect(t[0]!.lines.map((l) => `${l.qty}x${l.name}${l.options.length ? `(${l.options})` : ''}${l.note ? `"${l.note}"` : ''}`)).toEqual([
      '2xMatcha Latte(Large)"es sedikit"', '1xKopi Susu', '1xLatte',
    ]);
  });

  it('layar dapur memasak: status berubah di papan', async () => {
    at('12:08:00');
    await kdsStatus(a, 'COOKING');
    expect((await board()).tickets[0]).toMatchObject({ status: 'COOKING', hasNew: false });
  });

  it('item susulan saat dimasak: ditandai baru, status tetap COOKING', async () => {
    at('12:10:00');
    must(await engine.addItem(a, 'kopi-susu', 2));
    must(await engine.sendToKitchen(a));
    await termSync.flush();
    const t = (await board()).tickets[0]!;
    expect(t).toMatchObject({ status: 'COOKING', hasNew: true });
    expect(t.lines.find((l) => l.name === 'Kopi Susu')).toMatchObject({ qty: 3, fresh: true });
    expect(t.lines.find((l) => l.name === 'Latte')).toMatchObject({ qty: 1, fresh: false });
  });

  it('pisah bill: item terkirim yang dipisah menjadi tiket baru dengan waktu tunggu dan status yang sama', async () => {
    at('12:12:00');
    const b = must<{ id: string }>(await engine.splitOrder(a, [{ lineId: 'latte', qty: 1 }])).id;
    await termSync.flush();
    const tickets = (await board()).tickets;
    expect(tickets.map((t) => [t.orderId === a ? 'asal' : 'baru', t.table, t.status, t.lines.map((l) => `${l.qty}x${l.name}`)])).toEqual([
      ['asal', '5', 'COOKING', ['2xMatcha Latte', '3xKopi Susu']],
      ['baru', '5', 'COOKING', ['1xLatte']],
    ]);
    expect(tickets.find((t) => t.orderId === b)!.firstSentAt).toBe(WIB('12:06:00')); // timer tidak mulai ulang
    at('12:13:00');
    await kdsStatus(b, 'READY');
    at('12:13:30');
    await kdsStatus(b, 'SERVED');
    expect((await board()).tickets.map((t) => t.orderId)).toEqual([a]);
  });

  it('void order yang sedang dimasak: tiket hilang dan masuk daftar batal; R2 versi KDS menandainya sebagai insiden', async () => {
    at('12:15:00');
    // nominal di atas ambang: dua persetujuan, salah satunya owner (kunci POS tetap berlaku dengan adanya KDS)
    must(await engine.voidOrder(a, 'WRONG_ORDER', [{ userId: 'hendra', pin: pins.hendra }, { userId: 'owner', pin: pins.owner }]));
    at('12:16:00');
    await termSync.flush();
    const b = await board();
    expect(b.tickets).toEqual([]);
    expect(b.voided.map((v) => v.orderId)).toEqual([a]);

    const incidents = (await h.http('GET', '/v1/outlets/o1/incidents', owner)).body as { order_ids: string[]; hits: { rule: string; weight: number; note: string }[] }[];
    const inc = incidents.find((i) => i.order_ids.includes(a));
    expect(inc).toBeDefined();
    const r2 = inc!.hits.find((x) => x.rule === 'R2')!;
    expect(r2.weight).toBe(30); // bobot versi KDS, bukan proksi (20)
    expect(r2.note).toMatch(/dimasak|siap|disajikan/);
  });

  it('terminal membaca papan dan menerapkan SERVED dari layar dapur: void order yang sudah disajikan wajib owner', async () => {
    at('12:20:00');
    const c = must<{ id: string }>(await engine.createOrder('TAKE_AWAY')).id;
    must(await engine.addItem(c, 'kopi-susu', 1)); // 24.200: tanpa aturan nominal besar, hanya status dapur yang menentukan
    must(await engine.sendToKitchen(c));
    await termSync.flush();
    at('12:22:00');
    await kdsStatus(c, 'SERVED');

    // Persis yang dilakukan runtime POS: baca papan dengan token terminal, lalu terapkan statusnya.
    const res = await h.http('GET', '/v1/kds/board', termToken);
    expect(res.status).toBe(200);
    expect(res.body.served).toContain(c);
    const statuses: Record<string, 'COOKING' | 'READY' | 'SERVED'> = {};
    for (const t of res.body.tickets) if (t.status !== 'NEW') statuses[t.orderId] = t.status;
    for (const id of res.body.served) statuses[id] = 'SERVED';
    expect(await engine.applyKitchenStatuses(statuses)).toBeGreaterThan(0);

    expect(await engine.voidOrder(c, 'WRONG_ORDER', [{ userId: 'hendra', pin: pins.hendra }])).toMatchObject({ ok: false, code: 'OWNER_REQUIRED' });
    must(await engine.voidOrder(c, 'WRONG_ORDER', [{ userId: 'owner', pin: pins.owner }]));
  });

  it('rantai perangkat layar dapur utuh, tanpa masalah integritas, dan hanya berisi status dan heartbeat', async () => {
    const rows = (await h.db.tenantTx('t1', async (q) =>
      (await q.query<{ seq: number; type: string; integrity: string | null }>("select seq, type, integrity from event where device_id = 'kds-1' order by seq")).rows,
    ));
    expect(rows.length).toBe(4); // COOKING (asal), READY dan SERVED (tiket hasil pisah), SERVED (order c)
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(rows.every((r) => r.type === 'kitchen.status_changed' && r.integrity === null)).toBe(true);
  });
});

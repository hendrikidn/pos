import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter, SyncClient } from '@pos/pos-core';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const DATE = '2026-10-01';
const WIB = (hms: string) => Date.parse(`${DATE}T${hms}+07:00`);

/**
 * POS sungguhan (PosEngine + SyncClient) mengirim event ke API sungguhan, lalu insiden diperiksa.
 * Skenario: pembayaran tunai tidak diketik, order di-void dengan persetujuan supervisor (kolusi),
 * saat kertas printer habis. Semua kunci void dilewati dengan cara yang sah (approver supervisor memang punya hak).
 */
describe('POS → API → insiden', () => {
  let h: Harness;
  let now: number;
  let engine: PosEngine;
  let recorder: Recorder;
  let sync: SyncClient;
  let printer: SimPrinter;
  let owner: string;
  let sensorToken: string;
  let pins: Awaited<ReturnType<typeof demoConfig>>['demoPins'];
  const at = (hms: string) => { now = WIB(hms); h.setNow(now); };

  beforeAll(async () => {
    now = WIB('12:50:00');
    h = await createHarness(now);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createOutlet('t1', 'o1', 'Kopi Senopati', {
      terminals: ['term-sen'], capabilities: { sensor: true, kds: false, printerReportsStatus: true },
    });
    const termToken = await h.admin.createDevice('t1', 'o1', 'term-sen', 'terminal');
    sensorToken = await h.admin.createDevice('t1', 'o1', 'sensor-sen', 'sensor');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');

    const config = await demoConfig('o1', 'term-sen');
    pins = config.demoPins;
    const store = new MemoryStore();
    printer = new SimPrinter();
    recorder = new Recorder({ deviceId: 'term-sen', outletId: 'o1', store, now: () => now });
    engine = new PosEngine({ config, recorder, store, printer, now: () => now });
    await engine.init();
    // SyncClient memakai fetch ke server HTTP sungguhan milik harness
    const base = (h.app.getHttpServer().address() as { port: number }).port;
    sync = new SyncClient(recorder, { baseUrl: `http://127.0.0.1:${base}`, token: termToken, now: () => now });
  });
  afterAll(() => h.close());

  const ok = <T>(r: { ok: boolean; value?: T; code?: string; message?: string }): T => {
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    return r.value as T;
  };

  it('kolusi void dengan supervisor saat kertas habis menjadi insiden kritis dengan bukti yang benar', async () => {
    // --- sensor (perangkat terpisah, langsung ke API) ---
    const sim = new Sim('o1', DATE, 'term-sen', 'sensor-sen');
    sim.heartbeats('sensor', WIB('12:50:00'), WIB('13:30:00'), 60_000);
    sim.presence(WIB('13:11:30'), WIB('13:12:30'));   // customer order sah
    sim.presence(WIB('13:14:02'), WIB('13:15:00'));   // customer yang membayar tunai tanpa dicatat
    await h.postEvents(sensorToken, sim.events);

    // --- POS ---
    at('12:55:00');
    await engine.login('budi', pins.budi);
    ok(await engine.openShift(100_000));
    printer.paper = false;                            // kertas habis sejak 12:55
    await engine.pollPrinter();

    at('13:11:40');                                   // order sah: dicatat dan dibayar, struk ditolak karena kertas habis
    const legit = ok<{ id: string }>(await engine.createOrder('TAKE_AWAY'));
    ok(await engine.addItem(legit.id, 'latte', 1));
    ok(await engine.printBill(legit.id, { onScreen: true }));
    at('13:12:10');
    ok(await engine.pay(legit.id, { method: 'CASH', tendered: 30_000 }));
    ok(await engine.declineReceipt(legit.id, 'NO_PAPER'));

    // Order yang tidak akan dicatat pembayarannya. Nilainya sengaja di bawah ambang Rp 50.000: di atas itu POS
    // menuntut persetujuan owner (diuji di bawah), jadi kecurangan nyata cenderung tetap di bawah ambang.
    at('13:14:30');
    const ghost = ok<{ id: string }>(await engine.createOrder('TAKE_AWAY'));
    ok(await engine.addItem(ghost.id, 'nasi-goreng', 1, { options: ['sedang'] }));
    at('13:14:35');
    ok(await engine.sendToKitchen(ghost.id));
    at('13:14:40');
    ok(await engine.printBill(ghost.id, { onScreen: true }));
    // customer membayar tunai di sini, tetapi pembayaran tidak diketik

    at('13:21:00');                                   // void dengan PIN supervisor (kolusi)
    ok(await engine.voidOrder(ghost.id, 'CUSTOMER_CANCEL', [{ userId: 'hendra', pin: pins.hendra }]));

    at('13:30:00');
    const synced = await sync.flush();
    expect(synced).toMatchObject({ ok: true, remaining: 0, issues: [] });

    // --- hasil di server ---
    const list = await h.http('GET', '/v1/outlets/o1/incidents', owner);
    expect(list.status).toBe(200);
    const incident = list.body.find((i: { order_ids: string[] }) => i.order_ids.includes(ghost.id));
    expect(incident).toBeDefined();
    expect(incident).toMatchObject({ level: 'CRITICAL', score: 150 });
    expect(incident.hits.map((x: { rule: string }) => x.rule).sort()).toEqual(['R2', 'R3', 'R5']);
    expect(incident.actor_ids).toEqual(expect.arrayContaining(['budi', 'hendra']));

    // order yang sah tidak menimbulkan insiden sendiri
    expect(list.body.some((i: { order_ids: string[] }) => i.order_ids.includes(legit.id))).toBe(false);
    expect(h.notifier.critical).toHaveLength(1);
  });

  it('void bernilai besar tidak bisa dilakukan dengan supervisor saja (kunci POS bekerja)', async () => {
    at('13:35:00');
    const big = ok<{ id: string }>(await engine.createOrder('TAKE_AWAY'));
    ok(await engine.addItem(big.id, 'wagyu-bowl', 2));
    ok(await engine.printBill(big.id, { onScreen: true }));
    const denied = await engine.voidOrder(big.id, 'CUSTOMER_CANCEL', [{ userId: 'hendra', pin: pins.hendra }]);
    expect(denied).toMatchObject({ ok: false, code: 'NOT_ENOUGH_APPROVERS' });
    // dengan dua persetujuan termasuk owner, baru bisa
    ok(await engine.voidOrder(big.id, 'CUSTOMER_CANCEL', [
      { userId: 'hendra', pin: pins.hendra }, { userId: 'owner', pin: pins.owner },
    ]));
    await sync.flush();
  });

  it('seluruh event POS sampai ke server tanpa celah atau ketidakcocokan rantai', async () => {
    const rows = await h.db.tenantTx('t1', async (q) =>
      (await q.query<{ seq: number; integrity: string | null }>(
        "select seq, integrity from event where device_id = 'term-sen' order by seq",
      )).rows,
    );
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.every((r) => r.integrity === null)).toBe(true);
    expect(await recorder.pendingCount()).toBe(0);
  });

  it('data tidak tampak oleh kasir: shift ditutup dengan hitungan buta dan tersimpan di server', async () => {
    at('13:40:00');
    // semua order sudah selesai (satu dibayar, satu di-void)
    ok(await engine.closeShift(130_000));
    await sync.flush();
    const counted = await h.db.tenantTx('t1', async (q) =>
      (await q.query<{ payload: { counted: number; expected: number } }>("select payload from event where type = 'cash.counted'")).rows,
    );
    // 100.000 modal + 28.600 (latte 26.000 + PBJT) dari order sah = 128.600 yang diharapkan; kasir menghitung 130.000
    expect(counted[0]!.payload).toEqual({ shiftId: expect.any(String), counted: 130_000, expected: 128_600 });
  });
});

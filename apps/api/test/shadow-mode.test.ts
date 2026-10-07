import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PosEvent } from '@pos/events';
import { Sim } from '@pos/sim';
import { createPlatformAdmin } from '../src/onboard';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const DAY = 86_400_000;
const CAPS = { sensor: true, kds: true, printerReportsStatus: true };

/** Kasus phantom void (kritis) di satu terminal dan sensornya pada tanggal tertentu, dengan ID order sendiri. */
function phantom(outlet: string, date: string, term: string, sensor: string, order: string): Sim {
  const s = new Sim(outlet, date, term, sensor);
  s.heartbeats('sensor', '12:50:00', '13:30:00', 60_000);
  s.pos({ type: 'printer.status', payload: { state: 'paperOut', source: 'device' } }, '12:55:00');
  s.presence('13:14:02', '13:15:00');
  s.pos({ type: 'order.created', payload: { orderId: order, orderType: 'TAKE_AWAY' } }, '13:14:30', 'budi');
  s.pos({ type: 'order.sent_to_kitchen', payload: { orderId: order } }, '13:14:35', 'budi');
  s.pos({ type: 'bill.printed', payload: { orderId: order, total: 185_000 } }, '13:14:40', 'budi');
  s.pos({ type: 'payment.received', payload: { orderId: order, method: 'CASH', amount: 185_000 } }, '13:14:50', 'budi');
  s.pos({ type: 'kitchen.status_changed', payload: { orderId: order, status: 'COOKING' } }, '13:16:00', 'dapur');
  s.pos({ type: 'kitchen.status_changed', payload: { orderId: order, status: 'READY' } }, '13:17:40', 'dapur');
  s.pos({ type: 'void.approved', payload: { orderId: order, reasonCode: 'CUSTOMER_CANCEL', approverIds: ['hendra'], amount: 185_000 } }, '13:18:45', 'budi');
  return s;
}

describe('mode shadow', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let manager: string;
  let supervisor: string;
  let hendra: string;
  let stranger: string;
  const tok: Record<string, string> = {};
  const NOW = WIB('2026-10-01T13:30:00');

  const send = async (s: Sim, filter: (e: PosEvent) => boolean = () => true) => {
    for (const dev of new Set(s.events.map((e) => e.deviceId))) {
      const r = await h.postEvents(tok[dev]!, s.events.filter((e) => e.deviceId === dev && filter(e)));
      expect(r.status, dev).toBe(201);
    }
  };
  const get = (path: string, t = owner) => h.http('GET', path, t);
  const settings = async (outlet = 'o1') => (await get(`/v1/outlets/${outlet}/settings`)).body;
  const shadowOf = async (outlet = 'o1') => (await get('/v1/outlets')).body.find((o: { id: string }) => o.id === outlet).shadow;
  const liveList = async (outlet = 'o1') => (await get(`/v1/outlets/${outlet}/incidents`)).body as { order_ids: string[]; level: string }[];
  const put = (body: unknown, outlet = 'o1', t = owner) => h.http('PUT', `/v1/outlets/${outlet}/settings`, t, body);

  beforeAll(async () => {
    h = await createHarness(NOW);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1', 'term-2', 'term-3'], capabilities: CAPS, shadowDays: 14 });
    await h.admin.createOutlet('t1', 'o2', 'Outlet 2', { terminals: ['tb-1', 'tb-2'], capabilities: CAPS, shadowDays: 14 });
    for (const [dev, outlet, kind] of [
      ['term-1', 'o1', 'terminal'], ['sensor-1', 'o1', 'sensor'], ['term-2', 'o1', 'terminal'], ['sensor-2', 'o1', 'sensor'],
      ['term-3', 'o1', 'terminal'], ['sensor-3', 'o1', 'sensor'], ['tb-1', 'o2', 'terminal'], ['sb-1', 'o2', 'sensor'],
      ['tb-2', 'o2', 'terminal'], ['sb-2', 'o2', 'sensor'],
    ] as const) tok[dev] = await h.admin.createDevice('t1', outlet, dev, kind);
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    supervisor = await h.admin.createApiToken('t1', 'sup', 'SUPERVISOR');
    hendra = await h.admin.createApiToken('t1', 'hendra', 'OWNER');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t2', 'x1', 'X', { terminals: ['tx'], capabilities: CAPS });
    stranger = await h.admin.createApiToken('t2', 'owner-2', 'OWNER');
  });
  afterAll(() => h.close());

  it('outlet baru dengan shadow 14 hari menunggu aktivitas pertama: aktif tetapi hari belum berhitung', async () => {
    expect(await shadowOf()).toEqual({ days: 14, enabled: true, active: true, pending: true, startedMs: null, untilMs: null, day: 0, incidents: 0 });
    expect((await settings()).shadow).toMatchObject({ enabled: true, pending: true });
  });

  it('heartbeat sensor saja belum memulai hitungan; aktivitas bermakna (order, pembayaran, sesi sensor) yang memulai', async () => {
    const a = phantom('o1', '2026-10-01', 'term-1', 'sensor-1', 'o42');
    await send(a, (e) => e.type === 'device.heartbeat');
    expect((await shadowOf()).pending).toBe(true);
    expect((await shadowOf()).startedMs).toBeNull();

    await send(a, (e) => e.type !== 'device.heartbeat');
    const st = await shadowOf();
    expect(st).toMatchObject({ pending: false, active: true, day: 1, incidents: 1 });
    // Batch pertama yang tiba memuat sesi sensor (selesai 13.15.00); batch terminal (order 13.14.30) menyusul dan tidak menggeser awal.
    expect(st.startedMs).toBe(WIB('2026-10-01T13:15:00'));
    expect(st.untilMs).toBe(WIB('2026-10-01T13:15:00') + 14 * DAY);
  });

  it('insiden kritis dicatat tetapi tidak dikirim, dan tidak muncul di antrean review maupun hitungan outlet', async () => {
    expect(h.notifier.critical).toHaveLength(0);
    expect(await liveList()).toEqual([]);
    const o = (await get('/v1/outlets')).body.find((x: { id: string }) => x.id === 'o1');
    expect(o).toMatchObject({ open_incidents: 0, open_critical: 0 });
    expect(o.shadow.incidents).toBe(1);
  });

  it('ringkasan shadow: "apa yang akan terdeteksi", dengan aturan dan tingkat', async () => {
    const r = (await get('/v1/outlets/o1/shadow')).body;
    expect(r.state).toMatchObject({ enabled: true, active: true, day: 1, days: 14 });
    expect(r.summary).toMatchObject({ total: 1, byLevel: { CRITICAL: 1, MEDIUM: 0, LOW: 0 }, criticalPerWeek: null });
    expect(r.summary.byRule.map((x: { rule: string }) => x.rule).sort()).toEqual(['R2', 'R3', 'R5']);
    expect(r.summary.byDay).toEqual([{ date: '2026-10-01', total: 1, critical: 1 }]);
    expect(r.incidents).toHaveLength(1);
    expect(r.incidents[0]).toMatchObject({ level: 'CRITICAL', order_ids: ['o42'], status: 'OPEN' });
    expect(r.incidents[0].rules.sort()).toEqual(['R2', 'R3', 'R5']);
  });

  it('detail insiden shadow ditandai, dan orang yang terlibat (approver) tidak melihat apa pun', async () => {
    const id = (await get('/v1/outlets/o1/shadow')).body.incidents[0].id as string;
    const d = await get(`/v1/incidents/${encodeURIComponent(id)}`);
    expect(d.body.shadow).toBe(true);
    expect((await get(`/v1/incidents/${encodeURIComponent(id)}`, hendra)).status).toBe(404);
    const hs = (await get('/v1/outlets/o1/shadow', hendra)).body;
    expect(hs.summary.total).toBe(0);
    expect(hs.incidents).toEqual([]);
  });

  it('insiden shadow boleh direview untuk menilai presisi, dan hasilnya masuk ringkasan', async () => {
    const id = (await get('/v1/outlets/o1/shadow')).body.incidents[0].id as string;
    expect((await h.http('POST', `/v1/incidents/${encodeURIComponent(id)}/review`, owner, { label: 'FALSE_ALARM' })).status).toBe(201);
    const s = (await get('/v1/outlets/o1/shadow')).body.summary;
    expect(s.reviewed).toEqual({ total: 1, confirmed: 0, legit: 0, falseAlarm: 1, inconclusive: 0 });
    expect(s.criticalPrecision).toBe(0);
  });

  it('hak akses: owner, ops, manager boleh; supervisor, perangkat, dan tenant lain tidak', async () => {
    for (const t of [owner, ops, manager]) expect((await get('/v1/outlets/o1/shadow', t)).status).toBe(200);
    expect((await get('/v1/outlets/o1/shadow', supervisor)).status).toBe(403);
    expect((await get('/v1/outlets/o1/shadow', tok['term-1'])).status).toBe(403);
    expect((await get('/v1/outlets/o1/shadow', stranger)).status).toBe(404);
  });

  it('owner menonaktifkan shadow secara manual: insiden berikutnya langsung live dan dinotifikasi; yang lama tetap shadow', async () => {
    expect((await put({ shadowDays: 0 })).status).toBe(200);
    expect((await settings()).shadow).toMatchObject({ enabled: false, active: false });
    expect((await settings()).shadow_days).toBe(0);

    await send(phantom('o1', '2026-09-30', 'term-2', 'sensor-2', 'o43'));
    expect(h.notifier.critical).toHaveLength(1);
    const live = await liveList();
    expect(live.map((i) => i.order_ids[0])).toEqual(['o43']);
    expect(live[0]!.level).toBe('CRITICAL');
    // insiden shadow lama tidak berubah menjadi live walau dievaluasi ulang
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    expect((await liveList()).map((i) => i.order_ids[0])).toEqual(['o43']);
    expect((await shadowOf()).incidents).toBe(1);
  });

  it('owner mengaktifkan shadow lagi: langsung berlaku dan hitungan hari dimulai dari sekarang', async () => {
    expect((await put({ shadowDays: 14, shadowRestart: true })).status).toBe(200);
    const st = (await settings()).shadow;
    expect(st).toMatchObject({ enabled: true, active: true, pending: false, day: 1, days: 14, startedMs: NOW });

    await send(phantom('o1', '2026-09-29', 'term-3', 'sensor-3', 'o44'));
    expect(h.notifier.critical).toHaveLength(1); // tidak bertambah: insiden baru ini shadow
    expect((await liveList()).map((i) => i.order_ids[0])).toEqual(['o43']);
    const r = (await get('/v1/outlets/o1/shadow')).body;
    expect(r.summary.total).toBe(2);
    expect(r.incidents.map((i: { order_ids: string[] }) => i.order_ids[0]).sort()).toEqual(['o42', 'o44']);
  });

  it('mengubah lama saja tidak memulai ulang hitungan', async () => {
    expect((await put({ shadowDays: 30 })).status).toBe(200);
    expect((await settings()).shadow).toMatchObject({ days: 30, startedMs: NOW, active: true });
    expect((await put({ shadowDays: 14 })).status).toBe(200);
  });

  it('setelah masa shadow lewat, insiden baru live tanpa perlu diubah manual', async () => {
    await send(phantom('o2', '2026-10-01', 'tb-1', 'sb-1', 'p1'));
    expect(await shadowOf('o2')).toMatchObject({ active: true, incidents: 1 });
    expect(h.notifier.critical).toHaveLength(1);

    h.setNow(WIB('2026-10-16T13:30:00')); // 15 hari kemudian
    expect(await shadowOf('o2')).toMatchObject({ enabled: true, active: false, day: 14 });
    await send(phantom('o2', '2026-10-16', 'tb-2', 'sb-2', 'p2'));
    expect(h.notifier.critical).toHaveLength(2);
    expect((await liveList('o2')).map((i) => i.order_ids[0])).toEqual(['p2']);
    h.setNow(NOW);
  });

  it('pengaturan: validasi lama shadow dan syarat memulai ulang', async () => {
    for (const bad of [-1, 61, 1.5, 'x']) expect((await put({ shadowDays: bad })).status, String(bad)).toBe(400);
    expect((await put({ shadowRestart: true })).status).toBe(400);
    expect((await put({ shadowDays: 0, shadowRestart: true })).status).toBe(400);
    expect((await put({ shadowDays: 14, shadowRestart: 'ya' })).status).toBe(400);
    expect((await put({ shadowDays: 60 })).status).toBe(200);
    expect((await put({ shadowDays: 14 })).status).toBe(200);
  });

  it('hanya owner yang boleh mengubah mode shadow', async () => {
    for (const t of [ops, manager, supervisor, tok['term-1']!]) expect((await put({ shadowDays: 0 }, 'o1', t)).status).toBe(403);
    expect((await settings()).shadow_days).toBe(14);
  });

  it('insiden shadow tidak dihitung sebagai insiden terbuka di KPI konsol admin', async () => {
    const admin = (await createPlatformAdmin(h.db, { id: 'hendrik', name: 'Hendrik' })).token;
    const k = (await h.http('GET', '/v1/admin/tenants/t1', admin)).body.kpi;
    // live terbuka: o43 (o1) dan p2 (o2). Insiden shadow (o42, o44, p1) tidak terhitung.
    expect(k).toMatchObject({ incidentsOpen: 2, incidentsCritical: 2 });
  });

  it('outlet yang dibuat owner masuk shadow 14 hari; outlet pertama dari konsol admin juga', async () => {
    const made = await h.http('POST', '/v1/outlets', owner, { name: 'Outlet Baru', terminals: ['pos-9'] });
    expect(made.status).toBe(201);
    expect((await settings(made.body.id)).shadow).toMatchObject({ enabled: true, days: 14, pending: true });

    const admin = (await createPlatformAdmin(h.db, { id: 'a2', name: 'A2' })).token;
    const t = await h.http('POST', '/v1/admin/tenants', admin, { tenantId: 'kopi-z', tenantName: 'Kopi Z', outletId: 'kopi-z-pusat', outletName: 'Z Pusat', terminals: ['pos-1'] });
    expect(t.status).toBe(201);
    const s = (await h.http('GET', '/v1/outlets/kopi-z-pusat/settings', t.body.ownerToken)).body;
    expect(s.shadow).toMatchObject({ enabled: true, days: 14, pending: true });
  });
});

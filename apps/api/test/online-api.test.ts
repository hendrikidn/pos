import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const D = '2026-10-02';

describe('pesanan online: kanal, laporan platform, dan rekonsiliasi', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let manager: string;
  let ownerB: string;
  let term: string;
  let kds: string;

  const settings = (body: unknown, tok = owner) => h.http('PUT', '/v1/outlets/o1/settings', tok, body);
  const upload = (tok: string, channel: unknown, csv: unknown, outlet = 'o1', filename?: string) => h.http('POST', `/v1/outlets/${outlet}/online/reports`, tok, { channel, csv, ...(filename ? { filename } : {}) });
  const recon = (q = '?range=7d', tok = owner) => h.http('GET', `/v1/outlets/o1/online/reconciliation${q}`, tok);

  const REPORT = 'No Pesanan;Tanggal;Harga;Komisi;Diterima\nGF-1;02/10/2026;"45.000";"9.000";"36.000"\nGF-3;02/10/2026;"90.000";"18.000";"72.000"\nGF-404;02/10/2026;"55.000";"11.000";"44.000"\n';

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-03T09:00:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    kds = await h.admin.createDevice('t1', 'o1', 'kds-1', 'kds');
  });
  afterAll(() => h.close());

  it('kanal diaktifkan di pengaturan outlet dengan validasi; terminal menerimanya, layar dapur tidak', async () => {
    expect((await h.http('GET', '/v1/device/config', term)).body.outlet).not.toHaveProperty('channels');
    for (const bad of [[{ channel: 'TOKOPEDIA', commissionPercent: 10 }], [{ channel: 'GOFOOD', commissionPercent: 60 }], [{ channel: 'GOFOOD', commissionPercent: 1.5 }], [{ channel: 'GOFOOD', commissionPercent: 10 }, { channel: 'GOFOOD', commissionPercent: 20 }], 'semua']) {
      expect((await settings({ onlineChannels: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await settings({ onlineChannels: [{ channel: 'GOFOOD', commissionPercent: 20 }, { channel: 'GRABFOOD', commissionPercent: 25 }] })).status).toBeLessThan(300);
    expect((await h.http('GET', '/v1/device/config', term)).body.outlet.channels).toEqual([{ channel: 'GOFOOD', commissionPercent: 20 }, { channel: 'GRABFOOD', commissionPercent: 25 }]);
    expect((await h.http('GET', '/v1/device/config', kds)).body.outlet).not.toHaveProperty('channels');
    expect((await h.http('GET', '/v1/outlets/o1/settings', owner)).body.online_channels).toHaveLength(2);
  });

  it('ingest: kaitan kanal wajib kanal dan nomor yang sah', async () => {
    const send = (payload: unknown, type = 'order.channel_linked') => {
      const s = new Sim('o1', D, 'term-1', 'sensor-1');
      return h.postEvents(term, [s.pos({ type, payload } as never, '09:00:00', 'budi')]);
    };
    expect((await send({ orderId: 'z', channel: 'TOKOPEDIA', ref: 'ABC-1' })).status).toBe(400);
    expect((await send({ orderId: 'z', channel: 'GOFOOD', ref: 'ab' })).status).toBe(400);
    expect((await send({ orderId: 'z', channel: 'GOFOOD', ref: 'ada spasi' })).status).toBe(400);
    expect((await send({ orderId: 'z', channel: 'GOFOOD' })).status).toBe(400);
    expect((await send({ orderId: 'z', channel: 'GOFOOD', ref: 'GF-ok1' })).status).toBe(201);
  });

  it('unggah laporan platform: kanal harus aktif, kesalahan per baris membatalkan semuanya, peran dijaga', async () => {
    expect((await upload(owner, 'SHOPEEFOOD', REPORT)).status).toBe(400); // tidak diaktifkan outlet ini
    expect((await upload(owner, 'TOKOPEDIA', REPORT)).status).toBe(400);
    expect((await upload(owner, 'GOFOOD', 123)).status).toBe(400);
    const bad = await upload(owner, 'GOFOOD', 'No Pesanan;Tanggal;Harga\nGF-9;kemarin;1000\nGF-10;02/10/2026;gratis\n');
    expect(bad.body).toMatchObject({ applied: false, rows: 0 });
    expect(bad.body.errors.map((e: { line: number }) => e.line)).toEqual([2, 3]);
    expect((await recon()).body.rows).toEqual([]);
    expect((await upload(manager, 'GOFOOD', REPORT)).status).toBe(403);
    expect((await upload(term, 'GOFOOD', REPORT)).status).toBe(403);
    expect((await upload(undefined as never, 'GOFOOD', REPORT)).status).toBe(401);
    expect((await upload(ownerB, 'GOFOOD', REPORT)).status).toBe(404);
    const ok = await upload(ops, 'GOFOOD', REPORT, 'o1', 'gofood-okt.csv');
    expect(ok.body).toEqual({ applied: true, errors: [], rows: 3, inserted: 3, updated: 0, dateFrom: D, dateTo: D });
    expect((await upload(owner, 'GOFOOD', REPORT)).body).toMatchObject({ inserted: 0, updated: 3 }); // unggah ulang memperbarui, tidak menggandakan
    const audit = (await h.db.admin.query<{ detail: { rows: number; channel: string } }>("select detail from audit_log where action = 'channel.report' order by id")).rows;
    expect(audit.map((a) => [a.detail.channel, a.detail.rows])).toEqual([['GOFOOD', 3], ['GOFOOD', 3]]);
  });

  it('rekonsiliasi: pesanan platform dengan pasangan di POS, yang tidak diketik, dan order POS yang tidak ada di platform', async () => {
    const s = new Sim('o1', D, 'term-1', 'sensor-1');
    const order = (id: string, hms: string, ref: string, subtotal: number, actor = 'budi', method: 'PLATFORM' | 'CASH' = 'PLATFORM') => {
      s.pos({ type: 'order.created', payload: { orderId: id, orderType: 'TAKE_AWAY' } }, hms, actor);
      s.pos({ type: 'order.channel_linked', payload: { orderId: id, channel: 'GOFOOD', ref } }, hms, actor);
      s.pos({ type: 'bill.printed', payload: { orderId: id, total: Math.round(subtotal * 1.1), breakdown: { subtotal, discount: 0, service: 0, tax: Math.round(subtotal * 0.1), rounding: 0 } } }, hms, actor);
      s.pos({ type: 'payment.received', payload: { orderId: id, method, amount: Math.round(subtotal * 1.1) } }, hms, actor);
    };
    order('p1', '12:00:00', 'GF-1', 45_000); // cocok
    order('p2', '13:00:00', 'GF-2', 30_000, 'sari'); // tidak ada di laporan platform
    order('p3', '14:00:00', 'GF-3', 60_000); // platform mencatat 90.000
    // order biasa dengan metode Platform (jalan pintas menyembunyikan tunai)
    s.pos({ type: 'order.created', payload: { orderId: 'p4', orderType: 'TAKE_AWAY' } }, '15:00:00', 'sari');
    s.pos({ type: 'payment.received', payload: { orderId: 'p4', method: 'PLATFORM', amount: 70_000 } }, '15:01:00', 'sari');
    // nomor pesanan dipakai dua kali
    order('p5', '16:00:00', 'GF-1', 45_000, 'sari');
    expect((await h.postEvents(term, s.events)).status).toBe(201);

    const r = (await recon('?from=2026-10-02&to=2026-10-02')).body;
    expect(r.totals).toEqual({ orders: 3, gross: 190_000, commission: 38_000, net: 152_000 });
    const byRef = Object.fromEntries(r.rows.map((x: { ref: string; status: string; pos: { orderId: string } | null }) => [x.ref, [x.status, x.pos?.orderId ?? null]]));
    expect(byRef).toEqual({ 'GF-1': ['OK', 'p1'], 'GF-3': ['AMOUNT', 'p3'], 'GF-404': ['UNRECORDED', null] });
    expect(r.missing.map((m: { ref: string; status: string; orderId: string; actorId: string }) => [m.ref, m.status, m.orderId, m.actorId])).toEqual([['GF-2', 'MISSING', 'p2', 'sari']]);
    expect((await recon('?from=2026-10-02&to=2026-10-02', manager)).status).toBe(200);
    expect((await recon('?range=7d', term)).status).toBe(403);
    expect((await recon('?range=7d', ownerB)).status).toBe(404);
  });

  it('temuan masuk ke insiden: R35, R36, R37, R38, R39', async () => {
    h.setNow(WIB('2026-10-03T10:00:00'));
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    const hits = ((await h.http('GET', '/v1/outlets/o1/incidents', owner)).body as { hits: { rule: string; orderId: string | null; note: string }[] }[]).flatMap((i) => i.hits);
    const of = (rule: string) => hits.filter((x) => x.rule === rule).map((x) => x.orderId ?? x.note.match(/GF-\d+/)?.[0]).sort();
    expect(of('R35')).toEqual(['p4']);
    expect(of('R36')).toEqual(['p5']);
    expect(of('R37')).toEqual(['p2']);
    expect(of('R38')).toEqual(['p3']);
    expect(of('R39')).toEqual(['GF-404']);
  });

  it('jurnal akuntansi memuat piutang platform dan penyelesaian dari laporan platform', async () => {
    const j = (await h.http('GET', '/v1/outlets/o1/accounting/journal?from=2026-10-02&to=2026-10-02', owner)).body;
    const plt = j.entries.find((e: { ref: string }) => e.ref === 'JU-PLT-o1-20261002');
    expect(plt.lines).toEqual([{ account: '1-1210', debit: 0, credit: 190_000 }, { account: '1-1300', debit: 152_000, credit: 0 }, { account: '6-5100', debit: 38_000, credit: 0 }]);
    const pos = j.entries.find((e: { ref: string }) => e.ref === 'JU-POS-o1-20261002');
    expect(pos.lines.find((l: { account: string }) => l.account === '1-1210').debit).toBeGreaterThan(0);
    expect(pos.lines.find((l: { account: string }) => l.account === '1-1100')).toBeUndefined(); // tidak ada uang tunai
    const sum = (k: 'debit' | 'credit') => pos.lines.reduce((s: number, l: { debit: number; credit: number }) => s + l[k], 0);
    expect(sum('debit')).toBe(sum('credit'));
  });
});

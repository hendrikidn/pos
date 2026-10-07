import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventChain, type PosEvent } from '@pos/events';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const fixture = (p: string) => readFileSync(resolve(__dirname, '../../../fixtures', p), 'utf8');
const WIB = (iso: string) => Date.parse(`${iso}+07:00`);

/** Registri EDC outlet o1 (seperti yang diisi owner di Pengaturan). POS menolak TID di luar registri ini. */
async function registerEdcs(h: Harness, tids: string[]) {
  await h.db.admin.query('update outlet set edcs = $1::jsonb where id = $2', [
    JSON.stringify(tids.map((tid) => ({ tid, bank: 'Bank', label: `EDC ${tid}` }))), 'o1',
  ]);
}

async function seedTenant(h: Harness, tenant: string, outlet: string, terminals: string[]) {
  await h.admin.createTenant(tenant, `Tenant ${tenant}`);
  await h.admin.createOutlet(tenant, outlet, `Outlet ${outlet}`, {
    terminals,
    capabilities: { sensor: true, kds: true, printerReportsStatus: true },
  });
}

describe('keamanan dan isolasi', () => {
  let h: Harness;
  let devA: string;
  let apiA: string;
  let apiB: string;

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-01T14:00:00'));
    await seedTenant(h, 'ta', 'oa', ['term-a']);
    await seedTenant(h, 'tb', 'ob', ['term-b']);
    devA = await h.admin.createDevice('ta', 'oa', 'term-a', 'terminal');
    apiA = await h.admin.createApiToken('ta', 'owner-a', 'OWNER');
    apiB = await h.admin.createApiToken('tb', 'owner-b', 'OWNER');
  });
  afterAll(() => h.close());

  const chainA = () => {
    const c = new EventChain('term-a', 'oa');
    return (n: number) =>
      Array.from({ length: n }, (_, i) =>
        c.append({ type: 'device.heartbeat', deviceTime: WIB('2026-10-01T13:00:00') + i * 1000, payload: { kind: 'terminal' } }),
      );
  };

  it('endpoint publik tidak butuh token, endpoint lain wajib', async () => {
    expect((await h.http('GET', '/healthz')).status).toBe(200);
    expect((await h.http('POST', '/v1/events', undefined, { events: [] })).status).toBe(401);
    expect((await h.http('POST', '/v1/events', 'dev_salah', { events: [] })).status).toBe(401);
    expect((await h.http('POST', '/v1/events', 'tanpa-prefiks', { events: [] })).status).toBe(401);
  });

  it('token perangkat tidak bisa memakai endpoint pengguna, dan sebaliknya', async () => {
    expect((await h.http('GET', '/v1/outlets/oa/incidents', devA)).status).toBe(403);
    expect((await h.http('POST', '/v1/events', apiA, { events: [] })).status).toBe(403);
  });

  it('pengguna tenant B tidak bisa mengakses outlet tenant A', async () => {
    expect((await h.http('POST', '/v1/outlets/oa/evaluate', apiB)).status).toBe(404);
    expect((await h.http('GET', '/v1/outlets/oa/incidents', apiB)).body).toEqual([]);
  });

  it('RLS: tenant B tidak melihat event tenant A', async () => {
    const batch = chainA()(3);
    expect((await h.postEvents(devA, batch)).body.accepted).toBe(3);
    const asA = await h.db.tenantTx('ta', async (q) => (await q.query('select 1 from event')).rowCount);
    const asB = await h.db.tenantTx('tb', async (q) => (await q.query('select 1 from event')).rowCount);
    expect([asA, asB]).toEqual([3, 0]);
  });

  it('RLS: menyisipkan baris atas nama tenant lain ditolak', async () => {
    await expect(
      h.db.tenantTx('tb', (q) =>
        q.query(
          `insert into event (id, tenant_id, outlet_id, device_id, seq, type, device_time_ms, prev_hash, hash, payload)
           values ('x', 'ta', 'oa', 'term-a', 99, 'device.heartbeat', 0, 'p', 'h', '{}')`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('tabel event append-only: UPDATE, DELETE, dan TRUNCATE ditolak, bahkan untuk pemilik skema', async () => {
    await expect(h.db.admin.query("update event set type = 'x'")).rejects.toThrow(/append-only/);
    await expect(h.db.admin.query('delete from event')).rejects.toThrow(/append-only/);
    await expect(h.db.admin.query('truncate event')).rejects.toThrow(/append-only/);
  });
});

describe('ingest event', () => {
  let h: Harness;
  let dev: string;

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-01T14:00:00'));
    await seedTenant(h, 't1', 'o1', ['term-1']);
    dev = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
  });
  afterAll(() => h.close());

  const hb = (c: EventChain, sec: number) =>
    c.append({ type: 'device.heartbeat', deviceTime: WIB('2026-10-01T10:00:00') + sec * 1000, payload: { kind: 'terminal' } });

  it('menerima batch berurutan dan mengembalikan ackedSeq', async () => {
    const c = new EventChain('term-1', 'o1');
    const r = await h.postEvents(dev, [hb(c, 0), hb(c, 1), hb(c, 2)]);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ackedSeq: 3, accepted: 3, duplicates: 0, issues: [] });
  });

  it('idempoten: mengirim ulang batch yang sama tidak menggandakan', async () => {
    const c = new EventChain('term-1', 'o1');
    const batch = [hb(c, 0), hb(c, 1), hb(c, 2)];
    const r = await h.postEvents(dev, batch);
    expect(r.body).toMatchObject({ ackedSeq: 3, accepted: 0, duplicates: 3, issues: [] });
    const n = await h.db.tenantTx('t1', async (q) => (await q.query('select 1 from event where device_id = $1', ['term-1'])).rowCount);
    expect(n).toBe(3);
  });

  it('batch yang melompati seq dicatat sebagai SEQ_GAP tetapi tetap disimpan', async () => {
    const c = new EventChain('term-1', 'o1');
    const all = [hb(c, 0), hb(c, 1), hb(c, 2), hb(c, 3), hb(c, 4)];
    const r = await h.postEvents(dev, [all[4]!]); // seq 5, padahal terakhir 3
    expect(r.body.accepted).toBe(1);
    expect(r.body.issues.map((i: { kind: string }) => i.kind)).toContain('SEQ_GAP');
    const stored = await h.db.tenantTx('t1', async (q) => (await q.query('select integrity from event where seq = 5')).rows);
    expect(stored).toEqual([{ integrity: 'SEQ_GAP' }]);
  });

  it('event yang isinya diubah ditandai HASH_MISMATCH', async () => {
    const c = new EventChain('term-1', 'o1');
    for (let i = 0; i < 5; i++) hb(c, i);
    const e = hb(c, 5); // seq 6
    if (e.type === 'device.heartbeat') e.payload.kind = 'sensor';
    const r = await h.postEvents(dev, [e]);
    expect(r.body.issues.map((i: { kind: string }) => i.kind)).toContain('HASH_MISMATCH');
  });

  it('seq yang sama dengan isi berbeda dilaporkan DUPLICATE_MISMATCH', async () => {
    const c = new EventChain('term-1', 'o1');
    const forged = c.append({ type: 'device.heartbeat', deviceTime: WIB('2026-10-01T11:00:00'), payload: { kind: 'sensor' } });
    const r = await h.postEvents(dev, [forged]); // seq 1 sudah ada dengan hash lain
    expect(r.body.issues.map((i: { kind: string }) => i.kind)).toEqual(['DUPLICATE_MISMATCH']);
  });

  it('menolak event dengan deviceId atau outletId yang tidak sesuai token', async () => {
    const other = new EventChain('term-lain', 'o1');
    const r = await h.postEvents(dev, [hb(other, 0)]);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/deviceId/);
  });

  it('menolak tipe event tidak dikenal, bentuk salah, dan batch terlalu besar', async () => {
    const c = new EventChain('term-1', 'o1');
    const good = hb(c, 0);
    expect((await h.postEvents(dev, [{ ...good, type: 'order.hack' } as unknown as PosEvent])).status).toBe(400);
    expect((await h.postEvents(dev, [{ ...good, seq: 'a' } as unknown as PosEvent])).status).toBe(400);
    expect((await h.http('POST', '/v1/events', dev, { events: 'bukan array' })).status).toBe(400);
    const noOrder = { ...good, type: 'payment.received', payload: { method: 'CASH', amount: 1 } };
    const r = await h.postEvents(dev, [noOrder as unknown as PosEvent]);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/payment\.received/);
    const big = Array.from({ length: 501 }, () => good);
    expect((await h.postEvents(dev, big)).status).toBe(400);
  });
});

describe('dari event sampai insiden', () => {
  let h: Harness;
  let tokens: Record<string, string>;
  let owner: string;

  const phantom = () => {
    const s = new Sim('o1', '2026-10-01', 'term-1', 'sensor-1');
    s.heartbeats('sensor', '12:50:00', '13:30:00', 60_000);
    s.pos({ type: 'printer.status', payload: { state: 'paperOut', source: 'device' } }, '12:55:00');
    s.presence('13:14:02', '13:15:00');
    s.pos({ type: 'order.created', payload: { orderId: 'o42', orderType: 'TAKE_AWAY' } }, '13:14:30', 'budi');
    s.pos({ type: 'order.sent_to_kitchen', payload: { orderId: 'o42' } }, '13:14:35', 'budi');
    s.pos({ type: 'bill.printed', payload: { orderId: 'o42', total: 185_000 } }, '13:14:40', 'budi');
    s.pos({ type: 'payment.received', payload: { orderId: 'o42', method: 'CASH', amount: 185_000 } }, '13:14:50', 'budi');
    s.pos({ type: 'kitchen.status_changed', payload: { orderId: 'o42', status: 'COOKING' } }, '13:16:00', 'dapur');
    s.pos({ type: 'kitchen.status_changed', payload: { orderId: 'o42', status: 'READY' } }, '13:17:40', 'dapur');
    s.pos({ type: 'void.approved', payload: { orderId: 'o42', reasonCode: 'CUSTOMER_CANCEL', approverIds: ['hendra'], amount: 185_000 } }, '13:18:45', 'budi');
    return s;
  };

  const send = async (events: PosEvent[]) => {
    for (const id of ['sensor-1', 'term-1']) {
      const r = await h.postEvents(tokens[id]!, events.filter((e) => e.deviceId === id));
      expect(r.status).toBe(201);
    }
  };

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-01T13:30:00'));
    await seedTenant(h, 't1', 'o1', ['term-1']);
    tokens = {
      'term-1': await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal'),
      'sensor-1': await h.admin.createDevice('t1', 'o1', 'sensor-1', 'sensor'),
    };
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
  });
  afterAll(() => h.close());

  it('kasus phantom void menjadi satu insiden kritis dan memicu notifikasi sekali', async () => {
    await send(phantom().events);

    const list = await h.http('GET', '/v1/outlets/o1/incidents', owner);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ score: 170, level: 'CRITICAL', order_ids: ['o42'], status: 'OPEN' });
    expect(list.body[0].hits.map((x: { rule: string }) => x.rule).sort()).toEqual(['R2', 'R3', 'R5']);

    expect(h.notifier.critical).toHaveLength(1);

    // evaluasi ulang menghasilkan insiden yang sama dan tidak memicu notifikasi baru
    const again = await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    expect(again.body).toEqual({ incidents: 1, newCritical: 0 });
    expect(h.notifier.critical).toHaveLength(1);
  });

  it('insiden tidak terlihat oleh orang yang terlibat di dalamnya (approver)', async () => {
    const hendra = await h.admin.createApiToken('t1', 'hendra', 'OWNER');
    expect((await h.http('GET', '/v1/outlets/o1/incidents', hendra)).body).toEqual([]);
    const id = (await h.http('GET', '/v1/outlets/o1/incidents', owner)).body[0].id as string;
    expect((await h.http('GET', `/v1/incidents/${encodeURIComponent(id)}`, hendra)).status).toBe(404);
    expect((await h.http('POST', `/v1/incidents/${encodeURIComponent(id)}/review`, hendra, { label: 'LEGIT' })).status).toBe(403);
  });

  it('manager tidak boleh mereview, owner boleh, dan hasil review tidak ditimpa evaluasi ulang', async () => {
    const manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    const id = (await h.http('GET', '/v1/outlets/o1/incidents', owner)).body[0].id as string;
    const path = `/v1/incidents/${encodeURIComponent(id)}/review`;

    expect((await h.http('POST', path, manager, { label: 'LEGIT' })).status).toBe(403);
    expect((await h.http('POST', path, owner, { label: 'ASAL' })).status).toBe(400);
    expect((await h.http('POST', path, owner, { label: 'CONFIRMED_FRAUD', note: 'CCTV 13:14, customer sudah bayar' })).body).toEqual({
      status: 'CONFIRMED_FRAUD',
    });

    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    expect((await h.http('GET', '/v1/outlets/o1/incidents', owner)).body).toEqual([]); // tidak lagi OPEN
    const closed = await h.http('GET', '/v1/outlets/o1/incidents?status=CONFIRMED_FRAUD', owner);
    expect(closed.body).toHaveLength(1);
    expect(closed.body[0].score).toBe(170);
  });

  it('detail insiden memuat riwayat review dan pengaturan CCTV outlet; /me dan /outlets untuk dashboard', async () => {
    const closed = (await h.http('GET', '/v1/outlets/o1/incidents?status=CONFIRMED_FRAUD', owner)).body[0];
    const detail = await h.http('GET', `/v1/incidents/${encodeURIComponent(closed.id)}`, owner);
    expect(detail.status).toBe(200);
    expect(detail.body.reviews).toEqual([
      expect.objectContaining({ reviewer: 'owner-1', label: 'CONFIRMED_FRAUD', note: 'CCTV 13:14, customer sudah bayar' }),
    ]);
    expect(detail.body.reviews[0].reviewed_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(detail.body.outlet).toMatchObject({ id: 'o1', name: 'Outlet o1', cctv_retention_days: 7, cctv_clock_offset_sec: 0 });

    expect((await h.http('GET', '/v1/me', owner)).body).toEqual({ userId: 'owner-1', role: 'OWNER', tenantId: 't1' });
    expect((await h.http('GET', '/v1/me', tokens['term-1'])).status).toBe(403);
    expect((await h.http('GET', '/v1/me')).status).toBe(401);
    // insiden sudah direview, jadi tidak ada yang terbuka; pengguna yang terlibat tidak ikut menghitung
    expect((await h.http('GET', '/v1/outlets', owner)).body).toEqual([
      { id: 'o1', name: 'Outlet o1', cctv_retention_days: 7, cctv_clock_offset_sec: 0, open_incidents: 0, open_critical: 0 },
    ]);
  });

  it('data susulan yang membatalkan temuan menandai insiden RETRACTED', async () => {
    // outlet baru: presence 58 dtk tanpa order, lalu order tiba terlambat dari POS yang offline
    await seedTenant(h, 't2', 'o2', ['term-2']);
    const term = await h.admin.createDevice('t2', 'o2', 'term-2', 'terminal');
    const sensor = await h.admin.createDevice('t2', 'o2', 'sensor-2', 'sensor');
    const apiT2 = await h.admin.createApiToken('t2', 'owner-2', 'OWNER');
    const s = new Sim('o2', '2026-10-01', 'term-2', 'sensor-2');
    s.presence('13:00:00', '13:01:00');
    s.cashOrder('late-1', '13:01:30', '13:02:00');
    s.heartbeat('terminal', '13:20:00');

    // sensor dan heartbeat terminal tiba dulu; event order belum (seq 1..4 tertahan di POS)
    const termEvents = s.events.filter((e) => e.deviceId === 'term-2');
    const hbOnly = termEvents[termEvents.length - 1]!;
    await h.postEvents(sensor, s.events.filter((e) => e.deviceId === 'sensor-2'));
    await h.postEvents(term, [hbOnly]); // seq 5 duluan: terminal tampak punya celah
    h.setNow(WIB('2026-10-01T13:50:00')); // > 30 menit sejak jendela R1 berakhir: masa tunggu habis
    await h.http('POST', '/v1/outlets/o2/evaluate', apiT2);
    const before = await h.http('GET', '/v1/outlets/o2/incidents', apiT2);
    expect(before.body.some((i: { hits: { rule: string }[] }) => i.hits.some((x) => x.rule === 'R1'))).toBe(true);

    await h.postEvents(term, termEvents.slice(0, 4)); // data susulan tiba
    const after = await h.http('GET', '/v1/outlets/o2/incidents', apiT2);
    expect(after.body.some((i: { hits: { rule: string }[] }) => i.hits.some((x) => x.rule === 'R1'))).toBe(false);
    const retracted = await h.http('GET', '/v1/outlets/o2/incidents?status=RETRACTED', apiT2);
    expect(retracted.body.length).toBeGreaterThan(0);
  });
});

describe('rekonsiliasi bank lewat API', () => {
  let h: Harness;
  let term: string;
  let owner: string;

  interface Scenario {
    pos_payments: { order_id: string; paid_at: string; tid: string; method: string; amount: number }[];
  }
  const scenario: Scenario = JSON.parse(fixture('scenarios/2026-10-01-senopati.json'));

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-02T09:00:00'));
    await seedTenant(h, 't1', 'o1', ['term-1']);
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    await registerEdcs(h, ['12345678', '87654321', '55556666']);

    const chain = new EventChain('term-1', 'o1');
    const events = scenario.pos_payments.map((p) =>
      chain.append({
        type: 'payment.received',
        deviceTime: Date.parse(p.paid_at),
        actorId: 'budi',
        payload: { orderId: p.order_id, method: p.method as 'QRIS', amount: p.amount, tid: p.tid },
      }),
    );
    expect((await h.postEvents(term, events)).body.accepted).toBe(25);
  });
  afterAll(() => h.close());

  const upload = (file: string) =>
    h.http('POST', '/v1/outlets/o1/bank-reports', owner, { text: fixture(`bank-reports/${file}`), filename: file });
  const rulesOf = async () => {
    const r = await h.http('GET', '/v1/outlets/o1/incidents', owner);
    return r.body.flatMap((i: { hits: { rule: string; orderId: string | null }[] }) => i.hits.map((x) => `${x.rule}:${x.orderId ?? ''}`)).sort();
  };

  it('tanpa laporan bank, tidak ada tuduhan R7 (belum bisa dinilai)', async () => {
    expect((await rulesOf()).filter((x: string) => x.startsWith('R7'))).toEqual([]);
  });

  it('mengunggah laporan BCA: R7 dan R8 untuk BCA saja', async () => {
    const r = await upload('mock-bca-merchant-2026-10-01.csv');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ bank: 'BCA', txnCount: 10, newTxns: 10, parseErrors: [] });
    const rules = await rulesOf();
    expect(rules).toContain('R7:ord-0008');
    expect(rules).toContain('R8:ord-0009');
    expect(rules.filter((x: string) => x === 'R7:ord-0014' || x === 'R7:ord-0025')).toEqual([]);
  });

  it('mengunggah BRI dan Mandiri melengkapi semua temuan, pending Mandiri tidak dituduh', async () => {
    await upload('mock-bri-merchant-2026-10-01.csv');
    await upload('mock-mandiri-merchant-2026-10-01.csv');
    const rules = await rulesOf();
    for (const expected of ['R7:ord-0008', 'R7:ord-0014', 'R7:ord-0025', 'R8:ord-0009']) expect(rules).toContain(expected);
    expect(rules.some((x: string) => x.startsWith('R26'))).toBe(true);
    expect(rules.filter((x: string) => x.includes('ord-0024'))).toEqual([]);
    expect(rules.filter((x: string) => x.startsWith('R7'))).toHaveLength(3);
  });

  it('unggah ulang file yang sama tidak menggandakan transaksi maupun temuan', async () => {
    const before = await rulesOf();
    const r = await upload('mock-bca-merchant-2026-10-01.csv');
    expect(r.body.newTxns).toBe(0);
    expect(await rulesOf()).toEqual(before);
  });

  it('file bukan laporan bank ditolak dengan pesan jelas', async () => {
    const r = await h.http('POST', '/v1/outlets/o1/bank-reports', owner, { text: 'a,b,c\n1,2,3' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/tidak dikenali/);
  });

  it('hanya OWNER/OPS yang boleh mengunggah', async () => {
    const manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    const r = await h.http('POST', '/v1/outlets/o1/bank-reports', manager, { text: 'x' });
    expect(r.status).toBe(403);
  });

  it('R9: dengan registri lengkap tidak ada temuan R9', async () => {
    expect((await rulesOf()).filter((x: string) => x.startsWith('R9'))).toEqual([]);
  });

  it('R9: TID yang dicabut dari registri menandai semua pembayaran di TID itu, dan pulih bila didaftarkan lagi', async () => {
    const onTid = scenario.pos_payments.filter((p) => p.tid === '55556666').map((p) => `R9:${p.order_id}`).sort();
    expect(onTid.length).toBeGreaterThan(0);

    await registerEdcs(h, ['12345678', '87654321']);
    await upload('mock-bca-merchant-2026-10-01.csv'); // impor ulang menjalankan rekonsiliasi lagi
    expect((await rulesOf()).filter((x: string) => x.startsWith('R9'))).toEqual(onTid);

    const detail = await h.http('GET', '/v1/outlets/o1/incidents', owner);
    const hit = detail.body.flatMap((i: { hits: { rule: string; note: string }[] }) => i.hits).find((x: { rule: string }) => x.rule === 'R9');
    expect(hit.note).toMatch(/TID 55556666 tidak ada di registri EDC outlet/);

    await registerEdcs(h, ['12345678', '87654321', '55556666']);
    await upload('mock-bca-merchant-2026-10-01.csv');
    expect((await rulesOf()).filter((x: string) => x.startsWith('R9'))).toEqual([]);
  });
});

describe('R6 dan R14 lewat API', () => {
  let h: Harness;
  let term: string;
  let owner: string;
  const DAY = 24 * 3_600_000;

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-08T22:00:00'));
    await seedTenant(h, 't1', 'o1', ['term-1']);
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
  });
  afterAll(() => h.close());

  const incidents = async (token = owner) => (await h.http('GET', '/v1/outlets/o1/incidents', token)).body as {
    status: string; level: string; score: number; actor_ids: string[];
    hits: { rule: string; note: string; orderId: string | null }[];
  }[];

  it('R14: shift keempat dengan selisih kas dalam 7 hari menjadi insiden; shift lama tidak digandakan', async () => {
    const s = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
    const closeAt = (daysAgo: number, diff: number) =>
      s.pos(
        { type: 'cash.counted', payload: { shiftId: `S${daysAgo}`, counted: 500_000 + diff, expected: 500_000 } },
        WIB('2026-10-08T21:00:00') - daysAgo * DAY,
        'budi',
      );
    // dua shift lebih tua dari jendela 72 jam, tetapi masih dalam 7 hari
    closeAt(6, -10_000);
    closeAt(4, 15_000);
    expect((await h.postEvents(term, s.events)).status).toBe(201);
    expect((await incidents()).filter((i) => i.hits.some((x) => x.rule === 'R14'))).toEqual([]);

    closeAt(2, -8_000);
    closeAt(0, -7_000);
    expect((await h.postEvents(term, s.events.slice(2))).status).toBe(201);

    const r14 = (await incidents()).filter((i) => i.hits.some((x) => x.rule === 'R14'));
    expect(r14).toHaveLength(1);
    expect(r14[0]).toMatchObject({ level: 'LOW', score: 20, actor_ids: ['budi'], status: 'OPEN' });
    expect(r14[0]!.hits[0]!.note).toMatch(/^4 shift dalam 7 hari .* terakhir kurang Rp7\.000$/);

    // evaluasi ulang stabil: tetap satu insiden
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    expect((await incidents()).filter((i) => i.hits.some((x) => x.rule === 'R14'))).toHaveLength(1);
  });

  it('R14: kasir yang bersangkutan tidak melihat insiden tentang dirinya', async () => {
    const budi = await h.admin.createApiToken('t1', 'budi', 'OWNER');
    expect(await incidents(budi)).toEqual([]);
  });
});

describe('R6 lewat API', () => {
  let h: Harness;
  let owner: string;

  const r6Incidents = async (token = owner) =>
    ((await h.http('GET', '/v1/outlets/o1/incidents', token)).body as {
      status: string; level: string; score: number; actor_ids: string[]; order_ids: string[];
      hits: { rule: string; note: string }[];
    }[]).filter((i) => i.hits.some((x) => x.rule === 'R6'));

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-08T13:00:00'));
    await seedTenant(h, 't1', 'o1', ['term-1']);
    const term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');

    const s = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
    const meal = (id: string, at: string, employee: string, actor = 'budi') =>
      s.pos({ type: 'order.created', payload: { orderId: id, orderType: 'EMPLOYEE', employeeId: employee } }, at, actor);
    // 06:30 dan 08:00 WIB: hari yang sama di WIB, hari berbeda di UTC
    meal('m1', '06:30:00', 'andi');
    meal('m2', '08:00:00', 'andi');
    // andi sendiri membuat makan untuk dirinya, pada hari yang sama dengan orang lain
    meal('m3', '12:00:00', 'sari');
    expect((await h.postEvents(term, s.events)).status).toBe(201);
  });
  afterAll(() => h.close());

  it('makan kedua andi hari itu menjadi insiden; makan pertama dan makan sari tidak', async () => {
    const list = await r6Incidents();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ level: 'LOW', score: 25, order_ids: ['m2'], status: 'OPEN' });
    expect(list[0]!.actor_ids.sort()).toEqual(['andi', 'budi']);
    expect(list[0]!.hits[0]!.note).toMatch(/ke-2 hari ini untuk andi \(kuota 1\)/);
  });

  it('penerima makan (andi) tidak melihat insiden tentang dirinya', async () => {
    const andi = await h.admin.createApiToken('t1', 'andi', 'OWNER');
    expect(await r6Incidents(andi)).toEqual([]);
  });

  it('batas hari memakai zona waktu outlet: bila outlet di UTC, dua makan itu beda hari dan insiden ditarik kembali', async () => {
    await h.db.admin.query("update outlet set utc_offset_minutes = 0 where id = 'o1'");
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    expect(await r6Incidents()).toEqual([]); // daftar bawaan menyembunyikan yang ditarik kembali
    const retracted = (await h.http('GET', '/v1/outlets/o1/incidents?status=RETRACTED', owner)).body as { status: string; hits: { rule: string }[] }[];
    expect(retracted.filter((i) => i.hits.some((x) => x.rule === 'R6')).map((i) => i.status)).toEqual(['RETRACTED']);
  });
});

describe('makan karyawan: persetujuan dan kuota per outlet lewat API', () => {
  let h: Harness;
  let term: string;
  let owner: string;
  const incidents = async (status = 'OPEN') =>
    ((await h.http('GET', `/v1/outlets/o1/incidents?status=${status}`, owner)).body as {
      score: number; order_ids: string[]; status: string; hits: { rule: string; weight: number; note: string }[];
    }[]).filter((i) => i.hits.some((x) => x.rule === 'R6'));

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-08T22:00:00'));
    await seedTenant(h, 't1', 'o1', ['term-1']);
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');

    const s = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
    const meal = (id: string, at: string, approverId?: string) =>
      s.pos({ type: 'order.created', payload: { orderId: id, orderType: 'EMPLOYEE', employeeId: 'andi', ...(approverId ? { approverId } : {}) } }, at, 'budi');
    meal('m1', '09:00:00');
    meal('m2', '13:00:00', 'hendra'); // ke-2, disetujui supervisor independen
    meal('m3', '17:00:00'); // ke-3, tanpa persetujuan
    expect((await h.postEvents(term, s.events)).status).toBe(201);
  });
  afterAll(() => h.close());

  it('yang disetujui masuk sebagai insiden berbobot 10, yang tanpa persetujuan berbobot 25', async () => {
    const list = await incidents();
    const byOrder = Object.fromEntries(list.map((i) => [i.order_ids[0], i]));
    expect(Object.keys(byOrder).sort()).toEqual(['m2', 'm3']);
    expect(byOrder['m2']).toMatchObject({ score: 10 });
    expect(byOrder['m2']!.hits[0]!.note).toMatch(/disetujui hendra/);
    expect(byOrder['m3']).toMatchObject({ score: 25 });
  });

  it('approverId pada order bukan karyawan ditolak oleh ingest', async () => {
    const s = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
    s.pos({ type: 'order.created', payload: { orderId: 'x', orderType: 'TAKE_AWAY', approverId: 'hendra' } } as never, '18:00:00', 'budi');
    const r = await h.postEvents(term, s.events);
    expect(r.status).toBe(400);
  });

  it('owner menaikkan kuota ke 3 lewat Pengaturan: kedua insiden ditarik kembali karena makan ke-2 dan ke-3 kini dalam kuota', async () => {
    const put = await h.http('PUT', '/v1/outlets/o1/settings', owner, { policy: { employeeMealQuota: 3 } });
    expect(put.status).toBe(200);
    expect((await h.http('GET', '/v1/outlets/o1/settings', owner)).body.policy).toEqual({ employeeMealQuota: 3 });
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    expect(await incidents()).toEqual([]);
    expect((await incidents('RETRACTED')).map((i) => i.order_ids[0]).sort()).toEqual(['m2', 'm3']);
  });

  it('kuota 0 diterima (semua makan perlu persetujuan), di atas 10 atau negatif ditolak', async () => {
    expect((await h.http('PUT', '/v1/outlets/o1/settings', owner, { policy: { employeeMealQuota: 0 } })).status).toBe(200);
    for (const bad of [11, -1, 1.5]) {
      const r = await h.http('PUT', '/v1/outlets/o1/settings', owner, { policy: { employeeMealQuota: bad } });
      expect(r.status, String(bad)).toBe(400);
      expect(r.body.message).toMatch(/employeeMealQuota/);
    }
  });

  it('dengan kuota 0 setiap makan karyawan tanpa approver ditandai; yang disetujui berbobot rendah', async () => {
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    const byOrder = Object.fromEntries((await incidents()).map((i) => [i.order_ids[0]!, i.score]));
    expect(byOrder).toEqual({ m1: 25, m2: 10, m3: 25 });
  });
});

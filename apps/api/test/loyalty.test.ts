import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { MAX_REGISTRATIONS_PER_DEVICE_PER_HOUR } from '../src/member.service';
import { normalizePhone } from '../src/loyalty';
import { createHarness, type Harness } from './harness';

const DAY = '2026-10-02';
const T0 = Date.parse(`${DAY}T12:00:00+07:00`);

describe('normalizePhone', () => {
  it('berbagai penulisan nomor HP Indonesia menjadi bentuk yang sama; yang bukan nomor wajar ditolak', () => {
    for (const v of ['0812-3456-7890', '+62 812 3456 7890', '6281234567890', '(0812) 3456 7890', '081234567890']) expect(normalizePhone(v)).toBe('6281234567890');
    for (const v of ['', '12345', 'abc', '0812', '+1 555 123 4567', '08123456789012345678', null, 812345678901, '0812 3456 78x0']) expect(normalizePhone(v)).toBeNull();
  });
});

describe('loyalty: member, saldo poin, dan penukaran', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let manager: string;
  let ownerB: string;
  let term: string;
  let term2: string;
  let sensor: string;
  let kds: string;
  let sim: Sim;

  const settings = (body: unknown, tok = owner) => h.http('PUT', '/v1/outlets/o1/settings', tok, body);
  const register = (tok: string, phone: string, name = 'Dewi') => h.http('POST', '/v1/members', tok, { phone, name });
  const lookup = (tok: string, phone: string) => h.http('GET', `/v1/members/lookup?phone=${encodeURIComponent(phone)}`, tok);
  const points = async (phone: string) => (await lookup(term, phone)).body.points as number;
  const sync = async () => expect((await h.postEvents(term, sim.events.filter((e) => e.deviceId === 'term-1'))).status).toBe(201);
  const ledger = async () => (await h.db.admin.query<{ kind: string; points: number; order_id: string }>('select kind, points, order_id from member_ledger order by seq, kind')).rows;
  const alerts = async () => (await h.db.admin.query<{ kind: string; order_id: string }>('select kind, order_id from loyalty_alert order by seq, kind')).rows;
  const order = (id: string, hms: string, member?: string) => {
    sim.pos({ type: 'order.created', payload: { orderId: id, orderType: 'TAKE_AWAY' } }, hms, 'budi');
    if (member) sim.pos({ type: 'order.member_linked', payload: { orderId: id, memberId: member } }, hms, 'budi');
  };
  const pay = (id: string, hms: string, amount: number) => sim.pos({ type: 'payment.received', payload: { orderId: id, method: 'CASH', amount } }, hms, 'budi');
  const redeem = (id: string, hms: string, member: string, pts: number, amount: number) =>
    sim.pos({ type: 'discount.applied', payload: { orderId: id, kind: 'POINTS', verified: true, amount, percent: 10, memberId: member, points: pts } } as never, hms, 'budi');

  let dewi = '';

  beforeAll(async () => {
    h = await createHarness(T0 + 60 * 60_000);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1', 'term-2'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    term2 = await h.admin.createDevice('t1', 'o1', 'term-2', 'terminal');
    sensor = await h.admin.createDevice('t1', 'o1', 'sensor-1', 'sensor');
    kds = await h.admin.createDevice('t1', 'o1', 'kds-1', 'kds');
    sim = new Sim('o1', DAY, 'term-1', 'sensor-1');
  });
  afterAll(() => h.close());

  it('pengaturan loyalty: validasi, tercatat, dan dikirim ke terminal hanya bila aktif', async () => {
    expect((await h.http('GET', '/v1/device/config', term)).body.outlet).not.toHaveProperty('loyalty');
    const bad = (loyalty: unknown) => settings({ loyalty });
    expect((await bad({ rupiahPerPoint: -1, pointValue: 0, maxRedeemPercent: 50 })).status).toBe(400);
    expect((await bad({ rupiahPerPoint: 10_000, pointValue: 0, maxRedeemPercent: 0 })).status).toBe(400);
    expect((await bad({ rupiahPerPoint: 10_000, pointValue: 0, maxRedeemPercent: 101 })).status).toBe(400);
    expect((await bad({ rupiahPerPoint: 10_000, pointValue: 1.5, maxRedeemPercent: 50 })).status).toBe(400);
    expect((await bad({ rupiahPerPoint: 1_000, pointValue: 5_000, maxRedeemPercent: 50 })).status).toBe(400); // menukar lebih bernilai daripada memperoleh
    expect((await bad('aktif')).status).toBe(400);
    expect((await settings({ loyalty: { rupiahPerPoint: 10_000, pointValue: 100, maxRedeemPercent: 50 } })).status).toBeLessThan(300);
    expect((await h.http('GET', '/v1/device/config', term)).body.outlet.loyalty).toEqual({ rupiahPerPoint: 10_000, pointValue: 100, maxRedeemPercent: 50 });
    expect((await h.http('GET', '/v1/device/config', kds)).body.outlet).not.toHaveProperty('loyalty');
    expect((await h.http('GET', '/v1/outlets/o1/settings', owner)).body).toMatchObject({ loyalty_rupiah_per_point: 10_000, loyalty_point_value: 100 });
  });

  it('terminal mendaftarkan dan mencari member; nomor sama dengan penulisan berbeda dikenali; ganda 409; akses dibatasi', async () => {
    const r = await register(term, '0812-3456-7890');
    expect(r.status).toBe(201);
    dewi = r.body.id;
    expect(r.body).toMatchObject({ name: 'Dewi', points: 0 });
    expect((await register(term2, '+62 812 3456 7890', 'Orang lain')).status).toBe(409);
    expect((await lookup(term2, '6281234567890')).body).toEqual({ id: dewi, name: 'Dewi', points: 0 });
    expect((await lookup(term, '0899 0000 1111')).status).toBe(404);
    expect((await lookup(term, 'abc')).status).toBe(400);
    expect((await register(term, '0812', 'X')).status).toBe(400);
    expect((await register(term, '0813 0000 0001', '  ')).status).toBe(400);
    for (const tok of [sensor, kds, owner]) expect((await lookup(tok, '0812-3456-7890')).status).toBe(403);
    expect((await register(sensor, '0813 0000 0002')).status).toBe(403);
    expect((await h.http('GET', '/v1/members/lookup?phone=081234567890')).status).toBe(401);
    expect(JSON.stringify((await lookup(term, '081234567890')).body)).not.toContain('81234567890'); // nomor tidak dikirim balik
  });

  it('poin diperoleh dari pembayaran order yang dikaitkan: lantai(nominal / Rp per poin), pembayaran sebagian dihitung per pembayaran', async () => {
    order('o-1', '12:01:00', dewi);
    pay('o-1', '12:02:00', 47_000); // 4 poin
    order('o-2', '12:03:00', dewi);
    pay('o-2', '12:04:00', 30_000); // 3 poin
    pay('o-2', '12:05:00', 8_000); // 0 poin (di bawah satu poin)
    order('o-3', '12:06:00'); // tanpa member
    pay('o-3', '12:07:00', 90_000);
    await sync();
    expect(await ledger()).toEqual([{ kind: 'EARN', points: 4, order_id: 'o-1' }, { kind: 'EARN', points: 3, order_id: 'o-2' }]);
    expect(await points('0812 3456 7890')).toBe(7);
    await sync(); // kirim ulang: idempoten
    expect(await points('0812 3456 7890')).toBe(7);
    expect(await ledger()).toHaveLength(2);
  });

  it('penukaran poin mengurangi saldo; tanpa alert selama saldo cukup', async () => {
    order('o-4', '12:10:00', dewi);
    redeem('o-4', '12:11:00', dewi, 5, 500);
    await sync();
    expect(await points('0812 3456 7890')).toBe(2);
    expect(await alerts()).toEqual([]);
  });

  it('void membalik poin yang diperoleh dan mengembalikan yang ditukar; void ulang tidak menggandakan', async () => {
    order('o-5', '12:15:00', dewi);
    redeem('o-5', '12:15:30', dewi, 2, 200); // saldo 2 → 0
    pay('o-5', '12:16:00', 50_000); // +5
    await sync();
    expect(await points('0812 3456 7890')).toBe(5);
    const v = () => sim.pos({ type: 'void.approved', payload: { orderId: 'o-5', reasonCode: 'CUSTOMER_CANCEL', approverIds: ['hendra'], amount: 50_000 } }, '12:20:00', 'budi');
    v();
    await sync();
    expect(await points('0812 3456 7890')).toBe(2); // −5 diperoleh, +2 ditukar kembali
    v();
    await sync();
    expect(await points('0812 3456 7890')).toBe(2);
  });

  it('refund membalik poin sebanding nominalnya', async () => {
    order('o-6', '12:25:00', dewi);
    pay('o-6', '12:26:00', 60_000); // +6 → 8
    sim.pos({ type: 'refund.created', payload: { refundId: 'o-6-R1', originalOrderId: 'o-6', amount: 20_000, method: 'CASH', approverId: 'hendra' } }, '12:30:00', 'budi'); // −2
    await sync();
    expect(await points('0812 3456 7890')).toBe(6);
  });

  it('menukar lebih dari saldo, member tak dikenal, atau member berbeda dari yang dikaitkan: saldo tercatat apa adanya dan menjadi peringatan', async () => {
    order('o-7', '12:35:00', dewi);
    redeem('o-7', '12:36:00', dewi, 10, 1_000); // saldo 6 → −4
    order('o-8', '12:37:00', 'm-tidak-ada');
    redeem('o-8', '12:38:00', 'm-tidak-ada', 3, 300);
    const eko = (await register(term2, '0856 1111 2222', 'Eko')).body.id;
    order('o-9', '12:39:00', eko);
    redeem('o-9', '12:40:00', dewi, 1, 100); // order milik Eko, poin Dewi
    await sync();
    const a = await alerts();
    expect(a).toEqual(expect.arrayContaining([
      { kind: 'OVER_REDEEM', order_id: 'o-7' }, { kind: 'UNKNOWN_MEMBER', order_id: 'o-8' }, { kind: 'MEMBER_MISMATCH', order_id: 'o-9' },
    ]));
    expect(a.filter((x) => x.order_id === 'o-8').map((x) => x.kind)).toEqual(['UNKNOWN_MEMBER', 'UNKNOWN_MEMBER']); // tautan dan penukaran
    expect(await points('0812 3456 7890')).toBe(-5);
  });

  it('peringatan menjadi temuan R33 di insiden outlet', async () => {
    h.setNow(T0 + 90 * 60_000);
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    const hits = ((await h.http('GET', '/v1/outlets/o1/incidents', owner)).body as { hits: { rule: string; orderId: string | null; note: string }[] }[]).flatMap((i) => i.hits).filter((x) => x.rule === 'R33');
    expect(hits.map((x) => x.orderId).sort()).toEqual(['o-7', 'o-8', 'o-8', 'o-9', 'o-9']); // o-9: member berbeda, dan saldo masih negatif
    expect(hits.find((x) => x.orderId === 'o-7')!.note).toContain('saldo');
  });

  it('dashboard: daftar dengan saldo dan nomor tersamar; ubah nama dan nonaktifkan (lookup lalu 403); peran dan tenant', async () => {
    const list = (await h.http('GET', '/v1/members', manager)).body as { id: string; name: string; phoneMasked: string; points: number; active: boolean; lastActivityMs: number | null }[];
    const d = list.find((m) => m.id === dewi)!;
    expect(d).toMatchObject({ name: 'Dewi', points: -5, active: true });
    expect(d.phoneMasked).toBe('•••••••••7890');
    expect(d.lastActivityMs).toBeGreaterThan(0);
    expect(((await h.http('GET', '/v1/members?search=eko', owner)).body as unknown[]).length).toBe(1);
    expect(((await h.http('GET', '/v1/members?search=7890', owner)).body as unknown[]).length).toBe(1);
    expect((await h.http('PUT', `/v1/members/${dewi}`, manager, { name: 'X' })).status).toBe(403);
    expect((await h.http('PUT', `/v1/members/${dewi}`, ops, { name: 'Dewi Lestari' })).status).toBe(200);
    expect((await h.http('PUT', `/v1/members/${dewi}`, ops, { active: 'ya' })).status).toBe(400);
    expect((await h.http('PUT', `/v1/members/${dewi}`, ops, { active: false })).status).toBe(200);
    expect((await lookup(term, '0812 3456 7890')).status).toBe(403);
    expect((await h.http('PUT', '/v1/members/tidak-ada', owner, { name: 'X' })).status).toBe(404);
    expect((await h.http('GET', '/v1/members', ownerB)).body).toEqual([]);
    expect((await h.http('PUT', `/v1/members/${dewi}`, ownerB, { name: 'Peretas' })).status).toBe(404);
    expect((await h.http('GET', '/v1/members', term)).status).toBe(403);
    await h.http('PUT', `/v1/members/${dewi}`, owner, { active: true });
  });

  it('pendaftaran dari terminal dibatasi per jam; dashboard tidak dibatasi', async () => {
    const mk = (i: number) => register(term2, `0877 0000 ${String(1000 + i)}`, `Tamu ${i}`);
    // term2 sudah mendaftarkan Eko (1)
    for (let i = 0; i < MAX_REGISTRATIONS_PER_DEVICE_PER_HOUR - 1; i++) expect((await mk(i)).status).toBe(201);
    expect((await mk(99)).status).toBe(429);
    expect((await register(owner, '0877 0000 5000', 'Dari dashboard')).status).toBe(201);
    expect((await register(term, '0877 0000 5001', 'Terminal lain')).status).toBe(201);
  });
});

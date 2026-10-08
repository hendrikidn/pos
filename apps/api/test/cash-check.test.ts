import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { CASH_VERIFY_RETRY_MS, verifyWindowStart } from '../src/cash-check';
import { createHarness, type Harness } from './harness';

const DAY = '2026-10-01';
const T = (hms: string) => Date.parse(`${DAY}T${hms}+07:00`);

describe('verifikasi kas oleh server (R14 dan R30)', () => {
  let h: Harness;
  let owner: string;
  let term: string;
  const sim = new Sim('o1', DAY, 'term-1', 'sensor-1');
  let posted = 0;
  const flush = async () => {
    const batch = sim.events.slice(posted);
    posted = sim.events.length;
    expect((await h.postEvents(term, batch)).status).toBe(201);
  };
  const hitsOf = async () => ((await h.http('GET', '/v1/outlets/o1/incidents', owner)).body as { hits: { rule: string; note: string }[] }[]).flatMap((i) => i.hits);
  const checks = async () => (await h.db.admin.query<{ seq: number; status: string; claimed: number; server_expected: number }>('select seq, status, claimed, server_expected from cash_check order by seq')).rows;

  /** Satu shift: modal 100.000, tunai 100.000 + QRIS 50.000, lalu hitung. `claimed` = expected yang dikirim terminal. */
  const shift = (id: string, start: string, counted: number, claimed: number, actor = 'budi') => {
    const t = (min: number) => T(start) + min * 60_000;
    sim.pos({ type: 'shift.opened', payload: { shiftId: id, openingCash: 100_000 } }, t(0), actor);
    sim.pos({ type: 'payment.received', payload: { orderId: `${id}-a`, method: 'CASH', amount: 100_000 } }, t(10), actor);
    sim.pos({ type: 'payment.received', payload: { orderId: `${id}-b`, method: 'QRIS', amount: 50_000, tid: '12345678' } }, t(11), actor);
    sim.pos({ type: 'cash.counted', payload: { shiftId: id, counted, expected: claimed } }, t(50), actor);
    sim.pos({ type: 'shift.closed', payload: { shiftId: id } }, t(51), actor);
  };

  beforeAll(async () => {
    h = await createHarness(T('09:00:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
  });
  afterAll(() => h.close());

  it('terminal jujur: kas yang dilaporkan sama dengan hitungan server → tercatat OK, tanpa R30', async () => {
    shift('S1', '00:00:00', 200_000, 200_000);
    await flush();
    h.setNow(T('02:00:00'));
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    expect(await checks()).toEqual([{ seq: 4, status: 'OK', claimed: 200_000, server_expected: 200_000 }]);
    expect((await hitsOf()).map((x) => x.rule)).not.toContain('R30');
  });

  it('verifikasi idempoten: evaluasi berulang tidak menggandakan catatan', async () => {
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    expect(await checks()).toHaveLength(1);
  });

  it('klien dimodifikasi: expected disamakan dengan hitungan fisik untuk menyembunyikan kekurangan 50.000 di 4 shift → R30 tiap shift dan R14 memakai angka server', async () => {
    // laci seharusnya 200.000 tetapi hanya ada 150.000; terminal melapor expected 150.000 (selisih palsu nol)
    for (const [i, hh] of ['03:00:00', '04:00:00', '05:00:00', '06:00:00'].entries()) shift(`H${i}`, hh, 150_000, 150_000);
    await flush();
    h.setNow(T('08:00:00'));
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    const rows = await checks();
    expect(rows.filter((r) => r.status === 'MISMATCH')).toHaveLength(4);
    expect(rows.filter((r) => r.status === 'MISMATCH')[0]).toMatchObject({ claimed: 150_000, server_expected: 200_000 });

    const hits = await hitsOf();
    const r30 = hits.filter((x) => x.rule === 'R30');
    expect(r30).toHaveLength(4);
    expect(r30[0]!.note).toMatch(/terminal melaporkan kas seharusnya Rp150\.000, hitungan server Rp200\.000/);
    // R14: tanpa verifikasi server selisih tampak nol (tidak pernah terpicu); dengan angka server ke-4 shift menyimpang 50.000
    expect(hits.some((x) => x.rule === 'R14')).toBe(true);
  });

  it('laporan owner memakai angka server dan menandai angka kiriman terminal yang berbeda', async () => {
    const r = await h.http('GET', `/v1/outlets/o1/reports/sales?from=${DAY}&to=${DAY}`, owner);
    expect(r.status).toBe(200);
    const shifts = r.body.cashCounts.shifts as { shiftId: string; expected: number; counted: number; diff: number; verified: boolean; claimed?: number }[];
    const honest = shifts.find((s) => s.shiftId === 'S1')!;
    const forged = shifts.find((s) => s.shiftId === 'H0')!;
    expect(honest).toMatchObject({ expected: 200_000, diff: 0, verified: true });
    expect(honest.claimed).toBeUndefined();
    expect(forged).toMatchObject({ expected: 200_000, counted: 150_000, diff: -50_000, verified: true, claimed: 150_000 });
  });

  it('rantai belum utuh (kiriman tertunda): tidak diverifikasi dan tidak ada R30 palsu; dipakai angka terminal sampai lengkap', async () => {
    const before = (await checks()).length;
    // shift dengan pembayaran tunai yang "hilang" di tengah rantai: kirim sebagian event saja
    const t = (min: number) => T('07:00:00') + min * 60_000;
    sim.pos({ type: 'shift.opened', payload: { shiftId: 'G1', openingCash: 100_000 } }, t(0), 'budi');
    sim.pos({ type: 'payment.received', payload: { orderId: 'g-a', method: 'CASH', amount: 100_000 } }, t(10), 'budi'); // ditahan dulu
    sim.pos({ type: 'cash.counted', payload: { shiftId: 'G1', counted: 200_000, expected: 200_000 } }, t(50), 'budi');
    const all = sim.events.slice(posted);
    posted = sim.events.length;
    const [opened, delayed, counted] = all;
    expect((await h.postEvents(term, [opened!, counted!])).status).toBe(201); // seq lompat: pembayaran tertunda
    h.setNow(T('09:00:00'));
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    expect((await checks()).length).toBe(before); // belum diverifikasi
    // pembayaran yang tertunda tiba: sekarang rantai utuh dan hasilnya OK
    expect((await h.postEvents(term, [delayed!])).status).toBe(201);
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    expect((await checks()).length).toBe(before + 1);
    expect((await checks()).at(-1)).toMatchObject({ status: 'OK', server_expected: 200_000 });
  });

  it('bobot R30: terminal dengan pelacakan kas (tracked) = 60; tanpa pelacakan (shift lintas pembaruan atau disembunyikan) = 20 dengan keterangan', async () => {
    const t = (min: number) => T('10:00:00') + min * 60_000;
    const forged = (id: string, start: number, tracked: boolean) => {
      sim.pos({ type: 'shift.opened', payload: { shiftId: id, openingCash: 100_000 } }, t(start), 'sari');
      sim.pos({ type: 'payment.received', payload: { orderId: `${id}-a`, method: 'CASH', amount: 100_000 } }, t(start + 5), 'sari');
      sim.pos({ type: 'cash.counted', payload: { shiftId: id, counted: 200_000, expected: 180_000, ...(tracked ? { tracked: true } : {}) } }, t(start + 20), 'sari');
    };
    forged('W1', 0, true);
    forged('W2', 60, false);
    await flush();
    h.setNow(T('13:00:00'));
    await h.http('POST', '/v1/outlets/o1/evaluate', owner);
    const all = (await h.http('GET', '/v1/outlets/o1/incidents', owner)).body as { hits: { rule: string; weight: number; note: string; key: string }[] }[];
    // dua shift ini satu-satunya yang melaporkan kas seharusnya Rp180.000
    const r30 = all.flatMap((i) => i.hits).filter((x) => x.rule === 'R30' && x.note.includes('seharusnya Rp180.000'));
    expect(r30).toHaveLength(2);
    const byTracked = (tracked: boolean) => r30.filter((x) => /tanpa pelacakan/.test(x.note) === !tracked);
    expect(byTracked(true).map((x) => x.weight)).toEqual([60]);
    expect(byTracked(false).map((x) => x.weight)).toEqual([20]);
    expect(byTracked(false)[0]!.note).toMatch(/melintasi pembaruan aplikasi/);
  });

  it('jendela verifikasi: tidak lebih lama dari masa coba-ulang 4 hari, sehingga hitungan yang selamanya tak terverifikasi tidak diperiksa terus', () => {
    const now = T('12:00:00');
    expect(verifyWindowStart(now - 30 * 86_400_000, now)).toBe(now - CASH_VERIFY_RETRY_MS);
    expect(verifyWindowStart(now - 1_000, now)).toBe(now - 1_000); // yang lebih baru dipakai apa adanya
  });
});


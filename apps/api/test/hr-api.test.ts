import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);

describe('absensi dan penggajian', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let manager: string;
  let ownerB: string;
  let term: string;
  let sim: Sim;

  const post = (path: string, tok: string | undefined, body?: unknown) => h.http('POST', path, tok, body ?? {});
  const put = (path: string, tok: string, body: unknown) => h.http('PUT', path, tok, body);
  const get = (path: string, tok = owner) => h.http('GET', path, tok);
  const clock = (day: string, hms: string, kind: 'IN' | 'OUT', actor: string) => sim.pos({ type: 'attendance.clocked', payload: { kind } }, WIB(`${day}T${hms}`), actor);
  const sync = async () => expect((await h.postEvents(term, sim.events)).status).toBe(201);

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-08T10:00:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    for (const [id, name, role, pin] of [['budi', 'Budi', 'CASHIER', '4827'], ['sari', 'Sari', 'CASHIER', '5930'], ['rina', 'Rina', 'MANAGER', '2468'], ['dewi', 'Dewi', 'CASHIER', '7351']]) {
      expect((await post('/v1/staff', owner, { id, name, role, pin })).status).toBe(201);
    }
    sim = new Sim('o1', '2026-10-05', 'term-1', 'sensor-1');
    // Budi: Sen 5 Okt 09.00–19.30 (10,5 jam), Sel 6 Okt 10.00–16.00 (6 jam). Sari: Sen 5 Okt 12.00–20.00 (8 jam); Rab 7 Okt masuk tanpa pulang.
    clock('2026-10-05', '09:00:00', 'IN', 'budi'); clock('2026-10-05', '19:30:00', 'OUT', 'budi');
    clock('2026-10-06', '10:00:00', 'IN', 'budi'); clock('2026-10-06', '16:00:00', 'OUT', 'budi');
    clock('2026-10-05', '12:00:00', 'IN', 'sari'); clock('2026-10-05', '20:00:00', 'OUT', 'sari');
    clock('2026-10-07', '09:00:00', 'IN', 'sari');
    clock('2026-10-06', '08:00:00', 'IN', 'dewi'); // Dewi lupa absen pulang dan tidak pernah dikoreksi
    await sync();
  });
  afterAll(() => h.close());

  it('ingest: absen harus IN atau OUT; layar dapur tidak boleh mengirim absen', async () => {
    const s = new Sim('o1', '2026-10-05', 'term-1', 'sensor-1');
    expect((await h.postEvents(term, [s.pos({ type: 'attendance.clocked', payload: { kind: 'MASUK' } } as never, '09:00:00', 'budi')])).status).toBe(400);
    const kds = await h.admin.createDevice('t1', 'o1', 'kds-1', 'kds');
    const k = new Sim('o1', '2026-10-05', 'kds-1', 'sensor-1');
    expect((await h.postEvents(kds, [k.emit('kds-1', { type: 'attendance.clocked', payload: { kind: 'IN' } }, '09:00:00', 'budi')])).status).toBe(400);
  });

  it('absensi: rentang kerja per staf, ringkasan hari dan menit, absen terbuka (usang) ditandai; hanya OWNER dan MANAGER', async () => {
    h.setNow(WIB('2026-10-07T20:00:00')); // sari masuk 11 jam lalu: masih wajar
    const r = await get('/v1/outlets/o1/hr/attendance?from=2026-10-05&to=2026-10-07', manager);
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x: { staffId: string; minutes: number }) => [x.staffId, x.minutes])).toEqual([['budi', 630], ['sari', 480], ['budi', 360]]);
    expect(r.body.summary).toEqual([{ staffId: 'budi', name: 'Budi', days: 2, minutes: 990 }, { staffId: 'sari', name: 'Sari', days: 1, minutes: 480 }]);
    expect(r.body.open.map((o: { staffId: string; stale: boolean }) => [o.staffId, o.stale]).sort()).toEqual([['dewi', true], ['sari', false]]);
    h.setNow(WIB('2026-10-08T10:00:00'));
    expect((await get('/v1/outlets/o1/hr/attendance?range=7d', owner)).body.open[0].stale).toBe(true); // 25 jam: lupa absen pulang
    expect((await get('/v1/outlets/o1/hr/attendance', ops)).status).toBe(403);
    expect((await get('/v1/outlets/o1/hr/attendance', term)).status).toBe(403);
    expect((await get('/v1/outlets/o1/hr/attendance', ownerB)).status).toBe(404);
  });

  it('koreksi manual untuk lupa absen pulang: alasan wajib, tidak tumpang tindih, tidak di masa depan, bisa dibatalkan', async () => {
    const add = (tok: string, body: unknown) => post('/v1/outlets/o1/hr/attendance', tok, body);
    const base = { staffId: 'sari', start: WIB('2026-10-07T09:00:00'), end: WIB('2026-10-07T17:00:00'), reason: 'Lupa absen pulang' };
    expect((await add(ops, base)).status).toBe(403);
    expect((await add(manager, { ...base, reason: 'x' })).status).toBe(400);
    expect((await add(manager, { ...base, end: base.start })).status).toBe(400);
    expect((await add(manager, { ...base, end: WIB('2026-10-09T10:00:00') })).status).toBe(400);
    expect((await add(manager, { ...base, end: base.start + 17 * 3_600_000 })).status).toBe(400);
    expect((await add(manager, { ...base, staffId: 'tidak-ada' })).status).toBe(404);
    expect((await add(manager, { ...base, start: WIB('2026-10-05T11:00:00'), end: WIB('2026-10-05T13:00:00') })).status).toBe(409); // menimpa rentang sari 5 Okt
    expect((await add(manager, { ...base, staffId: 'budi', start: WIB('2026-10-06T15:00:00'), end: WIB('2026-10-06T17:00:00') })).status).toBe(409);
    const ok = await add(manager, base);
    expect(ok.status).toBe(201);
    const r = (await get('/v1/outlets/o1/hr/attendance?from=2026-10-07&to=2026-10-07')).body;
    expect(r.rows).toEqual([expect.objectContaining({ staffId: 'sari', minutes: 480, manual: true })]);
    expect(r.manual).toEqual([expect.objectContaining({ id: ok.body.id, reason: 'Lupa absen pulang', createdBy: 'rina' })]);
    expect((await post(`/v1/outlets/o1/hr/attendance/${ok.body.id}/void`, manager, { reason: '' })).status).toBe(400);
    expect((await post(`/v1/outlets/o1/hr/attendance/${ok.body.id}/void`, manager, { reason: 'salah' })).status).toBe(201);
    expect((await post(`/v1/outlets/o1/hr/attendance/${ok.body.id}/void`, manager, { reason: 'salah' })).status).toBe(409);
    expect((await get('/v1/outlets/o1/hr/attendance?from=2026-10-07&to=2026-10-07')).body.rows).toEqual([]);
    expect((await add(manager, base)).status).toBe(201); // koreksi final untuk penggajian di bawah
    expect((await h.db.admin.query("select 1 from audit_log where action = 'attendance.adjust'")).rowCount).toBe(2);
  });

  it('tarif gaji: hanya OWNER; validasi jenis, tarif, dan pengali lembur', async () => {
    expect((await get('/v1/hr/pay', manager)).status).toBe(403);
    expect((await put('/v1/hr/pay/budi', manager, { payType: 'HOURLY', rate: 1 })).status).toBe(403);
    for (const bad of [{ payType: 'HARIAN', rate: 1 }, { payType: 'HOURLY', rate: -1 }, { payType: 'HOURLY', rate: 1.5 }, { payType: 'HOURLY', rate: 1, overtimeMultiplier: 5 }, { payType: 'HOURLY', rate: 1, overtimeMultiplier: 1.25 }]) {
      expect((await put('/v1/hr/pay/budi', owner, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await put('/v1/hr/pay/tidak-ada', owner, { payType: 'HOURLY', rate: 1 })).status).toBe(404);
    expect((await put('/v1/hr/pay/budi', owner, { payType: 'HOURLY', rate: 20_000, overtimeMultiplier: 1.5 })).status).toBe(200);
    expect((await put('/v1/hr/pay/sari', owner, { payType: 'MONTHLY', rate: 3_460_000 })).status).toBe(200);
    expect((await put('/v1/hr/pay/dewi', owner, { payType: 'HOURLY', rate: 15_000 })).status).toBe(200);
    const list = (await get('/v1/hr/pay')).body as { id: string; payType: string | null; rate: number | null; overtimeMultiplier: number | null }[];
    expect(list.find((s) => s.id === 'budi')).toMatchObject({ payType: 'HOURLY', rate: 20_000, overtimeMultiplier: 1.5 });
    expect(list.find((s) => s.id === 'sari')).toMatchObject({ payType: 'MONTHLY', rate: 3_460_000, overtimeMultiplier: 1.5 });
    expect(list.find((s) => s.id === 'rina')).toMatchObject({ payType: null, rate: null });
  });

  it('penggajian: hitung dari absensi (reguler, lembur, gaji tetap), peringatan absen terbuka, tidak boleh tumpang tindih', async () => {
    const create = (tok: string, body: unknown) => post('/v1/outlets/o1/payroll-runs', tok, body);
    expect((await create(manager, { from: '2026-10-05', to: '2026-10-07' })).status).toBe(403);
    expect((await create(owner, { from: '2026-10-05', to: '2026-10-09' })).status).toBe(400); // melewati hari ini
    expect((await create(owner, { from: '2026-10-05', to: '2026-10-07', dailyRegularHours: 0 })).status).toBe(400);
    const r = await create(owner, { from: '2026-10-05', to: '2026-10-07' });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe(1);
    expect(r.body.warnings).toEqual([expect.stringContaining('Dewi')]); // Sari sudah dikoreksi; Dewi belum
    const d = (await get('/v1/payroll-runs/1')).body;
    expect(d).toMatchObject({ status: 'DRAFT', from: '2026-10-05', to: '2026-10-07', dailyRegularMinutes: 480 });
    const budi = d.lines.find((l: { staffId: string }) => l.staffId === 'budi');
    // 5 Okt 10,5 jam (8 reguler + 2,5 lembur), 6 Okt 6 jam: reguler 14 jam × 20.000 = 280.000; lembur 2,5 × 20.000 × 1,5 = 75.000
    expect(budi).toMatchObject({ regularMinutes: 840, overtimeMinutes: 150, base: 280_000, overtimePay: 75_000, net: 355_000 });
    // Sari bulanan: gaji tetap + lembur 0 (8 jam di 5 Okt, 8 jam koreksi di 7 Okt)
    expect(d.lines.find((l: { staffId: string }) => l.staffId === 'sari')).toMatchObject({ base: 3_460_000, overtimeMinutes: 0, net: 3_460_000 });
    expect(d.lines.map((l: { staffId: string }) => l.staffId)).toEqual(['budi', 'sari']); // Rina tanpa tarif tidak ikut
    expect(d.total).toBe(355_000 + 3_460_000);
    expect((await create(owner, { from: '2026-10-07', to: '2026-10-08' })).status).toBe(409); // tumpang tindih dengan #1
  });

  it('slip diubah hanya saat draf: tunjangan dan potongan menghitung ulang gaji bersih; final mengunci', async () => {
    expect((await put('/v1/payroll-runs/1/lines/budi', manager, { allowance: 1 })).status).toBe(403);
    expect((await put('/v1/payroll-runs/1/lines/budi', owner, { allowance: -1 })).status).toBe(400);
    expect((await put('/v1/payroll-runs/1/lines/tidak-ada', owner, { allowance: 1 })).status).toBe(404);
    expect((await put('/v1/payroll-runs/1/lines/budi', owner, { allowance: 50_000, deduction: 30_000, note: 'Uang makan; kasbon' })).status).toBe(200);
    expect((await get('/v1/payroll-runs/1')).body.lines.find((l: { staffId: string }) => l.staffId === 'budi')).toMatchObject({ allowance: 50_000, deduction: 30_000, net: 375_000, note: 'Uang makan; kasbon' });
    expect((await post('/v1/payroll-runs/1/pay', owner, { date: '2026-10-08', method: 'TRANSFER' })).status).toBe(409); // belum final
    expect((await post('/v1/payroll-runs/1/finalize', manager)).status).toBe(403);
    expect((await post('/v1/payroll-runs/1/finalize', owner)).status).toBe(201);
    expect((await post('/v1/payroll-runs/1/finalize', owner)).status).toBe(409);
    expect((await put('/v1/payroll-runs/1/lines/budi', owner, { allowance: 1 })).status).toBe(409);
  });

  it('pembayaran: tanggal sah dan setelah periode berakhir, metode, sekali saja; jurnal gaji tercatat; CSV slip aman dan beraudit', async () => {
    const pay = (body: unknown) => post('/v1/payroll-runs/1/pay', owner, body);
    expect((await pay({ date: '2026-10-08', method: 'KARTU' })).status).toBe(400);
    expect((await pay({ date: '2026-10-06', method: 'TRANSFER' })).status).toBe(400); // sebelum periode berakhir
    expect((await pay({ date: '2026-10-09', method: 'TRANSFER' })).status).toBe(400); // masa depan
    const ok = await pay({ date: '2026-10-08', method: 'TRANSFER' });
    expect(ok.body).toEqual({ total: 375_000 + 3_460_000 });
    expect((await pay({ date: '2026-10-08', method: 'TRANSFER' })).status).toBe(409);
    expect((await post('/v1/payroll-runs/1/cancel', owner, { reason: 'salah hitung' })).status).toBe(409); // sudah dibayar
    const j = (await get('/v1/outlets/o1/accounting/journal?from=2026-10-08&to=2026-10-08')).body.entries.find((e: { ref: string }) => e.ref === 'JU-GAJI-1');
    expect(j.lines).toEqual([{ account: '6-1000', debit: 3_835_000, credit: 0 }, { account: '1-1300', debit: 0, credit: 3_835_000 }]);
    const csv = await h.raw('/v1/payroll-runs/1/export', owner);
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.headers.get('content-disposition')).toBe('attachment; filename="o1-gaji-2026-10-05_2026-10-07.csv"');
    expect(csv.text).toContain('Budi,Per jam,20000,14:00,2:30,280000,75000,50000,30000,375000');
    expect((await h.raw('/v1/payroll-runs/1/export', manager)).status).toBe(403);
    expect((await h.db.admin.query("select 1 from audit_log where action = 'export.payroll'")).rowCount).toBe(1);
  });

  it('pembatalan draf dan final dengan alasan; daftar penggajian; tenant lain tidak melihat', async () => {
    // periode tanpa jam kerja siapa pun: tidak ada yang dibayar, jadi ditolak
    expect((await post('/v1/outlets/o1/payroll-runs', owner, { from: '2026-10-01', to: '2026-10-04' })).status).toBe(400);
    expect((await post('/v1/outlets/o1/hr/attendance', owner, { staffId: 'budi', start: WIB('2026-10-08T08:00:00'), end: WIB('2026-10-08T09:30:00'), reason: 'uji pembatalan' })).status).toBe(201);
    const r = await post('/v1/outlets/o1/payroll-runs', owner, { from: '2026-10-08', to: '2026-10-08' });
    expect(r.status).toBe(201);
    expect((await post(`/v1/payroll-runs/${r.body.id}/cancel`, owner, { reason: '' })).status).toBe(400);
    expect((await post(`/v1/payroll-runs/${r.body.id}/cancel`, owner, { reason: 'dibuat ulang nanti' })).status).toBe(201);
    expect((await get('/v1/payroll-runs?outletId=o1')).body.map((x: { id: number; status: string }) => [x.id, x.status])).toEqual([[r.body.id, 'CANCELED'], [1, 'PAID']]);
    expect((await get('/v1/payroll-runs', ownerB)).body).toEqual([]);
    expect((await get('/v1/payroll-runs/1', ownerB)).status).toBe(404);
    expect((await post('/v1/payroll-runs/1/pay', ownerB, { date: '2026-10-08', method: 'TUNAI' })).status).toBe(404);
    expect((await get('/v1/payroll-runs', manager)).status).toBe(403);
  });

  it('gaji bulanan tidak dibayar dobel antar-outlet dan hanya untuk yang bekerja di outlet itu', async () => {
    await h.admin.createOutlet('t1', 'o2', 'Outlet 2', { capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    const manual = (outlet: string, staffId: string) => post(`/v1/outlets/${outlet}/hr/attendance`, owner, { staffId, start: WIB('2026-09-21T09:00:00'), end: WIB('2026-09-21T17:00:00'), reason: 'uji dobel' });
    expect((await manual('o2', 'sari')).status).toBe(201);
    expect((await manual('o1', 'sari')).status).toBe(201);
    expect((await manual('o1', 'budi')).status).toBe(201);
    const a = await post('/v1/outlets/o2/payroll-runs', owner, { from: '2026-09-21', to: '2026-09-21' });
    expect(a.status).toBe(201);
    expect((await get(`/v1/payroll-runs/${a.body.id}`)).body.lines.map((l: { staffId: string }) => l.staffId)).toEqual(['sari']); // Budi tidak bekerja di o2
    const b = await post('/v1/outlets/o1/payroll-runs', owner, { from: '2026-09-21', to: '2026-09-21' });
    expect(b.status).toBe(201);
    expect((await get(`/v1/payroll-runs/${b.body.id}`)).body.lines.map((l: { staffId: string }) => l.staffId)).toEqual(['budi']); // Sari sudah dibayar lewat o2
    expect(b.body.warnings).toEqual([expect.stringContaining('Sari')]);
    // dibatalkan: gaji bulanan boleh dimuat lagi di outlet lain
    expect((await post(`/v1/payroll-runs/${a.body.id}/cancel`, owner, { reason: 'salah outlet' })).status).toBe(201);
    expect((await post(`/v1/payroll-runs/${b.body.id}/cancel`, owner, { reason: 'ulang' })).status).toBe(201);
    const c = await post('/v1/outlets/o1/payroll-runs', owner, { from: '2026-09-21', to: '2026-09-21' });
    expect((await get(`/v1/payroll-runs/${c.body.id}`)).body.lines.map((l: { staffId: string }) => l.staffId)).toEqual(['budi', 'sari']);
  });

  it('R42 di insiden: transaksi oleh staf di luar jam absen; manager dikecualikan', async () => {
    sim.pos({ type: 'attendance.clocked', payload: { kind: 'IN' } }, WIB('2026-10-08T08:00:00'), 'budi');
    sim.cashOrder('ok-1', WIB('2026-10-08T08:30:00'), WIB('2026-10-08T08:31:00'), 20_000, 'budi');
    sim.cashOrder('luar-1', WIB('2026-10-08T05:00:00'), WIB('2026-10-08T05:01:00'), 20_000, 'sari'); // sari tidak absen
    sim.cashOrder('mgr-1', WIB('2026-10-08T05:10:00'), WIB('2026-10-08T05:11:00'), 20_000, 'rina'); // manager dikecualikan
    await sync();
    h.setNow(WIB('2026-10-08T12:00:00'));
    await post('/v1/outlets/o1/evaluate', owner);
    const hits = ((await get('/v1/outlets/o1/incidents')).body as { hits: { rule: string; actorIds: string[] }[] }[]).flatMap((i) => i.hits).filter((x) => x.rule === 'R42');
    expect(hits.map((x) => x.actorIds[0]).sort()).toEqual(['sari']);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const H = 3_600_000;

describe('reservasi dan uang muka', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let rina: string;
  let sinta: string;
  let ownerB: string;
  let term: string;
  let kds: string;
  let sim: Sim;

  const post = (path: string, tok: string | undefined, body?: unknown) => h.http('POST', path, tok, body ?? {});
  const put = (path: string, tok: string, body: unknown) => h.http('PUT', path, tok, body);
  const get = (path: string, tok = owner) => h.http('GET', path, tok);
  const book = async (tok: string, body: Record<string, unknown>) => post('/v1/outlets/o1/reservations', tok, { guestName: 'Tamu', partySize: 2, ...body });
  const sync = async () => expect((await h.postEvents(term, sim.events)).status).toBe(201);
  const find = async (id: number) => ((await get('/v1/outlets/o1/reservations?from=2026-10-08&to=2026-10-20')).body.reservations as { id: number; [k: string]: any }[]).find((r) => r.id === id)!;
  const r43 = async () => ((await get('/v1/outlets/o1/incidents')).body as { hits: { rule: string; note: string }[] }[]).flatMap((i) => i.hits).filter((x) => x.rule === 'R43');

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-08T10:00:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t1', 'o2', 'Outlet 2', { terminals: ['term-2'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    await h.db.admin.query("update outlet set tables = $1::jsonb where id = 'o1'", [JSON.stringify([{ no: '1', area: 'Indoor', seats: 4 }, { no: '2', area: 'Indoor', seats: 4 }, { no: '3', area: 'Teras', seats: 6 }])]);
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    rina = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    sinta = await h.admin.createApiToken('t1', 'sinta', 'MANAGER');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    kds = await h.admin.createDevice('t1', 'o1', 'kds-1', 'kds');
    sim = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
  });
  afterAll(() => h.close());

  it('membuat reservasi: isian divalidasi, hanya OWNER/MANAGER, tenant lain tidak bisa', async () => {
    const ok = { guestName: 'Ani', phone: '0812-3456-7890', partySize: 4, start: WIB('2026-10-08T19:00:00'), tableNo: '1' };
    expect((await book(ops, ok)).status).toBe(403);
    expect((await post('/v1/outlets/o1/reservations', ownerB, { ...ok })).status).toBe(404);
    expect((await book(rina, { ...ok, guestName: '  ' })).status).toBe(400);
    expect((await book(rina, { ...ok, partySize: 0 })).status).toBe(400);
    expect((await book(rina, { ...ok, partySize: 51 })).status).toBe(400);
    expect((await book(rina, { ...ok, partySize: 2.5 })).status).toBe(400);
    expect((await book(rina, { ...ok, start: WIB('2026-10-08T08:00:00') })).status).toBe(400); // sudah lewat
    expect((await book(rina, { ...ok, start: WIB('2027-06-01T19:00:00') })).status).toBe(400); // terlalu jauh
    expect((await book(rina, { ...ok, start: 'besok' })).status).toBe(400);
    expect((await book(rina, { ...ok, durationMin: 10 })).status).toBe(400);
    expect((await book(rina, { ...ok, phone: 'abc' })).status).toBe(400);
    expect((await book(rina, { ...ok, tableNo: '99' })).status).toBe(400); // tidak ada di denah
    const r = await book(rina, ok);
    expect(r.status).toBe(201);
    expect(r.body.id).toBe(1);
    expect(await find(1)).toMatchObject({ guestName: 'Ani', partySize: 4, tableNo: '1', status: 'BOOKED', durationMin: 90, deposit: 0, remaining: 0, createdBy: 'rina' });
    expect((await h.db.admin.query("select 1 from audit_log where action = 'reservation.create'")).rowCount).toBe(1);
  });

  it('meja tidak boleh dobel: bentrok 409, bersentuhan boleh, dibatalkan tidak menahan', async () => {
    expect((await book(rina, { start: WIB('2026-10-08T19:30:00'), tableNo: '1' })).status).toBe(409);
    expect((await book(rina, { start: WIB('2026-10-08T18:00:00'), durationMin: 90, tableNo: '1' })).status).toBe(409);
    const next = await book(rina, { guestName: 'Cici', start: WIB('2026-10-08T20:30:00'), tableNo: '1' }); // #1 selesai tepat 20.30
    expect(next.status).toBe(201);
    const other = await book(rina, { guestName: 'Dodi', start: WIB('2026-10-08T19:00:00'), tableNo: '2' });
    expect(other.status).toBe(201);
    expect((await put(`/v1/reservations/${next.body.id}`, rina, { guestName: 'Cici', partySize: 2, start: WIB('2026-10-08T20:00:00'), tableNo: '1' })).status).toBe(409);
    expect((await put(`/v1/reservations/${next.body.id}`, rina, { guestName: 'Cici', partySize: 3, start: WIB('2026-10-08T20:30:00'), tableNo: '1' })).status).toBe(200); // diri sendiri tidak bentrok
    expect((await find(next.body.id)).partySize).toBe(3);
    expect((await post(`/v1/reservations/${other.body.id}/cancel`, rina, {})).status).toBe(400); // alasan wajib
    expect((await post(`/v1/reservations/${other.body.id}/cancel`, rina, { reason: 'tamu batal' })).status).toBe(201);
    expect((await book(rina, { guestName: 'Eka', start: WIB('2026-10-08T19:15:00'), tableNo: '2' })).status).toBe(201); // meja 2 bebas lagi
    expect((await put(`/v1/reservations/${other.body.id}`, rina, { guestName: 'Dodi', partySize: 2, start: WIB('2026-10-08T21:00:00') })).status).toBe(409); // sudah dibatalkan
    expect((await get('/v1/outlets/o1/reservations?from=2026-10-08&to=2026-10-08', ops)).status).toBe(403);
  });

  it('daftar: rentang tanggal divalidasi dan dibatasi; hanya outlet itu', async () => {
    const l = await get('/v1/outlets/o1/reservations?from=2026-10-08&to=2026-10-08');
    expect(l.body.range).toEqual({ from: '2026-10-08', to: '2026-10-08' });
    expect(l.body.tables).toEqual(['1', '2', '3']);
    expect(l.body.reservations.map((r: { guestName: string }) => r.guestName)).toEqual(['Ani', 'Dodi', 'Eka', 'Cici']);
    expect((await get('/v1/outlets/o1/reservations?from=2026-13-01')).status).toBe(400);
    expect((await get('/v1/outlets/o1/reservations?from=2026-10-01&to=2027-03-01')).status).toBe(400); // > 93 hari
    expect((await get('/v1/outlets/o1/reservations?from=2026-10-09&to=2026-10-08')).status).toBe(400);
    expect((await get('/v1/outlets/o2/reservations?from=2026-10-08&to=2026-10-08')).body.reservations).toEqual([]);
    expect((await get('/v1/outlets/o1/reservations', ownerB)).status).toBe(404);
  });

  it('uang muka: nominal sah, sekali per reservasi, hanya saat dipesan', async () => {
    const dep = (id: number, body: unknown, tok = rina) => post(`/v1/reservations/${id}/deposit`, tok, body);
    expect((await dep(1, { amount: 0, method: 'CASH' })).status).toBe(400);
    expect((await dep(1, { amount: 1.5, method: 'CASH' })).status).toBe(400);
    expect((await dep(1, { amount: 60_000_000, method: 'CASH' })).status).toBe(400);
    expect((await dep(1, { amount: 200_000, method: 'KARTU' })).status).toBe(400);
    expect((await dep(1, { amount: 200_000, method: 'CASH' }, ops)).status).toBe(403);
    h.setNow(WIB('2026-10-08T10:30:00'));
    expect((await dep(1, { amount: 200_000, method: 'CASH' })).status).toBe(201);
    expect((await dep(1, { amount: 50_000, method: 'CASH' })).status).toBe(409);
    expect(await find(1)).toMatchObject({ deposit: 200_000, depositMethod: 'CASH', depositBy: 'rina', depositAt: WIB('2026-10-08T10:30:00'), applied: 0, remaining: 200_000 });
    expect((await dep(9999, { amount: 50_000, method: 'CASH' })).status).toBe(404);
  });

  it('mendudukkan tamu: terlalu awal ditolak; dari terminal hanya outlet sendiri; sekali saja', async () => {
    expect((await post('/v1/reservations/1/seat-device', term)).status).toBe(400); // 10.30, reservasi 19.00
    expect((await post('/v1/reservations/1/seat-device', kds)).status).toBe(403);
    expect((await post('/v1/reservations/1/seat', rina)).status).toBe(400);
    h.setNow(WIB('2026-10-08T17:30:00'));
    const t2 = await h.admin.createDevice('t1', 'o2', 'term-2', 'terminal');
    expect((await post('/v1/reservations/1/seat-device', t2)).status).toBe(404); // reservasi outlet lain
    const ok = await post('/v1/reservations/1/seat-device', term);
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ tableNo: '1', guestName: 'Ani' });
    expect((await post('/v1/reservations/1/seat-device', term)).status).toBe(409);
    expect((await post('/v1/reservations/1/cancel', rina, { reason: 'x' })).status).toBe(409);
    expect((await find(1)).status).toBe('SEATED');
    expect((await h.db.admin.query("select actor from audit_log where action = 'reservation.seat'")).rows).toEqual([{ actor: 'device:term-1' }]);
  });

  it('tidak datang: baru setelah 15 menit; pembatalan butuh alasan; keduanya sekali', async () => {
    const r = await book(rina, { guestName: 'Fani', start: WIB('2026-10-08T18:00:00'), tableNo: '3' });
    expect((await post(`/v1/reservations/${r.body.id}/no-show`, rina)).status).toBe(400);
    h.setNow(WIB('2026-10-08T18:20:00'));
    expect((await post(`/v1/reservations/${r.body.id}/no-show`, ops)).status).toBe(403);
    expect((await post(`/v1/reservations/${r.body.id}/no-show`, rina)).status).toBe(201);
    expect((await post(`/v1/reservations/${r.body.id}/no-show`, rina)).status).toBe(409);
    expect((await find(r.body.id)).status).toBe('NO_SHOW');
  });

  it('menyelesaikan uang muka: pemisahan tugas, jenis sesuai status, sekali saja, jurnal seimbang', async () => {
    // #5: uang muka oleh rina, tidak datang
    h.setNow(WIB('2026-10-08T17:40:00'));
    const r = await book(rina, { guestName: 'Gita', start: WIB('2026-10-08T17:50:00'), tableNo: '3' });
    const id = r.body.id as number;
    expect((await post(`/v1/reservations/${id}/deposit`, rina, { amount: 150_000, method: 'TRANSFER' })).status).toBe(201);
    const settle = (tok: string, body: unknown) => post(`/v1/reservations/${id}/settle`, tok, body);
    expect((await settle(rina, { kind: 'REFUND', reason: 'batal' })).status).toBe(409); // masih dipesan
    h.setNow(WIB('2026-10-08T18:10:00'));
    expect((await post(`/v1/reservations/${id}/no-show`, rina)).status).toBe(201);
    expect((await settle(rina, { kind: 'FORFEIT', reason: 'tidak datang' })).status).toBe(403); // mencatat sendiri
    expect((await settle(sinta, { kind: 'FORFEIT', reason: '' })).status).toBe(400);
    expect((await settle(sinta, { kind: 'HAPUS', reason: 'x' })).status).toBe(400);
    expect((await settle(ops, { kind: 'FORFEIT', reason: 'x' })).status).toBe(403);
    const done = await settle(sinta, { kind: 'FORFEIT', reason: 'tidak datang, kebijakan uang muka hangus' });
    expect(done.body).toEqual({ amount: 150_000 });
    expect((await settle(owner, { kind: 'REFUND', reason: 'ralat' })).status).toBe(409); // sudah diselesaikan
    expect((await find(id)).settle).toMatchObject({ kind: 'FORFEIT', amount: 150_000, by: 'sinta' });
    // FORFEIT hanya untuk tidak datang/dibatalkan; REFUND untuk yang duduk (sisa) pun boleh
    expect((await settle(owner, { kind: 'FORFEIT', reason: 'x' })).status).toBe(409);
    // jurnal
    const j = (await get('/v1/outlets/o1/accounting/journal?from=2026-10-08&to=2026-10-08')).body.entries as { ref: string; lines: unknown[] }[];
    expect(j.find((e) => e.ref === `JU-UM-${id}`)!.lines).toEqual([{ account: '1-1300', debit: 150_000, credit: 0 }, { account: '2-1300', debit: 0, credit: 150_000 }]);
    expect(j.find((e) => e.ref === `JU-UMX-${id}`)!.lines).toEqual([{ account: '2-1300', debit: 150_000, credit: 0 }, { account: '4-9100', debit: 0, credit: 150_000 }]);
    expect(j.find((e) => e.ref === 'JU-UM-1')!.lines[0]).toEqual({ account: '1-1100', debit: 200_000, credit: 0 }); // #1 tunai
  });

  it('owner boleh menyelesaikan uang muka yang ia catat sendiri', async () => {
    h.setNow(WIB('2026-10-08T18:30:00'));
    const r = await book(owner, { guestName: 'Hadi', start: WIB('2026-10-08T21:30:00'), tableNo: '3' });
    expect((await post(`/v1/reservations/${r.body.id}/deposit`, owner, { amount: 100_000, method: 'CASH' })).status).toBe(201);
    expect((await post(`/v1/reservations/${r.body.id}/cancel`, owner, { reason: 'sakit' })).status).toBe(201);
    expect((await post(`/v1/reservations/${r.body.id}/settle`, owner, { kind: 'REFUND', reason: 'dikembalikan tunai' })).status).toBe(201);
  });

  it('ingest uang muka: wajib reservationId, hanya untuk metode DEPOSIT, tidak bisa diganti atau di-refund dengan metode ini', async () => {
    const s = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
    const bad = async (body: unknown) => expect((await h.postEvents(term, [s.pos(body as never, WIB('2026-10-08T19:00:00'), 'budi')])).status).toBe(400);
    await bad({ type: 'payment.received', payload: { orderId: 'x', method: 'DEPOSIT', amount: 1000 } });
    await bad({ type: 'payment.received', payload: { orderId: 'x', method: 'DEPOSIT', amount: 1000, reservationId: 1.5 } });
    await bad({ type: 'payment.received', payload: { orderId: 'x', method: 'CASH', amount: 1000, reservationId: 1 } });
    await bad({ type: 'payment.method_changed', payload: { orderId: 'x', from: 'CASH', to: 'DEPOSIT' } });
    await bad({ type: 'refund.created', payload: { refundId: 'x-R1', originalOrderId: 'x', amount: 1000, method: 'DEPOSIT', approverId: 'rina' } });
  });

  it('R43: uang muka dipakai melebihi jumlahnya, reservasi tidak ada, atau sesudah dikembalikan', async () => {
    h.setNow(WIB('2026-10-08T19:30:00'));
    // #1 (Ani) uang muka 200.000: 120.000 sah, lalu 120.000 lagi melebihi; reservasi 999 tidak ada
    sim.cashOrder('a1', WIB('2026-10-08T19:05:00'), WIB('2026-10-08T19:06:00'), 120_000, 'budi');
    sim.pos({ type: 'payment.received', payload: { orderId: 'dp-1', method: 'DEPOSIT', amount: 120_000, reservationId: 1 } }, WIB('2026-10-08T19:10:00'), 'budi');
    sim.pos({ type: 'payment.received', payload: { orderId: 'dp-2', method: 'DEPOSIT', amount: 120_000, reservationId: 1 } }, WIB('2026-10-08T19:20:00'), 'budi');
    sim.pos({ type: 'payment.received', payload: { orderId: 'dp-3', method: 'DEPOSIT', amount: 30_000, reservationId: 999 } }, WIB('2026-10-08T19:25:00'), 'budi');
    await sync();
    await post('/v1/outlets/o1/evaluate', owner);
    const hits = await r43();
    expect(hits).toHaveLength(2);
    expect(hits.some((x) => x.note.includes('melebihi uang muka'))).toBe(true);
    expect(hits.some((x) => x.note.includes('#999 tidak ada'))).toBe(true);
    expect((await find(1)).applied).toBe(240_000);
    expect((await find(1)).remaining).toBe(0);
    // papan terminal: uang muka #1 habis, jadi tidak lagi ditawarkan sebagai sisa
    const board = (await get('/v1/reservations/board', term)).body;
    expect(board.reservations.find((r: { id: number }) => r.id === 1)).toMatchObject({ status: 'SEATED', depositRemaining: 0 });
  });

  it('R43: pembayaran sesudah uang muka dikembalikan', async () => {
    h.setNow(WIB('2026-10-08T20:00:00'));
    const r = await book(rina, { guestName: 'Indra', start: WIB('2026-10-08T21:00:00'), tableNo: '2' });
    const id = r.body.id as number;
    expect((await post(`/v1/reservations/${id}/deposit`, rina, { amount: 80_000, method: 'CASH' })).status).toBe(201);
    expect((await post(`/v1/reservations/${id}/cancel`, rina, { reason: 'batal' })).status).toBe(201);
    expect((await post(`/v1/reservations/${id}/settle`, sinta, { kind: 'REFUND', reason: 'dikembalikan' })).status).toBe(201);
    h.setNow(WIB('2026-10-08T21:10:00'));
    sim.pos({ type: 'payment.received', payload: { orderId: 'dp-9', method: 'DEPOSIT', amount: 80_000, reservationId: id } }, WIB('2026-10-08T21:05:00'), 'budi');
    await sync();
    await post('/v1/outlets/o1/evaluate', owner);
    expect((await r43()).filter((x) => x.note.includes('dikembalikan'))).toHaveLength(1);
  });

  it('R44: uang muka menggantung lebih dari 24 jam setelah reservasi selesai; yang sudah diselesaikan tidak', async () => {
    h.setNow(WIB('2026-10-08T21:30:00'));
    const r = await book(rina, { guestName: 'Joko', start: WIB('2026-10-08T22:00:00'), tableNo: '3' });
    const id = r.body.id as number;
    expect((await post(`/v1/reservations/${id}/deposit`, rina, { amount: 90_000, method: 'CASH' })).status).toBe(201);
    h.setNow(WIB('2026-10-09T20:00:00')); // belum 24 jam setelah selesai (23.30)
    await post('/v1/outlets/o1/evaluate', owner);
    const r44 = async () => ((await get('/v1/outlets/o1/incidents')).body as { hits: { rule: string; note: string }[] }[]).flatMap((i) => i.hits).filter((x) => x.rule === 'R44');
    expect((await r44()).filter((x) => x.note.includes(`#${id}`))).toHaveLength(0);
    h.setNow(WIB('2026-10-09T23:45:00'));
    await post('/v1/outlets/o1/evaluate', owner);
    expect((await r44()).filter((x) => x.note.includes(`#${id}`))).toHaveLength(1);
    // #1 (Ani): uang mukanya habis dipakai, tidak menggantung; #6 dst diselesaikan
    expect((await r44()).some((x) => x.note.includes('#1 '))).toBe(false);
  });

  it('papan terminal: hanya terminal, tanpa nomor telepon, hanya reservasi outlet itu', async () => {
    h.setNow(WIB('2026-10-08T18:45:00'));
    expect((await get('/v1/reservations/board', kds)).status).toBe(403);
    expect((await get('/v1/reservations/board', rina)).status).toBe(403); // token pengguna bukan terminal
    const b = (await get('/v1/reservations/board', term)).body;
    expect(b.at).toBe(WIB('2026-10-08T18:45:00'));
    for (const r of b.reservations) {
      expect(Object.keys(r).sort()).toEqual(['depositRemaining', 'durationMin', 'guestName', 'id', 'partySize', 'start', 'status', 'tableNo']);
      expect(['BOOKED', 'SEATED']).toContain(r.status);
    }
    expect(b.reservations.some((r: { guestName: string }) => r.guestName === 'Dodi')).toBe(false); // dibatalkan
  });
});

import { describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { checkCall, estimateWaitMin, labelOf, queueHits, SEAT_LINK_GRACE_MS, SEAT_UNPAID_AFTER_MS, type QueueTicketFacts } from '../src/queue';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const T = WIB('2026-10-08T19:00:00');
const tk = (id: number, partySize: number, status: QueueTicketFacts['status'] = 'WAITING'): QueueTicketFacts => ({ id, seq: id, partySize, status, createdAtMs: T });

describe('antrian: nomor dan urutan panggilan (murni)', () => {
  it('nomor tiket A001..A999 lalu B001; perkiraan tunggu 4 menit per rombongan di depan', () => {
    expect([1, 12, 999, 1000, 1998, 1999].map(labelOf)).toEqual(['A001', 'A012', 'A999', 'B001', 'B999', 'C001']);
    expect([0, 1, 5].map(estimateWaitMin)).toEqual([0, 4, 20]);
    expect(estimateWaitMin(-3)).toBe(0);
  });

  it('memanggil yang paling lama menunggu selalu boleh, tanpa alasan', () => {
    const w = [tk(1, 2), tk(2, 4), tk(3, 2)];
    expect(checkCall(w, w[0]!, undefined, undefined)).toEqual({ ok: true, skipped: [] });
    expect(checkCall([tk(5, 3, 'CALLED'), tk(6, 2)], tk(6, 2), undefined, undefined)).toEqual({ ok: true, skipped: [] }); // yang sudah dipanggil bukan "di depan"
  });

  it('melewati antrian wajib beralasan; "meja cocok" hanya bila semua yang dilewati lebih besar', () => {
    const w = [tk(1, 6), tk(2, 5), tk(3, 2)];
    expect(checkCall(w, w[2]!, undefined, undefined)).toMatchObject({ ok: false, message: expect.stringContaining('2 tiket') });
    expect(checkCall(w, w[2]!, 'MAMPIR', undefined)).toMatchObject({ ok: false });
    expect(checkCall(w, w[2]!, 'TABLE_SIZE', undefined)).toEqual({ ok: true, skipped: [1, 2] }); // 6 dan 5 orang menunggu meja besar
    const mixed = [tk(1, 2), tk(2, 6), tk(3, 2)];
    expect(checkCall(mixed, mixed[2]!, 'TABLE_SIZE', undefined)).toMatchObject({ ok: false, message: expect.stringContaining('lebih besar') }); // tiket 1 sama besar: tidak sah
    expect(checkCall(mixed, mixed[2]!, 'PRIORITY', undefined)).toMatchObject({ ok: false, message: expect.stringContaining('jelaskan') });
    expect(checkCall(mixed, mixed[2]!, 'PRIORITY', 'x')).toMatchObject({ ok: false });
    expect(checkCall(mixed, mixed[2]!, 'PRIORITY', 'ibu hamil, kursi roda')).toEqual({ ok: true, skipped: [1, 2] });
    expect(checkCall(mixed, mixed[2]!, 'OTHER', 'teman pemilik')).toEqual({ ok: true, skipped: [1, 2] });
  });
});

describe('antrian: temuan R48-R49 (murni)', () => {
  const jump = (id: number, reason: string, note: string | null = null) => ({ id, label: labelOf(id), reason, note, skippedLabels: ['A001'], at: T, actor: 'budi' });
  const seated = (id: number, at = T) => ({ id, label: labelOf(id), seatedAtMs: at, seatedBy: 'budi' });
  const run = (build: (s: Sim) => void, jumps = [] as ReturnType<typeof jump>[], seatedRows = [seated(1)], now = T + 4 * 3_600_000) => {
    const s = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
    build(s);
    return queueHits(jumps, seatedRows, new Set(seatedRows.map((x) => x.id)), s.events, now, 0);
  };
  const link = (s: Sim, order: string, ticket: number, at: number) => {
    s.pos({ type: 'order.created', payload: { orderId: order, orderType: 'DINE_IN', tableNo: '4' } }, at, 'budi');
    s.pos({ type: 'order.queue_linked', payload: { orderId: order, ticketId: ticket } }, at + 1000, 'budi');
  };
  const pay = (s: Sim, order: string, at: number) => s.pos({ type: 'payment.received', payload: { orderId: order, method: 'CASH', amount: 50_000 } }, at, 'budi');
  const rules = (h: { rule: string }[]) => h.map((x) => x.rule).sort();

  it('R48: melewati antrian selain karena meja cocok; alasan dan catatan ikut dalam temuan', () => {
    const h = run(() => undefined, [jump(2, 'TABLE_SIZE'), jump(3, 'PRIORITY', 'lansia'), jump(4, 'OTHER', 'kenalan')], []);
    expect(rules(h)).toEqual(['R48', 'R48']);
    expect(h[0]!.note).toContain('prioritas');
    expect(h[0]!.note).toContain('lansia');
    expect(h.some((x) => x.note.includes('A004'))).toBe(true);
  });

  it('R49: didudukkan tetapi order tidak pernah dibuat (setelah 15 menit)', () => {
    expect(run(() => undefined, [], [seated(1)], T + SEAT_LINK_GRACE_MS - 1)).toEqual([]);
    expect(rules(run(() => undefined, [], [seated(1)], T + SEAT_LINK_GRACE_MS))).toEqual(['R49']);
  });

  it('R49: order tertaut dan dibayar tidak menimbulkan temuan; belum dibayar 3 jam; di-void', () => {
    expect(run((s) => { link(s, 'a', 1, T + 60_000); pay(s, 'a', T + 3_600_000); })).toEqual([]);
    expect(run((s) => link(s, 'a', 1, T + 60_000), [], [seated(1)], T + SEAT_UNPAID_AFTER_MS - 1)).toEqual([]);
    expect(rules(run((s) => link(s, 'a', 1, T + 60_000), [], [seated(1)], T + SEAT_UNPAID_AFTER_MS))).toEqual(['R49']);
    expect(rules(run((s) => { link(s, 'a', 1, T + 60_000); s.pos({ type: 'void.approved', payload: { orderId: 'a', reasonCode: 'SALAH', approverIds: ['rina'], amount: 0 } } as never, T + 120_000, 'budi'); }))).toEqual(['R49']);
  });

  it('R49: tautan ke tiket yang tidak ada/belum didudukkan; satu tiket ke dua order', () => {
    const ghost = run((s) => link(s, 'x', 77, T), [], []);
    expect(ghost[0]).toMatchObject({ rule: 'R49', note: expect.stringContaining('#77') });
    const dup = run((s) => { link(s, 'a', 1, T + 60_000); link(s, 'b', 1, T + 120_000); pay(s, 'a', T + 200_000); pay(s, 'b', T + 210_000); });
    expect(rules(dup)).toEqual(['R49']);
    expect(dup[0]!.note).toContain('2 order');
  });

  it('R49: order digabung ke order lain atau dipecah bayar tidak dianggap belum dibayar', () => {
    const moved = (s: Sim, kind: 'MERGE' | 'SPLIT', from: string, to: string, at: number) =>
      s.pos({ type: 'order.items_moved', payload: { fromOrderId: from, toOrderId: to, kind, items: [], sent: [] } } as never, at, 'budi');
    expect(run((s) => { link(s, 'a', 1, T + 60_000); s.pos({ type: 'order.created', payload: { orderId: 'b', orderType: 'DINE_IN', tableNo: '4' } }, T + 70_000, 'budi'); moved(s, 'MERGE', 'a', 'b', T + 120_000); pay(s, 'b', T + 200_000); })).toEqual([]);
    expect(run((s) => { link(s, 'a', 1, T + 60_000); s.pos({ type: 'order.created', payload: { orderId: 'a-S1', orderType: 'DINE_IN', tableNo: '4' } }, T + 70_000, 'budi'); moved(s, 'SPLIT', 'a', 'a-S1', T + 120_000); pay(s, 'a-S1', T + 200_000); })).toEqual([]); // hanya pecahannya yang dibayar
  });

  it('temuan lama sebelum jendela tidak dikeluarkan', () => {
    const hits = queueHits([jump(2, 'OTHER', 'kenalan')], [], new Set(), [], T + 1000, T + 500);
    expect(hits).toEqual([]);
  });
});

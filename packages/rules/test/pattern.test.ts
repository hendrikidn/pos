import { describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { buildIncidents, evaluatePatternRules } from '../src';

const DAY = 24 * 3_600_000;

/** Tutup shift pada `daysAgo` hari sebelum 2026-10-08 21:00 WIB dengan selisih kas (counted − expected) tertentu. */
function close(s: Sim, daysAgo: number, diff: number, actor = 'budi', deviceId = s.terminalId) {
  s.emit(
    deviceId,
    { type: 'cash.counted', payload: { shiftId: `S${daysAgo}-${actor}`, counted: 500_000 + diff, expected: 500_000 } },
    Date.parse('2026-10-08T21:00:00+07:00') - daysAgo * DAY,
    actor,
  );
}
const NOW = Date.parse('2026-10-08T22:00:00+07:00');
const run = (s: Sim, emitFrom = NOW - 72 * 3_600_000) => evaluatePatternRules({ events: s.events, emitFrom });

describe('R14: selisih kas berulang', () => {
  it('tiga shift menyimpang dalam 7 hari belum cukup; yang keempat memicu', () => {
    const s = new Sim();
    close(s, 6, -10_000);
    close(s, 4, -8_000);
    close(s, 2, 20_000);
    expect(run(s, 0)).toEqual([]);
    close(s, 0, -6_000);
    const hits = run(s, 0);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ rule: 'R14', weight: 20, modalities: ['POS'], actorIds: ['budi'], orderId: null, context: false });
    expect(hits[0]!.note).toBe('4 shift dalam 7 hari dengan selisih kas di luar Rp5.000; terakhir kurang Rp6.000');
  });

  it('selisih dalam toleransi (≤ Rp5.000) tidak dihitung, termasuk tepat Rp5.000', () => {
    const s = new Sim();
    close(s, 5, -5_000);
    close(s, 4, 5_000);
    close(s, 3, -1_000);
    close(s, 2, 0);
    close(s, 1, 4_999);
    close(s, 0, -5_000);
    expect(run(s, 0)).toEqual([]);
  });

  it('lebih (surplus) juga dihitung sebagai selisih', () => {
    const s = new Sim();
    for (const d of [3, 2, 1, 0]) close(s, d, 12_000);
    const [hit] = run(s, 0);
    expect(hit!.note).toContain('terakhir lebih Rp12.000');
  });

  it('shift lebih tua dari 7 hari tidak ikut hitungan', () => {
    const s = new Sim();
    close(s, 9, -20_000);
    close(s, 8, -20_000);
    close(s, 2, -20_000);
    close(s, 1, -20_000);
    close(s, 0, -20_000);
    // jendela hari ke-0: hanya hari 2, 1, 0 (3 shift); hari 8 dan 9 di luar 7 hari
    expect(run(s, 0)).toEqual([]);
  });

  it('dihitung per kasir, tidak dicampur antar kasir', () => {
    const s = new Sim();
    close(s, 3, -10_000, 'budi');
    close(s, 2, -10_000, 'sari');
    close(s, 1, -10_000, 'budi');
    close(s, 0, -10_000, 'sari');
    expect(run(s, 0)).toEqual([]);
    close(s, 0, -10_000, 'budi');
    close(s, 0, -10_000, 'budi');
    const hits = run(s, 0);
    expect(hits.map((h) => h.actorIds[0])).toEqual(['budi']);
  });

  it('shift kelima dan seterusnya memicu hit sendiri; kuncinya stabil antar evaluasi', () => {
    const s = new Sim();
    for (const d of [4, 3, 2, 1, 0]) close(s, d, -9_000);
    const hits = run(s, 0);
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.key)).size).toBe(2);
    expect(run(s, 0).map((h) => h.key)).toEqual(hits.map((h) => h.key));
  });

  it('hanya melaporkan hit di jendela emitFrom, walau hitungannya memakai riwayat lebih lama', () => {
    const s = new Sim();
    for (const d of [6, 5, 4, 3]) close(s, d, -9_000); // hit ke-4 terjadi 3 hari lalu
    close(s, 0, -9_000);
    const all = run(s, 0);
    expect(all).toHaveLength(2);
    // jendela 72 jam (batas pas di hari ke-3 tidak termasuk): hanya hit hari ini yang dilaporkan,
    // tetapi tetap dihitung dari riwayat 7 hari
    const recent = run(s, NOW - 2 * DAY);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.at).toBe(Date.parse('2026-10-08T21:00:00+07:00'));
    expect(recent[0]!.note).toMatch(/^5 shift/);
  });

  it('parameter bisa diatur (toleransi dan jumlah shift)', () => {
    const s = new Sim();
    close(s, 1, -3_000);
    close(s, 0, -3_000);
    expect(run(s, 0)).toEqual([]);
    const hits = evaluatePatternRules({ events: s.events, emitFrom: 0, config: { r14ToleranceAmount: 1_000, r14MaxShifts: 1 } });
    expect(hits).toHaveLength(1);
  });

  it('event tanpa pelaku dan tipe lain diabaikan', () => {
    const s = new Sim();
    for (const d of [3, 2, 1, 0]) {
      s.emit(s.terminalId, { type: 'cash.counted', payload: { shiftId: `x${d}`, counted: 0, expected: 100_000 } }, Date.parse('2026-10-08T21:00:00+07:00') - d * DAY, undefined);
    }
    s.pos({ type: 'shift.closed', payload: { shiftId: 'x0' } }, '21:00:00');
    expect(run(s, 0)).toEqual([]);
  });

  it('hit tidak membentang di jendela 7 hari, jadi tidak menyedot hit lain di terminal yang sama', () => {
    const s = new Sim();
    for (const d of [5, 3, 1, 0]) close(s, d, -9_000);
    const hits = run(s, 0);
    expect(hits[0]!.windowStart).toBe(hits[0]!.windowEnd);
    const [inc] = buildIncidents(hits);
    expect(inc).toMatchObject({ score: 20, level: 'LOW', orderIds: [], actorIds: ['budi'] });
    expect(inc!.endAt - inc!.startAt).toBe(0);
  });
});

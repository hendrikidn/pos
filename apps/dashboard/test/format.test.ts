import { describe, expect, it } from 'vitest';
import { ago, cctvInfo, wibClock, wibDate, wibDateTime, wibRange } from '../src/lib/format';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);

describe('waktu WIB', () => {
  it('memformat jam, tanggal, dan gabungan', () => {
    const t = WIB('2026-10-01T13:14:02');
    expect(wibClock(t)).toBe('13:14');
    expect(wibClock(t, true)).toBe('13:14:02');
    expect(wibDate(t)).toBe('01 Okt 2026');
    expect(wibDateTime(t)).toBe('01 Okt 2026, 13:14 WIB');
  });

  it('menangani pergantian hari di zona WIB (UTC masih hari sebelumnya)', () => {
    expect(wibDate(WIB('2026-10-02T01:00:00'))).toBe('02 Okt 2026');
    expect(wibClock(WIB('2026-10-02T01:00:00'))).toBe('01:00');
  });

  it('rentang di hari yang sama menampilkan tanggal sekali', () => {
    expect(wibRange(WIB('2026-10-01T13:14:02'), WIB('2026-10-01T13:18:45'))).toBe('01 Okt 2026, 13:14–13:18 WIB');
  });

  it('rentang lintas hari menampilkan kedua tanggal', () => {
    expect(wibRange(WIB('2026-10-01T23:58:00'), WIB('2026-10-02T00:03:00'))).toBe(
      '01 Okt 2026, 23:58 WIB – 02 Okt 2026, 00:03 WIB',
    );
  });
});

describe('ago', () => {
  const now = WIB('2026-10-02T12:00:00');
  it.each([
    [30_000, 'baru saja'],
    [5 * 60_000, '5 mnt lalu'],
    [3 * 3_600_000, '3 jam lalu'],
    [2 * 86_400_000, '2 hari lalu'],
  ])('%i ms → %s', (diff, expected) => {
    expect(ago(now - diff, now)).toBe(expected);
  });
});

describe('cctvInfo', () => {
  const start = WIB('2026-10-01T13:14:02');
  const end = WIB('2026-10-01T13:18:45');

  it('jendela = dua menit sebelum dan sesudah kejadian', () => {
    const c = cctvInfo(start, end, 7, 0, WIB('2026-10-02T09:00:00'));
    expect(wibClock(c.fromMs, true)).toBe('13:12:02');
    expect(wibClock(c.toMs, true)).toBe('13:20:45');
  });

  it('selisih jam NVR menggeser jendela (jam NVR lebih cepat 90 detik)', () => {
    const c = cctvInfo(start, end, 7, 90, WIB('2026-10-02T09:00:00'));
    expect(wibClock(c.fromMs, true)).toBe('13:13:32');
  });

  it('retensi 7 hari: kejadian 1 Okt 13:14, dicek 2 Okt 09:00 → batas 8 Okt 13:14, sisa 6 hari penuh', () => {
    const c = cctvInfo(start, end, 7, 0, WIB('2026-10-02T09:00:00'));
    expect(c).toMatchObject({ daysLeft: 6, status: 'OK' });
    expect(wibDateTime(c.retainedUntilMs)).toBe('08 Okt 2026, 13:14 WIB');
  });

  it('mendesak bila sisa kurang dari dua hari', () => {
    const c = cctvInfo(start, end, 7, 0, WIB('2026-10-07T00:00:00'));
    expect(c).toMatchObject({ daysLeft: 1, status: 'URGENT' });
  });

  it('kedaluwarsa setelah batas retensi', () => {
    const c = cctvInfo(start, end, 7, 0, WIB('2026-10-09T00:00:00'));
    expect(c).toMatchObject({ status: 'EXPIRED' });
    expect(c.daysLeft).toBeLessThan(0);
  });

  it('retensi yang lebih panjang memberi sisa lebih banyak', () => {
    expect(cctvInfo(start, end, 14, 0, WIB('2026-10-02T09:00:00')).daysLeft).toBe(13);
  });
});

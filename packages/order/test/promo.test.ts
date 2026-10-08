import { describe, expect, it } from 'vitest';
import { checkPromo, promoApplicable, promoDiscount, type Promo } from '../src';

const base: Promo = { id: 'hemat10', name: 'Hemat 10%', kind: 'PERCENT', value: 10 };
const WIB = 420;
const at = (iso: string) => Date.parse(`${iso}+07:00`);

describe('promoDiscount', () => {
  it('persen dibulatkan ke rupiah dan dibatasi maxDiscount; potongan tetap tidak melebihi subtotal', () => {
    expect(promoDiscount(base, 74_000)).toBe(7_400);
    expect(promoDiscount(base, 12_345)).toBe(1_235); // 1.234,5 dibulatkan
    expect(promoDiscount({ ...base, maxDiscount: 5_000 }, 74_000)).toBe(5_000);
    expect(promoDiscount({ ...base, maxDiscount: 5_000 }, 20_000)).toBe(2_000);
    expect(promoDiscount({ ...base, kind: 'AMOUNT', value: 15_000 }, 74_000)).toBe(15_000);
    expect(promoDiscount({ ...base, kind: 'AMOUNT', value: 15_000 }, 9_000)).toBe(9_000);
    expect(promoDiscount({ ...base, value: 100 }, 50_000)).toBe(50_000);
    expect(promoDiscount(base, 0)).toBe(0);
  });
});

describe('promoApplicable', () => {
  const ok = (p: Promo, iso: string, subtotal = 100_000) => promoApplicable(p, { nowMs: at(iso), utcOffsetMinutes: WIB, subtotal });

  it('tanpa batasan selalu berlaku', () => {
    expect(ok(base, '2026-10-08T10:00:00')).toEqual({ ok: true });
  });

  it('tanggal inklusif menurut tanggal LOKAL outlet, bukan UTC', () => {
    const p = { ...base, startDate: '2026-10-08', endDate: '2026-10-09' };
    expect(ok(p, '2026-10-07T23:59:00')).toMatchObject({ ok: false, code: 'PROMO_SCHEDULE' });
    expect(ok(p, '2026-10-08T00:30:00')).toEqual({ ok: true }); // 17.30 UTC tanggal 7, tetapi 8 Okt di WIB
    expect(ok(p, '2026-10-09T23:59:00')).toEqual({ ok: true });
    expect(ok(p, '2026-10-10T00:00:00')).toMatchObject({ ok: false, code: 'PROMO_SCHEDULE' });
  });

  it('hari dalam pekan menurut zona outlet (8 Okt 2026 = Kamis)', () => {
    const weekend = { ...base, days: [0, 6] };
    expect(ok(weekend, '2026-10-08T10:00:00')).toMatchObject({ ok: false, code: 'PROMO_SCHEDULE' });
    expect(ok(weekend, '2026-10-10T10:00:00')).toEqual({ ok: true }); // Sabtu
    expect(ok({ ...base, days: [4] }, '2026-10-08T00:10:00')).toEqual({ ok: true }); // Kamis dini hari WIB
  });

  it('jam [mulai, akhir): batas akhir tidak termasuk', () => {
    const happy = { ...base, startHour: 14, endHour: 17 };
    expect(ok(happy, '2026-10-08T13:59:00')).toMatchObject({ ok: false });
    expect(ok(happy, '2026-10-08T14:00:00')).toEqual({ ok: true });
    expect(ok(happy, '2026-10-08T16:59:59')).toEqual({ ok: true });
    expect(ok(happy, '2026-10-08T17:00:00')).toMatchObject({ ok: false, message: expect.stringContaining('14.00–17.00') });
  });

  it('minimal belanja', () => {
    const p = { ...base, minSubtotal: 50_000 };
    expect(ok(p, '2026-10-08T10:00:00', 49_999)).toMatchObject({ ok: false, code: 'PROMO_MIN' });
    expect(ok(p, '2026-10-08T10:00:00', 50_000)).toEqual({ ok: true });
  });
});

describe('checkPromo', () => {
  it('menerima promo yang sah', () => {
    expect(checkPromo(base)).toBeNull();
    expect(checkPromo({ id: 'hh', name: 'Happy hour', kind: 'PERCENT', value: 20, maxDiscount: 15_000, days: [1, 2, 3], startDate: '2026-10-01', endDate: '2026-12-31', startHour: 14, endHour: 17, minSubtotal: 30_000 })).toBeNull();
    expect(checkPromo({ id: 'p15', name: 'Potong 15rb', kind: 'AMOUNT', value: 15_000 })).toBeNull();
  });

  it.each([
    [{ id: 'Besar' }, 'id'], [{ id: '' }, 'id'], [{ name: '' }, 'nama'], [{ kind: 'LAIN' }, 'jenis'],
    [{ value: 0 }, 'nilai'], [{ value: 1.5 }, 'nilai'], [{ value: 101 }, 'maksimal 100'],
    [{ kind: 'AMOUNT', value: 20_000_000 }, 'maksimal'], [{ kind: 'AMOUNT', value: 5_000, maxDiscount: 1_000 }, 'hanya untuk promo persen'],
    [{ days: [7] }, 'hari'], [{ days: [1, 1] }, 'hari'], [{ startDate: '2026-02-30' }, 'tanggal'], [{ endDate: '2026-13-01' }, 'tanggal'], [{ startDate: '8 Okt 2026' }, 'tanggal'],
    [{ startDate: '2026-10-09', endDate: '2026-10-01' }, 'tanggal mulai'], [{ startHour: 10 }, 'bersamaan'],
    [{ startHour: 17, endHour: 14 }, 'jam berlaku'], [{ startHour: 0, endHour: 25 }, 'jam berlaku'], [{ minSubtotal: -1 }, 'subtotal'],
  ])('menolak %j', (patch, msg) => {
    expect(checkPromo({ ...base, ...patch } as Partial<Promo>)).toContain(msg);
  });
});

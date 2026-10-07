import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ParseError, parseMandiriSettlement } from '../src';

const slip = readFileSync(resolve(__dirname, '../../../fixtures/bank-reports/mandiri-settlement-slip-2026-10-01.txt'), 'utf8');

describe('slip settlement Mandiri (hasil transkripsi foto slip asli)', () => {
  const report = parseMandiriSettlement(slip);

  it('menggabungkan slip kartu dan slip QRIS menjadi satu ringkasan batch', () => {
    expect(report.summaries).toHaveLength(1);
    expect(report.warnings).toEqual([]);
    expect(report.summaries[0]).toMatchObject({
      bank: 'MANDIRI', tid: '12345678', mid: '70000000001', batch: '000344',
      closedAt: Date.parse('2026-10-01T21:57:19+07:00'),
    });
  });

  it('membaca jumlah dan total per jenis pembayaran', () => {
    const c = report.summaries[0]!.channels;
    expect(c.CARD_CREDIT!.sale).toEqual({ count: 1, amount: 15_000 });
    expect(c.CARD_DEBIT!.sale).toEqual({ count: 0, amount: 0 });
    expect(c.QRIS!.sale).toEqual({ count: 29, amount: 770_000 });
    expect(c.QRIS!.refund).toEqual({ count: 0, amount: 0 });
  });

  it('tidak menghitung dua kali bagian TRANSACTION DETAIL dan GRAND TOTAL', () => {
    const c = report.summaries[0]!.channels;
    expect(Object.keys(c).sort()).toEqual(['CARD_CREDIT', 'CARD_DEBIT', 'OTHER', 'QRIS']);
    expect(c.CARD_CREDIT!.sale.count).toBe(1);
  });
});

describe('ketahanan terhadap salah baca', () => {
  it('toleran huruf O sebagai nol, huruf kecil, dan spasi berlebih', () => {
    const noisy = slip.replace('SALE 029 RP 770.000', 'sale  O29   Rp 77O.OOO').replace('BATCH : 000344', 'batch : OOO344');
    const s = parseMandiriSettlement(noisy).summaries[0]!;
    expect(s.channels.QRIS!.sale).toEqual({ count: 29, amount: 770_000 });
    expect(s.batch).toBe('000344');
  });

  it('total kartu tidak cocok dengan GRAND TOTAL menjadi peringatan', () => {
    const wrong = slip.replace('CREDIT\nSALE 0001 RP 15.000', 'CREDIT\nSALE 0001 RP 16.000');
    const r = parseMandiriSettlement(wrong);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/GRAND TOTAL 15000/);
  });

  it('slip tanpa TID/BATCH gagal dengan pesan jelas', () => {
    const broken = slip.replaceAll('TID: 12345678', '').replaceAll('BATCH : 000344', '');
    expect(() => parseMandiriSettlement(broken)).toThrow(/tidak ditemukan: TID, BATCH/);
  });

  it('teks yang bukan slip ditolak', () => {
    expect(() => parseMandiriSettlement('halo dunia')).toThrow(ParseError);
  });

  it('slip QRIS saja (tanpa slip kartu) tetap terbaca', () => {
    const qrisOnly = slip.slice(slip.indexOf('mandiri', 10));
    expect(parseMandiriSettlement(qrisOnly).summaries[0]!.channels.QRIS!.sale.count).toBe(29);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ParseError, parseAmount, parseBankReport, parseBca, parseBri, parseCsv, parseMandiri } from '../src';

const fixture = (name: string) =>
  readFileSync(resolve(__dirname, '../../../fixtures/bank-reports', name), 'utf8');

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);

describe('parseCsv', () => {
  it('menangani kutip, koma dalam kutip, CRLF, dan BOM', () => {
    const rows = parseCsv('﻿a,"b,1","c ""x"""\r\n1,2,3\r\n');
    expect(rows).toEqual([['a', 'b,1', 'c "x"'], ['1', '2', '3']]);
  });
});

describe('parseAmount', () => {
  it('membaca tiga gaya nominal', () => {
    expect(parseAmount('45000.00', 'dot-decimal')).toBe(45000);
    expect(parseAmount('Rp 32.000', 'rp-id')).toBe(32000);
    expect(parseAmount('28.000,00', 'id-locale')).toBe(28000);
  });
  it('menolak teks bukan angka dan pecahan sen', () => {
    expect(() => parseAmount('abc', 'rp-id')).toThrow();
    expect(() => parseAmount('1000.50', 'dot-decimal')).toThrow(/pecahan/);
  });
});

describe('BCA', () => {
  const report = parseBca(fixture('mock-bca-merchant-2026-10-01.csv'));

  it('membaca 10 transaksi tanpa error', () => {
    expect(report.errors).toEqual([]);
    expect(report.txns).toHaveLength(10);
  });
  it('menormalisasi satu transaksi QRIS', () => {
    expect(report.txns[0]).toMatchObject({
      bank: 'BCA', mid: '000123456789', tid: '12345678', txnDate: '2026-10-01',
      txnAt: WIB('2026-10-01T08:15:32'), channel: 'QRIS', amount: 45000, mdr: 315,
      netAmount: 44685, approvalCode: '123401', rrn: '627400000001', status: 'SUCCESS',
    });
  });
  it('memetakan debit dan kredit', () => {
    expect(report.txns[1]!.channel).toBe('CARD_DEBIT');
    expect(report.txns[3]!.channel).toBe('CARD_CREDIT');
  });
  it('cakupan = akhir periode di metadata', () => {
    expect(report.coverageEndMs).toBe(WIB('2026-10-01T23:59:59.999'));
  });
});

describe('BRI', () => {
  const report = parseBri(fixture('mock-bri-merchant-2026-10-01.csv'));

  it('membaca 7 transaksi dengan nominal "Rp ..."', () => {
    expect(report.errors).toEqual([]);
    expect(report.txns).toHaveLength(7);
    expect(report.txns[0]).toMatchObject({
      bank: 'BRI', mid: '1234567890', tid: '87654321', channel: 'QRIS',
      amount: 32000, mdr: 224, netAmount: 31776, txnAt: WIB('2026-10-01T08:40:11'),
    });
  });
  it('cakupan = akhir hari transaksi terakhir', () => {
    expect(report.coverageEndMs).toBe(WIB('2026-10-01T23:59:59.999'));
  });
});

describe('Mandiri', () => {
  const report = parseMandiri(fixture('mock-mandiri-merchant-2026-10-01.csv'));

  it('membaca 5 transaksi dengan nominal format Indonesia', () => {
    expect(report.errors).toEqual([]);
    expect(report.txns).toHaveLength(5);
    expect(report.txns[2]).toMatchObject({
      bank: 'MANDIRI', tid: '55556666', channel: 'CARD_DEBIT', amount: 112000,
      settlementBatchId: 'DSB-20261001-1600', settledAt: WIB('2026-10-01T16:00:00'),
    });
  });
  it('cakupan = pencairan terakhir, bukan akhir hari', () => {
    expect(report.coverageEndMs).toBe(WIB('2026-10-01T20:00:00'));
  });
});

describe('parseBankReport (deteksi otomatis)', () => {
  it.each([
    ['mock-bca-merchant-2026-10-01.csv', 'BCA'],
    ['mock-bri-merchant-2026-10-01.csv', 'BRI'],
    ['mock-mandiri-merchant-2026-10-01.csv', 'MANDIRI'],
  ])('%s → %s', (file, bank) => {
    expect(parseBankReport(fixture(file)).bank).toBe(bank);
  });

  it('menolak format tak dikenal', () => {
    expect(() => parseBankReport('a,b,c\n1,2,3\n')).toThrow(ParseError);
  });
});

describe('ketahanan', () => {
  const bca = fixture('mock-bca-merchant-2026-10-01.csv');

  it('baris rusak dicatat, baris lain tetap diproses', () => {
    const broken = bca.replace('45000.00', 'abc');
    const r = parseBca(broken);
    expect(r.txns).toHaveLength(9);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/nominal tidak valid/);
  });

  it('kolom wajib hilang → gagal keras, bukan data salah', () => {
    expect(() => parseBca(bca.replace('Kode Approval', 'Kode'))).toThrow(/kolom wajib/);
  });

  it('urutan kolom berbeda tetap terbaca', () => {
    const rows = parseCsv(bca);
    const h = rows.findIndex((r) => r[0] === 'Tanggal Transaksi');
    const swapped = rows
      .map((r, i) => (i >= h ? [...r.slice(5, 6), ...r.slice(0, 5), ...r.slice(6)] : r))
      .map((r) => r.join(','))
      .join('\n');
    const r = parseBca(swapped);
    expect(r.txns).toHaveLength(10);
    expect(r.txns[0]!.amount).toBe(45000);
  });

  it('unggah ulang file yang sama tidak menggandakan transaksi', () => {
    const r = parseBca(bca + bca.split('\n').slice(6).join('\n'));
    expect(r.txns).toHaveLength(10);
  });
});

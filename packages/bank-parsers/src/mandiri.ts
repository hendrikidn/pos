import type { BankReport, Channel } from '@pos/domain';
import {
  digits, findHeaderRow, headerIndex, isoDate, mapRows, offsetOf,
  parseAmount, parseCsv, parseDate, parseTime, toEpochMs, ParseError, type ParseOptions,
} from './util';

// Format mock laporan pencairan (belum diverifikasi dengan laporan asli): lihat docs/BANK-REPORT-FORMAT.md
const DELIMITER = ';';
const HEADER_START = ['ID Pencairan', 'Tanggal Pencairan'];
const REQUIRED = [
  'ID Pencairan', 'Tanggal Pencairan', 'Waktu Pencairan', 'MID', 'TID', 'Tanggal Transaksi',
  'Waktu Transaksi', 'Metode', 'Nominal', 'MDR', 'Nominal Pencairan', 'Kode Otorisasi', 'Ref No',
];

const CHANNELS: Record<string, Channel> = {
  QRIS: 'QRIS',
  'DEBIT MANDIRI': 'CARD_DEBIT',
  'KARTU KREDIT': 'CARD_CREDIT',
};

export function detectMandiri(text: string): boolean {
  return findHeaderRow(parseCsv(text, DELIMITER), HEADER_START) >= 0;
}

export function parseMandiri(text: string, opts?: ParseOptions): BankReport {
  const off = offsetOf(opts);
  const rows = parseCsv(text, DELIMITER);
  const headerRow = findHeaderRow(rows, HEADER_START);
  if (headerRow < 0) throw new ParseError('header laporan Mandiri tidak ditemukan');
  const cols = headerIndex(rows[headerRow]!, REQUIRED);

  const { txns, errors } = mapRows(rows, headerRow, cols, (get, rowNo) => {
    const date = parseDate(get('Tanggal Transaksi'), '/');
    const settleDate = parseDate(get('Tanggal Pencairan'), '/');
    return {
      bank: 'MANDIRI',
      mid: digits(get('MID')),
      tid: digits(get('TID')),
      txnDate: isoDate(date),
      txnAt: toEpochMs(date, parseTime(get('Waktu Transaksi')), off),
      channel: CHANNELS[get('Metode').toUpperCase()] ?? 'OTHER',
      amount: parseAmount(get('Nominal'), 'id-locale'),
      mdr: parseAmount(get('MDR'), 'id-locale'),
      netAmount: parseAmount(get('Nominal Pencairan'), 'id-locale'),
      approvalCode: get('Kode Otorisasi') || null,
      rrn: get('Ref No') || null,
      status: 'SUCCESS', // laporan pencairan hanya memuat transaksi yang dicairkan
      settlementBatchId: get('ID Pencairan') || null,
      settledAt: toEpochMs(settleDate, parseTime(get('Waktu Pencairan')), off),
      sourceRow: rowNo,
    };
  });

  // Cakupan = pencairan terakhir dalam file. Transaksi setelahnya masih "pending pencairan".
  const settled = txns.map((t) => t.settledAt).filter((v): v is number => v !== null);
  const coverageEndMs = settled.length > 0 ? Math.max(...settled) : null;
  return { bank: 'MANDIRI', txns, coverageEndMs, errors };
}

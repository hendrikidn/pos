import type { BankReport, Channel, TxnStatus } from '@pos/domain';
import {
  digits, endOfDayMs, findHeaderRow, headerIndex, isoDate, mapRows, offsetOf,
  parseAmount, parseCsv, parseDate, parseTime, toEpochMs, ParseError, type ParseOptions,
} from './util';

// Format mock (belum diverifikasi dengan laporan asli): lihat docs/BANK-REPORT-FORMAT.md
const HEADER_START = ['MID', 'TID', 'Tanggal', 'Jam'];
const REQUIRED = [
  'MID', 'TID', 'Tanggal', 'Jam', 'Jenis Transaksi', 'Nominal', 'Biaya MDR',
  'Nominal Bersih', 'No Approval', 'No Referensi', 'Status',
];

const CHANNELS: Record<string, Channel> = {
  'QRIS MPM': 'QRIS',
  QRIS: 'QRIS',
  'KARTU DEBIT': 'CARD_DEBIT',
  'KARTU KREDIT': 'CARD_CREDIT',
};
const STATUSES: Record<string, TxnStatus> = { BERHASIL: 'SUCCESS', GAGAL: 'FAILED', REVERSAL: 'REVERSED' };

export function detectBri(text: string): boolean {
  return findHeaderRow(parseCsv(text), HEADER_START) >= 0;
}

export function parseBri(text: string, opts?: ParseOptions): BankReport {
  const off = offsetOf(opts);
  const rows = parseCsv(text);
  const headerRow = findHeaderRow(rows, HEADER_START);
  if (headerRow < 0) throw new ParseError('header laporan BRI tidak ditemukan');
  const cols = headerIndex(rows[headerRow]!, REQUIRED);

  const { txns, errors } = mapRows(rows, headerRow, cols, (get, rowNo) => {
    const date = parseDate(get('Tanggal'), '-');
    return {
      bank: 'BRI',
      mid: digits(get('MID')),
      tid: digits(get('TID')),
      txnDate: isoDate(date),
      txnAt: toEpochMs(date, parseTime(get('Jam')), off),
      channel: CHANNELS[get('Jenis Transaksi').toUpperCase()] ?? 'OTHER',
      amount: parseAmount(get('Nominal'), 'rp-id'),
      mdr: parseAmount(get('Biaya MDR'), 'rp-id'),
      netAmount: parseAmount(get('Nominal Bersih'), 'rp-id'),
      approvalCode: get('No Approval') || null,
      rrn: get('No Referensi') || null,
      status: STATUSES[get('Status').toUpperCase()] ?? 'UNKNOWN',
      settlementBatchId: null,
      settledAt: null,
      sourceRow: rowNo,
    };
  });

  // Laporan BRI tidak memuat periode: cakupan = akhir hari transaksi terakhir.
  let coverageEndMs: number | null = null;
  if (txns.length > 0) {
    const last = txns.map((t) => t.txnDate).sort().at(-1)!;
    coverageEndMs = endOfDayMs(parseDate(last, '-', 'ymd'), off);
  }
  return { bank: 'BRI', txns, coverageEndMs, errors };
}

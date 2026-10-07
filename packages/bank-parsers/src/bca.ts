import type { BankReport, Channel, TxnStatus } from '@pos/domain';
import {
  digits, endOfDayMs, findHeaderRow, headerIndex, isoDate, mapRows, offsetOf,
  parseAmount, parseCsv, parseDate, parseTime, toEpochMs, ParseError, type ParseOptions,
} from './util';

// Format mock (belum diverifikasi dengan laporan asli): lihat docs/BANK-REPORT-FORMAT.md
const HEADER_START = ['Tanggal Transaksi', 'Jam Transaksi'];
const REQUIRED = [
  'Tanggal Transaksi', 'Jam Transaksi', 'MID', 'TID', 'Tipe Pembayaran', 'Jumlah',
  'MDR', 'Jumlah Bersih', 'Kode Approval', 'Nomor Referensi', 'Status',
];

const CHANNELS: Record<string, Channel> = { QRIS: 'QRIS', DEBIT: 'CARD_DEBIT', KREDIT: 'CARD_CREDIT' };
const STATUSES: Record<string, TxnStatus> = { SUKSES: 'SUCCESS', GAGAL: 'FAILED', REVERSAL: 'REVERSED' };

export function detectBca(text: string): boolean {
  return findHeaderRow(parseCsv(text), HEADER_START) >= 0;
}

export function parseBca(text: string, opts?: ParseOptions): BankReport {
  const off = offsetOf(opts);
  const rows = parseCsv(text);
  const headerRow = findHeaderRow(rows, HEADER_START);
  if (headerRow < 0) throw new ParseError('header laporan BCA tidak ditemukan');
  const cols = headerIndex(rows[headerRow]!, REQUIRED);

  const { txns, errors } = mapRows(rows, headerRow, cols, (get, rowNo) => {
    const date = parseDate(get('Tanggal Transaksi'), '/');
    const channel = CHANNELS[get('Tipe Pembayaran').toUpperCase()] ?? 'OTHER';
    return {
      bank: 'BCA',
      mid: digits(get('MID')),
      tid: digits(get('TID')),
      txnDate: isoDate(date),
      txnAt: toEpochMs(date, parseTime(get('Jam Transaksi')), off),
      channel,
      amount: parseAmount(get('Jumlah'), 'dot-decimal'),
      mdr: parseAmount(get('MDR'), 'dot-decimal'),
      netAmount: parseAmount(get('Jumlah Bersih'), 'dot-decimal'),
      approvalCode: get('Kode Approval') || null,
      rrn: get('Nomor Referensi') || null,
      status: STATUSES[get('Status').toUpperCase()] ?? 'UNKNOWN',
      settlementBatchId: null,
      settledAt: null,
      sourceRow: rowNo,
    };
  });

  // Batas cakupan: akhir periode di metadata, atau akhir hari transaksi terakhir.
  let coverageEndMs: number | null = null;
  const period = rows.find((r) => r[0]?.trim() === 'Periode');
  const m = period && /(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})\s*$/.exec(period[1] ?? '');
  if (m) coverageEndMs = endOfDayMs(parseDate(m[2]!, '/'), off);
  else if (txns.length > 0) {
    const last = txns.map((t) => t.txnDate).sort().at(-1)!;
    coverageEndMs = endOfDayMs(parseDate(last, '-', 'ymd'), off);
  }
  return { bank: 'BCA', txns, coverageEndMs, errors };
}

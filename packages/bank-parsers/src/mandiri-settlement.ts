import type { ChannelSettlement, SettlementLine, SettlementReport, SettlementSummary, Channel } from '@pos/domain';
import { offsetOf, ParseError, parseDate, parseTime, toEpochMs, type ParseOptions } from './util';

/**
 * Parser slip settlement Mandiri (teks hasil pembacaan slip, mis. OCR atau ketikan).
 * Format sumber: ringkasan batch per jenis pembayaran. Tidak ada rincian per transaksi.
 *
 * Toleran terhadap salah baca OCR yang umum: huruf O sebagai angka nol, huruf besar/kecil, dan spasi.
 * Hasil dicek silang dengan GRAND TOTAL pada slip kartu; ketidakcocokan menjadi peringatan, bukan kegagalan.
 */

const CHANNEL_OF_HEADER: Record<string, Channel> = { DEBIT: 'CARD_DEBIT', CREDIT: 'CARD_CREDIT', NPG: 'OTHER' };

const zero = (): SettlementLine => ({ count: 0, amount: 0 });
const emptyChannel = (): ChannelSettlement => ({ sale: zero(), void: zero(), refund: zero() });

const num = (raw: string): number => Number(raw.replace(/O/g, '0').replace(/[.,\s]/g, ''));

const WITH_COUNT = /^(SALE|VOID|REFUND)\s+([0-9O]+)\s+-?\s*RP\.?\s*([0-9O.,]+)$/;
const NO_COUNT = /^(SALE|VOID|REFUND)\s+-?\s*RP\.?\s*([0-9O.,]+)$/;

interface Slip {
  tid?: string;
  mid?: string;
  batch?: string;
  date?: string;
  time?: string;
  channels: Partial<Record<Channel, ChannelSettlement>>;
  grandSale?: number;
}

function parseSlip(lines: string[]): Slip {
  const slip: Slip = { channels: {} };
  let section: 'NONE' | 'SUMMARY' | 'DETAIL' | 'GRAND' | 'QRIS' = 'NONE';
  let channel: Channel | null = null;

  for (const line of lines) {
    const tid = /\bTID\s*[:\-]?\s*([0-9O]{6,})/.exec(line);
    if (tid) slip.tid ??= tid[1]!.replace(/O/g, '0');
    const mid = /\bMID\s*[:\-]?\s*([0-9O]{6,})/.exec(line);
    if (mid) slip.mid ??= mid[1]!.replace(/O/g, '0');
    const batch = /\bBATCH\s*[:\-]?\s*([0-9O]+)/.exec(line);
    if (batch) slip.batch ??= batch[1]!.replace(/O/g, '0');
    const date = /\bDATE\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4})/.exec(line);
    if (date) slip.date ??= date[1];
    const time = /\bTIME\s*[:\-]?\s*(\d{1,2}:\d{2}(?::\d{2})?)/.exec(line);
    if (time) slip.time ??= time[1];

    if (/TRANSACTION\s+SUMMARY/.test(line)) { section = 'SUMMARY'; channel = null; continue; }
    if (/TRANSACTION\s+DETAIL/.test(line)) { section = 'DETAIL'; channel = null; continue; }
    if (/^GRAND\s+TOTAL$/.test(line)) { section = 'GRAND'; channel = null; continue; }
    if (/^\[?\s*QRIS\s*\]?$/.test(line)) { section = 'QRIS'; channel = 'QRIS'; continue; }

    if (section === 'SUMMARY') {
      const header = CHANNEL_OF_HEADER[line];
      if (header) { channel = header; slip.channels[header] ??= emptyChannel(); continue; }
    }

    const counted = WITH_COUNT.exec(line);
    if (counted && channel && (section === 'SUMMARY' || section === 'QRIS')) {
      const kind = counted[1]!.toLowerCase() as 'sale' | 'void' | 'refund';
      const entry = (slip.channels[channel] ??= emptyChannel());
      entry[kind] = { count: num(counted[2]!), amount: num(counted[3]!) };
      continue;
    }
    const total = NO_COUNT.exec(line);
    if (total && section === 'GRAND' && total[1] === 'SALE') slip.grandSale = num(total[2]!);
  }
  return slip;
}

export function parseMandiriSettlement(text: string, opts?: ParseOptions): SettlementReport {
  const off = offsetOf(opts);
  const chunks = text
    .split(/-{0,}\s*SETTLEMENT\s*CLOSE\s*-{0,}/i)
    .map((c) => c.split(/\r?\n/).map((l) => l.trim().toUpperCase().replace(/\s+/g, ' ')).filter(Boolean))
    .filter((lines) => lines.some((l) => /\bTID\b|\bBATCH\b|^\[?QRIS|TRANSACTION SUMMARY/.test(l)));

  if (chunks.length === 0) throw new ParseError('slip settlement Mandiri tidak dikenali');

  const warnings: string[] = [];
  const merged = new Map<string, SettlementSummary>();

  for (const lines of chunks) {
    const slip = parseSlip(lines);
    const missing = (['tid', 'mid', 'batch', 'date', 'time'] as const).filter((k) => !slip[k]);
    if (missing.length > 0) throw new ParseError(`slip tidak lengkap, tidak ditemukan: ${missing.join(', ').toUpperCase()}`);

    const date = parseDate(slip.date!, '/');
    const closedAt = toEpochMs(date, parseTime(slip.time!), off);

    if (slip.grandSale !== undefined) {
      const cardSales = (['CARD_DEBIT', 'CARD_CREDIT', 'OTHER'] as const).reduce(
        (s, c) => s + (slip.channels[c]?.sale.amount ?? 0), 0,
      );
      if (cardSales !== slip.grandSale) {
        warnings.push(
          `batch ${slip.batch}: jumlah penjualan kartu ${cardSales} tidak sama dengan GRAND TOTAL ${slip.grandSale}; periksa kemungkinan salah baca`,
        );
      }
    }

    const key = `${slip.tid}|${slip.batch}`;
    const existing = merged.get(key);
    if (existing) {
      if (existing.closedAt !== closedAt) warnings.push(`batch ${slip.batch}: waktu penutupan berbeda antar slip, dipakai yang pertama`);
      for (const [c, v] of Object.entries(slip.channels) as [Channel, ChannelSettlement][]) {
        if (existing.channels[c]) warnings.push(`batch ${slip.batch}: jenis ${c} muncul lebih dari sekali, dipakai yang pertama`);
        else existing.channels[c] = v;
      }
    } else {
      merged.set(key, {
        bank: 'MANDIRI', mid: slip.mid!, tid: slip.tid!, batch: slip.batch!, closedAt, channels: slip.channels,
      });
    }
  }
  return { summaries: [...merged.values()], warnings };
}

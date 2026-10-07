import type { Bank, BankReport } from '@pos/domain';
import { detectBca, parseBca } from './bca';
import { detectBri, parseBri } from './bri';
import { detectMandiri, parseMandiri } from './mandiri';
import { ParseError, type ParseOptions } from './util';

export { parseBca, parseBri, parseMandiri, ParseError };
export { parseMandiriSettlement } from './mandiri-settlement';
export type { ParseOptions };
export { parseCsv, parseAmount } from './util';

interface BankParser {
  bank: Bank;
  detect(text: string): boolean;
  parse(text: string, opts?: ParseOptions): BankReport;
}

const PARSERS: BankParser[] = [
  { bank: 'BCA', detect: detectBca, parse: parseBca },
  { bank: 'BRI', detect: detectBri, parse: parseBri },
  { bank: 'MANDIRI', detect: detectMandiri, parse: parseMandiri },
];

/** Mengenali bank dari isi file lalu mem-parse. Gagal jika tidak ada atau lebih dari satu parser yang cocok. */
export function parseBankReport(text: string, opts?: ParseOptions): BankReport {
  const hits = PARSERS.filter((p) => p.detect(text));
  if (hits.length === 0) throw new ParseError('format laporan bank tidak dikenali');
  if (hits.length > 1) {
    throw new ParseError(`format ambigu, cocok dengan: ${hits.map((h) => h.bank).join(', ')}`);
  }
  return hits[0]!.parse(text, opts);
}

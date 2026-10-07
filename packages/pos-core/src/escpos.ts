import type { PrinterState } from '@pos/events';
import type { Printer, PrinterCapabilities } from './printer';

/**
 * Encoder ESC/POS dan pembaca status untuk printer struk termal (Epson dan klonnya).
 * Pengiriman byte (TCP, USB, Bluetooth) dilakukan oleh `RawTransport`, yang di Android diimplementasikan
 * oleh plugin native; logika di sini murni dan diuji di komputer.
 */

export interface RawTransport {
  /** Mengirim byte ke printer. Melempar error bila gagal tersambung atau menulis. */
  write(bytes: Uint8Array): Promise<void>;
  /** Mengirim perintah dan menunggu `expect` byte jawaban (atau waktu habis). */
  query(bytes: Uint8Array, expect: number, timeoutMs: number): Promise<Uint8Array>;
}

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const DLE = 0x10;
const EOT = 0x04;

export interface EscPosOptions {
  /** Cut kertas parsial di akhir. */
  cut?: boolean;
  /** Buka laci kas (pulsa ke pin 2). */
  openDrawer?: boolean;
  /** Baris kosong sebelum cut agar teks melewati pisau. */
  feedLines?: number;
}

/** Karakter di luar ASCII yang dapat dicetak diganti agar tidak menghasilkan sampah di codepage bawaan printer. */
const TRANSLIT: Record<string, string> = { '–': '-', '—': '-', '−': '-', '·': '.', '•': '*', '×': 'x', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '✓': 'v' };

export function toPrinterAscii(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const mapped = TRANSLIT[ch] ?? ch;
    for (const c of mapped.normalize('NFD')) {
      const code = c.charCodeAt(0);
      if (code === 0x0a || (code >= 0x20 && code < 0x7f)) out.push(code);
      else if (code === 0x0d || (code >= 0x300 && code <= 0x36f)) continue; // CR dan tanda diakritik diabaikan
      else out.push(0x3f); // '?'
    }
  }
  return Uint8Array.from(out);
}

/** Menyusun byte cetak: init, teks, umpan kertas, cut, dan (opsional) buka laci. */
export function renderEscPos(text: string, opts: EscPosOptions = {}): Uint8Array {
  const body = toPrinterAscii(text.endsWith('\n') ? text : `${text}\n`);
  const feed = Array(opts.feedLines ?? 3).fill(LF) as number[];
  return Uint8Array.from([
    ESC, 0x40, // inisialisasi
    ...body,
    ...feed,
    ...(opts.cut === false ? [] : [GS, 0x56, 0x42, 0x00]), // GS V 66 0: cut parsial setelah umpan
    ...(opts.openDrawer ? [ESC, 0x70, 0x00, 0x19, 0xfa] : []),
  ]);
}

/** DLE EOT n: permintaan status waktu nyata. n=1 printer, 2 sebab offline, 4 sensor kertas. */
export const statusRequest = (n: 1 | 2 | 4): Uint8Array => Uint8Array.from([DLE, EOT, n]);

export interface RawStatus {
  /** jawaban n=1 */
  printer?: number;
  /** jawaban n=2 */
  offline?: number;
  /** jawaban n=4 */
  paper?: number;
}

/** Menerjemahkan jawaban status mentah. Bit mengikuti spesifikasi ESC/POS (Epson). */
export function interpretStatus(s: RawStatus): PrinterState {
  if (s.offline !== undefined && (s.offline & 0x04)) return 'coverOpen';
  if (s.paper !== undefined && (s.paper & 0x60)) return 'paperOut';
  if (s.offline !== undefined && (s.offline & 0x20)) return 'paperOut';
  if (s.paper !== undefined && (s.paper & 0x0c)) return 'paperNearEnd';
  if (s.offline !== undefined && (s.offline & 0x40)) return 'unknown'; // galat tak terpulihkan
  if (s.printer !== undefined && (s.printer & 0x08)) return 'disconnected'; // offline
  return 'ok';
}

const QUERY_TIMEOUT_MS = 1500;

/** Printer ESC/POS di atas transport mentah. */
export class EscPosPrinter implements Printer {
  capabilities: PrinterCapabilities = { reportsPaperStatus: true };

  constructor(
    private readonly transport: RawTransport,
    private readonly opts: EscPosOptions & { drawer?: boolean } = {},
  ) {}

  /**
   * Menanyakan status sekali untuk mengetahui apakah printer menjawab. Printer yang tidak menjawab
   * (Bluetooth murah, klon tanpa status) ditandai tidak melaporkan status kertas, sehingga R5 memakai klaim kasir.
   */
  async probe(): Promise<boolean> {
    try {
      const r = await this.transport.query(statusRequest(4), 1, QUERY_TIMEOUT_MS);
      this.capabilities = { reportsPaperStatus: r.length >= 1 };
    } catch {
      this.capabilities = { reportsPaperStatus: false };
    }
    return this.capabilities.reportsPaperStatus;
  }

  async status(): Promise<PrinterState> {
    const ask = async (n: 1 | 2 | 4): Promise<number | undefined> => {
      const r = await this.transport.query(statusRequest(n), 1, QUERY_TIMEOUT_MS);
      return r[0];
    };
    try {
      return interpretStatus({ printer: await ask(1), offline: await ask(2), paper: await ask(4) });
    } catch {
      return 'disconnected';
    }
  }

  async print(text: string): Promise<boolean> {
    // Cek kertas dulu: printer termal sering "berhasil" menerima byte walau kertas habis.
    if (this.capabilities.reportsPaperStatus) {
      const s = await this.status();
      if (s === 'paperOut' || s === 'coverOpen' || s === 'disconnected') return false;
    }
    try {
      await this.transport.write(renderEscPos(text, { cut: this.opts.cut, feedLines: this.opts.feedLines }));
      return true;
    } catch {
      return false;
    }
  }

  /** Membuka laci kas lewat printer (bila laci tersambung ke port RJ11 printer). */
  async openDrawer(): Promise<boolean> {
    try {
      await this.transport.write(Uint8Array.from([ESC, 0x70, 0x00, 0x19, 0xfa]));
      return true;
    } catch {
      return false;
    }
  }
}

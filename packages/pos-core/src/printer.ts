import type { PrinterState } from '@pos/events';

export interface PrinterCapabilities {
  /** Printer melaporkan status kertas sendiri. */
  reportsPaperStatus: boolean;
}

export interface Printer {
  readonly capabilities: PrinterCapabilities;
  status(): Promise<PrinterState>;
  /** Mengembalikan false bila gagal mencetak (mis. kertas habis). */
  print(text: string): Promise<boolean>;
}

/** Printer simulasi: menampung hasil cetak dan bisa diatur kertasnya. Dipakai tes dan demo tanpa perangkat keras. */
export class SimPrinter implements Printer {
  readonly capabilities: PrinterCapabilities;
  paper = true;
  readonly printed: string[] = [];

  constructor(opts: { reportsPaperStatus?: boolean } = {}) {
    this.capabilities = { reportsPaperStatus: opts.reportsPaperStatus ?? true };
  }

  async status(): Promise<PrinterState> {
    return this.paper ? 'ok' : 'paperOut';
  }

  async print(text: string): Promise<boolean> {
    if (!this.paper) return false;
    this.printed.push(text);
    return true;
  }
}

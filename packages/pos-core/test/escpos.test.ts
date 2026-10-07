import { describe, expect, it } from 'vitest';
import { EscPosPrinter, interpretStatus, renderEscPos, statusRequest, toPrinterAscii, type RawTransport } from '../src';

const bytes = (...n: number[]) => Uint8Array.from(n);
const text = (s: string) => Array.from(new TextEncoder().encode(s));

class FakeTransport implements RawTransport {
  written: Uint8Array[] = [];
  answers = new Map<number, number | null>(); // n -> byte jawaban; null = tidak menjawab
  failWrite = false;
  queries: number[] = [];

  async write(b: Uint8Array) {
    if (this.failWrite) throw new Error('koneksi putus');
    this.written.push(b);
  }
  async query(b: Uint8Array): Promise<Uint8Array> {
    const n = b[2]!;
    this.queries.push(n);
    const a = this.answers.get(n);
    if (a === null) throw new Error('waktu habis');
    return bytes(a ?? 0x12); // 0x12 = status normal pada kebanyakan Epson
  }
}

describe('renderEscPos', () => {
  it('urutan: init, teks, umpan 3 baris, cut parsial', () => {
    expect([...renderEscPos('Halo')]).toEqual([0x1b, 0x40, ...text('Halo\n'), 0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x42, 0x00]);
  });

  it('tanpa cut dan dengan laci', () => {
    const out = [...renderEscPos('A', { cut: false, openDrawer: true, feedLines: 1 })];
    expect(out).toEqual([0x1b, 0x40, ...text('A\n'), 0x0a, 0x1b, 0x70, 0x00, 0x19, 0xfa]);
  });

  it('teks yang sudah berakhir baris baru tidak digandakan', () => {
    expect([...renderEscPos('A\n', { cut: false, feedLines: 0 })]).toEqual([0x1b, 0x40, ...text('A\n')]);
  });
});

describe('toPrinterAscii', () => {
  it('mengganti karakter non-ASCII umum dan menghapus aksen', () => {
    expect(new TextDecoder().decode(toPrinterAscii('Rp 15.000 – kopi × 2 · café “ok”'))).toBe('Rp 15.000 - kopi x 2 . cafe "ok"');
  });
  it('karakter tak dikenal menjadi "?" dan CR dibuang', () => {
    expect(new TextDecoder().decode(toPrinterAscii('a\r\n日b'))).toBe('a\n?b');
  });
});

describe('interpretStatus', () => {
  it.each([
    [{ printer: 0x12, offline: 0x12, paper: 0x12 }, 'ok'],
    [{ printer: 0x12, offline: 0x12, paper: 0x72 }, 'paperOut'], // bit 5-6 sensor kertas habis
    [{ printer: 0x12, offline: 0x12, paper: 0x1e }, 'paperNearEnd'], // bit 2-3
    [{ printer: 0x12, offline: 0x16, paper: 0x12 }, 'coverOpen'], // bit 2 pada n=2
    [{ printer: 0x12, offline: 0x32, paper: 0x12 }, 'paperOut'], // bit 5 pada n=2 (berhenti karena kertas habis)
    [{ printer: 0x1a, offline: 0x12, paper: 0x12 }, 'disconnected'], // bit 3 pada n=1: offline
    [{ printer: 0x12, offline: 0x52, paper: 0x12 }, 'unknown'], // bit 6 pada n=2: galat
  ])('%j → %s', (raw, expected) => {
    expect(interpretStatus(raw)).toBe(expected);
  });
  it('kertas habis mengalahkan kertas hampir habis', () => {
    expect(interpretStatus({ paper: 0x7e })).toBe('paperOut');
  });
  it('perintah status sesuai DLE EOT n', () => {
    expect([...statusRequest(4)]).toEqual([0x10, 0x04, 0x04]);
  });
});

describe('EscPosPrinter', () => {
  it('mencetak: mengirim byte ESC/POS lengkap', async () => {
    const t = new FakeTransport();
    const p = new EscPosPrinter(t);
    expect(await p.probe()).toBe(true);
    expect(await p.print('Struk')).toBe(true);
    expect([...t.written[0]!.slice(0, 2)]).toEqual([0x1b, 0x40]);
  });

  it('kertas habis: tidak mengirim apa pun dan melaporkan gagal', async () => {
    const t = new FakeTransport();
    t.answers.set(4, 0x72);
    const p = new EscPosPrinter(t);
    await p.probe();
    expect(await p.status()).toBe('paperOut');
    expect(await p.print('Struk')).toBe(false);
    expect(t.written).toHaveLength(0);
  });

  it('koneksi putus saat menulis dilaporkan gagal, bukan melempar', async () => {
    const t = new FakeTransport();
    t.failWrite = true;
    const p = new EscPosPrinter(t);
    await p.probe();
    expect(await p.print('Struk')).toBe(false);
  });

  it('printer yang tidak menjawab status ditandai tidak melaporkan kertas, tetapi tetap bisa mencetak', async () => {
    const t = new FakeTransport();
    t.answers.set(4, null);
    const p = new EscPosPrinter(t);
    expect(await p.probe()).toBe(false);
    expect(p.capabilities.reportsPaperStatus).toBe(false);
    expect(await p.print('Struk')).toBe(true); // tanpa pra-cek status
  });

  it('status "disconnected" bila transport gagal menjawab', async () => {
    const t = new FakeTransport();
    const p = new EscPosPrinter(t);
    await p.probe();
    t.answers.set(1, null);
    expect(await p.status()).toBe('disconnected');
    expect(await p.print('x')).toBe(false);
  });

  it('membuka laci kas', async () => {
    const t = new FakeTransport();
    expect(await new EscPosPrinter(t).openDrawer()).toBe(true);
    expect([...t.written[0]!]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  });
});

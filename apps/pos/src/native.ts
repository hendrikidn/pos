import { Capacitor, registerPlugin } from '@capacitor/core';
import { fromBase64, toBase64, type RawTransport, type Signer } from '@pos/pos-core';

export interface Posture {
  autoTime: boolean;
  adb: boolean;
  devOptions: boolean;
  kiosk: boolean;
  rooted: boolean;
  appVersion: string;
}

/** Antarmuka plugin native `PosHardware` (android/app/src/main/java/id/anatta/pos/PosHardwarePlugin.java). */
export interface PosHardwarePlugin {
  tcpWrite(o: { host: string; port: number; data: string; timeoutMs?: number }): Promise<void>;
  tcpQuery(o: { host: string; port: number; data: string; expect: number; timeoutMs?: number }): Promise<{ data: string }>;
  usbList(): Promise<{ devices: { name: string; vendorId: number; productId: number; hasPermission: boolean }[] }>;
  usbWrite(o: { name?: string; data: string; timeoutMs?: number }): Promise<void>;
  usbQuery(o: { name?: string; data: string; timeoutMs?: number }): Promise<{ data: string }>;
  getPosture(): Promise<Posture>;
  enterKiosk(): Promise<void>;
  exitKiosk(): Promise<void>;
  signerPublicKey(): Promise<{ publicKey: string; hardwareBacked: boolean }>;
  signerSign(o: { message: string }): Promise<{ signature: string }>;
  displayAvailable(): Promise<{ available: boolean }>;
  displayShow(o: { view: string }): Promise<{ shown: boolean }>;
  displayHide(): Promise<void>;
}

/** True hanya di dalam aplikasi Android terbungkus. Di browser, fitur native tidak tersedia. */
export const isNative = Capacitor.isNativePlatform();
export const hardware = registerPlugin<PosHardwarePlugin>('PosHardware');

/** Penandatangan dengan kunci Android Keystore (berbasis perangkat keras bila perangkat mendukung). */
export class NativeSigner implements Signer {
  hardwareBacked: boolean | null = null;

  async publicKey(): Promise<string> {
    const r = await hardware.signerPublicKey();
    this.hardwareBacked = r.hardwareBacked;
    return r.publicKey;
  }

  async sign(message: string): Promise<string> {
    return (await hardware.signerSign({ message })).signature;
  }
}

/** Printer jaringan: byte ESC/POS dikirim lewat soket TCP (umumnya port 9100). */
export class TcpTransport implements RawTransport {
  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  write(bytes: Uint8Array): Promise<void> {
    return hardware.tcpWrite({ host: this.host, port: this.port, data: toBase64(bytes) });
  }

  async query(bytes: Uint8Array, expect: number, timeoutMs: number): Promise<Uint8Array> {
    const r = await hardware.tcpQuery({ host: this.host, port: this.port, data: toBase64(bytes), expect, timeoutMs });
    return fromBase64(r.data);
  }
}

/** Printer USB (kelas printer). Izin USB diminta sistem; setelah disetujui, percobaan kedua berhasil. */
export class UsbTransport implements RawTransport {
  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Error && e.message.includes('USB_PERMISSION')) {
        await new Promise((r) => setTimeout(r, 4000)); // beri waktu pengguna menyetujui dialog
        return fn();
      }
      throw e;
    }
  }

  write(bytes: Uint8Array): Promise<void> {
    return this.retry(() => hardware.usbWrite({ data: toBase64(bytes) }));
  }

  async query(bytes: Uint8Array, _expect: number, timeoutMs: number): Promise<Uint8Array> {
    const r = await this.retry(() => hardware.usbQuery({ data: toBase64(bytes), timeoutMs }));
    return fromBase64(r.data);
  }
}

export type PrinterKind = 'sim' | 'lan' | 'usb';
export interface PrinterSetting {
  kind: PrinterKind;
  host: string;
  port: number;
}

export const loadPrinterSetting = (): PrinterSetting => {
  try {
    const raw = JSON.parse(localStorage.getItem('pos.printer') ?? '{}') as Partial<PrinterSetting>;
    return { kind: raw.kind ?? 'sim', host: raw.host ?? '', port: raw.port ?? 9100 };
  } catch {
    return { kind: 'sim', host: '', port: 9100 };
  }
};
export const savePrinterSetting = (s: PrinterSetting) => localStorage.setItem('pos.printer', JSON.stringify(s));

export const kioskWanted = () => localStorage.getItem('pos.kiosk') === '1';
export const setKioskWanted = (on: boolean) => (on ? localStorage.setItem('pos.kiosk', '1') : localStorage.removeItem('pos.kiosk'));

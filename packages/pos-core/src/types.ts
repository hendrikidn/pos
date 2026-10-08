import type { KitchenStatus, OrderType, PaymentMethod } from '@pos/events';
import type { ChosenOption, ModifierGroup, OrderState, Policy, Role } from '@pos/order';

export interface MenuItem {
  id: string;
  name: string;
  price: number;
  category: string;
  /** Varian dan tambahan. Tidak ada = menu polos. */
  modifierGroups?: ModifierGroup[];
}

/** Staf beserta hash PIN (PBKDF2-HMAC-SHA256, 32 byte, hex). PIN polos tidak pernah ada di perangkat. */
export interface Staff {
  id: string;
  name: string;
  role: Role;
  salt: string;
  hash: string;
  iterations: number;
}

/** Tampilan staf untuk UI: tanpa hash. */
export type StaffPublic = Pick<Staff, 'id' | 'name' | 'role'>;

export interface Edc {
  tid: string;
  bank: string;
  label: string;
}

export interface PosConfig {
  outletId: string;
  deviceId: string;
  merchantName: string;
  /** Awal alamat struk digital (berakhiran "/r/"); bila kosong, terminal memakai alamat API-nya. */
  receiptBaseUrl?: string;
  /** Persen PBJT yang dikenakan setelah diskon */
  taxPercent: number;
  edcs: Edc[];
  staff: Staff[];
  menu: MenuItem[];
  policy?: Policy;
}

export interface CartLine {
  /**
   * Identitas baris di dalam order. Menu yang sama dengan pilihan atau catatan berbeda menjadi baris berbeda. Order lama
   * (sebelum varian) tidak punya `lineId`; identitasnya `itemId` (lihat `lineKey`).
   */
  lineId?: string;
  itemId: string;
  name: string;
  qty: number;
  /** Harga satuan akhir: harga menu + harga semua opsi terpilih. */
  unitPrice: number;
  options?: ChosenOption[];
  note?: string;
  /** Jumlah yang sudah dikirim ke dapur. Item yang sudah dikirim tidak boleh dikurangi tanpa void. */
  sentQty: number;
}

export const lineKey = (l: Pick<CartLine, 'lineId' | 'itemId'>): string => l.lineId ?? l.itemId;

export interface PaymentRecord {
  method: PaymentMethod;
  amount: number;
  tid?: string;
  approvalCode?: string;
  at: number;
}

/** DIGITAL: struk diberikan sebagai QR (tanpa kertas). */
export type ReceiptStatus = 'NONE' | 'PRINTED' | 'DIGITAL' | 'DECLINED';

export interface OrderRecord {
  id: string;
  /** Nomor urut tampilan di perangkat ini */
  number: number;
  type: OrderType;
  tableNo?: string;
  employeeId?: string;
  creatorId: string;
  createdAt: number;
  shiftId: string;
  items: CartLine[];
  discount: number;
  state: OrderState;
  payments: PaymentRecord[];
  refunds: { amount: number; method: PaymentMethod }[];
  receipt: ReceiptStatus;
  kitchen: KitchenStatus | null;
  /** Token struk digital (QR) bila sudah dibuat; satu order satu token. */
  receiptToken?: string;
  /** Kapan bill pertama kali dicetak (jam perangkat). Dasar kontrol bill yang ditahan lama. */
  billedAt?: number;
  /** Alasan menahan bill sudah dicatat; pembayaran berikutnya untuk order ini tidak menanyakannya lagi. */
  holdLogged?: boolean;
  /** Order ini dibuat dari pemisahan bill order lain. */
  splitFrom?: string;
  /** Seluruh item order ini sudah digabung ke order lain (status MERGED). */
  mergedInto?: string;
}

export interface ShiftRecord {
  id: string;
  userId: string;
  openedAt: number;
  openingCash: number;
  /**
   * Tunai masuk dan keluar sejak shift dibuka (pembayaran dan refund TUNAI yang dicatat selama shift ini), persis seperti yang
   * dihitung ulang server dari rantai event (`verifyCashCount`). Tidak ada pada shift yang dibuka sebelum pelacakan ini.
   */
  cashIn?: number;
  cashOut?: number;
}

export type Result<T = void> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (code: string, message: string): Result<never> => ({ ok: false, code, message });

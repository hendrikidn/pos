import type { KitchenStatus, LineItem, OnlineChannel, OrderType, PaymentMethod } from '@pos/events';
import type { ChosenOption, ModifierGroup, OrderState, Policy, Promo, Role, TableDef } from '@pos/order';

export interface MenuItem {
  id: string;
  name: string;
  price: number;
  category: string;
  /** Varian dan tambahan. Tidak ada = menu polos. */
  modifierGroups?: ModifierGroup[];
  /** Versi foto menu (sidik jari dari server); ada hanya bila menu punya foto. Isi gambarnya diunduh terpisah dan disimpan di terminal. */
  image?: string;
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

/** Satu baris pesanan toko web (nama untuk pesan ke kasir; `options` = id opsi). */
export interface WebOrderItem { itemId: string; name: string; qty: number; options: string[]; note?: string }

/** Pesanan toko web yang sudah diklaim di server dan siap dibuat sebagai order kasir. */
/** Pesanan dari gerbang GoFood/GrabFood/ShopeeFood yang sudah diklaim di server; `itemId` = menu outlet hasil pemetaan. */
export interface ChannelOrderInput { channel: OnlineChannel; ref: string; items: { itemId: string; name: string; qty: number; note?: string }[] }
export interface WebOrderInput { id: number; code: string; name: string; type: 'TAKE_AWAY' | 'DINE_IN'; tableNo?: string; items: WebOrderItem[] }

export interface PosConfig {
  outletId: string;
  deviceId: string;
  merchantName: string;
  /** Awal alamat struk digital (berakhiran "/r/"); bila kosong, terminal memakai alamat API-nya. */
  receiptBaseUrl?: string;
  /** Persen PBJT yang dikenakan setelah diskon */
  taxPercent: number;
  /** Persen service charge (0/kosong = tidak ada), pajak atas service (bawaan ya), dan kelipatan pembulatan total (0/kosong = tidak). */
  serviceChargePercent?: number;
  taxOnService?: boolean;
  roundingUnit?: number;
  edcs: Edc[];
  /** Kanal pesan-antar yang diaktifkan outlet beserta komisinya (dari server); kosong = tidak ada pesanan online. */
  channels?: { channel: OnlineChannel; commissionPercent: number }[];
  /** QR statis cetak boleh dipakai sebagai metode bayar (diaktifkan owner; setiap pemakaian ditandai R19 bila ada EDC). */
  staticQr?: boolean;
  /** Outlet mewajibkan foto saat absen (terminal memotret otomatis; absen tetap jalan bila foto gagal, dan hal itu ditandai R56). */
  attendancePhoto?: boolean;
  /** Loyalty outlet (dari server); tidak ada = loyalty mati. */
  loyalty?: { rupiahPerPoint: number; pointValue: number; maxRedeemPercent: number };
  /** Promo aktif outlet (dari server). Kasir hanya memilih dari sini; kosong = tidak ada promo. */
  promos?: Promo[];
  /** Zona waktu outlet (menit dari UTC), dipakai jadwal promo; bawaan WIB. */
  utcOffsetMinutes?: number;
  /** Denah meja outlet; tidak ada = kasir mengetik nomor meja bebas. */
  tables?: TableDef[];
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
  /** Order ini diserahkan ke terminal lain dan belum selesai diurus: terkunci (status MERGED) sampai diambil atau ditarik kembali. */
  handedOff?: boolean;
  /** Order dari platform pesan-antar: kanal dan nomor pesanan di platform. Dibayar platform; tanpa diskon. */
  channel?: { channel: OnlineChannel; ref: string };
  /** Order dibuat dari pesanan toko web: nomor pesanan, kode pendek untuk pelanggan, dan nama pemesan. Dibayar di kasir seperti biasa. */
  /** Order dibuat untuk tamu yang didudukkan dari antrian: nomor tiket di server dan nomor yang dipanggil. */
  queue?: { id: number; label: string };
  webOrder?: { id: number; code: string; name: string };
  /** Member yang dikaitkan ke order ini beserta saldo poin yang diketahui saat dicari (saldo resmi ada di server). */
  member?: { id: string; name: string; points: number };
  /** Poin yang ditukar pada order ini (satu kali per order; tidak digabung dengan diskon lain). */
  pointsRedeemed?: number;
  /** Promo yang dipakai order ini (satu order, satu promo; tidak digabung dengan diskon lain). */
  promoId?: string;
  /** Order ini dibuat dari order terminal lain yang diserahkan kepadanya. */
  takenFrom?: { deviceId: string; orderId: string };
}

/** Order milik terminal lain yang menunggu diambil (dari server). Isinya salinan `order.handed_off` dari rantai terminal asal. */
export interface Handoff {
  orderId: string;
  fromDeviceId: string;
  orderType: 'DINE_IN' | 'TAKE_AWAY';
  tableNo?: string;
  items: LineItem[];
  /** Kapan diserahkan (jam server, ms). */
  at: number;
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

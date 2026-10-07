/** Nama aturan dalam bahasa biasa, untuk notifikasi dan dashboard. */
export const RULE_LABELS: Record<string, string> = {
  R1: 'customer di kasir tanpa order',
  R2: 'void setelah pesanan diproduksi',
  R3: 'void setelah customer pergi',
  R4: 'sensor/printer berhenti mengirim data',
  R5: 'kertas habis berkepanjangan',
  R5B: 'klaim kertas habis tidak sesuai printer',
  R7: 'pembayaran non-tunai tidak ada di bank',
  R8: 'nominal bank lebih kecil dari POS',
  R10: 'selisih total harian tidak terjelaskan',
  R18: 'diskon setelah bill dicetak',
  R21: 'refund tanpa customer',
  R22: 'metode bayar diubah setelah lunas',
  R23: 'diskon manual besar tanpa verifikasi',
  R24: 'integritas data perangkat',
  R25: 'order tanpa presence berulang',
  R26: 'transaksi bank tanpa pembayaran POS',
  R27: 'total settlement EDC berbeda dengan POS',
  R28: 'metode bayar di POS tidak sesuai settlement',
  R29: 'pengaturan keamanan perangkat kasir tidak aman',
};

export const ruleLabel = (rule: string): string => RULE_LABELS[rule] ?? rule;

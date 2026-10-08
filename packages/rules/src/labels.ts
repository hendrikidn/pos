/** Nama aturan dalam bahasa biasa, untuk notifikasi dan dashboard. */
export const RULE_LABELS: Record<string, string> = {
  R1: 'customer di kasir tanpa order',
  R2: 'void setelah pesanan diproduksi',
  R3: 'void setelah customer pergi',
  R4: 'sensor/printer berhenti mengirim data',
  R5: 'kertas habis berkepanjangan',
  R5B: 'klaim kertas habis tidak sesuai printer',
  R6: 'makan karyawan di luar kuota atau untuk diri sendiri',
  R7: 'pembayaran non-tunai tidak ada di bank',
  R8: 'nominal bank lebih kecil dari POS',
  R9: 'EDC/TID tidak sesuai registri outlet',
  R10: 'selisih total harian tidak terjelaskan',
  R14: 'selisih kas berulang saat tutup shift',
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
  R30: 'kas yang seharusnya dilaporkan terminal tidak sama dengan hitungan server',
};

export const ruleLabel = (rule: string): string => RULE_LABELS[rule] ?? rule;

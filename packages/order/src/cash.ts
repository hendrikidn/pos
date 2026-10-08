import type { EventOf, PosEvent } from '@pos/events';

export interface CashCheck {
  deviceId: string;
  seq: number;
  shiftId: string;
  /** `expected` yang dilaporkan terminal. */
  claimed: number;
  /** Hasil hitung ulang server; null bila tidak dapat diverifikasi. */
  serverExpected: number | null;
  /**
   * OK: sama. MISMATCH: berbeda. UNVERIFIABLE: tidak ada `shift.opened` yang cocok, atau rantai event antara pembukaan dan
   * penutupan tidak utuh (ada yang hilang), sehingga hitungan server pasti keliru; tidak dipakai.
   */
  status: 'OK' | 'MISMATCH' | 'UNVERIFIABLE';
  reason?: 'NO_SHIFT_OPEN' | 'CHAIN_GAP';
  openingCash?: number;
  cashIn?: number;
  cashOut?: number;
}

/**
 * Menghitung ulang uang tunai yang seharusnya ada di laci untuk satu `cash.counted`, hanya dari rantai event perangkat itu:
 *   modal awal (`shift.opened`) + pembayaran TUNAI − refund TUNAI, untuk event dengan seq di antara pembukaan dan penutupan.
 * Aturannya sama dengan yang dipakai terminal (`PosEngine.closeShift`). Terminal yang dimodifikasi dapat melaporkan `expected`
 * apa pun agar selisihnya selalu nol; hitungan ini tidak bisa dipalsukan tanpa mengubah rantai event (yang terdeteksi R24).
 *
 * `deviceEvents`: event perangkat yang sama; boleh memuat lebih dari yang diperlukan.
 */
export function verifyCashCount(count: EventOf<'cash.counted'>, deviceEvents: PosEvent[]): CashCheck {
  const base = { deviceId: count.deviceId, seq: count.seq, shiftId: count.payload.shiftId, claimed: count.payload.expected };
  const mine = deviceEvents.filter((e) => e.deviceId === count.deviceId);
  let opened: EventOf<'shift.opened'> | undefined;
  for (const e of mine) {
    if (e.type === 'shift.opened' && e.payload.shiftId === count.payload.shiftId && e.seq < count.seq && (!opened || e.seq > opened.seq)) opened = e;
  }
  if (!opened) return { ...base, serverExpected: null, status: 'UNVERIFIABLE', reason: 'NO_SHIFT_OPEN' };

  const between = mine.filter((e) => e.seq > opened!.seq && e.seq < count.seq);
  const seqs = new Set(between.map((e) => e.seq));
  if (seqs.size !== count.seq - opened.seq - 1) return { ...base, serverExpected: null, status: 'UNVERIFIABLE', reason: 'CHAIN_GAP' };

  let cashIn = 0;
  let cashOut = 0;
  for (const e of between) {
    if (e.type === 'payment.received' && e.payload.method === 'CASH') cashIn += e.payload.amount;
    else if (e.type === 'refund.created' && e.payload.method === 'CASH') cashOut += e.payload.amount;
  }
  const serverExpected = opened.payload.openingCash + cashIn - cashOut;
  return {
    ...base, serverExpected, status: serverExpected === count.payload.expected ? 'OK' : 'MISMATCH',
    openingCash: opened.payload.openingCash, cashIn, cashOut,
  };
}

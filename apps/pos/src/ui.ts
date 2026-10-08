import type { OrderRecord, Result } from '@pos/pos-core';
import type { Runtime } from './runtime';

export const rp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', SENT: 'Di dapur', BILLED: 'Ditagih', PAID: 'Lunas', VOIDED: 'Dibatalkan', MERGED: 'Digabung',
};

export const TYPE_LABEL: Record<string, string> = { DINE_IN: 'Dine-in', TAKE_AWAY: 'Take-away', EMPLOYEE: 'Karyawan' };

export const METHOD_LABEL: Record<string, string> = {
  CASH: 'Tunai', QRIS: 'QRIS', EDC_DEBIT: 'Kartu debit', EDC_CREDIT: 'Kartu kredit',
};

export interface Ctx {
  rt: Runtime;
  /** Memicu render ulang setelah engine berubah. */
  bump(): void;
  toast(message: string, kind?: 'error' | 'info'): void;
  /** Meminta PIN persetujuan dari orang lain. Mengembalikan null bila dibatalkan. */
  /** `exclude`: orang yang tidak boleh menjadi approver (mis. penerima makan karyawan). */
  approve(need: number, message: string, exclude?: string[]): Promise<{ userId: string; pin: string }[] | null>;
  selectOrder(id: string | null): void;
}

/** Menjalankan aksi engine: menampilkan pesan bila gagal, dan memperbarui tampilan bila berhasil. */
export async function run<T>(ctx: Ctx, fn: () => Promise<Result<T>>): Promise<Result<T>> {
  const r = await fn();
  if (!r.ok) ctx.toast(r.message, 'error');
  ctx.bump();
  return r;
}

export const isPaid = (o: OrderRecord) => o.state.status === 'PAID';
export const isActive = (o: OrderRecord) => ['DRAFT', 'SENT', 'BILLED'].includes(o.state.status);

/** Kode penolakan yang berarti "perlu persetujuan", bukan kesalahan. */
export const NEEDS_APPROVAL = new Set(['APPROVAL_REQUIRED', 'NOT_ENOUGH_APPROVERS', 'OWNER_REQUIRED', 'MEAL_APPROVAL_REQUIRED']);

/** Penjelasan ramah mengapa persetujuan diperlukan, berdasarkan kode penolakan dari engine. */
export function approvalHint(code: string): string {
  switch (code) {
    case 'OWNER_REQUIRED':
      return 'Tindakan ini memerlukan persetujuan owner (order sudah dibayar atau disajikan, atau nominal besar).';
    case 'NOT_ENOUGH_APPROVERS':
      return 'Void order yang sudah dikirim ke dapur atau ditagih memerlukan persetujuan supervisor. Nominal besar memerlukan dua persetujuan termasuk owner.';
    default:
      return 'Diskon ini memerlukan persetujuan supervisor.';
  }
}

/** Teks jenis order: "Dine-in · Meja 5", atau "Karyawan · Sari" untuk makan karyawan. */
export function orderLabel(o: OrderRecord, staff: { id: string; name: string }[]): string {
  const who = o.employeeId ? ` · ${staff.find((s) => s.id === o.employeeId)?.name ?? o.employeeId}` : '';
  return `${TYPE_LABEL[o.type]}${who}${o.tableNo ? ` · Meja ${o.tableNo}` : ''}`;
}

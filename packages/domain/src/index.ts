export type Bank = 'BCA' | 'BRI' | 'MANDIRI';
export type Channel = 'QRIS' | 'CARD_DEBIT' | 'CARD_CREDIT' | 'OTHER';
export type TxnStatus = 'SUCCESS' | 'FAILED' | 'REVERSED' | 'UNKNOWN';

/** Bentuk kanonik transaksi bank. Lihat docs/BANK-REPORT-FORMAT.md. Nominal dalam integer rupiah. */
export interface BankTxn {
  bank: Bank;
  mid: string;
  tid: string;
  /** YYYY-MM-DD, zona waktu outlet */
  txnDate: string;
  /** epoch ms, null jika laporan tidak mencantumkan jam */
  txnAt: number | null;
  channel: Channel;
  amount: number;
  mdr: number | null;
  netAmount: number | null;
  approvalCode: string | null;
  rrn: string | null;
  status: TxnStatus;
  settlementBatchId: string | null;
  settledAt: number | null;
  sourceRow: number;
}

export interface ParseIssue {
  row: number;
  message: string;
}

export interface BankReport {
  bank: Bank;
  txns: BankTxn[];
  /** Batas waktu (epoch ms) sampai kapan laporan ini mencakup transaksi. Null jika tidak diketahui. */
  coverageEndMs: number | null;
  errors: ParseIssue[];
}

export type PosPaymentMethod = 'QRIS' | 'EDC_DEBIT' | 'EDC_CREDIT';

export interface PosPayment {
  orderId: string;
  /** epoch ms */
  paidAt: number;
  tid: string;
  method: PosPaymentMethod;
  amount: number;
  approvalCode: string | null;
}

/** Kunci identitas untuk membuang baris duplikat saat laporan yang sama diimpor ulang. */
export function bankTxnKey(t: BankTxn): string {
  if (t.approvalCode || t.rrn) {
    return [t.bank, t.tid, t.approvalCode ?? '', t.rrn ?? ''].join('|');
  }
  return [t.bank, t.tid, t.txnAt ?? t.txnDate, t.amount].join('|');
}

export function dedupeBankTxns(txns: BankTxn[]): BankTxn[] {
  const seen = new Set<string>();
  const out: BankTxn[] = [];
  for (const t of txns) {
    const k = bankTxnKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export interface SettlementLine {
  count: number;
  /** rupiah */
  amount: number;
}

export interface ChannelSettlement {
  sale: SettlementLine;
  void: SettlementLine;
  refund: SettlementLine;
}

/**
 * Ringkasan penutupan batch EDC (slip settlement). Hanya jumlah dan total per jenis pembayaran,
 * tanpa rincian per transaksi, sehingga dipakai untuk rekonsiliasi per batch, bukan per transaksi.
 */
export interface SettlementSummary {
  bank: Bank;
  mid: string;
  tid: string;
  batch: string;
  /** epoch ms waktu batch ditutup */
  closedAt: number;
  channels: Partial<Record<Channel, ChannelSettlement>>;
}

export interface SettlementReport {
  summaries: SettlementSummary[];
  /** Hal yang meragukan (mis. total tidak cocok karena salah baca) tanpa menggagalkan parse. */
  warnings: string[];
}

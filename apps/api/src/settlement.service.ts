import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { parseMandiriSettlement, ParseError } from '@pos/bank-parsers';
import type { Bank, Channel, ChannelSettlement, SettlementLine, SettlementSummary } from '@pos/domain';
import { reconcileSettlement, type SettlementFinding } from '@pos/reconciliation';
import type { RuleHit } from '@pos/rules';
import type { ApiAuth } from './auth';
import { loadNonCashPayments, type PaymentInfo } from './bank.service';
import { Database } from './db/database';
import type { Queryable } from './db/driver';

const LOOKBACK_MS = 14 * 86_400_000;
const WEIGHTS = { R27: 35, R28: 10 } as const;
const BANKS: Record<string, Bank> = { BCA: 'BCA', BRI: 'BRI', MANDIRI: 'MANDIRI' };
const SLIP_CHANNELS: Channel[] = ['QRIS', 'CARD_DEBIT', 'CARD_CREDIT'];

export interface SlipInput {
  tid?: string;
  batch?: string;
  /** ISO 8601 dengan zona waktu, mis. 2026-10-01T21:57:19+07:00 */
  closedAt?: string;
  channels?: Partial<Record<Channel, { sale?: Partial<SettlementLine>; void?: Partial<SettlementLine>; refund?: Partial<SettlementLine> }>>;
}

export interface BatchResult {
  channels: { channel: Channel; pos: SettlementLine; slip: SettlementLine; ok: boolean }[];
  notes: string[];
}

const zero = (): SettlementLine => ({ count: 0, amount: 0 });
const bad = (m: string): never => {
  throw new BadRequestException(m);
};

function line(raw: Partial<SettlementLine> | undefined, where: string): SettlementLine {
  if (!raw) return zero();
  const { count = 0, amount = 0 } = raw;
  if (!Number.isInteger(count) || count < 0 || count > 100_000) bad(`${where}: jumlah transaksi tidak valid`);
  if (!Number.isInteger(amount) || amount < 0 || amount > 10_000_000_000) bad(`${where}: total harus bilangan bulat rupiah ≥ 0`);
  if ((count === 0) !== (amount === 0)) bad(`${where}: jumlah transaksi dan total harus sama-sama nol atau sama-sama terisi`);
  return { count, amount };
}

@Injectable()
export class SettlementService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /**
   * Menyimpan slip settlement (teks hasil baca slip, atau isian terstruktur) lalu menjalankan ulang rekonsiliasi batch.
   * TID harus terdaftar di outlet: slip dari mesin lain ditolak, bukan diterima diam-diam.
   */
  async importSlip(
    auth: ApiAuth, outletId: string, input: { text?: string; slip?: SlipInput }, now = Date.now(),
  ): Promise<{ batches: number; warnings: string[]; findings: number }> {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const outlet = (
        await q.query<{ utc_offset_minutes: number; edcs: { tid: string; bank: string }[] }>(
          'select utc_offset_minutes, edcs from outlet where id = $1',
          [outletId],
        )
      ).rows[0];
      if (!outlet) throw new BadRequestException('outlet tidak ditemukan');

      const warnings: string[] = [];
      let summaries: SettlementSummary[];
      if (typeof input.text === 'string' && input.text.trim() !== '') {
        try {
          const r = parseMandiriSettlement(input.text, { utcOffsetMinutes: outlet.utc_offset_minutes });
          summaries = r.summaries;
          warnings.push(...r.warnings);
        } catch (e) {
          if (e instanceof ParseError) throw new BadRequestException(e.message);
          throw e;
        }
      } else if (input.slip) {
        summaries = [this.fromStructured(input.slip, outlet.edcs)];
      } else {
        throw new BadRequestException('kirim `text` (isi slip) atau `slip` (isian terstruktur)');
      }

      for (const s of summaries) {
        if (!outlet.edcs.some((e) => e.tid === s.tid)) {
          throw new BadRequestException(`TID ${s.tid} tidak terdaftar di outlet ini. Periksa slip, atau daftarkan EDC di pengaturan outlet.`);
        }
        const prev = (
          await q.query<{ summary: SettlementSummary }>('select summary from settlement_batch where outlet_id = $1 and tid = $2 and batch = $3', [outletId, s.tid, s.batch])
        ).rows[0];
        await q.query(
          `insert into settlement_batch (tenant_id, outlet_id, tid, batch, bank, closed_at_ms, summary, uploaded_by)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
           on conflict (outlet_id, tid, batch)
           do update set bank = excluded.bank, closed_at_ms = excluded.closed_at_ms, summary = excluded.summary,
                         uploaded_by = excluded.uploaded_by, uploaded_at = now()`,
          [auth.tenantId, outletId, s.tid, s.batch, s.bank, s.closedAt, JSON.stringify(s), auth.userId],
        );
        if (prev) {
          // Mengoreksi slip yang sudah tersimpan boleh (salah ketik), tetapi harus terlihat di jejak audit.
          await q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [
            auth.tenantId, auth.userId, 'settlement.replace', JSON.stringify({ outletId, tid: s.tid, batch: s.batch, before: prev.summary.channels, after: s.channels }),
          ]);
          warnings.push(`batch ${s.batch} (TID ${s.tid}) sudah pernah diunggah dan diganti; perubahan tercatat di audit`);
        }
      }
      const findings = await this.reconcile(q, auth.tenantId, outletId, outlet.utc_offset_minutes, now);
      return { batches: summaries.length, warnings, findings };
    });
  }

  private fromStructured(slip: SlipInput, edcs: { tid: string; bank: string }[]): SettlementSummary {
    if (!slip.tid || !/^[0-9]{6,12}$/.test(slip.tid)) bad('TID harus 6–12 digit');
    if (!slip.batch || !/^[0-9]{1,10}$/.test(slip.batch)) bad('nomor batch harus berupa angka');
    const closedAt = Date.parse(slip.closedAt ?? '');
    if (!Number.isFinite(closedAt) || !/(Z|[+-]\d{2}:?\d{2})$/.test(slip.closedAt!)) bad('closedAt harus ISO 8601 dengan zona waktu, mis. 2026-10-01T21:57:19+07:00');
    const edc = edcs.find((e) => e.tid === slip.tid);
    const bank = BANKS[(edc?.bank ?? '').toUpperCase()] ?? bad(`bank EDC ${slip.tid} belum dikenali; atur nama bank di pengaturan outlet (BCA, BRI, atau Mandiri)`);
    const channels: Partial<Record<Channel, ChannelSettlement>> = {};
    for (const [c, v] of Object.entries(slip.channels ?? {}) as [Channel, NonNullable<SlipInput['channels']>[Channel]][]) {
      if (!SLIP_CHANNELS.includes(c)) bad(`jenis pembayaran tidak dikenal: ${c}`);
      channels[c] = { sale: line(v?.sale, `${c} penjualan`), void: line(v?.void, `${c} void`), refund: line(v?.refund, `${c} refund`) };
    }
    if (Object.keys(channels).length === 0) bad('isi minimal satu jenis pembayaran');
    return { bank, mid: '', tid: slip.tid!, batch: slip.batch!, closedAt, channels };
  }

  /** Menjalankan ulang pembandingan seluruh batch terbaru: batas awal tiap batch adalah penutupan batch sebelumnya pada TID yang sama. */
  private async reconcile(q: Queryable, tenantId: string, outletId: string, utc: number, now: number): Promise<number> {
    const from = now - LOOKBACK_MS;
    const batches = (
      await q.query<{ tid: string; batch: string; closed_at_ms: number; summary: SettlementSummary }>(
        'select tid, batch, closed_at_ms, summary from settlement_batch where outlet_id = $1 and closed_at_ms >= $2 order by tid, closed_at_ms',
        [outletId, from - LOOKBACK_MS],
      )
    ).rows;
    const { posPayments, info } = await loadNonCashPayments(q, outletId, from - 2 * 86_400_000);

    await q.query("delete from bank_finding where outlet_id = $1 and source = 'SETTLEMENT'", [outletId]);
    let count = 0;
    let prevClosed: number | null = null;
    let prevTid = '';
    for (const b of batches) {
      if (b.tid !== prevTid) prevClosed = null;
      prevTid = b.tid;
      const r = reconcileSettlement({ summary: b.summary, posPayments, windowStartMs: prevClosed, utcOffsetMinutes: utc });
      prevClosed = b.closed_at_ms;

      const notes = r.findings.flatMap((f) =>
        f.rule === 'WINDOW_ASSUMED' ? ['Batas awal batch diasumsikan awal hari karena batch sebelumnya belum ada. Hasil bisa meleset bila kasir tidak menutup batch setiap hari.']
        : f.rule === 'SLIP_HAS_VOID_REFUND' ? [`Slip memuat void/refund pada ${f.channel}; pembanding memakai yang paling mendekati.`]
        : [],
      );
      await q.query('update settlement_batch set result = $4::jsonb where outlet_id = $1 and tid = $2 and batch = $3', [
        outletId, b.tid, b.batch, JSON.stringify({ channels: r.channels, notes } satisfies BatchResult),
      ]);

      for (const hit of this.toHits(outletId, b.summary, r.findings, info)) {
        await q.query(
          "insert into bank_finding (tenant_id, outlet_id, hit_key, at_ms, hit, source) values ($1, $2, $3, $4, $5::jsonb, 'SETTLEMENT') on conflict (outlet_id, hit_key) do nothing",
          [tenantId, outletId, hit.key, hit.at, JSON.stringify(hit)],
        );
        count++;
      }
    }
    return count;
  }

  private toHits(outletId: string, s: SettlementSummary, findings: SettlementFinding[], info: Map<string, PaymentInfo>): RuleHit[] {
    const hits: RuleHit[] = [];
    const base = { outletId, context: false, confidence: 'HIGH' as const, modalities: ['BANK' as const, 'POS' as const] };

    const bind = (candidates: string[][]) => {
      const orders = [...new Set(candidates.flat())];
      const evidence = orders.flatMap((id) => {
        const p = info.get(id);
        return p ? [{ orderId: id, at: p.paidAt, amount: p.amount, terminalId: p.terminalId, actorId: p.actorId }] : [];
      });
      const times = evidence.map((e) => e.at);
      return {
        evidence,
        // Satu kombinasi yang pasti: insiden terikat ke order itu. Beberapa kemungkinan: tidak diikat ke order mana pun.
        orderId: candidates.length === 1 && candidates[0]!.length === 1 ? candidates[0]![0]! : null,
        actorIds: candidates.length === 1 ? [...new Set(evidence.flatMap((e) => (e.actorId ? [e.actorId] : [])))] : [],
        terminalId: candidates.length === 1 ? (evidence[0]?.terminalId ?? null) : null,
        at: times.length > 0 ? Math.min(...times) : s.closedAt,
        windowStart: times.length > 0 ? Math.min(...times) : s.closedAt,
        windowEnd: times.length > 0 ? Math.max(...times) : s.closedAt,
      };
    };

    for (const f of findings) {
      if (f.rule === 'R27') {
        const b = bind(f.candidates);
        const kind = f.diffAmount > 0 ? 'POS mencatat lebih banyak dari EDC' : f.diffAmount < 0 ? 'EDC mencatat lebih banyak dari POS' : 'jumlah transaksi sama tetapi total berbeda';
        hits.push({
          ...base, ...b, rule: 'R27', key: `R27:${s.tid}:${s.batch}:${f.channel}`, weight: WEIGHTS.R27,
          note: `Batch ${s.batch} (TID ${s.tid}), ${f.channel}: POS ${f.pos.count} transaksi Rp ${f.pos.amount.toLocaleString('id-ID')} vs slip ${f.slip.count} transaksi Rp ${f.slip.amount.toLocaleString('id-ID')} — ${kind}.${f.candidates.length > 1 ? ` ${f.candidates.length} kemungkinan kombinasi order.` : ''}`,
        });
      } else if (f.rule === 'R28') {
        const b = bind(f.candidates);
        hits.push({
          ...base, ...b, rule: 'R28', key: `R28:${s.tid}:${s.batch}:${f.recordedAs}>${f.settledAs}`, weight: WEIGHTS.R28,
          note: `Batch ${s.batch} (TID ${s.tid}): ${f.count} pembayaran Rp ${f.amount.toLocaleString('id-ID')} dicatat sebagai ${f.recordedAs} di POS, tetapi di slip tercatat sebagai ${f.settledAs}. Kemungkinan salah memilih metode bayar.`,
        });
      }
    }
    return hits;
  }

  /** Daftar batch terbaru beserta hasil pembandingannya, dan kapan batch terakhir tiap EDC ditutup. */
  async list(auth: ApiAuth, outletId: string) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const batches = (
        await q.query<{ tid: string; batch: string; bank: string; closed_at_ms: number; summary: SettlementSummary; result: BatchResult; uploaded_by: string }>(
          'select tid, batch, bank, closed_at_ms, summary, result, uploaded_by from settlement_batch where outlet_id = $1 order by closed_at_ms desc limit 60',
          [outletId],
        )
      ).rows;
      const edcs = (await q.query<{ edcs: { tid: string; bank: string; label: string }[] }>('select edcs from outlet where id = $1', [outletId])).rows[0]?.edcs ?? [];
      return {
        batches,
        edcs: edcs.map((e) => ({ ...e, last_closed_at_ms: batches.find((b) => b.tid === e.tid)?.closed_at_ms ?? null })),
      };
    });
  }
}

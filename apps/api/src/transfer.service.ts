import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiAuth } from './auth';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { CLOCK, type Clock } from './pipeline.service';
import { StockService } from './stock.service';
import { TRANSFER_STALE_MS } from './transfer-hits';

const need = (ok: unknown, message: string): void => {
  if (!ok) throw new BadRequestException(message);
};
const num = (v: unknown) => Number(v);
const MAX_QTY = 1_000_000_000;

export interface TransferInput { fromOutletId?: unknown; toOutletId?: unknown; note?: unknown; lines?: unknown }

interface TransferRow { id: string; from_outlet: string; to_outlet: string; status: 'SENT' | 'RECEIVED' | 'CANCELED'; note: string | null; sent_by: string; sent_at_ms: number; received_by: string | null; received_at_ms: number | null; cancel_reason: string | null; short: boolean }

/**
 * Transfer stok antar-outlet (mis. dapur pusat → outlet). Mengirim langsung mengurangi stok outlet asal; stok outlet tujuan baru bertambah saat
 * diterima, sebesar jumlah yang benar-benar diterima. Selisih (dikirim − diterima) dan kiriman yang menggantung adalah celah kebocoran,
 * jadi keduanya dicatat dan menjadi temuan (R40, R41).
 */
@Injectable()
export class TransferService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(StockService) private readonly stock: StockService,
  ) {}

  private audit(q: Queryable, auth: ApiAuth, action: string, detail: object) {
    return q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [auth.tenantId, auth.userId, action, JSON.stringify(detail)]);
  }

  private movement(q: Queryable, tenantId: string, outletId: string, ingredientId: string, kind: 'TRANSFER_IN' | 'TRANSFER_OUT', qty: number, note: string, user: string, at: number) {
    return q.query('insert into stock_movement (tenant_id, outlet_id, ingredient_id, kind, qty, note, user_id, at_ms) values ($1, $2, $3, $4, $5, $6, $7, $8)', [tenantId, outletId, ingredientId, kind, qty, note.slice(0, 140), user, at]);
  }

  async send(auth: ApiAuth, input: TransferInput): Promise<{ id: number }> {
    need(typeof input.fromOutletId === 'string' && typeof input.toOutletId === 'string', 'outlet asal dan tujuan wajib');
    need(input.fromOutletId !== input.toOutletId, 'outlet asal dan tujuan harus berbeda');
    need(Array.isArray(input.lines) && input.lines.length >= 1 && input.lines.length <= 50, 'transfer 1–50 baris');
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    need(note.length <= 140, 'catatan maks. 140 karakter');
    const lines = input.lines as { ingredientId?: unknown; qty?: unknown }[];
    const now = this.clock();
    return this.db.tenantTx(auth.tenantId, async (q) => {
      for (const o of [input.fromOutletId, input.toOutletId]) if ((await q.query('select 1 from outlet where id = $1', [o])).rowCount === 0) throw new NotFoundException(`outlet ${String(o)} tidak ditemukan`);
      const seen = new Set<string>();
      const ready: { ingredientId: string; qty: number; cost: number }[] = [];
      for (const [i, l] of lines.entries()) {
        need(typeof l?.ingredientId === 'string', `baris ${i + 1}: bahan wajib`);
        need(!seen.has(l.ingredientId as string), `baris ${i + 1}: bahan ${String(l.ingredientId)} muncul dua kali`);
        seen.add(l.ingredientId as string);
        need(Number.isInteger(l.qty) && (l.qty as number) >= 1 && (l.qty as number) <= MAX_QTY, `baris ${i + 1}: jumlah harus bilangan bulat ≥ 1`);
        const ing = (await q.query<{ active: boolean; avg_cost: string }>("select active, avg_cost from ingredient where id = $1 and kind = 'RAW'", [l.ingredientId])).rows[0];
        if (!ing) throw new NotFoundException(`bahan ${String(l.ingredientId)} tidak ditemukan`);
        need(ing.active, `bahan ${String(l.ingredientId)} nonaktif`);
        const have = await this.stock.onHand(q, input.fromOutletId as string, l.ingredientId as string, now);
        need(have === null || (l.qty as number) <= have, `baris ${i + 1}: stok ${String(l.ingredientId)} di outlet asal hanya ${have}`);
        ready.push({ ingredientId: l.ingredientId as string, qty: l.qty as number, cost: num(ing.avg_cost) });
      }
      const id = num((await q.query<{ id: string }>(
        "insert into stock_transfer (tenant_id, from_outlet, to_outlet, status, note, sent_by, sent_at_ms) values ($1, $2, $3, 'SENT', $4, $5, $6) returning id",
        [auth.tenantId, input.fromOutletId, input.toOutletId, note || null, auth.userId, now],
      )).rows[0]!.id);
      for (const [i, r] of ready.entries()) {
        await q.query('insert into stock_transfer_line (tenant_id, transfer_id, line_no, ingredient_id, qty_sent, unit_cost) values ($1, $2, $3, $4, $5, $6)', [auth.tenantId, id, i + 1, r.ingredientId, r.qty, r.cost]);
        await this.movement(q, auth.tenantId, input.fromOutletId as string, r.ingredientId, 'TRANSFER_OUT', r.qty, `Transfer #${id} ke ${String(input.toOutletId)}`, auth.userId, now);
      }
      await this.audit(q, auth, 'transfer.send', { id, from: input.fromOutletId, to: input.toOutletId, lines: ready.length });
      return { id };
    });
  }

  private async get(q: Queryable, id: number): Promise<TransferRow> {
    const t = (await q.query<TransferRow>('select id, from_outlet, to_outlet, status, note, sent_by, sent_at_ms, received_by, received_at_ms, cancel_reason, short from stock_transfer where id = $1 for update', [id])).rows[0];
    if (!t) throw new NotFoundException('transfer tidak ditemukan');
    return t;
  }

  /**
   * Menerima kiriman di outlet tujuan. Jumlah per baris (0 sampai jumlah dikirim) harus diisi untuk semua baris; yang kurang dari kiriman
   * menandai transfer ("kurang") dan menjadi temuan. Penerima tidak boleh pengirimnya sendiri (pemisahan tugas).
   */
  async receive(auth: ApiAuth, id: number, input: { lines?: unknown }): Promise<{ short: boolean; shortfallValue: number }> {
    need(Array.isArray(input.lines) && input.lines.length >= 1, 'jumlah diterima per baris wajib');
    const now = this.clock();
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const t = await this.get(q, id);
      if (t.status !== 'SENT') throw new ConflictException('transfer ini sudah diterima atau dibatalkan');
      if (t.sent_by === auth.userId) throw new ConflictException('penerima tidak boleh orang yang mengirim transfer ini');
      const lines = (await q.query<{ line_no: number; ingredient_id: string; qty_sent: number; unit_cost: string }>('select line_no, ingredient_id, qty_sent, unit_cost from stock_transfer_line where transfer_id = $1', [id])).rows;
      const got = new Map<string, number>();
      for (const [i, l] of (input.lines as { ingredientId?: unknown; qty?: unknown }[]).entries()) {
        need(typeof l?.ingredientId === 'string' && lines.some((x) => x.ingredient_id === l.ingredientId), `baris ${i + 1}: bahan tidak ada di transfer ini`);
        need(!got.has(l.ingredientId as string), `baris ${i + 1}: bahan muncul dua kali`);
        need(Number.isInteger(l.qty) && (l.qty as number) >= 0, `baris ${i + 1}: jumlah harus bilangan bulat ≥ 0`);
        got.set(l.ingredientId as string, l.qty as number);
      }
      need(got.size === lines.length, 'isi jumlah diterima untuk semua baris (boleh 0)');
      let shortfallValue = 0;
      for (const l of lines) {
        const qty = got.get(l.ingredient_id)!;
        need(qty <= l.qty_sent, `jumlah diterima ${l.ingredient_id} melebihi yang dikirim (${l.qty_sent})`);
        await q.query('update stock_transfer_line set qty_received = $3 where transfer_id = $1 and line_no = $2', [id, l.line_no, qty]);
        if (qty > 0) await this.movement(q, auth.tenantId, t.to_outlet, l.ingredient_id, 'TRANSFER_IN', qty, `Transfer #${id} dari ${t.from_outlet}`, auth.userId, now);
        shortfallValue += Math.round((l.qty_sent - qty) * num(l.unit_cost));
      }
      const short = lines.some((l) => got.get(l.ingredient_id)! < l.qty_sent);
      await q.query("update stock_transfer set status = 'RECEIVED', received_by = $2, received_at_ms = $3, short = $4 where id = $1", [id, auth.userId, now, short]);
      await this.audit(q, auth, 'transfer.receive', { id, short, shortfallValue });
      return { short, shortfallValue };
    });
  }

  /** Pengirim membatalkan kiriman yang belum diterima: stok outlet asal dikembalikan. */
  async cancel(auth: ApiAuth, id: number, reason: unknown): Promise<void> {
    const why = typeof reason === 'string' ? reason.trim() : '';
    need(why.length >= 3 && why.length <= 140, 'alasan pembatalan wajib (3–140 karakter)');
    const now = this.clock();
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const t = await this.get(q, id);
      if (t.status !== 'SENT') throw new ConflictException('transfer ini sudah diterima atau dibatalkan');
      const lines = (await q.query<{ ingredient_id: string; qty_sent: number }>('select ingredient_id, qty_sent from stock_transfer_line where transfer_id = $1', [id])).rows;
      for (const l of lines) await this.movement(q, auth.tenantId, t.from_outlet, l.ingredient_id, 'TRANSFER_IN', l.qty_sent, `Batal transfer #${id}`, auth.userId, now);
      await q.query("update stock_transfer set status = 'CANCELED', cancel_reason = $2 where id = $1", [id, why]);
      await this.audit(q, auth, 'transfer.cancel', { id, reason: why });
    });
  }

  async list(auth: ApiAuth, outletId?: string) {
    const now = this.clock();
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const rows = (await q.query<TransferRow>(
        `select id, from_outlet, to_outlet, status, note, sent_by, sent_at_ms, received_by, received_at_ms, cancel_reason, short from stock_transfer
         where ($1::text is null or from_outlet = $1 or to_outlet = $1) order by id desc limit 100`, [outletId ?? null],
      )).rows;
      const lines = rows.length === 0 ? [] : (await q.query<{ transfer_id: string; ingredient_id: string; name: string; unit: string; qty_sent: number; qty_received: number | null; unit_cost: string }>(
        `select l.transfer_id, l.ingredient_id, i.name, i.unit, l.qty_sent, l.qty_received, l.unit_cost from stock_transfer_line l
         join ingredient i on i.tenant_id = l.tenant_id and i.id = l.ingredient_id where l.transfer_id = any($1::bigint[]) order by l.transfer_id, l.line_no`, [rows.map((r) => r.id)],
      )).rows;
      return rows.map((r) => ({
        id: num(r.id), fromOutlet: r.from_outlet, toOutlet: r.to_outlet, status: r.status, note: r.note, sentBy: r.sent_by, sentAt: num(r.sent_at_ms), receivedBy: r.received_by,
        receivedAt: r.received_at_ms === null ? null : num(r.received_at_ms), cancelReason: r.cancel_reason, short: r.short, stale: r.status === 'SENT' && now - num(r.sent_at_ms) > TRANSFER_STALE_MS,
        lines: lines.filter((l) => num(l.transfer_id) === num(r.id)).map((l) => ({ ingredientId: l.ingredient_id, name: l.name, unit: l.unit, qtySent: l.qty_sent, qtyReceived: l.qty_received, unitCost: num(l.unit_cost) })),
      }));
    });
  }
}

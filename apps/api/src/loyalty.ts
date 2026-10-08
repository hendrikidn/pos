import { correctedTime, type PosEvent } from '@pos/events';
import type { Queryable } from './db/driver';

export const LOYALTY_TYPES = ['order.member_linked', 'payment.received', 'discount.applied', 'void.approved', 'refund.created'];

/** Nomor HP ke bentuk baku (digit, awalan 62): "0812-3456-7890", "+62 812 3456 7890", dan "6281234567890" sama. Null bila bukan nomor HP wajar. */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let d = raw.replace(/[\s().-]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (!/^\d+$/.test(d)) return null;
  if (d.startsWith('0')) d = `62${d.slice(1)}`;
  else if (!d.startsWith('62')) return null;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

interface Settings { rupiahPerPoint: number }

/**
 * Memperbarui buku besar poin dari event yang baru diterima (dipanggil dalam transaksi ingest, setelah event tersimpan). Idempoten:
 * kunci (perangkat, seq, jenis) mencegah baris ganda bila batch dikirim ulang. Saldo tidak pernah ditulis; saldo = jumlah baris buku besar.
 *  - pembayaran order yang dikaitkan ke member: EARN = lantai(nominal / rupiahPerPoint)
 *  - diskon POINTS: REDEEM; saldo yang menjadi negatif, member tak dikenal, atau member berbeda dari yang dikaitkan ke order = peringatan (R33)
 *  - void: poin yang diperoleh dari order itu dibalik dan poin yang ditukar dikembalikan; refund: dibalik sebanding nominalnya
 */
export async function applyLoyalty(q: Queryable, auth: { tenantId: string; outletId: string }, events: PosEvent[]): Promise<void> {
  const relevant = events.filter((e) => LOYALTY_TYPES.includes(e.type)).sort((a, b) => a.seq - b.seq);
  if (relevant.length === 0) return;
  const settings = (
    await q.query<{ rpp: number }>('select loyalty_rupiah_per_point as rpp from outlet where id = $1', [auth.outletId])
  ).rows[0];
  const cfg: Settings = { rupiahPerPoint: settings?.rpp ?? 0 };

  const linkCache = new Map<string, string | null>();
  const linkOf = async (orderId: string): Promise<string | null> => {
    if (linkCache.has(orderId)) return linkCache.get(orderId)!;
    const row = (
      await q.query<{ member: string }>(
        `select payload->>'memberId' as member from event
         where outlet_id = $1 and type = 'order.member_linked' and payload->>'orderId' = $2 order by device_time_ms limit 1`,
        [auth.outletId, orderId],
      )
    ).rows[0];
    linkCache.set(orderId, row?.member ?? null);
    return row?.member ?? null;
  };
  const memberExists = async (id: string) => (await q.query('select 1 from member where id = $1', [id])).rowCount > 0;

  const ledger = (e: PosEvent, member: string, kind: 'EARN' | 'REDEEM' | 'REVERSE', orderId: string, points: number) =>
    q.query(
      `insert into member_ledger (tenant_id, outlet_id, member_id, device_id, seq, kind, order_id, points, at_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing`,
      [auth.tenantId, auth.outletId, member, e.deviceId, e.seq, kind, orderId, points, correctedTime(e)],
    );
  const alert = (e: PosEvent, kind: 'UNKNOWN_MEMBER' | 'OVER_REDEEM' | 'MEMBER_MISMATCH', orderId: string, member: string, detail: string) =>
    q.query(
      `insert into loyalty_alert (tenant_id, outlet_id, device_id, seq, kind, order_id, member_id, actor_id, detail, at_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict do nothing`,
      [auth.tenantId, auth.outletId, e.deviceId, e.seq, kind, orderId, member, e.actorId, detail, correctedTime(e)],
    );

  for (const e of relevant) {
    switch (e.type) {
      case 'order.member_linked': {
        if (!(await memberExists(e.payload.memberId))) await alert(e, 'UNKNOWN_MEMBER', e.payload.orderId, e.payload.memberId, `order dikaitkan ke member ${e.payload.memberId} yang tidak terdaftar`);
        break;
      }
      case 'payment.received': {
        const member = await linkOf(e.payload.orderId);
        if (!member || cfg.rupiahPerPoint <= 0 || !(await memberExists(member))) break;
        const pts = Math.floor(e.payload.amount / cfg.rupiahPerPoint);
        if (pts > 0) await ledger(e, member, 'EARN', e.payload.orderId, pts);
        break;
      }
      case 'discount.applied': {
        const d = e.payload;
        if (d.kind !== 'POINTS' || !d.memberId || !d.points) break;
        if (!(await memberExists(d.memberId))) {
          await alert(e, 'UNKNOWN_MEMBER', d.orderId, d.memberId, `penukaran ${d.points} poin untuk member ${d.memberId} yang tidak terdaftar`);
          break;
        }
        const linked = await linkOf(d.orderId);
        if (linked !== d.memberId) await alert(e, 'MEMBER_MISMATCH', d.orderId, d.memberId, `poin member ${d.memberId} ditukar pada order yang ${linked ? `dikaitkan ke member ${linked}` : 'tidak dikaitkan ke member mana pun'}`);
        await ledger(e, d.memberId, 'REDEEM', d.orderId, -d.points);
        const balance = Number((await q.query<{ b: string }>('select coalesce(sum(points), 0) as b from member_ledger where tenant_id = $1 and member_id = $2', [auth.tenantId, d.memberId])).rows[0]!.b);
        if (balance < 0) await alert(e, 'OVER_REDEEM', d.orderId, d.memberId, `penukaran ${d.points} poin membuat saldo member ${d.memberId} menjadi ${balance}`);
        break;
      }
      case 'void.approved': {
        const orderId = e.payload.orderId;
        const rows = (await q.query<{ member_id: string; kind: string; points: number }>('select member_id, kind, points from member_ledger where outlet_id = $1 and order_id = $2', [auth.outletId, orderId])).rows;
        if (rows.length === 0) break;
        // Order dibatalkan: poin yang diperoleh dari order ini dibalik, poin yang ditukar untuknya dikembalikan (sisa pembalikan sebelumnya diperhitungkan).
        const net = rows.reduce((s, r) => s + Number(r.points), 0);
        if (net !== 0) await ledger(e, rows[0]!.member_id, 'REVERSE', orderId, -net);
        break;
      }
      case 'refund.created': {
        const orderId = e.payload.originalOrderId;
        const member = await linkOf(orderId);
        if (!member || cfg.rupiahPerPoint <= 0) break;
        const pts = Math.floor(e.payload.amount / cfg.rupiahPerPoint);
        if (pts > 0) await ledger(e, member, 'REVERSE', orderId, -pts);
        break;
      }
      default:
        break;
    }
  }
}

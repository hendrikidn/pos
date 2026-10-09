import type { Channel, InboundFacts, InboundItem } from './channel-inbound';
import type { Queryable } from './db/driver';

const num = (v: unknown) => Number(v);

/** Pesanan gerbang yang diterima sejak `fromMs` untuk GuardService, dengan menu platform yang sudah diterjemahkan ke menu outlet lewat pemetaan. */
export async function channelInboundFacts(q: Queryable, outletId: string, fromMs: number): Promise<InboundFacts[]> {
  const rows = (await q.query<{ id: string; channel: Channel; ref: string; status: string; decided_at_ms: number | null; items: InboundItem[] }>(
    "select id, channel, ref, status, decided_at_ms, items from channel_inbound where outlet_id = $1 and status = 'ACCEPTED' and decided_at_ms >= $2", [outletId, fromMs],
  )).rows;
  if (rows.length === 0) return [];
  const maps = (await q.query<{ channel: Channel; external_key: string; menu_id: string }>('select channel, external_key, menu_id from channel_item_map', [])).rows;
  const by = new Map(maps.map((m) => [`${m.channel}|${m.external_key}`, m.menu_id]));
  return rows.map((r) => ({
    id: num(r.id), channel: r.channel, ref: r.ref, status: r.status, decidedAtMs: r.decided_at_ms === null ? null : num(r.decided_at_ms),
    items: r.items.map((i) => ({ menuId: by.get(`${r.channel}|${i.key}`) ?? null, qty: i.qty, name: i.name })),
  }));
}

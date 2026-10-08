import { correctedTime, type EventOf, type PosEvent } from '@pos/events';
import { DEFAULT_CONFIG, type RuleConfig, type RuleHit } from './types';

/**
 * Aturan perilaku yang membutuhkan jendela data lebih panjang daripada aturan real-time (14 hari bawaan), plus aturan laci dan QR statis.
 *  - R11: void satu kasir hampir selalu disetujui orang yang sama (kolusi), padahal penyetuju lain bertugas di hari-hari itu.
 *  - R12: kasir menyimpang jauh dari rekannya pada void, refund, diskon manual, cetak ulang, atau penolakan struk.
 *  - R13: void dan ganti metode bayar menumpuk saat kertas habis (kertas habis dipakai sebagai alasan tidak mencetak struk).
 *  - R17: laci kas terbuka tanpa pembayaran atau refund tunai di sekitarnya.
 *  - R19: pembayaran QR statis padahal EDC atau QR dinamis tersedia di outlet.
 *  - R20: cetak ulang tagihan dan pindah meja menumpuk di jam terakhir sebelum tutup shift.
 * Hit hanya dikeluarkan untuk kejadian sejak `emitFrom`; kunci stabil, jadi evaluasi ulang tidak membuat duplikat.
 */
export interface BehaviorInput {
  events: PosEvent[];
  now: number;
  /** Hanya temuan dengan waktu sejak ini yang dikeluarkan (batas jendela insiden). */
  emitFrom: number;
  /** Outlet punya EDC atau QR dinamis (R19). */
  dynamicQrAvailable?: boolean;
  utcOffsetMinutes?: number;
  config?: Partial<RuleConfig>;
}

const rp = (n: number) => `Rp${Math.round(n).toLocaleString('id-ID')}`;

export function evaluateBehaviorRules(input: BehaviorInput): RuleHit[] {
  const cfg: RuleConfig = { ...DEFAULT_CONFIG, ...input.config, weights: { ...DEFAULT_CONFIG.weights, ...input.config?.weights } };
  const t = correctedTime;
  const off = input.utcOffsetMinutes ?? 420;
  const events = [...input.events].filter((e) => t(e) <= input.now + 86_400_000).sort((a, b) => t(a) - t(b) || a.seq - b.seq);
  const hits: RuleHit[] = [];
  const day = (ms: number) => new Date(ms + off * 60_000).toISOString().slice(0, 10);
  const weekKey = (ms: number) => Math.floor((ms + off * 60_000) / (7 * 86_400_000));
  const outletId = events[0]?.outletId ?? '';
  const push = (h: Omit<RuleHit, 'outletId' | 'windowStart' | 'windowEnd' | 'context' | 'confidence' | 'modalities' | 'orderId'> & { orderId?: string | null; windowStart?: number; windowEnd?: number }) => {
    if (h.at < input.emitFrom) return;
    hits.push({ outletId, modalities: ['POS'], orderId: null, windowStart: h.at, windowEnd: h.at, context: false, confidence: 'HIGH', ...h });
  };

  // ---- R11: pasangan kasir-penyetuju void ----
  const voids = events.filter((e): e is EventOf<'void.approved'> => e.type === 'void.approved' && !!e.actorId);
  const approversByDay = new Map<string, Set<string>>();
  for (const v of voids) {
    const set = approversByDay.get(day(t(v))) ?? approversByDay.set(day(t(v)), new Set()).get(day(t(v)))!;
    for (const a of v.payload.approverIds) set.add(a);
  }
  const byCashier = new Map<string, EventOf<'void.approved'>[]>();
  for (const v of voids) (byCashier.get(v.actorId!) ?? byCashier.set(v.actorId!, []).get(v.actorId!)!).push(v);
  for (const [cashier, list] of byCashier) {
    if (list.length < cfg.r11MinVoids) continue;
    const share = new Map<string, number>();
    for (const v of list) for (const a of new Set(v.payload.approverIds)) share.set(a, (share.get(a) ?? 0) + 1);
    for (const [approver, n] of share) {
      if (n / list.length < cfg.r11Share) continue;
      // Penyetuju satu-satunya yang bertugas wajar menyetujui hampir semuanya: hanya ditandai bila penyetuju lain ada di hari-hari yang sama.
      const others = new Set<string>();
      for (const v of list) for (const a of approversByDay.get(day(t(v))) ?? []) if (a !== approver && a !== cashier) others.add(a);
      if (others.size === 0) continue;
      const last = list[list.length - 1]!;
      push({
        rule: 'R11', key: `R11:${cashier}:${approver}:${weekKey(t(last))}`, weight: cfg.weights.R11 ?? 0, terminalId: last.deviceId, actorIds: [cashier, approver], at: t(last),
        note: `${n} dari ${list.length} void ${cashier} disetujui ${approver} (${Math.round((n / list.length) * 100)}%), padahal penyetuju lain bertugas (${[...others].join(', ')})`,
      });
    }
  }

  // ---- R12: kasir menyimpang dari rekannya ----
  const orders = new Map<string, number>();
  type Metric = 'void' | 'refund' | 'diskon manual' | 'cetak ulang' | 'penolakan struk';
  const counts = new Map<string, Record<Metric, { n: number; last: PosEvent | null }>>();
  const slot = (a: string) => counts.get(a) ?? counts.set(a, { void: { n: 0, last: null }, refund: { n: 0, last: null }, 'diskon manual': { n: 0, last: null }, 'cetak ulang': { n: 0, last: null }, 'penolakan struk': { n: 0, last: null } }).get(a)!;
  const billSeen = new Set<string>();
  const bump = (a: string | null, m: Metric, e: PosEvent) => { if (!a) return; const s = slot(a)[m]; s.n++; s.last = e; };
  for (const e of events) {
    if (e.type === 'order.created' && e.actorId && e.payload.orderType !== 'EMPLOYEE') orders.set(e.actorId, (orders.get(e.actorId) ?? 0) + 1);
    else if (e.type === 'void.approved') bump(e.actorId, 'void', e);
    else if (e.type === 'refund.created') bump(e.actorId, 'refund', e);
    else if (e.type === 'discount.applied' && e.payload.kind === 'MANUAL') bump(e.actorId, 'diskon manual', e);
    else if (e.type === 'receipt.declined') bump(e.actorId, 'penolakan struk', e);
    else if (e.type === 'bill.printed') {
      if (billSeen.has(e.payload.orderId)) bump(e.actorId, 'cetak ulang', e);
      billSeen.add(e.payload.orderId);
    }
  }
  const absolute: Record<Metric, number> = { void: 0.12, refund: 0.06, 'diskon manual': 0.2, 'cetak ulang': 0.2, 'penolakan struk': 0.3 };
  const cashiers = [...orders].filter(([, n]) => n >= cfg.r12MinOrders).map(([a]) => a);
  for (const metric of Object.keys(absolute) as Metric[]) {
    const rate = new Map(cashiers.map((a) => [a, (counts.get(a)?.[metric].n ?? 0) / orders.get(a)!]));
    for (const a of cashiers) {
      const c = counts.get(a)?.[metric];
      if (!c || !c.last || c.n < cfg.r12MinEvents) continue;
      const mine = rate.get(a)!;
      const peers = cashiers.filter((x) => x !== a).map((x) => rate.get(x)!);
      let flagged = false;
      let basis = '';
      if (peers.length >= 2) {
        const mean = peers.reduce((s, x) => s + x, 0) / peers.length;
        const sd = Math.sqrt(peers.reduce((s, x) => s + (x - mean) ** 2, 0) / peers.length);
        const limit = mean + cfg.r12Sigma * Math.max(sd, mean * 0.5, 0.01);
        flagged = mine > limit;
        basis = `rekan rata-rata ${(mean * 100).toFixed(1)}%`;
      } else {
        flagged = mine >= absolute[metric];
        basis = `ambang ${(absolute[metric] * 100).toFixed(0)}% (rekan kurang dari dua)`;
      }
      if (!flagged) continue;
      push({
        rule: 'R12', key: `R12:${a}:${metric}:${weekKey(t(c.last))}`, weight: cfg.weights.R12 ?? 0, terminalId: c.last.deviceId, actorIds: [a], at: t(c.last),
        note: `${metric} ${c.n} kali dari ${orders.get(a)} order (${(mine * 100).toFixed(1)}%), ${basis}`,
      });
    }
  }

  // ---- R13: void dan ganti metode bayar saat kertas habis ----
  type Iv = { start: number; end: number; terminalId: string };
  const intervals: Iv[] = [];
  const open = new Map<string, Iv>();
  for (const e of events) {
    if (e.type !== 'printer.status' && e.type !== 'printer.paper_claim') continue;
    const source = e.type === 'printer.status' ? e.payload.source : 'claim';
    const active = e.type === 'printer.status' ? e.payload.state === 'paperOut' : e.payload.active;
    const k = `${e.deviceId}|${source}`;
    const cur = open.get(k);
    if (active && !cur) open.set(k, { start: t(e), end: input.now, terminalId: e.deviceId });
    if (!active && cur) { cur.end = t(e); intervals.push(cur); open.delete(k); }
  }
  intervals.push(...open.values());
  const sensitive = events.filter((e) => e.type === 'void.approved' || e.type === 'payment.method_changed');
  if (sensitive.length >= cfg.r13MinEvents && intervals.length > 0) {
    const during = sensitive.filter((e) => intervals.some((iv) => iv.terminalId === e.deviceId && t(e) >= iv.start && t(e) <= iv.end));
    const span = Math.max(1, t(events[events.length - 1]!) - t(events[0]!));
    const paperTime = intervals.reduce((s, iv) => s + Math.max(0, Math.min(iv.end, input.now) - iv.start), 0);
    const timeShare = Math.min(1, paperTime / span);
    const eventShare = during.length / sensitive.length;
    if (during.length >= cfg.r13MinEvents && eventShare >= 0.5 && eventShare >= 3 * Math.max(timeShare, 0.02)) {
      const last = during[during.length - 1]!;
      const actors = [...new Set(during.map((e) => e.actorId).filter((a): a is string => !!a))];
      push({
        rule: 'R13', key: `R13:${last.deviceId}:${weekKey(t(last))}`, weight: cfg.weights.R13 ?? 0, terminalId: last.deviceId, actorIds: actors, at: t(last),
        note: `${during.length} dari ${sensitive.length} void dan penggantian metode bayar terjadi saat kertas habis, padahal kertas habis hanya ${(timeShare * 100).toFixed(1)}% dari waktu`,
      });
    }
  }

  // ---- R17: laci terbuka tanpa pembayaran tunai ----
  const cashEvents = events.filter((e) => (e.type === 'payment.received' && e.payload.method === 'CASH') || (e.type === 'refund.created' && e.payload.method === 'CASH'));
  for (const e of events) {
    if (e.type !== 'drawer.opened') continue;
    const near = cashEvents.some((c) => c.deviceId === e.deviceId && Math.abs(t(c) - t(e)) <= cfg.r17MatchMs);
    if (near) continue;
    const approved = !!e.payload.approverId;
    push({
      rule: 'R17', key: `R17:${e.deviceId}:${e.seq}`, weight: (approved ? cfg.weights.R17_APPROVED : cfg.weights.R17) ?? 0, terminalId: e.deviceId, actorIds: [e.actorId, e.payload.approverId].filter((a): a is string => !!a), at: t(e),
      note: `laci kas dibuka tanpa pembayaran atau refund tunai dalam ${Math.round(cfg.r17MatchMs / 1000)} detik${e.payload.reason ? ` (alasan: ${e.payload.reason}${approved ? `, disetujui ${e.payload.approverId}` : ''})` : ''}`,
    });
  }

  // ---- R19: QR statis padahal EDC atau QR dinamis tersedia ----
  if (input.dynamicQrAvailable) {
    for (const e of events) {
      if (e.type !== 'payment.received' || e.payload.method !== 'QR_STATIC') continue;
      push({
        rule: 'R19', key: `R19:${e.deviceId}:${e.seq}`, weight: cfg.weights.R19 ?? 0, terminalId: e.deviceId, orderId: e.payload.orderId, actorIds: e.actorId ? [e.actorId] : [], at: t(e),
        note: `pembayaran ${rp(e.payload.amount)} lewat QR statis padahal EDC atau QR dinamis tersedia; uangnya tidak bisa dicocokkan dengan bank otomatis`,
      });
    }
  }

  // ---- R20: cetak ulang dan pindah meja menjelang tutup shift ----
  const opened = new Map<string, number>();
  const seenBills = new Set<string>();
  const flow: { e: PosEvent; at: number }[] = [];
  for (const e of events) {
    if (e.type === 'bill.printed') { if (seenBills.has(e.payload.orderId)) flow.push({ e, at: t(e) }); seenBills.add(e.payload.orderId); }
    else if (e.type === 'order.table_changed') flow.push({ e, at: t(e) });
  }
  for (const e of events) {
    if (e.type === 'shift.opened') opened.set(e.deviceId, t(e));
    if (e.type !== 'shift.closed') continue;
    const close = t(e);
    const start = opened.get(e.deviceId) ?? close - 12 * 3_600_000;
    const mine = flow.filter((f) => f.e.deviceId === e.deviceId && f.at >= start && f.at <= close);
    const late = mine.filter((f) => f.at >= close - cfg.r20WindowMs);
    if (late.length >= cfg.r20MinEvents && late.length / mine.length >= 0.5) {
      push({
        rule: 'R20', key: `R20:${e.deviceId}:${e.seq}`, weight: cfg.weights.R20 ?? 0, terminalId: e.deviceId, actorIds: [...new Set(late.map((f) => f.e.actorId).filter((a): a is string => !!a))], at: close,
        windowStart: close - cfg.r20WindowMs, windowEnd: close,
        note: `${late.length} cetak ulang tagihan dan pindah meja dalam ${Math.round(cfg.r20WindowMs / 60_000)} menit sebelum tutup shift (${mine.length} sepanjang shift)`,
      });
    }
  }
  return hits.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

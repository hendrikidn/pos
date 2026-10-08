import { correctedTime, type EventOf, type PosEvent } from '@pos/events';

/** Aturan antrian meja yang murni (tanpa database): nomor tiket, urutan panggilan, perkiraan tunggu, dan temuan R48-R49. */

export const MAX_PARTY = 20;
/** Batas tiket yang menunggu per outlet: antrian sepanjang ini sudah tidak masuk akal (atau diserang). */
export const MAX_WAITING = 60;
/** Perkiraan lama tunggu per rombongan di depan (menit). Sengaja sederhana dan dinyatakan sebagai perkiraan. */
export const MINUTES_PER_PARTY = 4;
/** Tiket yang dipanggil baru boleh ditandai tidak datang setelah menunggu sekian lama sejak panggilan terakhir. */
export const NO_SHOW_AFTER_MS = 2 * 60_000;
/** Tamu didudukkan tetapi order kasirnya tidak dibuat dalam waktu ini menjadi temuan (R49). */
export const SEAT_LINK_GRACE_MS = 15 * 60_000;
/** Order dari tiket yang belum dibayar sekian lama setelah didudukkan menjadi temuan (R49). */
export const SEAT_UNPAID_AFTER_MS = 3 * 3_600_000;

export type TicketStatus = 'WAITING' | 'CALLED' | 'SEATED' | 'NO_SHOW' | 'CANCELED' | 'EXPIRED';

/** Nomor tiket: A001..A999, lalu B001, dst. (urutan per outlet per hari). */
export function labelOf(seq: number): string {
  const letter = String.fromCharCode(65 + Math.floor((seq - 1) / 999) % 26);
  return `${letter}${String(((seq - 1) % 999) + 1).padStart(3, '0')}`;
}

export const estimateWaitMin = (ahead: number) => Math.max(0, ahead) * MINUTES_PER_PARTY;

/** Alasan memanggil tiket yang bukan giliran pertama. TABLE_SIZE diperiksa mesin; yang lain wajib dijelaskan dan menjadi temuan R48. */
export const JUMP_REASONS = ['TABLE_SIZE', 'PRIORITY', 'OTHER'] as const;
export type JumpReason = (typeof JUMP_REASONS)[number];

export interface QueueTicketFacts { id: number; seq: number; partySize: number; status: TicketStatus; createdAtMs: number }

export type CallCheck = { ok: true; skipped: number[] } | { ok: false; message: string };

/**
 * Memeriksa pemanggilan satu tiket. Memanggil yang paling lama menunggu selalu boleh. Memanggil yang lain berarti melewati tiket di depannya:
 * wajib beralasan, dan alasan "meja cocok" hanya sah bila SEMUA tiket yang dilewati membawa rombongan lebih besar daripada yang dipanggil
 * (rombongan besar menunggu meja besar, yang kecil boleh masuk meja kecil yang kosong).
 */
export function checkCall(waiting: QueueTicketFacts[], target: QueueTicketFacts, reason: unknown, note: unknown): CallCheck {
  const ahead = waiting.filter((t) => t.status === 'WAITING' && t.seq < target.seq);
  if (ahead.length === 0) return { ok: true, skipped: [] };
  if (!JUMP_REASONS.includes(reason as JumpReason)) return { ok: false, message: `ada ${ahead.length} tiket yang lebih lama menunggu: pilih alasan melewati antrian` };
  if (reason === 'TABLE_SIZE' && !ahead.every((t) => t.partySize > target.partySize)) return { ok: false, message: 'alasan "meja cocok" hanya sah bila semua tiket yang dilewati membawa rombongan lebih besar' };
  if (reason !== 'TABLE_SIZE' && !(typeof note === 'string' && note.trim().length >= 3 && note.trim().length <= 80)) return { ok: false, message: 'jelaskan alasan melewati antrian (3–80 karakter)' };
  return { ok: true, skipped: ahead.map((t) => t.id) };
}

export interface QueueHit { rule: 'R48' | 'R49'; key: string; at: number; actor: string | null; terminalId: string | null; orderId: string | null; note: string }

export interface JumpFacts { id: number; label: string; reason: string; note: string | null; skippedLabels: string[]; at: number; actor: string | null }
export interface SeatedFacts { id: number; label: string; seatedAtMs: number; seatedBy: string | null }

/**
 * Temuan antrian:
 *  - R48: tiket dipanggil melewati antrian dengan alasan selain "meja cocok" (alasan itu diperiksa mesin; yang lain perlu ditinjau owner).
 *  - R49: tamu didudukkan dari antrian tetapi order kasirnya tidak dibuat dalam 15 menit; tautan ke tiket yang tidak ada atau belum didudukkan;
 *    satu tiket ke lebih dari satu order; order di-void; atau belum dibayar 3 jam setelah didudukkan.
 */
export function queueHits(jumps: JumpFacts[], seated: SeatedFacts[], linkedKnownIds: Set<number>, events: PosEvent[], now: number, fromMs: number): QueueHit[] {
  const t = correctedTime;
  const hits: QueueHit[] = [];
  for (const j of jumps) {
    if (j.reason === 'TABLE_SIZE') continue;
    hits.push({
      rule: 'R48', key: `R48:${j.id}`, at: j.at, actor: j.actor, terminalId: null, orderId: null,
      note: `antrian ${j.label} dipanggil melewati ${j.skippedLabels.join(', ')} dengan alasan ${j.reason === 'PRIORITY' ? 'prioritas' : 'lainnya'}${j.note ? `: ${j.note}` : ''}`,
    });
  }
  const links = events.filter((e): e is EventOf<'order.queue_linked'> => e.type === 'order.queue_linked').sort((a, b) => t(a) - t(b) || a.deviceId.localeCompare(b.deviceId) || a.seq - b.seq);
  const voided = new Map<string, number>();
  const paid = new Set<string>();
  for (const e of events) {
    if (e.type === 'void.approved' && !voided.has(e.payload.orderId)) voided.set(e.payload.orderId, t(e));
    else if (e.type === 'payment.received') paid.add(e.payload.orderId);
  }
  const byTicket = new Map<number, EventOf<'order.queue_linked'>[]>();
  for (const l of links) (byTicket.get(l.payload.ticketId) ?? byTicket.set(l.payload.ticketId, []).get(l.payload.ticketId)!).push(l);
  const seatedById = new Map(seated.map((s) => [s.id, s]));
  for (const [tid, ls] of byTicket) {
    const s = seatedById.get(tid);
    const first = ls[0]!;
    if (!s || !linkedKnownIds.has(tid)) {
      hits.push({ rule: 'R49', key: `R49:link:${tid}`, at: t(first), actor: first.actorId ?? null, terminalId: first.deviceId, orderId: first.payload.orderId, note: `order kasir ditautkan ke tiket antrian #${tid} yang tidak ada atau belum didudukkan` });
      continue;
    }
    const live = ls.filter((l) => !voided.has(l.payload.orderId));
    if (live.length > 1) hits.push({ rule: 'R49', key: `R49:dup:${tid}`, at: t(live[1]!), actor: live[1]!.actorId ?? null, terminalId: live[1]!.deviceId, orderId: live[1]!.payload.orderId, note: `tiket antrian ${s.label} ditautkan ke ${live.length} order kasir sekaligus` });
    for (const l of ls) {
      const oid = l.payload.orderId;
      const v = voided.get(oid);
      if (v !== undefined) hits.push({ rule: 'R49', key: `R49:void:${oid}`, at: v, actor: l.actorId ?? null, terminalId: l.deviceId, orderId: oid, note: `order kasir ${oid} dari tiket antrian ${s.label} di-void` });
      else if (!paid.has(oid) && now >= s.seatedAtMs + SEAT_UNPAID_AFTER_MS) hits.push({ rule: 'R49', key: `R49:unpaid:${oid}`, at: s.seatedAtMs + SEAT_UNPAID_AFTER_MS, actor: l.actorId ?? null, terminalId: l.deviceId, orderId: oid, note: `order kasir ${oid} dari tiket antrian ${s.label} belum dibayar lebih dari 3 jam setelah didudukkan` });
    }
  }
  for (const s of seated) {
    if (byTicket.has(s.id)) continue;
    const due = s.seatedAtMs + SEAT_LINK_GRACE_MS;
    if (now >= due) hits.push({ rule: 'R49', key: `R49:nolink:${s.id}`, at: due, actor: s.seatedBy, terminalId: null, orderId: null, note: `tiket antrian ${s.label} didudukkan tetapi order kasirnya tidak pernah dibuat` });
  }
  return hits.filter((h) => h.at >= fromMs);
}

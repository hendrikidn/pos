import {
  correctedTime, orderIdOf, verifyChain,
  type EventOf, type PosEvent,
} from '@pos/events';
import { DEFAULT_CONFIG, type Modality, type RuleConfig, type RuleHit, type RuleInput } from './types';

interface Session {
  start: number;
  end: number;
  terminalId?: string;
}

interface Link {
  session: Session;
  confidence: 'HIGH' | 'LOW';
}

const POS_ONLY: Modality[] = ['POS'];
const PHYSICAL_POS: Modality[] = ['PHYSICAL', 'POS'];

function localDate(ms: number, offsetMinutes: number): string {
  return new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * Mengevaluasi aturan Kelas 1 (R1–R6, R18, R21–R25, R29) terhadap aliran event satu outlet.
 * Deterministik: input yang sama menghasilkan hit yang sama.
 */
export function evaluateRules(input: RuleInput): RuleHit[] {
  const cfg: RuleConfig = {
    ...DEFAULT_CONFIG,
    ...input.config,
    weights: { ...DEFAULT_CONFIG.weights, ...input.config?.weights },
  };
  const { now, terminals, capabilities: caps } = input;
  const events = [...input.events].sort((a, b) => correctedTime(a) - correctedTime(b) || a.seq - b.seq);
  const t = correctedTime;
  const outletId = events[0]?.outletId ?? '';
  const hits: RuleHit[] = [];

  const hit = (h: Omit<RuleHit, 'outletId' | 'confidence' | 'context'> & { confidence?: 'HIGH' | 'LOW'; context?: boolean }) =>
    hits.push({ outletId, confidence: 'HIGH', context: false, ...h });

  // ---- indeks ----
  const byDevice = new Map<string, PosEvent[]>();
  const byOrder = new Map<string, PosEvent[]>();
  const sessions: Session[] = [];
  for (const e of events) {
    (byDevice.get(e.deviceId) ?? byDevice.set(e.deviceId, []).get(e.deviceId)!).push(e);
    const oid = orderIdOf(e);
    if (oid) (byOrder.get(oid) ?? byOrder.set(oid, []).get(oid)!).push(e);
    // Pemindahan item tercatat di kedua order: order tujuan perlu tahu dari mana itemnya datang.
    if (e.type === 'order.items_moved') (byOrder.get(e.payload.toOrderId) ?? byOrder.set(e.payload.toOrderId, []).get(e.payload.toOrderId)!).push(e);
    if (e.type === 'presence.session') {
      sessions.push({
        start: e.payload.start - e.clockOffsetMs,
        end: e.payload.end - e.clockOffsetMs,
        terminalId: e.payload.terminalId,
      });
    }
  }

  /** Waktu terakhir data perangkat yang lengkap (seq berurutan tanpa celah). */
  const watermark = (deviceId: string): number => {
    const list = [...(byDevice.get(deviceId) ?? [])].sort((a, b) => a.seq - b.seq);
    let last = -Infinity;
    let prevSeq: number | undefined;
    for (const e of list) {
      if (prevSeq !== undefined && e.seq !== prevSeq + 1) break;
      last = Math.max(last, t(e));
      prevSeq = e.seq;
    }
    return last;
  };
  const watermarks = new Map(terminals.map((id) => [id, watermark(id)]));
  /** Aturan "tidak ada event" hanya dievaluasi jika data terminal sudah lengkap sampai batas jendela, atau sudah lewat masa tunggu. */
  const absenceReady = (windowEnd: number): boolean =>
    now >= windowEnd && (terminals.every((id) => (watermarks.get(id) ?? -Infinity) >= windowEnd) || now - windowEnd >= cfg.lateGraceMs);

  const sessionsFor = (terminalId: string | null) =>
    sessions.filter((s) => !s.terminalId || !terminalId || s.terminalId === terminalId);

  /** Menghubungkan order dengan sesi presence yang paling banyak beririsan dengan jendela transaksinya. */
  const linkPresence = (terminalId: string | null, from: number, to: number): Link | null => {
    const lo = from - cfg.linkPadMs;
    const hi = to + cfg.linkPadMs;
    const scored = sessionsFor(terminalId)
      .map((s) => ({ s, overlap: Math.min(s.end, hi) - Math.max(s.start, lo) }))
      .filter((x) => x.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap);
    const best = scored[0];
    if (!best) return null;
    const rival = scored[1];
    return { session: best.s, confidence: rival && rival.overlap >= best.overlap * 0.5 ? 'LOW' : 'HIGH' };
  };

  const w = (key: string, link?: Link | null) => {
    const base = cfg.weights[key] ?? 0;
    return link?.confidence === 'LOW' ? Math.round(base * 0.5) : base;
  };

  // ---- aturan per order ----
  interface OrderView {
    id: string;
    terminalId: string;
    createdAt: number;
    orderType: string;
    created: EventOf<'order.created'>;
    sent?: PosEvent;
    bill?: PosEvent;
    payment?: PosEvent;
    voided?: EventOf<'void.approved'>;
    endAt: number;
    events: PosEvent[];
  }
  const orders: OrderView[] = [];
  for (const [id, list] of byOrder) {
    const created = list.find((e): e is EventOf<'order.created'> => e.type === 'order.created');
    if (!created) continue;
    const voided = list.find((e): e is EventOf<'void.approved'> => e.type === 'void.approved');
    const payment = list.find((e) => e.type === 'payment.received');
    const last = list.reduce((m, e) => Math.max(m, t(e)), 0);
    // Item yang dipindah ke order ini sudah dikirim dan mungkin sudah dimasak di order asalnya. Tanpa warisan ini, memisah item
    // ke order baru lalu mem-void-nya akan lolos dari R2 (riwayat dapur ada di order asal).
    const sources = list.flatMap((e) =>
      e.type === 'order.items_moved' && e.payload.toOrderId === id && e.payload.sent ? (byOrder.get(e.payload.fromOrderId) ?? []) : [],
    );
    orders.push({
      id,
      terminalId: created.deviceId,
      createdAt: t(created),
      orderType: created.payload.orderType,
      created,
      sent: list.find((e) => e.type === 'order.sent_to_kitchen') ?? sources.find((e) => e.type === 'order.sent_to_kitchen'),
      bill: list.find((e) => e.type === 'bill.printed'),
      payment,
      voided,
      endAt: voided ? t(voided) : payment ? t(payment) : last,
      events: [...list, ...sources.filter((e) => e.type === 'kitchen.status_changed')],
    });
  }
  orders.sort((a, b) => a.createdAt - b.createdAt);

  /** Dine-in yang bayar belakangan: customer ada di kasir saat membayar, bukan saat order. */
  const linkOrder = (o: OrderView): Link | null => {
    const from = o.orderType === 'DINE_IN' && o.bill ? t(o.bill) : o.createdAt;
    return linkPresence(o.terminalId, from, o.endAt);
  };

  for (const o of orders) {
    const ids = [o.created.actorId].filter((x): x is string => !!x);

    // R2: void setelah produksi
    if (o.voided) {
      const v = o.voided;
      const vt = t(v);
      const actors = [...ids, ...(v.actorId ? [v.actorId] : []), ...v.payload.approverIds];
      const produced = o.events.some(
        (e) => e.type === 'kitchen.status_changed' && t(e) <= vt,
      );
      if (caps.kds && produced) {
        hit({
          rule: 'R2', key: `R2:${o.id}`, weight: w('R2'), modalities: POS_ONLY, terminalId: o.terminalId, orderId: o.id,
          actorIds: actors, at: vt, windowStart: o.sent ? t(o.sent) : o.createdAt, windowEnd: vt,
          note: 'void setelah tiket dapur dimasak/siap/disajikan',
        });
      } else if (!caps.kds && o.sent && vt - t(o.sent) > cfg.r2ProxyDelayMs) {
        hit({
          rule: 'R2', key: `R2:${o.id}`, weight: w('R2_PROXY'), modalities: POS_ONLY, terminalId: o.terminalId, orderId: o.id,
          actorIds: actors, at: vt, windowStart: t(o.sent), windowEnd: vt,
          note: 'void lebih dari 5 menit setelah dikirim ke dapur (tanpa KDS)',
        });
      }

      // R3: void setelah customer meninggalkan kasir
      if (caps.sensor && (o.payment || o.bill)) {
        const link = linkOrder(o);
        const stillThere = sessionsFor(o.terminalId).some((s) => s.start <= vt && s.end > vt - cfg.r3AfterPresenceMs);
        if (link && !stillThere && vt - link.session.end > cfg.r3AfterPresenceMs) {
          hit({
            rule: 'R3', key: `R3:${o.id}`, weight: w('R3', link), modalities: PHYSICAL_POS, terminalId: o.terminalId,
            orderId: o.id, actorIds: actors, at: vt, windowStart: link.session.start, windowEnd: vt,
            confidence: link.confidence,
            note: `void ${Math.round((vt - link.session.end) / 1000)} dtk setelah customer pergi`,
          });
        }
      }
    }

    // R18, R23: diskon
    const billAt = o.bill ? t(o.bill) : undefined;
    for (const d of o.events.filter((e): e is EventOf<'discount.applied'> => e.type === 'discount.applied')) {
      const actor = d.actorId ? [d.actorId] : [];
      if (billAt !== undefined && t(d) > billAt) {
        const approved = !!d.payload.approverId;
        hit({
          rule: 'R18', key: `R18:${o.id}:${d.seq}`, weight: w(approved ? 'R18_APPROVED' : 'R18'), modalities: POS_ONLY,
          terminalId: o.terminalId, orderId: o.id, actorIds: [...actor, ...(d.payload.approverId ? [d.payload.approverId] : [])],
          at: t(d), windowStart: billAt, windowEnd: t(d),
          note: approved ? 'diskon setelah bill dicetak (disetujui)' : 'diskon setelah bill dicetak tanpa persetujuan',
        });
      }
      const p = d.payload;
      if (p.kind === 'MANUAL' && !p.verified && !p.approverId &&
          (p.percent > cfg.discountMaxPercent || p.amount > cfg.discountMaxAmount)) {
        hit({
          rule: 'R23', key: `R23:${o.id}:${d.seq}`, weight: w('R23'), modalities: POS_ONLY, terminalId: o.terminalId,
          orderId: o.id, actorIds: actor, at: t(d), windowStart: t(d), windowEnd: t(d),
          note: 'diskon manual besar tanpa verifikasi atau persetujuan',
        });
      }
    }

    // R22: metode bayar diubah setelah lunas
    for (const m of o.events.filter((e): e is EventOf<'payment.method_changed'> => e.type === 'payment.method_changed')) {
      if (o.payment && t(m) > t(o.payment)) {
        hit({
          rule: 'R22', key: `R22:${o.id}:${m.seq}`, weight: w('R22'), modalities: POS_ONLY, terminalId: o.terminalId,
          orderId: o.id, actorIds: m.actorId ? [m.actorId] : [], at: t(m), windowStart: t(o.payment), windowEnd: t(m),
          note: `metode bayar diubah ${m.payload.from} → ${m.payload.to} setelah lunas`,
        });
      }
    }

    // R21: refund tanpa customer
    if (caps.sensor) {
      for (const r of o.events.filter((e): e is EventOf<'refund.created'> => e.type === 'refund.created')) {
        const lo = t(r) - cfg.r21ToleranceMs;
        const hi = t(r) + cfg.r21ToleranceMs;
        if (!absenceReady(hi)) continue;
        const present = sessionsFor(r.deviceId).some((s) => s.end >= lo && s.start <= hi);
        if (!present) {
          hit({
            rule: 'R21', key: `R21:${r.payload.refundId}`, weight: w('R21'), modalities: PHYSICAL_POS, terminalId: r.deviceId,
            orderId: o.id, actorIds: [...(r.actorId ? [r.actorId] : []), r.payload.approverId], at: t(r),
            windowStart: lo, windowEnd: hi, note: 'refund dibuat tanpa ada customer di depan kasir',
          });
        }
      }
    }
  }

  // ---- R6: order karyawan di luar kuota harian, atau dibuat oleh penerimanya sendiri ----
  // Order yang di-void tidak dihitung ke kuota. Jendela evaluasi hanya memuat sebagian hari paling awal,
  // jadi hitungan bisa kurang (terlewat), tidak pernah lebih (tuduhan palsu).
  const utcOffset = input.utcOffsetMinutes ?? 420;
  const mealsPerDay = new Map<string, number>();
  for (const o of orders) {
    const employeeId = o.created.payload.employeeId;
    if (o.orderType !== 'EMPLOYEE' || o.voided || !employeeId) continue;
    const dayKey = `${employeeId}|${localDate(o.createdAt, utcOffset)}`;
    const nth = (mealsPerDay.get(dayKey) ?? 0) + 1;
    mealsPerDay.set(dayKey, nth);
    const reasons: string[] = [];
    if (nth > cfg.r6DailyQuota) reasons.push(`makan karyawan ke-${nth} hari ini untuk ${employeeId} (kuota ${cfg.r6DailyQuota})`);
    if (o.created.actorId === employeeId) reasons.push('dibuat oleh penerimanya sendiri');
    if (reasons.length === 0) continue;
    // Disetujui secara independen = approver bukan pembuat dan bukan penerima. Tetap dicatat (bobot rendah) agar owner bisa
    // melihat pola, tetapi tidak sama beratnya dengan makan yang lolos tanpa persetujuan.
    const approver = o.created.payload.approverId;
    const independent = !!approver && approver !== o.created.actorId && approver !== employeeId;
    if (independent) reasons.push(`disetujui ${approver}`);
    else if (approver) reasons.push(`approver ${approver} tidak independen`);
    hit({
      rule: 'R6', key: `R6:${o.id}`, weight: w(independent ? 'R6_APPROVED' : 'R6'), modalities: POS_ONLY, terminalId: o.terminalId, orderId: o.id,
      actorIds: [...new Set([o.created.actorId, employeeId, ...(independent ? [approver] : [])].filter((x): x is string => !!x))],
      at: o.createdAt, windowStart: o.createdAt, windowEnd: o.endAt, note: reasons.join('; '),
    });
  }

  // ---- R1: presence lama tanpa order ----
  if (caps.sensor) {
    const drawer = events.filter((e) => e.type === 'drawer.opened');
    for (const s of sessions) {
      if (s.end - s.start < cfg.r1MinPresenceMs) continue;
      const windowEnd = s.start + cfg.r1OrderWindowMs;
      if (!absenceReady(windowEnd)) continue;
      const scope = s.terminalId ? [s.terminalId] : terminals;
      const active = events.some(
        (e) =>
          scope.includes(e.deviceId) &&
          (e.type === 'order.created' || e.type === 'bill.printed' || e.type === 'payment.received') &&
          t(e) >= s.start && t(e) <= windowEnd,
      );
      if (active) continue;
      const drawerOpen = drawer.some((e) => scope.includes(e.deviceId) && t(e) >= s.start && t(e) <= s.end);
      hit({
        rule: 'R1', key: `R1:${s.start}`, weight: w(drawerOpen ? 'R1_DRAWER' : 'R1'), modalities: PHYSICAL_POS,
        terminalId: scope.length === 1 ? scope[0]! : null, orderId: null, actorIds: [], at: s.start,
        windowStart: s.start, windowEnd,
        note: `customer ${Math.round((s.end - s.start) / 1000)} dtk tanpa order${drawerOpen ? ', laci terbuka' : ''}`,
      });
    }
  }

  // ---- R25: order berturut-turut tanpa presence ----
  if (caps.sensor) {
    for (const terminal of terminals) {
      const mine = orders.filter((o) => o.terminalId === terminal);
      let run: OrderView[] = [];
      let emitted = false;
      for (const o of mine) {
        if (!absenceReady(o.endAt + cfg.linkPadMs)) break;
        if (linkOrder(o)) {
          run = [];
          emitted = false;
          continue;
        }
        run.push(o);
        if (run.length >= cfg.r25Run && !emitted) {
          emitted = true;
          hit({
            rule: 'R25', key: `R25:${terminal}:${run[0]!.id}`, weight: w('R25'), modalities: PHYSICAL_POS, terminalId: terminal,
            orderId: null, actorIds: [...new Set(run.map((r) => r.created.actorId).filter((x): x is string => !!x))],
            at: o.createdAt, windowStart: run[0]!.createdAt, windowEnd: o.endAt,
            note: `${run.length} order berturut-turut tanpa presence customer (sensor terhalang atau salah posisi?)`,
          });
        }
      }
    }
  }

  // ---- R5 / R5b: kertas habis ----
  const payments = events.filter((e) => e.type === 'payment.received');
  const printerEvents = events.filter(
    (e): e is EventOf<'printer.status'> | EventOf<'printer.paper_claim'> =>
      e.type === 'printer.status' || e.type === 'printer.paper_claim',
  );
  type Interval = { start: number; end: number; terminalId: string; source: 'device' | 'claim'; actor: string | null };
  const intervals: Interval[] = [];
  const open = new Map<string, Interval>();
  for (const e of printerEvents) {
    const source = e.type === 'printer.status' ? e.payload.source : 'claim';
    const active = e.type === 'printer.status' ? e.payload.state === 'paperOut' : e.payload.active;
    const k = `${e.deviceId}|${source}`;
    const cur = open.get(k);
    if (active && !cur) open.set(k, { start: t(e), end: now, terminalId: e.deviceId, source, actor: e.actorId });
    if (!active && cur) {
      cur.end = t(e);
      intervals.push(cur);
      open.delete(k);
    }
  }
  intervals.push(...open.values());
  for (const iv of intervals) {
    const flagAt = iv.start + cfg.r5PaperOutMs;
    if (iv.end < flagAt) continue;
    const traded = payments.some((p) => p.deviceId === iv.terminalId && t(p) >= flagAt && t(p) <= iv.end);
    if (!traded) continue;
    hit({
      rule: 'R5', key: `R5:${iv.terminalId}:${iv.source}:${iv.start}`, weight: w('R5'), modalities: ['PHYSICAL'],
      terminalId: iv.terminalId, orderId: null, actorIds: iv.actor ? [iv.actor] : [], at: flagAt,
      windowStart: iv.start, windowEnd: iv.end, context: true,
      note: `kertas habis (${iv.source === 'device' ? 'status printer' : 'klaim kasir'}) lebih dari 15 menit sementara transaksi berjalan`,
    });
  }
  if (caps.printerReportsStatus) {
    for (const c of printerEvents) {
      if (c.type !== 'printer.paper_claim' || !c.payload.active) continue;
      const lastDevice = [...printerEvents]
        .filter((e): e is EventOf<'printer.status'> => e.type === 'printer.status' && e.payload.source === 'device' && e.deviceId === c.deviceId && t(e) <= t(c))
        .pop();
      if (lastDevice && lastDevice.payload.state === 'ok') {
        hit({
          rule: 'R5B', key: `R5B:${c.deviceId}:${c.seq}`, weight: w('R5B'), modalities: ['PHYSICAL'], terminalId: c.deviceId,
          orderId: null, actorIds: c.actorId ? [c.actorId] : [], at: t(c), windowStart: t(c), windowEnd: t(c),
          context: true, note: 'kasir mengklaim kertas habis padahal printer melaporkan normal',
        });
      }
    }
  }

  // ---- R4: sensor/printer berhenti mengirim detak saat POS tetap bertransaksi ----
  const beats = events.filter((e) => e.type === 'device.heartbeat' || e.type === 'presence.session');
  const beatDevices = new Set(beats.filter((e) => e.type === 'presence.session' || (e.type === 'device.heartbeat' && e.payload.kind !== 'terminal')).map((e) => e.deviceId));
  const terminalEvents = events.filter((e) => terminals.includes(e.deviceId) && e.type !== 'device.heartbeat');
  for (const dev of beatDevices) {
    if (terminals.includes(dev)) continue;
    const times = beats.filter((e) => e.deviceId === dev).map(t);
    const edges = [...times, now];
    for (let i = 0; i + 1 < edges.length; i++) {
      const from = edges[i]!;
      const to = edges[i + 1]!;
      if (to - from <= cfg.r4GapMs) continue;
      const inGap = terminalEvents.filter((e) => t(e) > from + cfg.r4GapMs && t(e) <= to);
      if (inGap.length === 0) continue;
      hit({
        rule: 'R4', key: `R4:${dev}:${from}`, weight: w('R4'), modalities: ['PHYSICAL'], terminalId: inGap[0]!.deviceId,
        orderId: null, actorIds: [], at: from + cfg.r4GapMs, windowStart: from, windowEnd: to, context: true,
        note: `perangkat ${dev} tidak mengirim detak ${Math.round((to - from) / 60_000)} menit sementara POS bertransaksi`,
      });
    }
  }

  // ---- R29: postur keamanan perangkat ----
  for (const e of events) {
    if (e.type !== 'device.posture') continue;
    const p = e.payload;
    const issues: [string, number, string][] = [];
    if (!p.autoTime) issues.push(['R29_TIME', 1, 'waktu otomatis dimatikan: jam perangkat bisa diubah kasir']);
    if (p.rooted) issues.push(['R29_ROOT', 1, 'perangkat terindikasi di-root']);
    if (p.adb || p.devOptions) issues.push(['R29_DEBUG', 1, 'USB debugging atau opsi pengembang aktif']);
    for (const [key, , note] of issues) {
      hit({
        rule: 'R29', key: `R29:${e.deviceId}:${e.seq}:${key}`, weight: w(key), modalities: ['PHYSICAL'], terminalId: e.deviceId,
        orderId: null, actorIds: e.actorId ? [e.actorId] : [], at: t(e), windowStart: t(e), windowEnd: t(e), note,
      });
    }
  }

  // ---- R31: order berpindah antar-terminal di luar serah-terima ----
  // Satu-satunya jalan sah memindahkan order milik terminal lain adalah `order.handed_off` dari terminal asal lalu `order.items_moved` (MERGE)
  // oleh penerima. Selain itu (tanpa penyerahan, isi berbeda dari yang diserahkan, atau diambil dua kali) isi order bisa dimanipulasi.
  {
    const creator = new Map<string, string>();
    const handed = new Map<string, { deviceId: string; at: number; qty: number; value: number; reclaimed: boolean }>();
    const taken = new Set<string>();
    const worth = (items: { qty: number; unitPrice: number }[]) => items.reduce((a, l) => a + l.qty * l.unitPrice, 0);
    for (const e of events) {
      if (e.type === 'order.created') creator.set(e.payload.orderId, e.deviceId);
      else if (e.type === 'order.handed_off') {
        handed.set(e.payload.orderId, { deviceId: e.deviceId, at: t(e), qty: e.payload.items.reduce((a, l) => a + l.qty, 0), value: worth(e.payload.items), reclaimed: false });
        taken.delete(e.payload.orderId);
      } else if (e.type === 'order.handoff_reclaimed') {
        const h = handed.get(e.payload.orderId);
        if (h && h.deviceId === e.deviceId) h.reclaimed = true;
      } else if (e.type === 'order.items_moved' && e.payload.kind === 'MERGE') {
        const from = e.payload.fromOrderId;
        const origin = creator.get(from);
        if (origin === undefined || origin === e.deviceId) continue; // gabung order sendiri, atau asal order tidak terlihat di jendela ini
        const h = handed.get(from);
        const why =
          !h || h.deviceId !== origin || h.reclaimed ? `order ${from} milik ${origin} dipindahkan oleh ${e.deviceId} tanpa diserahkan oleh ${origin}`
          : taken.has(from) ? `order ${from} yang diserahkan diambil lebih dari sekali`
          : h.qty !== e.payload.items.reduce((a, l) => a + l.qty, 0) || h.value !== worth(e.payload.items) ? `isi order ${from} berbeda dari yang diserahkan ${origin}`
          : null;
        taken.add(from);
        if (!why) continue;
        hit({
          rule: 'R31', key: `R31:${e.deviceId}:${e.seq}`, weight: w('R31'), modalities: POS_ONLY, terminalId: e.deviceId, orderId: e.payload.toOrderId,
          actorIds: e.actorId ? [e.actorId] : [], at: t(e), windowStart: t(e), windowEnd: t(e), note: why,
        });
      }
    }
  }

  // ---- R24: integritas event ----
  for (const [deviceId, list] of byDevice) {
    for (const issue of verifyChain(list)) {
      const at = list.find((e) => e.seq === issue.seq);
      const when = at ? t(at) : now;
      hit({
        rule: 'R24', key: `R24:${deviceId}:${issue.seq}:${issue.kind}`, weight: w('R24'), modalities: POS_ONLY,
        terminalId: terminals.includes(deviceId) ? deviceId : null, orderId: null, actorIds: at?.actorId ? [at.actorId] : [],
        at: when, windowStart: when, windowEnd: when, note: `${issue.kind}: ${issue.detail}`,
      });
    }
  }

  for (const x of input.extraIntegrity ?? []) {
    hit({
      rule: 'R24', key: `R24:${x.deviceId}:${x.seq}:${x.kind}`, weight: w('R24'), modalities: POS_ONLY,
      terminalId: terminals.includes(x.deviceId) ? x.deviceId : null, orderId: null, actorIds: x.actorId ? [x.actorId] : [],
      at: x.at, windowStart: x.at, windowEnd: x.at, note: `${x.kind}: event ${x.deviceId}#${x.seq}`,
    });
  }

  return hits.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

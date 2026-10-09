import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { newToken, sha256, type ApiAuth, type DeviceAuth } from './auth';
import { checkInbound, CHANNELS, INBOUND_EXPIRE_MS, REF_RE, type Channel, type InboundItem } from './channel-inbound';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { CLOCK, type Clock } from './pipeline.service';
import { RateLimiter } from './rate-limit';
import { DAY_MS } from './sales-report';

const num = (v: unknown) => Number(v);
const need = (ok: unknown, message: string): void => {
  if (!ok) throw new BadRequestException(message);
};
const clean = (v: unknown, min: number, max: number): string | null => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return s.length >= min && s.length <= max ? s : null;
};
const asChannel = (v: unknown): Channel => {
  need(typeof v === 'string' && (CHANNELS as readonly string[]).includes(v), 'kanal harus GOFOOD, GRABFOOD, atau SHOPEEFOOD');
  return v as Channel;
};

const KEY_PREFIX = 'chn_';
const CALLS_PER_KEY_PER_MINUTE = 240;
const CALLS_PER_IP_PER_MINUTE = 120;
const PENDING_PER_OUTLET = 100;
/** Pembatalan oleh platform terhadap pesanan yang sudah diterima tetap ditampilkan ke kasir selama ini. */
const CANCEL_NOTICE_MS = 2 * 3_600_000;

interface Gate { integrationId: number; tenantId: string; outletId: string; channel: Channel }
interface InboundRow {
  id: string; outlet_id: string; channel: Channel; ref: string; customer_name: string | null; note: string | null; items: InboundItem[]; total: string; received_at_ms: number;
  status: 'NEW' | 'ACCEPTED' | 'REJECTED' | 'CANCELED' | 'EXPIRED'; decided_by: string | null; decided_at_ms: number | null; decided_reason: string | null; platform_canceled_at_ms: number | null;
}
const COLS = 'id, outlet_id, channel, ref, customer_name, note, items, total, received_at_ms, status, decided_by, decided_at_ms, decided_reason, platform_canceled_at_ms';

/**
 * Gerbang pesanan GoFood, GrabFood, dan ShopeeFood yang masuk langsung ke POS. Platform (atau perantara/integrator yang memegang akses resmi
 * ke platform) mengirim pesanan ke alamat publik dengan kunci per outlet dan kanal; pesanan muncul di terminal, menunya dipetakan ke menu
 * outlet, dan kasir menerimanya (atau terminal menerimanya otomatis bila menunya semua terpetakan). Order kasir yang lahir tertaut ke kanal
 * dan nomor pesanan, sehingga rekonsiliasi dan aturan R36/R54/R55 bekerja seperti biasa.
 */
@Injectable()
export class ChannelInboundService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  private audit(q: Queryable, tenantId: string, actor: string, action: string, detail: object) {
    return q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [tenantId, actor, action, JSON.stringify(detail)]);
  }

  private async sweep(q: Queryable, outletId: string, now: number) {
    await q.query("update channel_inbound set status = 'EXPIRED' where outlet_id = $1 and status = 'NEW' and received_at_ms < $2", [outletId, now - INBOUND_EXPIRE_MS]);
  }

  // ---------- publik: dipanggil platform/perantara dengan kunci ----------

  private async gate(authorization: string | undefined, caller: string): Promise<Gate> {
    const now = this.clock();
    await this.limiter.enforce(`chn:ip:${caller}`, CALLS_PER_IP_PER_MINUTE, 60_000, now, 'terlalu banyak permintaan; coba lagi sebentar');
    const m = /^Bearer (chn_[A-Za-z0-9_-]{20,64})$/.exec(authorization ?? '');
    if (!m) throw new UnauthorizedException('kunci integrasi tidak valid');
    const keyHash = sha256(m[1]!);
    const row = (await this.db.admin.query<{ id: string; tenant_id: string; outlet_id: string; channel: Channel }>(
      `select i.id, i.tenant_id, i.outlet_id, i.channel from channel_integration i join tenant t on t.id = i.tenant_id
       where i.key_hash = $1 and i.revoked_at is null and t.suspended_at is null`, [keyHash],
    )).rows[0];
    if (!row) throw new UnauthorizedException('kunci integrasi tidak valid');
    await this.limiter.enforce(`chn:key:${keyHash.slice(0, 16)}`, CALLS_PER_KEY_PER_MINUTE, 60_000, now, 'terlalu banyak permintaan; coba lagi sebentar');
    return { integrationId: num(row.id), tenantId: row.tenant_id, outletId: row.outlet_id, channel: row.channel };
  }

  private view(r: InboundRow) {
    return { ref: r.ref, status: r.status, receivedAt: num(r.received_at_ms), decidedAt: r.decided_at_ms === null ? null : num(r.decided_at_ms), reason: r.decided_reason, canceledByPlatform: r.platform_canceled_at_ms !== null };
  }

  /** Menerima pesanan dari platform. Idempoten: nomor pesanan yang sama mengembalikan keadaannya yang sekarang (platform sering mengirim ulang). */
  async receive(authorization: string | undefined, body: unknown, caller: string): Promise<{ id: number; ref: string; status: string; duplicate: boolean }> {
    const g = await this.gate(authorization, caller);
    const c = checkInbound(body);
    if (!c.ok) throw new BadRequestException(c.message);
    const v = c.value;
    const now = this.clock();
    return this.db.tenantTx(g.tenantId, async (q) => {
      await this.sweep(q, g.outletId, now);
      const prior = (await q.query<{ id: string; status: string }>('select id, status from channel_inbound where outlet_id = $1 and channel = $2 and ref = $3', [g.outletId, g.channel, v.ref])).rows[0];
      if (prior) return { id: num(prior.id), ref: v.ref, status: prior.status, duplicate: true };
      const waiting = num((await q.query<{ n: string }>("select count(*) n from channel_inbound where outlet_id = $1 and status = 'NEW'", [g.outletId])).rows[0]!.n);
      if (waiting >= PENDING_PER_OUTLET) throw new HttpException('terlalu banyak pesanan yang belum ditanggapi kasir', HttpStatus.TOO_MANY_REQUESTS);
      const id = num((await q.query<{ id: string }>(
        `insert into channel_inbound (tenant_id, outlet_id, channel, ref, customer_name, note, items, total, placed_at_ms, received_at_ms)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) returning id`,
        [g.tenantId, g.outletId, g.channel, v.ref, v.customerName, v.note, JSON.stringify(v.items), v.total, v.placedAt, now],
      )).rows[0]!.id);
      return { id, ref: v.ref, status: 'NEW', duplicate: false };
    });
  }

  /** Status pesanan di POS, untuk platform/perantara yang menarik status (diterima, ditolak, kedaluwarsa). */
  async statusOf(authorization: string | undefined, ref: string, caller: string) {
    const g = await this.gate(authorization, caller);
    need(REF_RE.test(ref), 'nomor pesanan tidak valid');
    return this.db.tenantTx(g.tenantId, async (q) => {
      await this.sweep(q, g.outletId, this.clock());
      const r = (await q.query<InboundRow>(`select ${COLS} from channel_inbound where outlet_id = $1 and channel = $2 and ref = $3`, [g.outletId, g.channel, ref])).rows[0];
      if (!r) throw new NotFoundException('pesanan tidak ditemukan');
      return this.view(r);
    });
  }

  /** Platform membatalkan pesanan. Yang belum diterima kasir menjadi CANCELED; yang sudah diterima ditandai agar kasir tahu (uang tidak akan dibayar platform). */
  async cancel(authorization: string | undefined, ref: string, caller: string) {
    const g = await this.gate(authorization, caller);
    need(REF_RE.test(ref), 'nomor pesanan tidak valid');
    const now = this.clock();
    return this.db.tenantTx(g.tenantId, async (q) => {
      await this.sweep(q, g.outletId, now);
      const r = (await q.query<InboundRow>(`select ${COLS} from channel_inbound where outlet_id = $1 and channel = $2 and ref = $3`, [g.outletId, g.channel, ref])).rows[0];
      if (!r) throw new NotFoundException('pesanan tidak ditemukan');
      if (r.status === 'NEW') await q.query("update channel_inbound set status = 'CANCELED', decided_by = 'platform', decided_at_ms = $2, platform_canceled_at_ms = $2 where id = $1", [r.id, now]);
      else if (r.status === 'ACCEPTED' && r.platform_canceled_at_ms === null) await q.query('update channel_inbound set platform_canceled_at_ms = $2 where id = $1', [r.id, now]);
      const after = (await q.query<InboundRow>(`select ${COLS} from channel_inbound where id = $1`, [r.id])).rows[0]!;
      return this.view(after);
    });
  }

  // ---------- dashboard (owner/manager) ----------

  async integrations(auth: ApiAuth, outletId: string) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const rows = (await q.query<{ channel: Channel; key_prefix: string; auto_accept: boolean; created_at: string }>(
        'select channel, key_prefix, auto_accept, created_at from channel_integration where outlet_id = $1 and revoked_at is null', [outletId],
      )).rows;
      return { integrations: CHANNELS.map((ch) => {
        const r = rows.find((x) => x.channel === ch);
        return { channel: ch, active: !!r, keyPrefix: r?.key_prefix ?? null, autoAccept: r?.auto_accept ?? false, createdAt: r?.created_at ?? null };
      }) };
    });
  }

  /** Membuat kunci baru (yang lama dicabut). Kunci hanya ditampilkan sekali; yang disimpan hanya hash-nya. */
  async createKey(auth: ApiAuth, outletId: string, channel: unknown): Promise<{ channel: Channel; key: string }> {
    const ch = asChannel(channel);
    return this.db.tenantTx(auth.tenantId, async (q) => {
      need((await q.query('select 1 from outlet where id = $1', [outletId])).rowCount === 1, 'outlet tidak ditemukan');
      const key = `${KEY_PREFIX}${newToken('api').slice(4)}`;
      const old = await q.query('update channel_integration set revoked_at = now() where outlet_id = $1 and channel = $2 and revoked_at is null returning auto_accept', [outletId, ch]);
      await q.query(
        'insert into channel_integration (tenant_id, outlet_id, channel, key_hash, key_prefix, auto_accept, created_by) values ($1, $2, $3, $4, $5, $6, $7)',
        [auth.tenantId, outletId, ch, sha256(key), key.slice(0, 8), (old.rows[0] as { auto_accept?: boolean } | undefined)?.auto_accept ?? false, auth.userId],
      );
      await this.audit(q, auth.tenantId, auth.userId, 'channel.key.create', { outletId, channel: ch, rotated: old.rowCount === 1 });
      return { channel: ch, key };
    });
  }

  async revokeKey(auth: ApiAuth, outletId: string, channel: unknown): Promise<void> {
    const ch = asChannel(channel);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await q.query('update channel_integration set revoked_at = now() where outlet_id = $1 and channel = $2 and revoked_at is null', [outletId, ch]);
      if (r.rowCount === 0) throw new NotFoundException('integrasi tidak aktif');
      await this.audit(q, auth.tenantId, auth.userId, 'channel.key.revoke', { outletId, channel: ch });
    });
  }

  async setAutoAccept(auth: ApiAuth, outletId: string, channel: unknown, on: unknown): Promise<void> {
    const ch = asChannel(channel);
    need(typeof on === 'boolean', 'autoAccept harus true atau false');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await q.query('update channel_integration set auto_accept = $3 where outlet_id = $1 and channel = $2 and revoked_at is null', [outletId, ch, on]);
      if (r.rowCount === 0) throw new NotFoundException('integrasi tidak aktif');
      await this.audit(q, auth.tenantId, auth.userId, 'channel.auto_accept', { outletId, channel: ch, on });
    });
  }

  /** Pemetaan menu platform ke menu outlet, ditambah menu pesanan terakhir yang belum terpetakan. */
  async itemMap(auth: ApiAuth, outletId: string, now = this.clock()) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const maps = (await q.query<{ channel: Channel; external_key: string; menu_id: string; name: string | null }>(
        'select m.channel, m.external_key, m.menu_id, i.name from channel_item_map m left join menu_item i on i.tenant_id = m.tenant_id and i.id = m.menu_id order by m.channel, m.external_key', [],
      )).rows;
      const recent = (await q.query<{ channel: Channel; items: InboundItem[] }>(
        'select channel, items from channel_inbound where outlet_id = $1 and received_at_ms >= $2', [outletId, now - 14 * DAY_MS],
      )).rows;
      const mapped = new Set(maps.map((m) => `${m.channel}|${m.external_key}`));
      const unmapped = new Map<string, { channel: Channel; key: string; name: string; seen: number }>();
      for (const r of recent) for (const it of r.items) {
        const k = `${r.channel}|${it.key}`;
        if (mapped.has(k)) continue;
        const cur = unmapped.get(k) ?? { channel: r.channel, key: it.key, name: it.name, seen: 0 };
        cur.seen += it.qty;
        unmapped.set(k, cur);
      }
      return {
        map: maps.map((m) => ({ channel: m.channel, key: m.external_key, menuId: m.menu_id, menuName: m.name })),
        unmapped: [...unmapped.values()].sort((a, b) => b.seen - a.seen),
      };
    });
  }

  async setMap(auth: ApiAuth, input: { channel?: unknown; key?: unknown; menuId?: unknown }): Promise<void> {
    const ch = asChannel(input.channel);
    const key = clean(input.key, 1, 140);
    need(key, 'kunci menu platform wajib');
    need(typeof input.menuId === 'string' && input.menuId.length > 0, 'menu outlet wajib');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      need((await q.query('select 1 from menu_item where id = $1 and active', [input.menuId])).rowCount === 1, 'menu tidak ditemukan atau tidak aktif');
      await q.query(
        `insert into channel_item_map (tenant_id, channel, external_key, menu_id, created_by) values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, channel, external_key) do update set menu_id = excluded.menu_id, created_by = excluded.created_by`,
        [auth.tenantId, ch, key, input.menuId, auth.userId],
      );
      await this.audit(q, auth.tenantId, auth.userId, 'channel.map.set', { channel: ch, key, menuId: input.menuId });
    });
  }

  async deleteMap(auth: ApiAuth, channel: unknown, key: unknown): Promise<void> {
    const ch = asChannel(channel);
    need(typeof key === 'string' && key.length > 0 && key.length <= 140, 'kunci menu platform wajib');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      await q.query('delete from channel_item_map where channel = $1 and external_key = $2', [ch, key]);
      await this.audit(q, auth.tenantId, auth.userId, 'channel.map.delete', { channel: ch, key });
    });
  }

  async list(auth: ApiAuth, outletId: string, q2: { days?: string }, now = this.clock()) {
    const days = Math.min(30, Math.max(1, Number.parseInt(q2.days ?? '7', 10) || 7));
    return this.db.tenantTx(auth.tenantId, async (q) => {
      await this.sweep(q, outletId, now);
      const rows = (await q.query<InboundRow>(`select ${COLS} from channel_inbound where outlet_id = $1 and received_at_ms >= $2 order by received_at_ms desc limit 200`, [outletId, now - days * DAY_MS])).rows;
      return { orders: rows.map((r) => ({ id: num(r.id), channel: r.channel, ref: r.ref, customerName: r.customer_name, total: num(r.total), status: r.status, receivedAt: num(r.received_at_ms), decidedBy: r.decided_by, decidedAt: r.decided_at_ms === null ? null : num(r.decided_at_ms), reason: r.decided_reason, canceledByPlatform: r.platform_canceled_at_ms !== null, items: r.items.map((i) => ({ name: i.name, qty: i.qty, unitPrice: i.unitPrice })) })) };
    });
  }

  // ---------- terminal POS ----------

  private async resolve(q: Queryable, tenantId: string, channel: Channel, items: InboundItem[]) {
    const keys = [...new Set(items.map((i) => i.key))];
    const rows = (await q.query<{ external_key: string; menu_id: string }>(
      'select m.external_key, m.menu_id from channel_item_map m join menu_item i on i.tenant_id = m.tenant_id and i.id = m.menu_id and i.active where m.channel = $1 and m.external_key = any($2::text[])', [channel, keys],
    )).rows;
    const by = new Map(rows.map((r) => [r.external_key, r.menu_id]));
    return items.map((i) => ({ ...i, menuId: by.get(i.key) ?? null }));
  }

  /** Pesanan baru yang menunggu kasir dengan pemetaan menunya, plus pesanan diterima yang dibatalkan platform. */
  async pending(device: DeviceAuth, now = this.clock()) {
    return this.db.tenantTx(device.tenantId, async (q) => {
      await this.sweep(q, device.outletId, now);
      const rows = (await q.query<InboundRow>(`select ${COLS} from channel_inbound where outlet_id = $1 and status = 'NEW' order by received_at_ms, id`, [device.outletId])).rows;
      const auto = new Map((await q.query<{ channel: Channel; auto_accept: boolean }>('select channel, auto_accept from channel_integration where outlet_id = $1 and revoked_at is null', [device.outletId])).rows.map((r) => [r.channel, r.auto_accept]));
      const canceled = (await q.query<{ channel: Channel; ref: string; platform_canceled_at_ms: number }>(
        "select channel, ref, platform_canceled_at_ms from channel_inbound where outlet_id = $1 and status = 'ACCEPTED' and platform_canceled_at_ms >= $2 order by platform_canceled_at_ms", [device.outletId, now - CANCEL_NOTICE_MS],
      )).rows;
      const orders = [];
      for (const r of rows) {
        const items = await this.resolve(q, device.tenantId, r.channel, r.items);
        orders.push({
          id: num(r.id), channel: r.channel, ref: r.ref, name: r.customer_name, note: r.note, total: num(r.total), receivedAt: num(r.received_at_ms), autoAccept: auto.get(r.channel) === true,
          items: items.map((i) => ({ name: i.name, qty: i.qty, unitPrice: i.unitPrice, note: i.note ?? null, menuId: i.menuId })),
        });
      }
      return { at: now, orders, canceled: canceled.map((c) => ({ channel: c.channel, ref: c.ref, at: num(c.platform_canceled_at_ms) })) };
    });
  }

  /** Klaim atomik: hanya satu terminal berhasil, dan hanya bila kanalnya aktif di outlet serta semua menu sudah terpetakan. */
  async accept(device: DeviceAuth, id: number, now = this.clock()) {
    return this.db.tenantTx(device.tenantId, async (q) => {
      const cur = (await q.query<InboundRow>(`select ${COLS} from channel_inbound where id = $1 and outlet_id = $2 and status = 'NEW' and received_at_ms >= $3`, [id, device.outletId, now - INBOUND_EXPIRE_MS])).rows[0];
      if (!cur) throw new ConflictException('pesanan sudah diterima terminal lain, ditolak, dibatalkan, atau kedaluwarsa');
      const outlet = (await q.query<{ online_channels: { channel: string }[] }>('select online_channels from outlet where id = $1', [device.outletId])).rows[0];
      if (!(outlet?.online_channels ?? []).some((c) => c.channel === cur.channel)) throw new ConflictException(`kanal ${cur.channel} belum diaktifkan di pengaturan outlet`);
      const items = await this.resolve(q, device.tenantId, cur.channel, cur.items);
      const missing = items.filter((i) => !i.menuId);
      if (missing.length > 0) throw new ConflictException(`menu belum dipetakan: ${missing.map((m) => m.name).join(', ')}; minta manager memetakannya di dashboard`);
      const r = await q.query("update channel_inbound set status = 'ACCEPTED', decided_by = $3, decided_at_ms = $4 where id = $1 and outlet_id = $2 and status = 'NEW'", [id, device.outletId, `device:${device.deviceId}`, now]);
      if (r.rowCount === 0) throw new ConflictException('pesanan sudah diterima terminal lain, ditolak, dibatalkan, atau kedaluwarsa');
      await this.audit(q, device.tenantId, `device:${device.deviceId}`, 'channel.accept', { id, outletId: device.outletId, channel: cur.channel, ref: cur.ref });
      return {
        id, channel: cur.channel, ref: cur.ref, name: cur.customer_name, note: cur.note,
        items: items.map((i) => ({ itemId: i.menuId!, name: i.name, qty: i.qty, ...(i.note ? { note: i.note } : {}) })),
      };
    });
  }

  async reject(device: DeviceAuth, id: number, reason: unknown, now = this.clock()): Promise<void> {
    const why = clean(reason, 2, 140);
    need(why, 'alasan wajib (2–140 karakter)');
    await this.db.tenantTx(device.tenantId, async (q) => {
      const r = await q.query("update channel_inbound set status = 'REJECTED', decided_by = $3, decided_at_ms = $4, decided_reason = $5 where id = $1 and outlet_id = $2 and status = 'NEW' and received_at_ms >= $6", [id, device.outletId, `device:${device.deviceId}`, now, why, now - INBOUND_EXPIRE_MS]);
      if (r.rowCount === 0) throw new ConflictException('pesanan sudah diputuskan, dibatalkan, atau kedaluwarsa');
      await this.audit(q, device.tenantId, `device:${device.deviceId}`, 'channel.reject', { id, outletId: device.outletId, reason: why });
    });
  }
}



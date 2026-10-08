import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, HttpException, HttpStatus } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { ApiAuth, DeviceAuth } from './auth';
import { Database } from './db/database';
import { normalizePhone } from './loyalty';
import { CLOCK, type Clock } from './pipeline.service';

/** Pendaftaran member dari kasir dibatasi supaya akun palsu tidak bisa dibuat massal untuk menimbun poin. */
export const MAX_REGISTRATIONS_PER_DEVICE_PER_HOUR = 20;

export interface MemberView {
  id: string;
  name: string;
  points: number;
}

const PHONE_HELP = 'nomor HP tidak valid (contoh: 0812 3456 7890)';

@Injectable()
export class MemberService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private name(v: unknown): string {
    const n = typeof v === 'string' ? v.trim() : '';
    if (n.length < 1 || n.length > 60) throw new BadRequestException('nama member wajib (maks. 60 karakter)');
    return n;
  }

  /** Terminal mencari member lewat nomor HP: hanya nama dan saldo yang kembali (nomor tidak dikirim balik ke kasir). */
  async lookup(device: DeviceAuth, phoneRaw: unknown): Promise<MemberView> {
    const phone = normalizePhone(phoneRaw);
    if (!phone) throw new BadRequestException(PHONE_HELP);
    return this.db.tenantTx(device.tenantId, async (q) => {
      const m = (await q.query<{ id: string; name: string; active: boolean }>('select id, name, active from member where phone = $1', [phone])).rows[0];
      if (!m) throw new NotFoundException('member tidak ditemukan');
      if (!m.active) throw new ForbiddenException('member ini dinonaktifkan');
      return { id: m.id, name: m.name, points: await this.balance(q, device.tenantId, m.id) };
    });
  }

  async register(by: DeviceAuth | ApiAuth, input: { phone?: unknown; name?: unknown }): Promise<MemberView> {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new BadRequestException(PHONE_HELP);
    const name = this.name(input.name);
    const id = `m${randomBytes(6).toString('hex')}`;
    const createdBy = by.kind === 'device' ? by.deviceId : by.userId;
    return this.db.tenantTx(by.tenantId, async (q) => {
      if (by.kind === 'device') {
        const recent = Number(
          (await q.query<{ n: string }>('select count(*) as n from member where created_by = $1 and created_at > to_timestamp($2::float8 / 1000)', [createdBy, this.clock() - 3_600_000])).rows[0]!.n,
        );
        if (recent >= MAX_REGISTRATIONS_PER_DEVICE_PER_HOUR) throw new HttpException('terlalu banyak pendaftaran member dari terminal ini; coba lagi nanti', HttpStatus.TOO_MANY_REQUESTS);
      }
      if ((await q.query('select 1 from member where phone = $1', [phone])).rowCount > 0) throw new ConflictException('nomor HP ini sudah terdaftar sebagai member');
      await q.query('insert into member (tenant_id, id, phone, name, created_by) values ($1, $2, $3, $4, $5)', [by.tenantId, id, phone, name, createdBy]);
      await q.query("insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, 'member.create', $3::jsonb)", [by.tenantId, createdBy, JSON.stringify({ id })]);
      return { id, name, points: 0 };
    });
  }

  /** Daftar member untuk dashboard (nomor HP disamarkan kecuali empat digit terakhir). */
  async list(auth: ApiAuth, search?: string) {
    const term = (search ?? '').trim().toLowerCase();
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const rows = (
        await q.query<{ id: string; name: string; phone: string; active: boolean; created_at: string; points: string; last_ms: string | null }>(
          `select m.id, m.name, m.phone, m.active, m.created_at,
                  coalesce((select sum(points) from member_ledger l where l.tenant_id = m.tenant_id and l.member_id = m.id), 0) as points,
                  (select max(at_ms) from member_ledger l where l.tenant_id = m.tenant_id and l.member_id = m.id) as last_ms
           from member m
           where ($1 = '' or lower(m.name) like '%' || $1 || '%' or m.phone like '%' || $1 || '%')
           order by m.created_at desc limit 200`,
          [term],
        )
      ).rows;
      return rows.map((r) => ({
        id: r.id, name: r.name, phoneMasked: `${'•'.repeat(Math.max(0, r.phone.length - 4))}${r.phone.slice(-4)}`, active: r.active,
        points: Number(r.points), lastActivityMs: r.last_ms === null ? null : Number(r.last_ms), createdAt: r.created_at,
      }));
    });
  }

  async update(auth: ApiAuth, id: string, input: { name?: unknown; active?: unknown }): Promise<void> {
    if (input.active !== undefined && typeof input.active !== 'boolean') throw new BadRequestException('active harus true atau false');
    const name = input.name === undefined ? null : this.name(input.name);
    await this.db.tenantTx(auth.tenantId, async (q) => {
      const r = await q.query('update member set name = coalesce($2, name), active = coalesce($3, active) where id = $1', [id, name, input.active ?? null]);
      if (r.rowCount === 0) throw new NotFoundException('member tidak ditemukan');
      await q.query("insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, 'member.update', $3::jsonb)", [auth.tenantId, auth.userId, JSON.stringify({ id, fields: Object.keys(input) })]);
    });
  }

  private async balance(q: { query: <T>(sql: string, p?: unknown[]) => Promise<{ rows: T[] }> }, tenantId: string, memberId: string): Promise<number> {
    const r = await q.query<{ b: string }>('select coalesce(sum(points), 0) as b from member_ledger where tenant_id = $1 and member_id = $2', [tenantId, memberId]);
    return Number(r.rows[0]!.b);
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { newToken, sha256, type ApiRole } from './auth';
import { Database } from './db/database';
import type { Capabilities } from '@pos/rules';

/** Administrasi tenant, outlet, perangkat, dan token. Dipakai tes dan skrip onboarding; belum diekspos lewat HTTP. */
@Injectable()
export class AdminService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async createTenant(id: string, name: string): Promise<void> {
    await this.db.admin.query('insert into tenant (id, name) values ($1, $2)', [id, name]);
  }

  async createOutlet(
    tenantId: string,
    id: string,
    name: string,
    opts: { capabilities?: Capabilities; terminals?: string[]; utcOffsetMinutes?: number; cctvRetentionDays?: number; cctvClockOffsetSec?: number } = {},
  ): Promise<void> {
    await this.db.admin.query(
      `insert into outlet (id, tenant_id, name, capabilities, terminals, utc_offset_minutes, cctv_retention_days, cctv_clock_offset_sec)
       values ($1, $2, $3, coalesce($4::jsonb, '{"sensor":true,"kds":false,"printerReportsStatus":true}'::jsonb), $5::jsonb, $6, $7, $8)`,
      [
        id, tenantId, name, opts.capabilities ? JSON.stringify(opts.capabilities) : null, JSON.stringify(opts.terminals ?? []),
        opts.utcOffsetMinutes ?? 420, opts.cctvRetentionDays ?? 7, opts.cctvClockOffsetSec ?? 0,
      ],
    );
  }

  /** Mengembalikan token polos satu kali. Hanya hash-nya yang tersimpan. */
  async createDevice(
    tenantId: string, outletId: string, id: string, kind: 'terminal' | 'sensor' | 'kds',
  ): Promise<string> {
    const token = newToken('dev');
    await this.db.admin.query(
      'insert into device (id, tenant_id, outlet_id, kind, token_hash) values ($1, $2, $3, $4, $5)',
      [id, tenantId, outletId, kind, sha256(token)],
    );
    return token;
  }

  async createApiToken(tenantId: string, userId: string, role: ApiRole, label?: string): Promise<string> {
    const token = newToken('api');
    await this.db.admin.query(
      'insert into api_token (token_hash, tenant_id, user_id, role, label) values ($1, $2, $3, $4, $5)',
      [sha256(token), tenantId, userId, role, label ?? null],
    );
    return token;
  }
}

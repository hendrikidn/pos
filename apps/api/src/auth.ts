import { createHash, randomBytes } from 'node:crypto';
import {
  CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Database } from './db/database';

export type ApiRole = 'OWNER' | 'OPS' | 'MANAGER' | 'SUPERVISOR';

export interface DeviceAuth {
  kind: 'device';
  tenantId: string;
  outletId: string;
  deviceId: string;
  deviceKind: 'terminal' | 'sensor' | 'kds';
}

export interface ApiAuth {
  kind: 'api';
  tenantId: string;
  userId: string;
  role: ApiRole;
  /** Id baris token (untuk daftar sesi aktif dan "keluar dari perangkat lain"). */
  tokenId?: number;
}

/** Admin platform (konsol admin). Bukan pengguna tenant: tidak bisa memakai endpoint tenant, dan sebaliknya. */
export interface AdminAuth {
  kind: 'admin';
  adminId: string;
}

export type Auth = DeviceAuth | ApiAuth | AdminAuth;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Token acak dengan prefiks: `dev_` perangkat, `api_` pengguna dashboard tenant, `adm_` admin platform. Hanya hash-nya yang disimpan. */
export function newToken(prefix: 'dev' | 'api' | 'adm'): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

/** Tenant yang ditangguhkan admin: semua token pengguna dan perangkatnya ditolak dengan pesan ini (403). */
export const SUSPENDED_MESSAGE = 'akun tenant ditangguhkan; hubungi administrator';

export const PUBLIC = 'public';
export const Public = () => SetMetadata(PUBLIC, true);

export interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  auth?: Auth;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    const token = raw?.startsWith('Bearer ') ? raw.slice(7).trim() : undefined;
    if (!token) throw new UnauthorizedException('token tidak ada');
    const hash = sha256(token);

    if (token.startsWith('dev_')) {
      const r = await this.db.admin.query<{ id: string; tenant_id: string; outlet_id: string; kind: DeviceAuth['deviceKind']; suspended: boolean }>(
        `select d.id, d.tenant_id, d.outlet_id, d.kind, t.suspended_at is not null as suspended
         from device d join tenant t on t.id = d.tenant_id where d.token_hash = $1 and d.revoked_at is null`,
        [hash],
      );
      const d = r.rows[0];
      if (!d) throw new UnauthorizedException('token tidak dikenal');
      if (d.suspended) throw new ForbiddenException(SUSPENDED_MESSAGE);
      req.auth = { kind: 'device', tenantId: d.tenant_id, outletId: d.outlet_id, deviceId: d.id, deviceKind: d.kind };
      return true;
    }
    if (token.startsWith('api_')) {
      const r = await this.db.admin.query<{ id: string; tenant_id: string; user_id: string; role: ApiRole; suspended: boolean; session: boolean; stale: boolean }>(
        `select a.id, a.tenant_id, a.user_id, a.role, a.session, t.suspended_at is not null as suspended,
                (a.session and (a.last_used_at is null or a.last_used_at < now() - interval '5 minutes')) as stale
         from api_token a join tenant t on t.id = a.tenant_id where a.token_hash = $1 and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())`,
        [hash],
      );
      const a = r.rows[0];
      if (!a) throw new UnauthorizedException('token tidak dikenal');
      if (a.suspended) throw new ForbiddenException(SUSPENDED_MESSAGE);
      // "Terakhir dipakai" untuk daftar sesi: ditulis paling sering sekali per 5 menit supaya tidak menambah tulis di setiap permintaan.
      if (a.stale) await this.db.admin.query('update api_token set last_used_at = now() where id = $1', [a.id]);
      req.auth = { kind: 'api', tenantId: a.tenant_id, userId: a.user_id, role: a.role, tokenId: Number(a.id) };
      return true;
    }
    if (token.startsWith('adm_')) {
      // Sesi konsol admin (hasil login, bisa dengan 2FA) diterima langsung; token admin mentah hanya bila admin itu BELUM mengaktifkan 2FA.
      const s = await this.db.admin.query<{ admin_id: string }>(
        `select s.admin_id from admin_session s join platform_admin p on p.id = s.admin_id and p.revoked_at is null
         where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`, [hash],
      );
      if (s.rows[0]) {
        req.auth = { kind: 'admin', adminId: s.rows[0].admin_id };
        return true;
      }
      const r = await this.db.admin.query<{ id: string; totp_enabled: boolean }>('select id, totp_enabled from platform_admin where token_hash = $1 and revoked_at is null', [hash]);
      const a = r.rows[0];
      if (!a) throw new UnauthorizedException('token tidak dikenal');
      if (a.totp_enabled) throw new UnauthorizedException('admin ini memakai verifikasi 2 langkah: masuk lewat /v1/admin/auth/login');
      req.auth = { kind: 'admin', adminId: a.id };
      return true;
    }
    throw new UnauthorizedException('token tidak dikenal');
  }
}

export function requireAdmin(req: AuthedRequest): AdminAuth {
  if (req.auth?.kind !== 'admin') throw new ForbiddenException('endpoint ini hanya untuk admin platform');
  return req.auth;
}

export function requireDevice(req: AuthedRequest): DeviceAuth {
  if (req.auth?.kind !== 'device') throw new ForbiddenException('endpoint ini hanya untuk perangkat');
  return req.auth;
}

export function requireApi(req: AuthedRequest, roles?: ApiRole[]): ApiAuth {
  if (req.auth?.kind !== 'api') throw new ForbiddenException('endpoint ini hanya untuk pengguna');
  if (roles && !roles.includes(req.auth.role)) throw new ForbiddenException('peran tidak diizinkan');
  return req.auth;
}

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
      const r = await this.db.admin.query<{ tenant_id: string; user_id: string; role: ApiRole; suspended: boolean }>(
        `select a.tenant_id, a.user_id, a.role, t.suspended_at is not null as suspended
         from api_token a join tenant t on t.id = a.tenant_id where a.token_hash = $1 and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())`,
        [hash],
      );
      const a = r.rows[0];
      if (!a) throw new UnauthorizedException('token tidak dikenal');
      if (a.suspended) throw new ForbiddenException(SUSPENDED_MESSAGE);
      req.auth = { kind: 'api', tenantId: a.tenant_id, userId: a.user_id, role: a.role };
      return true;
    }
    if (token.startsWith('adm_')) {
      const r = await this.db.admin.query<{ id: string }>('select id from platform_admin where token_hash = $1 and revoked_at is null', [hash]);
      const a = r.rows[0];
      if (!a) throw new UnauthorizedException('token tidak dikenal');
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

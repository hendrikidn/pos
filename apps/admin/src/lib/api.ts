import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3000';
/** Nama cookie berbeda dari dashboard owner, agar kedua sesi tidak saling menimpa bila berbagi domain induk. */
export const TOKEN_COOKIE = 'guard_admin_token';

export interface AdminMe {
  adminId: string;
}

export interface TenantRow {
  id: string;
  name: string;
  created_at: string;
  outlets: number;
  devices: number;
  last_seen_ms: number | null;
  owner_tokens: number;
}

export interface OutletRow {
  id: string;
  name: string;
  terminals: string[];
}

export interface DeviceRow {
  id: string;
  kind: 'terminal' | 'sensor' | 'kds';
  outlet_id: string;
  terminal_id: string | null;
  last_seen_ms: number | null;
  revoked_at: string | null;
}

export interface TokenRow {
  id: number;
  user_id: string;
  role: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface TenantDetail {
  tenant: { id: string; name: string; created_at: string };
  outlets: OutletRow[];
  devices: DeviceRow[];
  tokens: TokenRow[];
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function getToken(): Promise<string | undefined> {
  return (await cookies()).get(TOKEN_COOKIE)?.value;
}

/** Memanggil API dari server Next dengan token admin di cookie httpOnly. Token tidak pernah sampai ke JavaScript browser. */
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const token = await getToken();
  if (!token) throw new ApiError(401, 'belum login');
  const res = await fetch(`${API_URL}${path}`, {
    method: init?.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    cache: 'no-store',
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const j = (await res.json()) as { message?: string | string[] };
      message = (Array.isArray(j.message) ? j.message.join('; ') : j.message) ?? message;
    } catch {
      /* respons bukan JSON */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

/** Untuk server component: token tidak sah mengarahkan ke halaman login. */
export async function authed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) redirect('/login');
    throw e;
  }
}

/** Menolak permintaan POST lintas situs: Origin, bila ada, harus sama dengan host. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.get('host');
  } catch {
    return false;
  }
}

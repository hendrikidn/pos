import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3000';
export const TOKEN_COOKIE = 'guard_token';

export interface Me {
  userId: string;
  role: 'OWNER' | 'OPS' | 'MANAGER' | 'SUPERVISOR';
  tenantId: string;
}

export interface Outlet {
  id: string;
  name: string;
  cctv_retention_days: number;
  cctv_clock_offset_sec: number;
  /** Hanya ada pada daftar outlet (/v1/outlets). */
  open_incidents?: number;
  open_critical?: number;
}

export interface Hit {
  rule: string;
  key: string;
  weight: number;
  at: number;
  windowStart: number;
  windowEnd: number;
  note: string;
  confidence: 'HIGH' | 'LOW';
  actorIds: string[];
  orderId: string | null;
  terminalId: string | null;
  modalities: string[];
  context: boolean;
  evidence?: { orderId: string; at: number; amount: number; terminalId: string | null; actorId: string | null }[];
}

export interface Incident {
  id: string;
  outlet_id: string;
  terminal_id: string | null;
  start_ms: number;
  end_ms: number;
  score: number;
  level: 'LOW' | 'MEDIUM' | 'CRITICAL';
  multiplier: number;
  order_ids: string[];
  actor_ids: string[];
  hits: Hit[];
  status: string;
}

export interface IncidentDetail extends Incident {
  reviews: { reviewer: string; label: string; note: string | null; reviewed_at: string }[];
  outlet: Outlet;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function getToken(): Promise<string | undefined> {
  return (await cookies()).get(TOKEN_COOKIE)?.value;
}

/** Memanggil API dari server Next dengan token di cookie httpOnly. Token tidak pernah sampai ke JavaScript browser. */
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
      message = ((await res.json()) as { message?: string }).message ?? message;
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
    if (e instanceof ApiError && e.status === 401) redirect('/login');
    // 403 dari guard berarti tenant ditangguhkan admin platform (peran yang kurang ditangani tiap halaman sendiri).
    if (e instanceof ApiError && e.status === 403 && /ditangguhkan/.test(e.message)) redirect('/login?s=1');
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

export interface DashboardUser {
  id: number;
  user_id: string;
  email: string;
  role: 'OWNER' | 'OPS' | 'MANAGER' | 'SUPERVISOR';
  active: boolean;
  created_at: string;
  last_login_at: string | null;
  active_sessions: number;
}

export interface StaffRow {
  id: string;
  name: string;
  role: 'CASHIER' | 'SUPERVISOR' | 'MANAGER' | 'OWNER';
  outlet_ids: string[] | null;
  active: boolean;
}

export interface MenuRow {
  id: string;
  name: string;
  price: number;
  category: string;
  sort: number;
  outlet_id: string | null;
  active: boolean;
}

export interface OutletSettings {
  id: string;
  name: string;
  terminals: string[];
  merchant_name: string | null;
  tax_percent: number;
  edcs: { tid: string; bank: string; label: string }[];
  policy: { secondApprovalAbove?: number; manualDiscountMaxPercent?: number; manualDiscountMaxAmount?: number } | null;
  cctv_retention_days: number;
  cctv_clock_offset_sec: number;
}

export interface SettlementLine {
  count: number;
  amount: number;
}

export interface SettlementBatch {
  tid: string;
  batch: string;
  bank: string;
  closed_at_ms: number;
  uploaded_by: string;
  result: { channels: { channel: string; pos: SettlementLine; slip: SettlementLine; ok: boolean }[]; notes: string[] };
}

export interface SettlementList {
  batches: SettlementBatch[];
  edcs: { tid: string; bank: string; label: string; last_closed_at_ms: number | null }[];
}

export interface DeviceRow {
  id: string;
  kind: 'terminal' | 'sensor' | 'kds';
  outlet_id: string;
  terminal_id: string | null;
  key_enrolled: boolean;
  last_seq: number;
  /** Jam server saat event terakhir diterima. */
  last_seen_ms: number | null;
  revoked_at: string | null;
}

export interface PendingPairing {
  device_id: string;
  kind: 'terminal' | 'sensor' | 'kds';
  outlet_id: string;
  terminal_id: string | null;
  expires_at: string;
}

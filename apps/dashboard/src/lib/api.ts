import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3000';
import { TOKEN_COOKIE } from './cookie';
export { TOKEN_COOKIE };

export interface Me {
  userId: string;
  role: 'OWNER' | 'OPS' | 'MANAGER' | 'SUPERVISOR';
  tenantId: string;
}

/** Status mode shadow outlet (lihat apps/api/src/shadow.ts). */
export interface ShadowStatus {
  days: number;
  enabled: boolean;
  active: boolean;
  /** Belum ada aktivitas pertama, jadi hitungan hari belum mulai. */
  pending: boolean;
  startedMs: number | null;
  untilMs: number | null;
  day: number;
}

export interface Outlet {
  id: string;
  name: string;
  cctv_retention_days: number;
  cctv_clock_offset_sec: number;
  /** Hanya ada pada daftar outlet (/v1/outlets). */
  open_incidents?: number;
  open_critical?: number;
  shadow?: ShadowStatus & { incidents: number };
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
  /** Tercatat selama mode shadow: tidak dikirim dan tidak masuk antrean review. */
  shadow?: boolean;
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
  has_password: boolean;
}

export interface StaffRow {
  id: string;
  name: string;
  role: 'CASHIER' | 'SUPERVISOR' | 'MANAGER' | 'OWNER';
  outlet_ids: string[] | null;
  active: boolean;
}

export interface ModifierOption { id: string; name: string; price: number }
export interface ModifierGroup { id: string; name: string; min: number; max: number; options: ModifierOption[] }

export interface MenuRow {
  id: string;
  name: string;
  price: number;
  category: string;
  modifierGroups: ModifierGroup[];
  sort: number;
  outlet_id: string | null;
  active: boolean;
  /** Versi foto (sidik jari); null = belum ada foto. */
  image: string | null;
}

export interface MemberRow {
  id: string;
  name: string;
  phoneMasked: string;
  active: boolean;
  points: number;
  lastActivityMs: number | null;
  createdAt: string;
}

export interface PromoRow {
  id: string;
  name: string;
  kind: 'PERCENT' | 'AMOUNT';
  value: number;
  minSubtotal?: number;
  maxDiscount?: number;
  days?: number[];
  startDate?: string;
  endDate?: string;
  startHour?: number;
  endHour?: number;
  outletId: string | null;
  active: boolean;
}

export interface OutletSettings {
  id: string;
  name: string;
  terminals: string[];
  merchant_name: string | null;
  tax_percent: number;
  service_charge_percent: number;
  tax_on_service: boolean;
  rounding_unit: number;
  loyalty_rupiah_per_point: number;
  loyalty_point_value: number;
  loyalty_max_redeem_percent: number;
  edcs: { tid: string; bank: string; label: string }[];
  tables: { no: string; area: string; seats: number }[];
  policy: { secondApprovalAbove?: number; manualDiscountMaxPercent?: number; manualDiscountMaxAmount?: number; employeeMealQuota?: number; holdBillMinutes?: number } | null;
  cctv_retention_days: number;
  cctv_clock_offset_sec: number;
  shadow_days: number;
  shadow: ShadowStatus;
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

export interface CashierRow {
  userId: string;
  orders: number;
  sales: number;
  voids: number;
  voidAmount: number;
  voidsAfterPayment: number;
  refunds: number;
  refundAmount: number;
  discounts: number;
  discountAmount: number;
}

/** Bentuk respons GET /v1/outlets/:id/reports/sales (lihat apps/api/src/sales-report.ts). */
export interface Change { delta: number; pct: number | null }
export interface ProductMover { itemId: string; name: string; current: number; previous: number; delta: number }
export interface SalesComparison {
  previous: { range: SalesReport['range']; totals: SalesReport['totals']; byDay: SalesReport['byDay'] };
  partial: boolean;
  change: { net: Change; gross: Change; orders: Change; avgOrder: Change; refunds: Change; discount: Change; voids: Change; voidsAfterPayment: Change };
  movers: { up: ProductMover[]; down: ProductMover[] };
}

export interface SalesReport {
  /** Hanya ada bila diminta dengan `compare=1`. */
  comparison?: SalesComparison;
  range: { from: string; to: string; days: number; utcOffsetMinutes: number; generatedAt: number };
  totals: {
    gross: number;
    refunds: number;
    net: number;
    orders: number;
    avgOrder: number;
    discount: { count: number; amount: number };
    voids: { count: number; amount: number; afterPayment: { count: number; amount: number } };
    employeeMeals: number;
  };
  byDay: { date: string; orders: number; net: number }[];
  byHour: { hour: number; orders: number; net: number }[];
  byMethod: { method: 'CASH' | 'QRIS' | 'EDC_DEBIT' | 'EDC_CREDIT'; payments: number; amount: number }[];
  byCashier: CashierRow[];
  byProduct: { itemId: string; name: string; qty: number; amount: number }[];
  byOption: { group: string; name: string; qty: number; amount: number }[];
  holds: { reason: string; count: number; longestMinutes: number }[];
  ordersWithoutItems: number;
  cashCounts: {
    toleranceAmount: number;
    shifts: { shiftId: string; userId: string | null; terminalId: string; at: number; counted: number; expected: number; diff: number; verified: boolean; claimed?: number }[];
  };
  notes: string[];
}

/** Respons GET /v1/outlets/:id/shadow. */
export interface ShadowReport {
  state: ShadowStatus;
  summary: {
    total: number;
    byLevel: { CRITICAL: number; MEDIUM: number; LOW: number };
    byRule: { rule: string; label: string; incidents: number }[];
    byDay: { date: string; total: number; critical: number }[];
    criticalPerWeek: number | null;
    reviewed: { total: number; confirmed: number; legit: number; falseAlarm: number; inconclusive: number };
    criticalPrecision: number | null;
  };
  incidents: {
    id: string; start_ms: number; end_ms: number; score: number; level: 'LOW' | 'MEDIUM' | 'CRITICAL';
    status: string; order_ids: string[]; actor_ids: string[]; rules: string[];
  }[];
}

export interface Ingredient { id: string; name: string; unit: 'g' | 'ml' | 'pcs'; minStock: number; active: boolean }

export interface StockMovement {
  id: number; ingredientId: string; kind: 'PURCHASE' | 'WASTE' | 'COUNT'; qty: number; expected: number | null; variance: number | null;
  periodUsed: number | null; note: string | null; userId: string; at: number;
}

/** GET /v1/outlets/:id/stock (lihat apps/api/src/stock.ts). */
export interface StockRow {
  ingredientId: string; name: string; unit: Ingredient['unit']; minStock: number; active: boolean;
  baseline: { at: number; counted: number } | null;
  purchased: number; wasted: number; used: number; expected: number | null;
  status: 'NO_BASELINE' | 'OK' | 'LOW' | 'EMPTY';
  lastCount: StockMovement | null;
  recent: StockMovement[];
}

export interface CountRow extends StockMovement { name: string; unit: Ingredient['unit']; flagged: boolean }

/** GET /v1/recipes: `{ [menuId]: { base: {bahan: qty}, options: {[optionId]: {bahan: qty}} } }`. */
export type Recipes = Record<string, { base: Record<string, number>; options: Record<string, Record<string, number>> }>;

export interface InvoiceRow {
  id: string;
  periodStart: string;
  periodEnd: string;
  outlets: number;
  unitPrice: number;
  amount: number;
  status: 'ISSUED' | 'PAID' | 'VOID';
  issuedAt: string;
  dueDate: string;
  paidAt: string | null;
  payMethod: string | null;
  payRef: string | null;
}

export type SubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'DUE' | 'OVERDUE' | 'CANCELED';

export interface Billing {
  subscription: null | {
    planId: string;
    planName: string;
    pricePerOutlet: number;
    status: SubscriptionStatus;
    trialEnd: string;
    trialDaysLeft: number;
    outlets: number;
    monthlyAmount: number;
    paidThrough: string | null;
  };
  invoices: InvoiceRow[];
  paymentInfo: string;
}

export interface AccountRow { code: string; name: string; type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'; normal: 'DEBIT' | 'CREDIT'; active: boolean }
export interface JournalEntryRow { ref: string; date: string; memo: string; source: 'POS' | 'MANUAL'; lines: { account: string; debit: number; credit: number }[]; notes?: string[] }
export interface ManualEntryRow { id: number; ref: string; date: string; memo: string; createdBy: string; voided: boolean; voidReason: string | null }
export interface JournalView { range: { from: string; to: string }; accounts: AccountRow[]; entries: JournalEntryRow[]; manual: ManualEntryRow[] }
export interface TrialRow { account: string; name: string; type: string; debit: number; credit: number; balance: number }
export interface AccountingReports {
  range: { from: string; to: string };
  trialBalance: { rows: TrialRow[]; totalDebit: number; totalCredit: number };
  incomeStatement: { revenue: TrialRow[]; expenses: TrialRow[]; totalRevenue: number; totalExpenses: number; netIncome: number };
}

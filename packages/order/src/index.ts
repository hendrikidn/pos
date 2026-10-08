export * from './cash';
export * from './consumption';
export * from './receipt';
export * from './kds';
export * from './modifiers';
import type { EventBody, KitchenStatus, OrderType, PosEvent } from '@pos/events';

export type Role = 'CASHIER' | 'SUPERVISOR' | 'MANAGER' | 'OWNER';
const RANK: Record<Role, number> = { CASHIER: 0, SUPERVISOR: 1, MANAGER: 2, OWNER: 3 };

/** MERGED: seluruh itemnya dipindahkan ke order lain; order ini tidak punya nilai lagi. */
export type OrderStatus = 'DRAFT' | 'SENT' | 'BILLED' | 'PAID' | 'VOIDED' | 'MERGED';

export interface OrderState {
  orderId: string;
  orderType: OrderType;
  creatorId: string | null;
  status: OrderStatus;
  kitchen: KitchenStatus | null;
  billPrinted: boolean;
  total: number | null;
  paid: number;
}

/** Menerapkan satu event ke state order. Event yang tidak terkait order diabaikan. */
export function reduceOrder(state: OrderState | undefined, e: PosEvent): OrderState | undefined {
  if (e.type === 'order.created') {
    return {
      orderId: e.payload.orderId,
      orderType: e.payload.orderType,
      creatorId: e.actorId,
      status: 'DRAFT',
      kitchen: null,
      billPrinted: false,
      total: null,
      paid: 0,
    };
  }
  if (!state) return state;
  switch (e.type) {
    case 'order.sent_to_kitchen':
      return state.status === 'DRAFT' ? { ...state, status: 'SENT' } : state;
    case 'kitchen.status_changed':
      return { ...state, kitchen: e.payload.status };
    case 'bill.printed':
      return {
        ...state,
        billPrinted: true,
        total: e.payload.total,
        status: state.status === 'PAID' || state.status === 'VOIDED' ? state.status : 'BILLED',
      };
    case 'payment.received': {
      const paid = state.paid + e.payload.amount;
      const total = state.total ?? paid;
      return { ...state, paid, total, status: paid >= total ? 'PAID' : state.status };
    }
    case 'void.approved':
      return { ...state, status: 'VOIDED' };
    case 'order.items_moved': {
      const p = e.payload;
      if (state.orderId === p.fromOrderId) return p.kind === 'MERGE' ? { ...state, status: 'MERGED' } : state;
      if (state.orderId !== p.toOrderId) return state;
      return {
        ...state,
        status: p.sent && state.status === 'DRAFT' ? 'SENT' : state.status,
        kitchen: p.kitchen ?? state.kitchen,
      };
    }
    default:
      return state;
  }
}

export function replayOrder(events: PosEvent[], orderId: string): OrderState | undefined {
  let state: OrderState | undefined;
  for (const e of events) {
    if (e.type === 'order.created' && e.payload.orderId !== orderId) continue;
    state = reduceOrder(state, e);
  }
  return state;
}

export interface Policy {
  reasonCodes: string[];
  /** Void/refund di atas nominal ini memerlukan dua persetujuan, salah satunya owner. */
  secondApprovalAbove: number;
  manualDiscountMaxPercent: number;
  manualDiscountMaxAmount: number;
  /** Makan karyawan gratis per orang per hari. Yang berikutnya memerlukan persetujuan supervisor. */
  employeeMealQuota: number;
  /** Bill tunai yang dibiarkan terbuka lebih lama dari ini (menit) memerlukan alasan sebelum dibayar. 0 = tidak dipakai. */
  holdBillMinutes: number;
}

/** Alasan baku menahan bill tunai (kontrol bill recycling, CF4). */
export const HOLD_REASONS = [
  { code: 'STILL_DINING', label: 'Customer masih makan/minum' },
  { code: 'WAITING_GROUP', label: 'Menunggu rombongan lain' },
  { code: 'CUSTOMER_AWAY', label: 'Customer meninggalkan meja sementara' },
  { code: 'SYSTEM_ISSUE', label: 'Kendala sistem atau EDC' },
  { code: 'OTHER', label: 'Lainnya (laporkan ke supervisor)' },
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number]['code'];
export const isHoldReason = (v: unknown): v is HoldReason => HOLD_REASONS.some((r) => r.code === v);

export const DEFAULT_POLICY: Policy = {
  reasonCodes: ['CUSTOMER_CANCEL', 'WRONG_ORDER', 'OUT_OF_STOCK', 'DUPLICATE', 'KITCHEN_ERROR'],
  secondApprovalAbove: 50_000,
  manualDiscountMaxPercent: 15,
  manualDiscountMaxAmount: 50_000,
  employeeMealQuota: 1,
  holdBillMinutes: 60,
};

export interface Ctx {
  roleOf(userId: string): Role | undefined;
  policy?: Policy;
}

export type Decision<T extends EventBody['type']> =
  | { ok: true; body: Extract<EventBody, { type: T }> }
  | { ok: false; code: string; message: string };

const deny = (code: string, message: string) => ({ ok: false as const, code, message });
const rank = (ctx: Ctx, id: string) => RANK[ctx.roleOf(id) ?? 'CASHIER'];

export interface VoidCommand {
  actorId: string;
  approverIds: string[];
  reasonCode: string;
  amount: number;
}

/**
 * Kunci void (SPEC 5.3):
 *  - belum dikirim ke dapur: tanpa persetujuan
 *  - sudah dikirim/ditagih: supervisor ke atas, bukan pembuat order dan bukan pelaku
 *  - sudah dibayar atau sudah disajikan: owner
 *  - nominal di atas ambang: dua persetujuan, salah satunya owner
 */
export function decideVoid(order: OrderState, cmd: VoidCommand, ctx: Ctx): Decision<'void.approved'> {
  const policy = ctx.policy ?? DEFAULT_POLICY;
  if (!policy.reasonCodes.includes(cmd.reasonCode)) return deny('REASON_INVALID', 'alasan void harus dari daftar baku');
  if (order.status === 'VOIDED') return deny('ALREADY_VOIDED', 'order sudah dibatalkan');

  const approvers = [...new Set(cmd.approverIds)];
  const level =
    order.status === 'PAID' || order.kitchen === 'SERVED' ? 2 : order.status === 'DRAFT' ? 0 : 1;

  if (level > 0) {
    if (approvers.length === 0) return deny('NOT_ENOUGH_APPROVERS', 'butuh persetujuan');
    if (approvers.includes(cmd.actorId)) return deny('SELF_APPROVAL', 'pelaku tidak boleh menyetujui sendiri');
    if (order.creatorId && approvers.includes(order.creatorId)) {
      return deny('CREATOR_APPROVAL', 'pembuat order tidak boleh menjadi approver');
    }
    if (approvers.some((a) => rank(ctx, a) < RANK.SUPERVISOR)) {
      return deny('APPROVER_ROLE_TOO_LOW', 'approver minimal supervisor');
    }
    const hasOwner = approvers.some((a) => ctx.roleOf(a) === 'OWNER');
    if (level === 2 && !hasOwner) return deny('OWNER_REQUIRED', 'void setelah dibayar/disajikan memerlukan owner');
    if (cmd.amount > policy.secondApprovalAbove) {
      if (approvers.length < 2) return deny('NOT_ENOUGH_APPROVERS', 'nominal besar butuh dua persetujuan');
      if (!hasOwner) return deny('OWNER_REQUIRED', 'nominal besar memerlukan owner');
    }
  }
  return {
    ok: true,
    body: {
      type: 'void.approved',
      payload: { orderId: order.orderId, reasonCode: cmd.reasonCode, approverIds: approvers, amount: cmd.amount },
    },
  };
}

export interface DiscountCommand {
  actorId: string;
  kind: 'MANUAL' | 'MEMBER' | 'COUPON';
  amount: number;
  percent: number;
  verified: boolean;
  approverId?: string;
}

/** Diskon setelah bill dicetak, atau diskon manual besar tanpa verifikasi, memerlukan supervisor. */
export function decideDiscount(order: OrderState, cmd: DiscountCommand, ctx: Ctx): Decision<'discount.applied'> {
  const policy = ctx.policy ?? DEFAULT_POLICY;
  if (order.status === 'PAID' || order.status === 'VOIDED') return deny('ORDER_CLOSED', 'order sudah selesai');

  const bigManual =
    cmd.kind === 'MANUAL' &&
    !cmd.verified &&
    (cmd.percent > policy.manualDiscountMaxPercent || cmd.amount > policy.manualDiscountMaxAmount);

  if (order.billPrinted || bigManual) {
    if (!cmd.approverId) return deny('APPROVAL_REQUIRED', 'diskon ini memerlukan persetujuan');
    if (cmd.approverId === cmd.actorId) return deny('SELF_APPROVAL', 'pelaku tidak boleh menyetujui sendiri');
    if (rank(ctx, cmd.approverId) < RANK.SUPERVISOR) return deny('APPROVER_ROLE_TOO_LOW', 'approver minimal supervisor');
  }
  return {
    ok: true,
    body: {
      type: 'discount.applied',
      payload: {
        orderId: order.orderId,
        kind: cmd.kind,
        amount: cmd.amount,
        percent: cmd.percent,
        verified: cmd.verified,
        approverId: cmd.approverId,
      },
    },
  };
}

export interface RefundCommand {
  actorId: string;
  refundId: string;
  approverId: string;
  amount: number;
  method: 'CASH' | 'QRIS' | 'EDC_DEBIT' | 'EDC_CREDIT';
}

/**
 * Refund harus merujuk order yang sudah dibayar, tidak melebihi yang dibayar, disetujui supervisor ke atas
 * yang bukan pelaku, dan nominal di atas ambang memerlukan owner.
 */
export function decideRefund(order: OrderState, cmd: RefundCommand, ctx: Ctx): Decision<'refund.created'> {
  const policy = ctx.policy ?? DEFAULT_POLICY;
  if (order.status !== 'PAID') return deny('NOT_PAID', 'refund hanya untuk order yang sudah dibayar');
  if (cmd.amount <= 0 || cmd.amount > order.paid) return deny('AMOUNT_INVALID', 'nominal refund tidak boleh melebihi yang dibayar');
  if (cmd.approverId === cmd.actorId) return deny('SELF_APPROVAL', 'pelaku tidak boleh menyetujui sendiri');
  if (rank(ctx, cmd.approverId) < RANK.SUPERVISOR) return deny('APPROVER_ROLE_TOO_LOW', 'approver minimal supervisor');
  if (cmd.amount > policy.secondApprovalAbove && ctx.roleOf(cmd.approverId) !== 'OWNER') {
    return deny('OWNER_REQUIRED', 'refund di atas ambang memerlukan owner');
  }
  return {
    ok: true,
    body: {
      type: 'refund.created',
      payload: { refundId: cmd.refundId, originalOrderId: order.orderId, amount: cmd.amount, method: cmd.method, approverId: cmd.approverId },
    },
  };
}

export interface EmployeeMealCommand {
  /** Kasir yang membuat order. */
  actorId: string;
  /** Karyawan penerima makan. */
  employeeId: string;
  /** Makan karyawan penerima yang sudah tercatat hari ini (tidak termasuk yang di-void). */
  mealsToday: number;
  approverId?: string;
}

export type EmployeeMealDecision =
  | { ok: true; /** Hanya terisi bila persetujuan memang diperlukan. */ approverId?: string }
  | { ok: false; code: string; message: string };

/**
 * Kunci makan karyawan (SPEC 5.3: kuota per orang per hari). Persetujuan supervisor ke atas diperlukan bila makan ini
 * melewati kuota, atau dibuat oleh penerimanya sendiri. Approver harus orang ketiga: bukan pembuat order dan bukan
 * penerima. Terminal hanya mengetahui order di perangkatnya sendiri, jadi penentu akhirnya tetap aturan R6 di server.
 */
export function decideEmployeeMeal(cmd: EmployeeMealCommand, ctx: Ctx): EmployeeMealDecision {
  const policy = ctx.policy ?? DEFAULT_POLICY;
  const reasons: string[] = [];
  if (cmd.mealsToday >= policy.employeeMealQuota) {
    reasons.push(`makan ke-${cmd.mealsToday + 1} hari ini untuk ${cmd.employeeId} (kuota ${policy.employeeMealQuota})`);
  }
  if (cmd.actorId === cmd.employeeId) reasons.push('dibuat oleh penerimanya sendiri');
  if (reasons.length === 0) return { ok: true };

  if (!cmd.approverId) return { ok: false, code: 'MEAL_APPROVAL_REQUIRED', message: `Makan karyawan ini perlu persetujuan: ${reasons.join('; ')}.` };
  if (cmd.approverId === cmd.actorId) return { ok: false, code: 'SELF_APPROVAL', message: 'Pembuat order tidak boleh menyetujui sendiri.' };
  if (cmd.approverId === cmd.employeeId) return { ok: false, code: 'RECIPIENT_APPROVAL', message: 'Penerima makan tidak boleh menjadi approver.' };
  if (rank(ctx, cmd.approverId) < RANK.SUPERVISOR) return { ok: false, code: 'APPROVER_ROLE_TOO_LOW', message: 'Approver minimal supervisor.' };
  return { ok: true, approverId: cmd.approverId };
}
export * from './tables';

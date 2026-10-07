import { describe, expect, it } from 'vitest';
import { EventChain, type NewEvent } from '@pos/events';
import { decideDiscount, decideRefund, decideVoid, replayOrder, type Ctx, type OrderState, type Role } from '../src';

const T0 = Date.parse('2026-10-01T10:00:00+07:00');
const ROLES: Record<string, Role> = {
  budi: 'CASHIER', sari: 'CASHIER', hendra: 'SUPERVISOR', rina: 'MANAGER', owner: 'OWNER',
};
const ctx: Ctx = { roleOf: (id) => ROLES[id] };

function replay(...bodies: Omit<NewEvent, 'deviceTime'>[]): OrderState {
  const c = new EventChain('t1', 'o1');
  const events = bodies.map((b, i) => c.append({ ...b, deviceTime: T0 + i * 1000, actorId: 'budi' } as NewEvent));
  return replayOrder(events, 'o1')!;
}

const created = { type: 'order.created', payload: { orderId: 'o1', orderType: 'DINE_IN' } } as const;
const sent = { type: 'order.sent_to_kitchen', payload: { orderId: 'o1' } } as const;
const billed = { type: 'bill.printed', payload: { orderId: 'o1', total: 100_000 } } as const;
const paid = { type: 'payment.received', payload: { orderId: 'o1', method: 'CASH', amount: 100_000 } } as const;
const served = { type: 'kitchen.status_changed', payload: { orderId: 'o1', status: 'SERVED' } } as const;

describe('reduceOrder', () => {
  it('alur normal: draft → sent → billed → paid', () => {
    expect(replay(created).status).toBe('DRAFT');
    expect(replay(created, sent).status).toBe('SENT');
    expect(replay(created, sent, billed).status).toBe('BILLED');
    expect(replay(created, sent, billed, paid).status).toBe('PAID');
  });
  it('pembayaran sebagian belum melunasi', () => {
    const s = replay(created, billed, {
      type: 'payment.received', payload: { orderId: 'o1', method: 'CASH', amount: 40_000 },
    });
    expect(s.status).toBe('BILLED');
    expect(s.paid).toBe(40_000);
  });
  it('mencatat pembuat order dan status dapur', () => {
    const s = replay(created, sent, served);
    expect(s.creatorId).toBe('budi');
    expect(s.kitchen).toBe('SERVED');
  });
});

describe('decideVoid', () => {
  const cmd = (over = {}) => ({ actorId: 'budi', approverIds: [] as string[], reasonCode: 'CUSTOMER_CANCEL', amount: 30_000, ...over });

  it('draft: tanpa persetujuan', () => {
    expect(decideVoid(replay(created), cmd(), ctx).ok).toBe(true);
  });

  it('alasan di luar daftar ditolak', () => {
    const r = decideVoid(replay(created), cmd({ reasonCode: 'customer tidak ambil struk' }), ctx);
    expect(r).toMatchObject({ ok: false, code: 'REASON_INVALID' });
  });

  it('setelah dikirim ke dapur butuh supervisor', () => {
    const o = replay(created, sent);
    expect(decideVoid(o, cmd(), ctx)).toMatchObject({ ok: false, code: 'NOT_ENOUGH_APPROVERS' });
    expect(decideVoid(o, cmd({ approverIds: ['sari'] }), ctx)).toMatchObject({ code: 'APPROVER_ROLE_TOO_LOW' });
    expect(decideVoid(o, cmd({ approverIds: ['hendra'] }), ctx).ok).toBe(true);
  });

  it('pelaku dan pembuat order tidak boleh jadi approver', () => {
    const o = replay(created, sent);
    expect(decideVoid(o, cmd({ actorId: 'hendra', approverIds: ['hendra'] }), ctx)).toMatchObject({ code: 'SELF_APPROVAL' });
    const ownOrder: Ctx = { roleOf: () => 'SUPERVISOR' };
    // budi membuat order dan mencoba menjadi approver untuk pelaku lain
    expect(decideVoid(o, cmd({ actorId: 'hendra', approverIds: ['budi'] }), ownOrder)).toMatchObject({ code: 'CREATOR_APPROVAL' });
  });

  it('setelah dibayar atau disajikan wajib owner', () => {
    const paidOrder = replay(created, sent, billed, paid);
    expect(decideVoid(paidOrder, cmd({ approverIds: ['rina'] }), ctx)).toMatchObject({ code: 'OWNER_REQUIRED' });
    expect(decideVoid(paidOrder, cmd({ approverIds: ['owner'] }), ctx).ok).toBe(true);
    const servedOrder = replay(created, sent, served);
    expect(decideVoid(servedOrder, cmd({ approverIds: ['hendra'] }), ctx)).toMatchObject({ code: 'OWNER_REQUIRED' });
  });

  it('nominal di atas ambang butuh dua approver termasuk owner', () => {
    const o = replay(created, sent);
    const big = cmd({ amount: 80_000 });
    expect(decideVoid(o, { ...big, approverIds: ['hendra'] }, ctx)).toMatchObject({ code: 'NOT_ENOUGH_APPROVERS' });
    expect(decideVoid(o, { ...big, approverIds: ['hendra', 'rina'] }, ctx)).toMatchObject({ code: 'OWNER_REQUIRED' });
    expect(decideVoid(o, { ...big, approverIds: ['hendra', 'owner'] }, ctx).ok).toBe(true);
  });

  it('order yang sudah void tidak bisa di-void lagi', () => {
    const o = replay(created, { type: 'void.approved', payload: { orderId: 'o1', reasonCode: 'DUPLICATE', approverIds: [], amount: 0 } });
    expect(decideVoid(o, cmd(), ctx)).toMatchObject({ code: 'ALREADY_VOIDED' });
  });
});

describe('decideDiscount', () => {
  const cmd = (over = {}) => ({ actorId: 'budi', kind: 'MANUAL' as const, amount: 5_000, percent: 5, verified: false, ...over });

  it('diskon kecil sebelum bill: lolos', () => {
    expect(decideDiscount(replay(created), cmd(), ctx).ok).toBe(true);
  });
  it('diskon setelah bill dicetak butuh supervisor', () => {
    const o = replay(created, billed);
    expect(decideDiscount(o, cmd(), ctx)).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(decideDiscount(o, cmd({ approverId: 'sari' }), ctx)).toMatchObject({ code: 'APPROVER_ROLE_TOO_LOW' });
    expect(decideDiscount(o, cmd({ approverId: 'hendra' }), ctx).ok).toBe(true);
  });
  it('diskon manual besar tanpa verifikasi butuh persetujuan; terverifikasi tidak', () => {
    const o = replay(created);
    expect(decideDiscount(o, cmd({ percent: 30, amount: 40_000 }), ctx)).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(decideDiscount(o, cmd({ kind: 'MEMBER', verified: true, percent: 30, amount: 40_000 }), ctx).ok).toBe(true);
  });
  it('order yang sudah lunas tidak bisa diberi diskon', () => {
    expect(decideDiscount(replay(created, billed, paid), cmd(), ctx)).toMatchObject({ code: 'ORDER_CLOSED' });
  });
});

describe('decideRefund', () => {
  const paidOrder = () => replay(created, billed, paid);
  const cmd = (over = {}) => ({ actorId: 'budi', refundId: 'r1', approverId: 'hendra', amount: 30_000, method: 'CASH' as const, ...over });

  it('hanya untuk order yang sudah dibayar dan tidak melebihi yang dibayar', () => {
    expect(decideRefund(replay(created), cmd(), ctx)).toMatchObject({ code: 'NOT_PAID' });
    expect(decideRefund(paidOrder(), cmd({ amount: 150_000 }), ctx)).toMatchObject({ code: 'AMOUNT_INVALID' });
  });
  it('approver bukan pelaku dan minimal supervisor', () => {
    expect(decideRefund(paidOrder(), cmd({ approverId: 'budi' }), ctx)).toMatchObject({ code: 'SELF_APPROVAL' });
    expect(decideRefund(paidOrder(), cmd({ approverId: 'sari' }), ctx)).toMatchObject({ code: 'APPROVER_ROLE_TOO_LOW' });
    expect(decideRefund(paidOrder(), cmd(), ctx).ok).toBe(true);
  });
  it('nominal di atas ambang memerlukan owner', () => {
    expect(decideRefund(paidOrder(), cmd({ amount: 80_000 }), ctx)).toMatchObject({ code: 'OWNER_REQUIRED' });
    expect(decideRefund(paidOrder(), cmd({ amount: 80_000, approverId: 'owner' }), ctx).ok).toBe(true);
  });
});

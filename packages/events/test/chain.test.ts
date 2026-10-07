import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson, EventChain, hashEvent, verifyChain, type PosEvent } from '../src';

const T0 = Date.parse('2026-10-01T10:00:00+07:00');

function sample(n = 5): PosEvent[] {
  const c = new EventChain('term-1', 'outlet-1');
  const out: PosEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      c.append({
        type: 'order.created',
        deviceTime: T0 + i * 1000,
        actorId: 'kasir-1',
        payload: { orderId: `o${i}`, orderType: 'DINE_IN' },
      }),
    );
  }
  return out;
}

describe('canonicalJson', () => {
  it('tidak bergantung pada urutan properti', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it('mengabaikan properti undefined', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('verifyChain', () => {
  it('rantai utuh tidak menghasilkan masalah', () => {
    expect(verifyChain(sample())).toEqual([]);
  });

  it('event yang dihapus terdeteksi sebagai lompatan seq', () => {
    const events = sample().filter((e) => e.seq !== 3);
    const issues = verifyChain(events);
    expect(issues.map((i) => i.kind)).toContain('SEQ_GAP');
  });

  it('event yang diubah terdeteksi sebagai hash tidak cocok', () => {
    const events = sample();
    const target = events[2]!;
    if (target.type === 'order.created') target.payload.orderType = 'EMPLOYEE';
    expect(verifyChain(events).map((i) => i.kind)).toContain('HASH_MISMATCH');
  });

  it('event yang disisipkan di tengah memutus rantai', () => {
    const events = sample();
    const forged = new EventChain('term-1', 'outlet-1');
    const fake = forged.append({
      type: 'order.created', deviceTime: T0, payload: { orderId: 'x', orderType: 'DINE_IN' },
    });
    const replaced = events.map((e) => (e.seq === 1 ? fake : e));
    expect(verifyChain(replaced).map((i) => i.kind)).toContain('CHAIN_BROKEN');
  });

  it('jam bergeser jauh dilaporkan', () => {
    const c = new EventChain('term-1', 'outlet-1');
    const e = c.append({
      type: 'device.heartbeat', deviceTime: T0, clockOffsetMs: 20 * 60_000, payload: { kind: 'terminal' },
    });
    expect(verifyChain([e]).map((i) => i.kind)).toEqual(['CLOCK_SKEW']);
  });

  it('urutan kedatangan tidak berpengaruh', () => {
    expect(verifyChain([...sample()].reverse())).toEqual([]);
  });
});

describe('hash dan kelanjutan rantai', () => {
  it('hash sama persis dengan SHA-256 bawaan Node (agar browser dan server sepakat)', () => {
    const [e] = sample(1);
    const { hash, ...rest } = e!;
    const expected = createHash('sha256').update(rest.prevHash).update(canonicalJson(rest)).digest('hex');
    expect(hash).toBe(expected);
    expect(hashEvent(rest as Parameters<typeof hashEvent>[0])).toBe(expected);
  });

  it('rantai dapat dilanjutkan dari posisi tersimpan tanpa memutus verifikasi', () => {
    const first = new EventChain('term-1', 'outlet-1');
    const a = first.append({ type: 'device.heartbeat', deviceTime: T0, payload: { kind: 'terminal' } });
    const resumed = new EventChain('term-1', 'outlet-1', first.position);
    const b = resumed.append({ type: 'device.heartbeat', deviceTime: T0 + 1000, payload: { kind: 'terminal' } });
    expect(b.seq).toBe(2);
    expect(verifyChain([a, b])).toEqual([]);
  });
});

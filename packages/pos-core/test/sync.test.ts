import { describe, expect, it } from 'vitest';
import { MemoryStore, Recorder, SyncClient } from '../src';

const T0 = Date.parse('2026-10-01T10:00:00+07:00');

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  let now = T0;
  const store = new MemoryStore();
  const recorder = new Recorder({ deviceId: 'term-1', outletId: 'o1', store, now: () => now });
  const calls: { url: string; body: { events: { seq: number }[] } }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return handler(url, init);
  }) as unknown as typeof fetch;
  const sync = new SyncClient(recorder, { baseUrl: 'http://api', token: 'dev_x', fetchImpl, now: () => now });
  return { recorder, sync, calls, setNow: (n: number) => { now = n; } };
}

const ackAll = (serverTime = T0) => (_u: string, init: RequestInit) => {
  const events = JSON.parse(init.body as string).events as { seq: number }[];
  return Response.json({ ackedSeq: events.at(-1)!.seq, accepted: events.length, duplicates: 0, issues: [], serverTime }, { status: 201 });
};

describe('SyncClient', () => {
  it('mengirim outbox berurutan dan menghapusnya setelah diakui', async () => {
    const t = setup(ackAll());
    await t.recorder.init();
    for (let i = 0; i < 3; i++) await t.recorder.record({ type: 'device.heartbeat', payload: { kind: 'terminal' } });
    const r = await t.sync.flush();
    expect(r).toEqual({ ok: true, sent: 3, remaining: 0, issues: [] });
    expect(t.calls[0]!.body.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(await t.recorder.pendingCount()).toBe(0);
  });

  it('offline: event tetap di outbox dan terkirim saat tersambung kembali', async () => {
    let online = false;
    const t = setup((u, i) => {
      if (!online) throw new TypeError('fetch failed');
      return ackAll()(u, i);
    });
    await t.recorder.init();
    await t.recorder.record({ type: 'device.heartbeat', payload: { kind: 'terminal' } });
    expect(await t.sync.flush()).toMatchObject({ ok: false, reason: 'offline' });
    expect(await t.recorder.pendingCount()).toBe(1);
    online = true;
    expect(await t.sync.flush()).toMatchObject({ ok: true, sent: 1, remaining: 0 });
  });

  it('server hanya mengakui sebagian: sisanya dikirim di putaran berikutnya', async () => {
    let first = true;
    const t = setup((_u, init) => {
      const events = JSON.parse(init.body as string).events as { seq: number }[];
      const ackedSeq = first ? 2 : events.at(-1)!.seq;
      first = false;
      return Response.json({ ackedSeq, accepted: 0, duplicates: 0, issues: [], serverTime: T0 }, { status: 201 });
    });
    await t.recorder.init();
    for (let i = 0; i < 4; i++) await t.recorder.record({ type: 'device.heartbeat', payload: { kind: 'terminal' } });
    const r = await t.sync.flush();
    expect(r).toMatchObject({ ok: true, remaining: 0 });
    expect(t.calls.map((c) => c.body.events.map((e) => e.seq))).toEqual([[1, 2, 3, 4], [3, 4]]);
  });

  it('token ditolak dan batch ditolak: event tidak dihapus', async () => {
    const t401 = setup(() => new Response('', { status: 401 }));
    await t401.recorder.init();
    await t401.recorder.record({ type: 'device.heartbeat', payload: { kind: 'terminal' } });
    expect(await t401.sync.flush()).toMatchObject({ ok: false, reason: 'unauthorized' });
    expect(await t401.recorder.pendingCount()).toBe(1);

    const t400 = setup(() => new Response('{"message":"event[0]: tidak valid"}', { status: 400 }));
    await t400.recorder.init();
    await t400.recorder.record({ type: 'device.heartbeat', payload: { kind: 'terminal' } });
    expect(await t400.sync.flush()).toMatchObject({ ok: false, reason: 'rejected' });
    expect(await t400.recorder.pendingCount()).toBe(1);
  });

  it('mengukur selisih jam perangkat dan memakainya pada event berikutnya; derau kecil diabaikan', async () => {
    const t = setup(ackAll(T0 - 600_000)); // jam server 10 menit di belakang perangkat
    await t.recorder.init();
    await t.recorder.record({ type: 'device.heartbeat', payload: { kind: 'terminal' } });
    await t.sync.flush();
    expect(t.recorder.offsetMs).toBe(600_000);
    const e = await t.recorder.record({ type: 'device.heartbeat', payload: { kind: 'terminal' } });
    expect(e.clockOffsetMs).toBe(600_000);

    const t2 = setup(ackAll(T0 - 800)); // 0,8 detik: derau
    await t2.recorder.init();
    await t2.recorder.record({ type: 'device.heartbeat', payload: { kind: 'terminal' } });
    await t2.sync.flush();
    expect(t2.recorder.offsetMs).toBe(0);
  });

  it('pemanggilan flush bersamaan tidak mengirim ganda', async () => {
    const t = setup(ackAll());
    await t.recorder.init();
    await t.recorder.record({ type: 'device.heartbeat', payload: { kind: 'terminal' } });
    await Promise.all([t.sync.flush(), t.sync.flush()]);
    expect(t.calls).toHaveLength(1);
  });
});

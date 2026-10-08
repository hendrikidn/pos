import { describe, expect, it } from 'vitest';
import { demoConfig, MemoryStore, PosEngine, Recorder, SimPrinter } from '../src';

const T0 = Date.parse('2026-10-01T08:00:00+07:00');

async function boot(store = new MemoryStore(), at = () => T0) {
  const config = await demoConfig();
  const recorder = new Recorder({ deviceId: config.deviceId, outletId: config.outletId, store, now: at });
  const engine = new PosEngine({ config, recorder, store, printer: new SimPrinter(), now: at });
  await engine.init();
  return { engine, recorder, store, pins: config.demoPins, config };
}

describe('engine: absensi', () => {
  it('absen masuk dan pulang tercatat sebagai event milik staf yang login; menit kerja dihitung', async () => {
    let now = T0;
    const b = await boot(new MemoryStore(), () => now);
    expect(await b.engine.clockIn()).toMatchObject({ ok: false, code: 'NOT_LOGGED_IN' });
    await b.engine.login('budi', b.pins.budi);
    expect(b.engine.clockedInSince()).toBeNull();
    expect((await b.engine.clockIn()).ok).toBe(true);
    expect(b.engine.clockedInSince()).toBe(T0);
    expect(await b.engine.clockIn()).toMatchObject({ ok: false, code: 'ALREADY_CLOCKED_IN' });
    now += 8 * 3_600_000 + 15 * 60_000;
    const out = await b.engine.clockOut();
    expect(out).toMatchObject({ ok: true, value: { since: T0, minutes: 495 } });
    expect(b.engine.clockedInSince()).toBeNull();
    expect(await b.engine.clockOut()).toMatchObject({ ok: false, code: 'NOT_CLOCKED_IN' });
    const ev = (await b.recorder.pending()).filter((e) => e.type === 'attendance.clocked');
    expect(ev.map((e) => [e.payload.kind, e.actorId])).toEqual([['IN', 'budi'], ['OUT', 'budi']]);
  });

  it('status per staf: staf lain tidak terpengaruh; bertahan setelah terminal dimulai ulang', async () => {
    const store = new MemoryStore();
    const a = await boot(store);
    await a.engine.login('budi', a.pins.budi);
    await a.engine.clockIn();
    await a.engine.login('sari', a.pins.sari);
    expect(a.engine.clockedInSince()).toBeNull(); // sari belum absen
    expect(a.engine.clockedInSince('budi')).toBe(T0);
    const b = await boot(store);
    expect(b.engine.clockedInSince('budi')).toBe(T0);
    await b.engine.login('budi', b.pins.budi);
    expect(await b.engine.clockIn()).toMatchObject({ ok: false, code: 'ALREADY_CLOCKED_IN' });
    expect((await b.engine.clockOut()).ok).toBe(true);
  });
});

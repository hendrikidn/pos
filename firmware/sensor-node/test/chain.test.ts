import { execFileSync, spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashEvent, verifyChain, type PosEvent } from '@pos/events';
import { parseEvent } from '../../../apps/api/src/ingest.service';
import { build, hasCompiler } from './helpers';

let bins: ReturnType<typeof build>;
beforeAll(() => {
  bins = hasCompiler ? build() : null;
});

const T0 = Date.parse('2026-10-02T10:00:00+07:00');

function gen(args: (string | number)[]): { events: PosEvent[]; state: { seq: number; hash: string } } {
  const lines = execFileSync(bins!.genEvents, args.map(String)).toString().trim().split('\n');
  const stateLine = lines.pop()!.split(' ');
  return { events: lines.map((l) => JSON.parse(l) as PosEvent), state: { seq: Number(stateLine[1]), hash: stateLine[2]! } };
}

describe.skipIf(!hasCompiler)('rantai event dari firmware (C) diverifikasi oleh TypeScript', () => {
  it('rantai utuh: tidak ada masalah integritas', () => {
    const { events } = gen(['sensor-sen', 'o1', 0, '-', 12, T0, 0, 'pos-1']);
    expect(events).toHaveLength(12);
    expect(verifyChain(events)).toEqual([]);
  });

  it('hash sama persis dengan hashEvent TypeScript untuk setiap event', () => {
    const { events } = gen(['sensor-sen', 'o1', 0, '-', 9, T0, 0]);
    for (const e of events) {
      const { hash, ...rest } = e;
      expect(hashEvent(rest as Parameters<typeof hashEvent>[0])).toBe(hash);
    }
  });

  it('melanjutkan rantai dari posisi tersimpan (seperti setelah perangkat dinyalakan ulang)', () => {
    const first = gen(['sensor-sen', 'o1', 0, '-', 5, T0, 0]);
    const second = gen(['sensor-sen', 'o1', first.state.seq, first.state.hash, 5, T0 + 600_000, 0]);
    expect(second.events[0]!.seq).toBe(6);
    expect(verifyChain([...first.events, ...second.events])).toEqual([]);
  });

  it('selisih jam dicantumkan dan terdeteksi bila terlalu besar', () => {
    const { events } = gen(['sensor-sen', 'o1', 0, '-', 3, T0, 600_000]);
    expect(events[0]!.clockOffsetMs).toBe(600_000);
    expect(verifyChain(events).map((i) => i.kind)).toContain('CLOCK_SKEW');
  });

  it('semua event lolos validasi isi yang dipakai server saat ingest', () => {
    const { events } = gen(['sensor-sen', 'o1', 0, '-', 9, T0, 0, 'pos-1']);
    for (const e of events) expect(typeof parseEvent(e)).toBe('object');
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['device.heartbeat', 'presence.session']));
  });

  it('event berisi data sesi yang benar', () => {
    const { events } = gen(['sensor-sen', 'o1', 0, '-', 3, T0, 0, 'pos-1']);
    const e = events[2]!;
    expect(e).toMatchObject({ type: 'presence.session', deviceId: 'sensor-sen', outletId: 'o1', id: 'sensor-sen:3', actorId: null });
    if (e.type === 'presence.session') expect(e.payload).toMatchObject({ terminalId: 'pos-1', end: T0 + 60_000, start: T0 + 2_000 });
  });

  it('menolak ID perangkat atau hash awal yang tidak aman/valid', () => {
    for (const args of [['sensor sen', 'o1', 0, '-', 1, T0, 0], ['sensor-sen', 'o"1', 0, '-', 1, T0, 0], ['sensor-sen', 'o1', 5, 'bukan-hash', 1, T0, 0]]) {
      const r = spawnSync(bins!.genEvents, args.map(String));
      expect(r.status).toBe(3);
    }
  });
});

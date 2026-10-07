import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PosEvent } from '@pos/events';
import { createHarness, type Harness } from '../../../apps/api/test/harness';
import { build, hasCompiler } from './helpers';

const T0 = Date.parse('2026-10-02T10:00:00+07:00');

describe.skipIf(!hasCompiler)('sensor firmware → API sungguhan', () => {
  let h: Harness;
  let token: string;
  let genEvents: string;

  const gen = (args: (string | number)[]) => {
    const lines = execFileSync(genEvents, args.map(String)).toString().trim().split('\n');
    const [, seq, hash] = lines.pop()!.split(' ');
    return { events: lines.map((l) => JSON.parse(l) as PosEvent), seq: Number(seq), hash: hash! };
  };

  beforeAll(async () => {
    genEvents = build()!.genEvents;
    h = await createHarness(T0 + 3_600_000);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['pos-1'] });
    token = await h.admin.createDevice('t1', 'o1', 'sensor-sen', 'sensor');
  });
  afterAll(() => h.close());

  it('server menerima event buatan firmware: hash dan rantai cocok, tanpa masalah integritas', async () => {
    const a = gen(['sensor-sen', 'o1', 0, '-', 12, T0, 0, 'pos-1']);
    const r = await h.postEvents(token, a.events);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ accepted: 12, duplicates: 0, issues: [], ackedSeq: 12 });
  });

  it('setelah dinyalakan ulang, rantai berlanjut tanpa celah atau ketidakcocokan', async () => {
    const first = (await h.db.tenantTx('t1', async (q) =>
      (await q.query<{ last_seq: number; last_hash: string }>("select last_seq, last_hash from device where id = 'sensor-sen'")).rows,
    ))[0]!;
    const next = gen(['sensor-sen', 'o1', first.last_seq, first.last_hash, 6, T0 + 3_600_000, 0, 'pos-1']);
    const r = await h.postEvents(token, next.events);
    expect(r.body).toMatchObject({ accepted: 6, issues: [], ackedSeq: 18 });
  });

  it('sesi presence dari firmware muncul sebagai event yang dipakai mesin aturan', async () => {
    const rows = await h.db.tenantTx('t1', async (q) =>
      (await q.query<{ payload: { terminalId: string; end: number } }>("select payload from event where type = 'presence.session' order by seq limit 1")).rows,
    );
    expect(rows[0]!.payload).toMatchObject({ terminalId: 'pos-1' });
  });

  it('event tanpa kelanjutan yang benar (posisi rantai salah) dilaporkan server', async () => {
    const wrong = gen(['sensor-sen', 'o1', 18, '-', 2, T0 + 7_200_000, 0]); // prev_hash genesis, padahal seharusnya hash seq 18
    const r = await h.postEvents(token, wrong.events);
    expect(r.body.issues.map((i: { kind: string }) => i.kind)).toContain('CHAIN_BROKEN');
  });
});

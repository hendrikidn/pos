import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { GuardService } from '../src/guard.service';
import { PipelineService } from '../src/pipeline.service';
import { createHarness, type Harness } from '../test/harness';
import { buildDataset } from './dataset';

/**
 * Uji beban evaluasi aturan: satu outlet sibuk (3 terminal, ORDERS_PER_DAY order per hari, 14 hari) lalu ukur
 *  - waktu satu evaluasi penuh (`GuardService.evaluate`),
 *  - waktu satu permintaan setoran event kecil (yang memicu evaluasi), dan
 *  - waktu setoran serentak dari tiga terminal.
 * Jalankan: TEST_PG_URL=postgres://postgres:pw@127.0.0.1:5433/postgres BENCH_ORDERS=600 npm run bench
 */
const ORDERS_PER_DAY = Number(process.env['BENCH_ORDERS'] ?? 600);
const DAYS = 14;
const TERMINALS = ['term-1', 'term-2', 'term-3'];
const ms = (a: number) => Math.round(a);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

describe(`beban evaluasi (${process.env['BENCH_MODE'] ?? 'sync'}): ${ORDERS_PER_DAY} order/hari x ${DAYS} hari x ${TERMINALS.length} terminal`, () => {
  let h: Harness;
  let owner: string;
  const toks: Record<string, string> = {};
  const sims: Record<string, Sim> = {};
  const sent: Record<string, number> = {};
  const end = Date.parse('2026-10-09T20:00:00+07:00');
  let total = 0;

  const post = async (tid: string, upTo = Infinity) => {
    const sim = sims[tid]!;
    const rows = sim.events.slice(sent[tid]!, upTo);
    for (let i = 0; i < rows.length; i += 500) {
      const t0 = performance.now();
      const r = await h.postEvents(toks[tid]!, rows.slice(i, i + 500));
      expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(201);
      if (i === 0 && rows.length <= 500) return performance.now() - t0;
    }
    sent[tid] = Number.isFinite(upTo) ? upTo : sim.events.length;
    return 0;
  };

  beforeAll(async () => {
    h = await createHarness(end, { evaluateMode: process.env['BENCH_MODE'] === 'background' ? 'background' : 'sync' });
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createOutlet('t1', 'o1', 'Outlet Sibuk', { terminals: TERMINALS, capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    for (const tid of TERMINALS) {
      toks[tid] = await h.admin.createDevice('t1', 'o1', tid, 'terminal');
      sims[tid] = new Sim('o1', '2026-10-01', tid, 'sensor-1');
      sent[tid] = 0;
    }
    for (const [id, name, pin] of [['budi', 'Budi', '4827'], ['sari', 'Sari', '5930'], ['dewi', 'Dewi', '6041']]) await h.http('POST', '/v1/staff', owner, { id, name, role: 'CASHIER', pin });
    total = buildDataset(sims, TERMINALS, ORDERS_PER_DAY, DAYS);
  });
  afterAll(() => h.close());

  it('memuat data lalu mengukur setoran dan evaluasi', async () => {
    const tIngest = performance.now();
    // Muat semua kecuali 20 event terakhir tiap terminal; yang terakhir dipakai untuk mengukur setoran "hidup".
    for (const tid of TERMINALS) await post(tid, sims[tid]!.events.length - 20);
    const loadMs = performance.now() - tIngest;
    const rows = (await h.db.admin.query<{ n: string }>('select count(*) n from event')).rows[0]!.n;
    console.log(`BENCH data: ${rows} event dimuat (${ms(loadMs)} ms, ${ms((Number(rows) / loadMs) * 1000)} event/dtk)`);

    const guard = h.app.get(GuardService);
    const evalTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await guard.evaluate('t1', 'o1', end);
      evalTimes.push(performance.now() - t0);
    }
    console.log(`BENCH evaluasi penuh: median ${ms(pct(evalTimes, 0.5))} ms, maks ${ms(Math.max(...evalTimes))} ms (5 kali)`);

    const inc = (await h.http('GET', '/v1/outlets/o1/incidents', owner)).body as unknown[];
    const size = (await h.db.admin.query<{ b: string }>("select pg_total_relation_size('event') b")).rows[0]!.b;
    console.log(`BENCH ukuran tabel event: ${Math.round(Number(size) / 1e6)} MB untuk ${rows} baris (${Math.round(Number(size) / Number(rows))} byte/event); insiden terbaca: ${inc.length}`);
    const live: number[] = [];
    for (const tid of TERMINALS) live.push(await post(tid));
    console.log(`BENCH setoran 20 event (sinkron + evaluasi): ${live.map(ms).join(' / ')} ms`);

    // Tiga terminal menyetor serentak, 5 putaran: meniru sinkronisasi tiap 5 dtk.
    const burst: number[] = [];
    for (let round = 0; round < 5; round++) {
      const t0 = performance.now();
      await Promise.all(TERMINALS.map(async (tid, ti) => {
        const sim = sims[tid]!;
        sim.pos({ type: 'order.created', payload: { orderId: `x-${tid}-${round}`, orderType: 'TAKE_AWAY' } }, end + round * 5_000 + ti * 10, 'budi');
        await post(tid);
      }));
      burst.push(performance.now() - t0);
    }
    await h.app.get(PipelineService).drain();
    console.log(`BENCH 3 terminal serentak: ${burst.map(ms).join(' / ')} ms per putaran (total event ${total})`);
  });
});

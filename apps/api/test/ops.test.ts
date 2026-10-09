import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { Alerter } from '../src/alerter';
import { GuardService } from '../src/guard.service';
import { OpsController } from '../src/ops.controller';
import { PipelineService } from '../src/pipeline.service';
import { Telemetry } from '../src/telemetry';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('operasional: kesiapan, metrik, header, peringatan', () => {
  let h: Harness;
  let owner: string;
  let term: string;
  const alerts: string[] = [];
  const base = () => (h.app.getHttpServer().address() as { port: number }).port;
  const fetchRaw = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${base()}${path}`, { headers });

  beforeAll(async () => {
    process.env['METRICS_TOKEN'] = 'metrik-rahasia-1234567890';
    h = await createHarness(WIB('2026-10-08T10:00:00'), { alertSink: async (t) => { alerts.push(t); } });
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
  });
  afterAll(async () => { delete process.env['METRICS_TOKEN']; await h.close(); });

  it('readyz menjawab 200 dan healthz tetap hidup; keduanya tanpa login', async () => {
    expect((await fetchRaw('/readyz')).status).toBe(200);
    expect((await fetchRaw('/healthz')).status).toBe(200);
  });

  it('header keamanan ada di semua jawaban; x-powered-by tidak; id permintaan dari proxy dipakai bila sah dan diganti bila tidak', async () => {
    const r = await fetchRaw('/v1/me', { authorization: `Bearer ${owner}`, 'x-request-id': 'req-abc12345' });
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-powered-by')).toBeNull();
    expect(r.headers.get('x-request-id')).toBe('req-abc12345');
    const bad = await fetchRaw('/healthz', { 'x-request-id': 'bad id <script>' });
    expect(bad.headers.get('x-request-id')).toMatch(/^[0-9a-f]{16}$/);
    expect((await fetchRaw('/nope')).headers.get('x-content-type-options')).toBe('nosniff'); // juga untuk 404
    expect(r.headers.get('strict-transport-security')).toBeNull(); // bukan HTTPS
  });

  it('metrik: mati tanpa token; token salah 401; token benar memuat rute berpola, tanpa id, token, atau isi', async () => {
    delete process.env['METRICS_TOKEN'];
    expect((await fetchRaw('/metrics')).status).toBe(404);
    process.env['METRICS_TOKEN'] = 'metrik-rahasia-1234567890';
    expect((await fetchRaw('/metrics')).status).toBe(401);
    expect((await fetchRaw('/metrics', { authorization: 'Bearer salah' })).status).toBe(401);
    await h.http('GET', '/v1/outlets/o1/web-orders/12345/../x', owner); // rute tak dikenal tidak menambah seri
    await h.http('POST', '/v1/outlets/o1/web-orders/999/reject', owner, { reason: 'rahasia-isi' });
    const sim = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
    sim.cashOrder('A-1', '10:00:00', '10:01:00');
    expect((await h.postEvents(term, sim.events)).status).toBe(201);
    const m = await (await fetchRaw('/metrics', { authorization: 'Bearer metrik-rahasia-1234567890' })).text();
    expect(m).toContain('pos_http_requests_total{method="POST",route="/v1/events",status="2xx"} 1');
    expect(m).toContain('route="/v1/outlets/:outletId/web-orders/:id/reject"');
    expect(m).toContain('route="unmatched"');
    expect(m).toContain('pos_events_received_total{result="accepted"} 4');
    expect(m).toContain('pos_evaluations_total{result="ok"}');
    expect(m).toContain('pos_terminal_last_seen_age_seconds{device="term-1",outlet="o1"}');
    expect(m).toContain('pos_http_request_duration_seconds_bucket');
    for (const secret of [owner, term, 'rahasia-isi', '/999', '/12345', 'metrik-rahasia']) expect(m).not.toContain(secret);
  });
});

describe('Alerter dan PipelineService', () => {
  it('peringatan diredam per kunci dalam jendelanya, kegagalan sink tidak melempar, tanpa sink tidak mengirim', async () => {
    let t = 1_000;
    const got: string[] = [];
    const a = new Alerter(60_000, () => t);
    a.sink = async (x) => { got.push(x); };
    expect(await a.alert('k1', 'satu')).toBe(true);
    expect(await a.alert('k1', 'satu lagi')).toBe(false); // diredam
    expect(await a.alert('k2', 'dua')).toBe(true); // kunci lain lolos
    t += 61_000;
    expect(await a.alert('k1', 'tiga')).toBe(true); // jendela lewat
    expect(got).toEqual(['[Anatta POS] satu', '[Anatta POS] dua', '[Anatta POS] tiga']);
    a.sink = async () => { throw new Error('webhook mati'); };
    expect(await a.alert('k3', 'gagal')).toBe(false);
    a.sink = null;
    expect(await a.alert('k4', 'tanpa sink')).toBe(false);
  });

  it('mode background menggabungkan: banyak setoran = satu evaluasi segera + satu susulan setelah jeda; drain menjalankan yang tertunda', async () => {
    const calls: number[] = [];
    const guard = { evaluate: async () => { calls.push(Date.now()); await sleep(20); return { incidents: [], newCritical: [] }; } };
    const p = new PipelineService(guard as never, { notifyCritical: async () => {} }, new Telemetry(), new Alerter(), () => 1, 'background', 150);
    await Promise.all(Array.from({ length: 12 }, () => p.schedule('t1', 'o1')));
    await sleep(60);
    expect(calls).toHaveLength(1); // yang pertama segera; sisanya digabung dan menunggu jeda
    await sleep(250);
    expect(calls).toHaveLength(2); // satu susulan, bukan sebelas
    await p.schedule('t1', 'o1');
    await p.schedule('t1', 'o1');
    await p.drain(); // tidak menunggu jeda
    expect(calls).toHaveLength(3);
    await sleep(300);
    expect(calls).toHaveLength(3); // tidak ada yang tersisa
  });

  it('mode background: outlet berbeda tidak saling menunda; kegagalan evaluasi dicatat, dikirim sebagai peringatan, dan tidak melempar', async () => {
    const ran: string[] = [];
    const guard = { evaluate: async (_t: string, o: string) => { ran.push(o); if (o === 'rusak') throw new Error('kueri gagal'); return { incidents: [], newCritical: [] }; } };
    const sent: string[] = [];
    const alerter = new Alerter(60_000);
    alerter.sink = async (x) => { sent.push(x); };
    const tel = new Telemetry();
    const p = new PipelineService(guard as never, { notifyCritical: async () => {} }, tel, alerter, () => 1, 'background', 10_000);
    await p.schedule('t1', 'a');
    await p.schedule('t1', 'b');
    await p.schedule('t1', 'rusak');
    await p.drain();
    expect(ran.sort()).toEqual(['a', 'b', 'rusak']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('rusak');
    expect(sent[0]).toContain('kueri gagal');
    expect(tel.read('pos_evaluations_total', { result: 'error' })).toBe(1);
    expect(tel.read('pos_evaluations_total', { result: 'ok' })).toBe(2);
  });

  it('readyz 503 saat database mati dan peringatan hanya sekali; pulih memberi peringatan pulih', async () => {
    let down = true;
    const db = { admin: { query: async () => { if (down) throw new Error('koneksi ditolak'); return { rows: [], rowCount: 0 }; } }, driver: {} };
    const sent: string[] = [];
    const alerter = new Alerter(0);
    alerter.sink = async (x) => { sent.push(x); };
    const ops = new OpsController(db as never, new Telemetry(), alerter);
    await expect(ops.ready(undefined)).rejects.toMatchObject({ status: 503 });
    await expect(ops.ready(undefined)).rejects.toMatchObject({ status: 503 });
    expect(sent.filter((s) => s.includes('tidak terjangkau'))).toHaveLength(1);
    down = false;
    expect(await ops.ready(undefined)).toEqual({ ok: true });
    expect(sent.some((s) => s.includes('kembali terjangkau'))).toBe(true);
  });
});

describe('mode background di API sungguhan', () => {
  it('setoran event menjawab tanpa menunggu evaluasi; insiden muncul setelah evaluasi latar belakang selesai', async () => {
    const h = await createHarness(WIB('2026-10-08T20:00:00'), { evaluateMode: 'background', evaluateMinGapMs: 50 });
    try {
      await h.admin.createTenant('t1', 'Tenant 1');
      await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
      const owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
      const term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
      const guard = h.app.get(GuardService);
      const orig = guard.evaluate.bind(guard);
      let finished = false;
      guard.evaluate = async (...a) => { await sleep(400); const r = await orig(...a); finished = true; return r; };
      const s = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
      s.cashOrder('A-1', '19:00:00', '19:01:00');
      const t0 = Date.now();
      expect((await h.postEvents(term, s.events)).status).toBe(201);
      expect(Date.now() - t0).toBeLessThan(300); // tidak menunggu evaluasi yang 400 ms
      expect(finished).toBe(false);
      await h.app.get(PipelineService).drain();
      expect(finished).toBe(true);
      expect(h.app.get(Telemetry).read('pos_evaluations_total', { result: 'ok' })).toBe(1);
      expect((await h.http('GET', '/v1/outlets/o1/incidents', owner)).status).toBe(200);
    } finally {
      await h.close();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

/** Semua route terdaftar (modul lama dan baru) dipanggil dengan body dan id aneh: tidak boleh ada 5xx. */
describe('fuzz semua route', () => {
  let h: Harness;
  let owner: string;
  let term: string;
  beforeAll(async () => {
    h = await createHarness(Date.parse('2026-10-08T12:00:00+07:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
  });
  afterAll(() => h.close());

  it('tidak ada 5xx', { timeout: 180_000 }, async () => {
    const router = (h.app.getHttpAdapter().getInstance() as unknown as { _router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }; router?: { stack: unknown[] } });
    const stack = (router._router?.stack ?? []) as { route?: { path: string; methods: Record<string, boolean> } }[];
    const routes = stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route!.methods).map((m) => [m.toUpperCase(), l.route!.path] as const));
    expect(routes.length).toBeGreaterThan(100); // pastikan route benar-benar terbaca
    const SKIP = /login|password|otp|signup|enroll|admin|logout|platform/;
    const bodies: unknown[] = [undefined, {}, null, [], 'x', { a: 1 }, { id: 'x', name: 'x', amount: 'x', qty: -1, lines: [{}], items: [{}], from: 'x', to: 'x', date: 'x', day: 'x' }];
    const ids = ['1', '0', '-1', '99999999999999999999', 'abc', 'o1', 'kopi', '%00'];
    const bad = new Set<string>();
    for (const [method, path] of routes) {
      if (SKIP.test(path)) continue;
      for (const id of ids) {
        const p = path.replace(/:[a-zA-Z]+/g, id);
        for (const body of method === 'GET' || method === 'DELETE' ? [undefined] : bodies) {
          for (const tok of [owner, term]) {
            const q = method === 'GET' ? '?from=x&to=x&days=x&limit=x&range=x&day=x&outletId=x&date=x' : '';
            const r = await h.http(method, p + q, tok, body);
            if (r.status >= 500) bad.add(`${method} ${path} [${id}] ${tok === owner ? 'owner' : 'term'} → ${r.status}`);
          }
        }
      }
    }
    expect([...bad]).toEqual([]);
  });
});

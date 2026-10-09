import { Sim } from '@pos/sim';
import { AdminService } from '../src/admin.service';
import { createApp } from '../src/bootstrap';
import { Database } from '../src/db/database';
import { PgDriver } from '../src/db/driver';
import { buildDataset } from './dataset';

/**
 * Mengisi database PostgreSQL (DATABASE_URL) dengan data sintetis satu outlet sibuk lewat API sungguhan, untuk menguji cadangan/pulih dan kinerja:
 *   DATABASE_URL=postgres://... SEED_ORDERS=150 npx tsx apps/api/bench/seed.ts
 */
async function main() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL wajib diisi');
  const orders = Number(process.env['SEED_ORDERS'] ?? 150);
  const days = Number(process.env['SEED_DAYS'] ?? 14);
  const db = new Database(new PgDriver(url));
  await db.migrate();
  const app = await createApp(db, { evaluateMode: 'background', pinIterations: 1_000 });
  await app.listen(0);
  const port = (app.getHttpServer().address() as { port: number }).port;
  const admin = app.get(AdminService);
  const terminals = ['term-1', 'term-2', 'term-3'];
  await admin.createTenant('seed', 'Tenant Seed');
  await admin.createOutlet('seed', 'o1', 'Outlet Sibuk', { terminals, capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
  const owner = await admin.createApiToken('seed', 'owner-1', 'OWNER');
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  for (const [id, name, pin] of [['budi', 'Budi', '4827'], ['sari', 'Sari', '5930'], ['dewi', 'Dewi', '6041']]) await call('POST', '/v1/staff', owner, { id, name, role: 'CASHIER', pin });
  const sims: Record<string, Sim> = {};
  const tokens: Record<string, string> = {};
  for (const t of terminals) { sims[t] = new Sim('o1', '2026-10-01', t, 'sensor-1'); tokens[t] = await admin.createDevice('seed', 'o1', t, 'terminal'); }
  const n = buildDataset(sims, terminals, orders, days);
  for (const t of terminals) {
    const ev = sims[t]!.events;
    for (let i = 0; i < ev.length; i += 500) {
      const r = await call('POST', '/v1/events', tokens[t]!, { events: ev.slice(i, i + 500) });
      if (r.status !== 201) throw new Error(`setoran gagal ${r.status}: ${r.text.slice(0, 200)}`);
    }
  }
  console.log(`seed selesai: ${n} event`);
  await app.close();
  await db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });

import { Sim } from '@pos/sim';
import { AdminService } from './admin.service';
import type { ApiAuth } from './auth';
import { ConfigService } from './config.service';
import { createApp } from './bootstrap';
import { ConsoleMailer } from './mailer';
import { hashPassword } from './password';
import { Database } from './db/database';
import { PgliteDriver } from './db/driver';

/**
 * Menjalankan API dengan data simulasi untuk mencoba dashboard tanpa hardware.
 * Waktu kejadian dihitung relatif terhadap sekarang, sehingga selalu berada dalam jendela evaluasi 72 jam.
 */
async function main() {
  const db = new Database(await PgliteDriver.create());
  await db.migrate();
  const app = await createApp(db, {
    dashboardUrl: process.env['DASHBOARD_URL'] ?? 'http://localhost:3001',
    mailer: new ConsoleMailer(), // demo: kode masuk dicetak di konsol ini
    corsOrigins: ['http://localhost:3002', 'http://127.0.0.1:3002'],
  });
  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);
  const admin = app.get(AdminService);

  await admin.createTenant('demo', 'Demo F&B');
  const caps = { sensor: true, kds: false, printerReportsStatus: true };
  await admin.createOutlet('demo', 'senopati', 'Kopi Senopati', { terminals: ['term-sen', 'pos-1'], capabilities: caps, cctvRetentionDays: 7 });
  await admin.createOutlet('demo', 'kemang', 'Kopi Kemang', { terminals: ['term-kem'], capabilities: caps, cctvRetentionDays: 14 });
  const term = await admin.createDevice('demo', 'senopati', 'term-sen', 'terminal');
  const sensor = await admin.createDevice('demo', 'senopati', 'sensor-sen', 'sensor');
  await admin.createDevice('demo', 'kemang', 'term-kem', 'terminal');
  const posToken = await admin.createDevice('demo', 'senopati', 'pos-1', 'terminal'); // terminal POS yang bisa Anda pakai langsung
  const liveSensorToken = await admin.createDevice('demo', 'senopati', 'sensor-pos1', 'sensor'); // sensor ESP32 sungguhan untuk terminal pos-1
  const owner = await admin.createApiToken('demo', 'owner-demo', 'OWNER', 'demo owner');
  const manager = await admin.createApiToken('demo', 'rina', 'MANAGER', 'demo manager');
  await db.admin.query("insert into dashboard_user (tenant_id, user_id, email, role) values ('demo', 'owner-demo', 'owner@demo.local', 'OWNER'), ('demo', 'rina', 'rina@demo.local', 'MANAGER')");
  await db.admin.query("update dashboard_user set password_hash = $1, password_set_at = now() where tenant_id = 'demo'", [await hashPassword('demo-password-2026')]);

  // Konfigurasi terminal: pengaturan outlet, staf (PIN disimpan sebagai hash), dan menu, lewat layanan yang sama dengan API.
  const config = app.get(ConfigService);
  const seeder: ApiAuth = { kind: 'api', tenantId: 'demo', userId: 'demo-seed', role: 'OWNER' };
  await config.updateSettings(seeder, 'senopati', {
    merchantName: 'Kopi Senopati', taxPercent: 10, edcs: [{ tid: '12345678', bank: 'Mandiri', label: 'EDC Mandiri' }],
  });
  const demoPins = { budi: '4827', sari: '5930', hendra: '7351', rina: '2468', owner: '9042' };
  const people = [
    ['budi', 'Budi (Kasir)', 'CASHIER'], ['sari', 'Sari (Kasir)', 'CASHIER'], ['hendra', 'Hendra (Supervisor)', 'SUPERVISOR'],
    ['rina', 'Rina (Manager)', 'MANAGER'], ['owner', 'Owner', 'OWNER'],
  ] as const;
  for (const [id, name, role] of people) await config.createStaff(seeder, { id, name, role, pin: demoPins[id] });
  const menu: [string, string, number, string][] = [
    ['kopi-susu', 'Kopi Susu', 22_000, 'Kopi'], ['americano', 'Americano', 20_000, 'Kopi'], ['latte', 'Latte', 26_000, 'Kopi'],
    ['matcha', 'Matcha Latte', 28_000, 'Non-kopi'], ['teh', 'Teh Tarik', 18_000, 'Non-kopi'], ['croissant', 'Croissant', 24_000, 'Makanan'],
    ['nasi-goreng', 'Nasi Goreng', 38_000, 'Makanan'], ['mie-goreng', 'Mie Goreng', 35_000, 'Makanan'], ['wagyu-bowl', 'Wagyu Rice Bowl', 92_500, 'Makanan'],
  ];
  for (const [id, name, price, category] of menu) await config.createMenu(seeder, { id, name, price, category });

  const call = async (path: string, token: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`);
    return r.json() as Promise<any>;
  };

  const now = Date.now();
  const MIN = 60_000;
  const at = (minutesAgo: number, sec = 0) => now - minutesAgo * MIN + sec * 1000;
  const s = new Sim('senopati', '2026-01-01', 'term-sen', 'sensor-sen');

  // Kasus 1 (kritis): void setelah customer bayar dan pergi, saat kertas habis. Kasir budi, approver hendra.
  s.heartbeats('sensor', at(215), at(0), MIN);
  s.pos({ type: 'printer.status', payload: { state: 'paperOut', source: 'device' } }, at(205));
  s.presence(at(180, 2), at(180, 60));
  s.pos({ type: 'order.created', payload: { orderId: 'A-042', orderType: 'TAKE_AWAY' } }, at(180, 30), 'budi');
  s.pos({ type: 'order.sent_to_kitchen', payload: { orderId: 'A-042' } }, at(180, 35), 'budi');
  s.pos({ type: 'bill.printed', payload: { orderId: 'A-042', total: 185_000 } }, at(180, 40), 'budi');
  s.pos({ type: 'payment.received', payload: { orderId: 'A-042', method: 'CASH', amount: 185_000 } }, at(180, 50), 'budi');
  s.pos({ type: 'void.approved', payload: { orderId: 'A-042', reasonCode: 'CUSTOMER_CANCEL', approverIds: ['hendra'], amount: 185_000 } }, at(175, 15), 'budi');
  s.pos({ type: 'printer.status', payload: { state: 'ok', source: 'device' } }, at(120));

  // Kasus 2 (sedang): refund dibuat tanpa ada customer di depan kasir.
  s.cashOrder('A-051', at(100), at(99, 30), 64_000, 'siti');
  s.pos({ type: 'refund.created', payload: { refundId: 'RF-7', originalOrderId: 'A-051', amount: 64_000, method: 'CASH', approverId: 'hendra' } }, at(60), 'siti');

  // Kasus 3 (rendah): customer lama di kasir tanpa order.
  s.presence(at(40), at(39, 5));

  // Kasus 4 (kritis, sudah direview): void serupa kemarin oleh sari.
  s.heartbeats('sensor', at(20 * 60 + 30), at(20 * 60 - 30), MIN);
  s.cashOrder('A-007', at(20 * 60), at(20 * 60 - 1), 120_000, 'sari');
  s.presence(at(20 * 60 + 1), at(20 * 60 - 1));
  s.pos({ type: 'kitchen.status_changed', payload: { orderId: 'A-007', status: 'COOKING' } }, at(20 * 60 - 3), 'dapur');
  s.pos({ type: 'void.approved', payload: { orderId: 'A-007', reasonCode: 'WRONG_ORDER', approverIds: ['hendra'], amount: 120_000 } }, at(20 * 60 - 8), 'sari');

  // Pembayaran non-tunai melalui EDC Mandiri (TID 12345678). Satu di antaranya (Rp 64.000, siti) tidak akan ada di slip settlement.
  const edcPay = (orderId: string, minutesAgo: number, amount: number, actor: string) =>
    s.pos({ type: 'payment.received', payload: { orderId, method: 'QRIS', amount, tid: '12345678' } }, at(minutesAgo), actor);
  edcPay('Q-1', 200, 22_000, 'budi');
  edcPay('Q-2', 170, 26_000, 'budi');
  edcPay('Q-3', 130, 38_000, 'sari');
  edcPay('Q-4', 110, 20_000, 'budi');
  edcPay('Q-GHOST', 100, 64_000, 'siti');
  edcPay('Q-5', 90, 28_000, 'sari');

  // Aktivitas normal agar log terlihat wajar.
  for (let i = 0; i < 6; i++) {
    const t0 = at(150 - i * 12);
    s.presence(t0 - 20_000, t0 + 25_000);
    s.cashOrder(`N-${i}`, t0, t0 + 20_000, 35_000 + i * 5_000, 'budi');
  }
  s.heartbeat('terminal', at(2));

  const send = async (deviceId: string, token: string) => {
    const events = s.events.filter((e) => e.deviceId === deviceId).sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < events.length; i += 500) await call('/v1/events', token, { events: events.slice(i, i + 500) });
  };
  await send('sensor-sen', sensor);
  await send('term-sen', term);

  // Slip settlement: batch sebelumnya (kosong) menentukan batas awal, batch ini mencatat 5 QRIS Rp 134.000 sedangkan POS mencatat 6.
  const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '+00:00');
  await call('/v1/outlets/senopati/settlements', owner, {
    slip: { tid: '12345678', batch: '000343', closedAt: iso(at(300)), channels: { QRIS: { sale: { count: 0, amount: 0 } } } },
  });
  await call('/v1/outlets/senopati/settlements', owner, {
    slip: { tid: '12345678', batch: '000344', closedAt: iso(at(60)), channels: { QRIS: { sale: { count: 5, amount: 134_000 } } } },
  });

  const open = await call('/v1/outlets/senopati/incidents', owner);
  const old = open.find((i: { order_ids: string[] }) => i.order_ids.includes('A-007'));
  if (old) await call(`/v1/incidents/${encodeURIComponent(old.id)}/review`, owner, { label: 'FALSE_ALARM', note: 'Customer salah pesan, dibuktikan CCTV. Void sah.' });

  console.log(`
API demo berjalan di http://localhost:${port}

Login dashboard: email owner@demo.local (atau rina@demo.local) dengan password demo-password-2026.
Atau "Lupa password" / "Masuk dengan kode email": kode 6 digit dicetak di konsol ini.
Atau jalur cadangan dengan token (tempel di halaman login, pilih "Masuk dengan token"):
  OWNER   ${owner}
  MANAGER ${manager}

Jalankan dashboard di terminal lain:
  npm run dashboard
lalu buka http://localhost:3001

Terminal POS demo (Pengaturan di aplikasi POS, npm run pos lalu buka http://localhost:3002):
  API     http://localhost:${port}
  TOKEN   ${posToken}
Sensor ESP32 (isi di firmware/sensor-node/app/secrets.h):
  SERVER_URL   http://<IP-komputer-ini>:${port}
  DEVICE_ID    sensor-pos1
  DEVICE_TOKEN ${liveSensorToken}
  OUTLET_ID    senopati
  TERMINAL_ID  pos-1
Staf demo (PIN): ${Object.entries(demoPins).map(([k, v]) => `${k} ${v}`).join(' · ')}
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

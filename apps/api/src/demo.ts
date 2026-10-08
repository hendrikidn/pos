import { deflateSync } from 'node:zlib';
import { DEMO_MENU } from '@pos/pos-core';
import { Sim } from '@pos/sim';
import { AdminService } from './admin.service';
import type { ApiAuth } from './auth';
import { ConfigService } from './config.service';
import { StockService } from './stock.service';
import { createApp } from './bootstrap';
import { ConsoleMailer } from './mailer';
import { hashPassword } from './password';
import { Database } from './db/database';
import { PgliteDriver } from './db/driver';

const line = (itemId: string, name: string, qty: number, unitPrice: number, options?: { group: string; name: string; price: number }[]) => ({
  itemId, name, qty, unitPrice, ...(options ? { options } : {}),
});
const LARGE = { group: 'Ukuran', name: 'Large', price: 6_000 };
const BOBA = { group: 'Topping', name: 'Boba', price: 6_000 };
const OAT = { group: 'Topping', name: 'Oat Milk', price: 8_000 };
/** Campuran pesanan wajar untuk laporan produk di demo (harga sama dengan menu demo POS). */
const MIXES = [
  [line('kopi-susu', 'Kopi Susu', 2, 22_000), line('croissant', 'Croissant', 1, 24_000)],
  [line('americano', 'Americano', 1, 20_000), line('latte', 'Latte', 1, 26_000)],
  [line('matcha', 'Matcha Latte', 2, 40_000, [LARGE, BOBA])],
  [line('matcha', 'Matcha Latte', 1, 28_000, [{ group: 'Ukuran', name: 'Regular', price: 0 }]), line('nasi-goreng', 'Nasi Goreng', 1, 43_000, [{ group: 'Level pedas', name: 'Pedas', price: 0 }, { group: 'Tambahan', name: 'Telur', price: 5_000 }])],
  [line('matcha', 'Matcha Latte', 1, 42_000, [LARGE, OAT])],
  [line('kopi-susu', 'Kopi Susu', 1, 22_000), line('latte', 'Latte', 2, 26_000)],
].map((items) => ({ items, total: items.reduce((a, l) => a + l.qty * l.unitPrice, 0) }));

/**
 * Menjalankan API dengan data simulasi untuk mencoba dashboard tanpa hardware.
 * Waktu kejadian dihitung relatif terhadap sekarang, sehingga selalu berada dalam jendela evaluasi 72 jam.
 */
/** PNG gradien berbentuk lingkaran (tanpa pustaka gambar): foto contoh untuk demo, agar kartu menu bergambar bisa dicoba. */
function demoPhoto(a: [number, number, number], b: [number, number, number], size = 160): string {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const x of buf) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      const d = Math.hypot(x - size / 2, y - size / 2) / (size / 2);
      const inside = d < 0.62;
      for (let c = 0; c < 3; c++) {
        const base = a[c]! * (1 - t) + b[c]! * t;
        raw[y * (size * 3 + 1) + 1 + x * 3 + c] = Math.round(inside ? Math.min(255, base * 0.8 + 70) : base);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

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
  await admin.createOutlet('demo', 'senopati', 'Kopi Senopati', { terminals: ['term-sen', 'pos-1', 'pos-2'], capabilities: caps, cctvRetentionDays: 7 });
  // Kemang = outlet baru yang masih dalam mode shadow (insiden dicatat tetapi tidak dikirim); Senopati sudah aktif penuh.
  await admin.createOutlet('demo', 'kemang', 'Kopi Kemang', { terminals: ['term-kem'], capabilities: caps, cctvRetentionDays: 14, shadowDays: 14 });
  const term = await admin.createDevice('demo', 'senopati', 'term-sen', 'terminal');
  const sensor = await admin.createDevice('demo', 'senopati', 'sensor-sen', 'sensor');
  const termKem = await admin.createDevice('demo', 'kemang', 'term-kem', 'terminal');
  const sensorKem = await admin.createDevice('demo', 'kemang', 'sensor-kem', 'sensor');
  const posToken = await admin.createDevice('demo', 'senopati', 'pos-1', 'terminal'); // terminal POS yang bisa Anda pakai langsung
  const pos2Token = await admin.createDevice('demo', 'senopati', 'pos-2', 'terminal'); // terminal kedua: coba serah-terima order dan denah meja bersama
  const kdsToken = await admin.createDevice('demo', 'senopati', 'kds-sen', 'kds'); // layar dapur: buka POS dengan token ini
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
    // Denah meja: meja 4 dan 9 dipakai terminal term-sen (order hidup di bawah), jadi terminal pos-1 melihatnya terisi.
    tables: [
      ...Array.from({ length: 9 }, (_, i) => ({ no: String(i + 1), area: 'Indoor', seats: i < 6 ? 4 : 2 })),
      ...['T1', 'T2', 'T3'].map((no) => ({ no, area: 'Teras', seats: 6 })),
    ],
  });
  const demoPins = { budi: '4827', sari: '5930', hendra: '7351', rina: '2468', owner: '9042' };
  const people = [
    ['budi', 'Budi (Kasir)', 'CASHIER'], ['sari', 'Sari (Kasir)', 'CASHIER'], ['hendra', 'Hendra (Supervisor)', 'SUPERVISOR'],
    ['rina', 'Rina (Manager)', 'MANAGER'], ['owner', 'Owner', 'OWNER'],
  ] as const;
  for (const [id, name, role] of people) await config.createStaff(seeder, { id, name, role, pin: demoPins[id] });
  const photos: Record<string, [[number, number, number], [number, number, number]]> = {
    'kopi-susu': [[120, 80, 50], [200, 150, 100]], americano: [[40, 30, 25], [110, 80, 60]],
    matcha: [[90, 150, 70], [190, 220, 140]], croissant: [[200, 140, 50], [240, 200, 120]],
  };
  for (const m of DEMO_MENU) await config.createMenu(seeder, { id: m.id, name: m.name, price: m.price, category: m.category, modifierGroups: m.modifierGroups });
  for (const [id, [a, b]] of Object.entries(photos)) await config.setMenuImage(seeder, id, { contentType: 'image/png', data: demoPhoto(a, b) });

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
    const m = MIXES[i % MIXES.length]!;
    s.cashOrder(`N-${i}`, t0, t0 + 20_000, m.total, 'budi', m.items);
  }
  s.heartbeat('terminal', at(2));
  // Riwayat penjualan 4–14 hari lalu (di luar jendela deteksi 72 jam) agar laporan punya periode pembanding.
  for (let d = 4; d <= 14; d++) {
    for (let i = 0; i < 2 + ((d * 7) % 4); i++) {
      const t0 = at(d * 1440 - 9 * 60 + i * 47);
      const m = MIXES[(d + i) % MIXES.length]!;
      s.cashOrder(`H-${d}-${i}`, t0, t0 + 20_000, m.total, i % 2 ? 'sari' : 'budi', m.items);
    }
  }

  // Layar dapur (KDS): pesanan lama sudah disajikan; tiga tiket hidup dengan umur berbeda (normal, perhatian, terlambat + item susulan).
  for (const e of [...s.events]) {
    if (e.type === 'order.sent_to_kitchen' && e.deviceId === 'term-sen') {
      s.pos({ type: 'kitchen.status_changed', payload: { orderId: e.payload.orderId, status: 'SERVED' } }, e.deviceTime + 8 * MIN, 'dapur');
    }
  }
  // Kas laci: satu shift jujur dan satu shift dengan terminal yang dimodifikasi (expected disamakan dengan hitungan fisik; server mendeteksi
  // laci seharusnya 150.000 tetapi hanya 120.000 dan menandainya merah di laporan dan sebagai temuan R30).
  const drawer = (shiftId: string, minutesAgo: number, counted: number, claimedExpected: number, actor: string) => {
    s.pos({ type: 'shift.opened', payload: { shiftId, openingCash: 100_000 } }, at(minutesAgo), actor);
    s.pos({ type: 'payment.received', payload: { orderId: `${shiftId}-cash`, method: 'CASH', amount: 50_000 } }, at(minutesAgo - 20), actor);
    s.pos({ type: 'cash.counted', payload: { shiftId, counted, expected: claimedExpected } }, at(minutesAgo - 40), actor);
    s.pos({ type: 'shift.closed', payload: { shiftId } }, at(minutesAgo - 41), actor);
  };
  drawer('demo-S1', 400, 150_000, 150_000, 'siti');
  drawer('demo-S2', 300, 120_000, 120_000, 'budi');

  const liveOrder = (id: string, type: 'DINE_IN' | 'TAKE_AWAY', table: string | undefined, minutesAgo: number, items: ReturnType<typeof line>[]) => {
    s.presence(at(minutesAgo + 1), at(minutesAgo - 1));
    s.pos({ type: 'order.created', payload: { orderId: id, orderType: type, ...(table ? { tableNo: table } : {}) } }, at(minutesAgo, 5), 'budi');
    s.pos({ type: 'order.sent_to_kitchen', payload: { orderId: id, items } }, at(minutesAgo, 10), 'budi');
  };
  liveOrder('term-sen-L1', 'DINE_IN', '4', 6, [line('matcha', 'Matcha Latte', 1, 40_000, [LARGE, BOBA]), line('croissant', 'Croissant', 2, 24_000)]);
  s.pos({ type: 'kitchen.status_changed', payload: { orderId: 'term-sen-L1', status: 'COOKING' } }, at(4), 'dapur');
  liveOrder('term-sen-L2', 'TAKE_AWAY', undefined, 1, [line('americano', 'Americano', 2, 20_000)]);
  liveOrder('term-sen-L3', 'DINE_IN', '9', 13, [line('nasi-goreng', 'Nasi Goreng', 1, 43_000, [{ group: 'Level pedas', name: 'Pedas', price: 0 }, { group: 'Tambahan', name: 'Telur', price: 5_000 }])]);
  s.pos({ type: 'kitchen.status_changed', payload: { orderId: 'term-sen-L3', status: 'COOKING' } }, at(11), 'dapur');
  s.pos({ type: 'order.sent_to_kitchen', payload: { orderId: 'term-sen-L3', items: [line('teh', 'Teh Tarik', 2, 18_000)] } }, at(2), 'budi');

  const send = async (deviceId: string, token: string) => {
    const events = s.events.filter((e) => e.deviceId === deviceId).sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < events.length; i += 500) await call('/v1/events', token, { events: events.slice(i, i + 500) });
  };
  await send('sensor-sen', sensor);
  await send('term-sen', term);

  // Kopi Kemang (shadow): beberapa kasus dalam tiga hari terakhir, tidak ada notifikasi dan tidak masuk antrean review.
  const k = new Sim('kemang', '2026-01-01', 'term-kem', 'sensor-kem');
  k.heartbeats('sensor', at(71 * 60), at(0), 5 * MIN);
  // hari ini (kritis): void setelah customer pergi, kasir dewi
  k.presence(at(5 * 60 + 2), at(5 * 60 - 1));
  k.cashOrder('K-101', at(5 * 60), at(5 * 60 - 1), 95_000, 'dewi');
  k.pos({ type: 'kitchen.status_changed', payload: { orderId: 'K-101', status: 'COOKING' } }, at(5 * 60 - 3), 'dapur');
  k.pos({ type: 'void.approved', payload: { orderId: 'K-101', reasonCode: 'CUSTOMER_CANCEL', approverIds: ['hendra'], amount: 95_000 } }, at(5 * 60 - 8), 'dewi');
  // kemarin (sedang): refund tanpa customer; (rendah): customer lama tanpa order
  k.cashOrder('K-088', at(28 * 60), at(28 * 60 - 1), 54_000, 'dewi');
  k.pos({ type: 'refund.created', payload: { refundId: 'KR-2', originalOrderId: 'K-088', amount: 54_000, method: 'CASH', approverId: 'hendra' } }, at(27 * 60), 'dewi');
  k.presence(at(30 * 60 + 1), at(30 * 60 - 1));
  // dua hari lalu (kritis): void setelah customer pergi, kasir andi
  k.presence(at(52 * 60 + 2), at(52 * 60 - 1));
  k.cashOrder('K-051', at(52 * 60), at(52 * 60 - 1), 210_000, 'andi');
  k.pos({ type: 'kitchen.status_changed', payload: { orderId: 'K-051', status: 'SERVED' } }, at(52 * 60 - 3), 'dapur');
  k.pos({ type: 'void.approved', payload: { orderId: 'K-051', reasonCode: 'WRONG_ORDER', approverIds: ['hendra'], amount: 210_000 } }, at(52 * 60 - 8), 'andi');
  // lalu lintas normal
  for (let i = 0; i < 8; i++) {
    const t0 = at(70 * 60 - i * 70); // setiap 70 menit
    k.presence(t0 - 20_000, t0 + 25_000);
    const m = MIXES[(i + 2) % MIXES.length]!;
    k.cashOrder(`KN-${i}`, t0, t0 + 20_000, m.total, 'dewi', m.items);
  }
  k.heartbeat('terminal', at(2));
  for (const [dev, tk] of [['sensor-kem', sensorKem], ['term-kem', termKem]] as const) {
    const ev = k.events.filter((e) => e.deviceId === dev).sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < ev.length; i += 500) await call('/v1/events', tk, { events: ev.slice(i, i + 500) });
  }

  // Slip settlement: batch sebelumnya (kosong) menentukan batas awal, batch ini mencatat 5 QRIS Rp 134.000 sedangkan POS mencatat 6.
  const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '+00:00');
  await call('/v1/outlets/senopati/settlements', owner, {
    slip: { tid: '12345678', batch: '000343', closedAt: iso(at(300)), channels: { QRIS: { sale: { count: 0, amount: 0 } } } },
  });
  await call('/v1/outlets/senopati/settlements', owner, {
    slip: { tid: '12345678', batch: '000344', closedAt: iso(at(60)), channels: { QRIS: { sale: { count: 5, amount: 134_000 } } } },
  });

  // Inventori: bahan, resep, dan riwayat stok Kopi Senopati (hitung awal 24 jam lalu; pemakaian dihitung dari penjualan di atas).
  const stockSvc = app.get(StockService);
  for (const [id, name, unit, minStock] of [
    ['biji', 'Biji kopi', 'g', 500], ['susu', 'Susu segar', 'ml', 2_000], ['bubuk-matcha', 'Bubuk matcha', 'g', 100], ['oat', 'Susu oat', 'ml', 1_000], ['telur', 'Telur', 'pcs', 12], ['nasi', 'Nasi', 'g', 2_000],
  ] as const) await stockSvc.createIngredient(seeder, { id, name, unit, minStock });
  const R = (menuId: string, lines: [string, number][], optionId?: string) =>
    stockSvc.setRecipe(seeder, menuId, { ...(optionId ? { optionId } : {}), lines: lines.map(([ingredientId, qty]) => ({ ingredientId, qty })) });
  await R('kopi-susu', [['biji', 18], ['susu', 150]]); await R('americano', [['biji', 18]]); await R('latte', [['biji', 18], ['susu', 200]]);
  await R('matcha', [['bubuk-matcha', 5], ['susu', 150]]); await R('matcha', [['susu', 50]], 'large'); await R('matcha', [['oat', 200]], 'oat');
  await R('nasi-goreng', [['nasi', 200], ['telur', 1]]); await R('nasi-goreng', [['telur', 1]], 'telur');
  const H = 3_600_000;
  const mv = (hoursAgo: number, ingredientId: string, kind: 'PURCHASE' | 'WASTE' | 'COUNT', qty: number, note?: string) =>
    stockSvc.addMovement(seeder, 'senopati', { ingredientId, kind, qty, ...(note ? { note } : {}) }, now - hoursAgo * H);
  for (const [id, qty] of [['biji', 5_000], ['susu', 20_000], ['bubuk-matcha', 600], ['oat', 5_000], ['telur', 60], ['nasi', 8_000]] as const) await mv(24, id, 'COUNT', qty);
  await mv(20, 'biji', 'PURCHASE', 2_000, 'Supplier Kopi Nusantara');
  await mv(10, 'susu', 'WASTE', 1_500, 'Kedaluwarsa');
  // Opname biji 6 jam lalu: 12% lebih sedikit dari perkiraan (selisih kurang yang ditandai).
  const beans = (await stockSvc.stock(seeder, 'senopati', now - 6 * H)).find((r) => r.ingredientId === 'biji')!;
  await mv(6, 'biji', 'COUNT', Math.round((beans.expected ?? 0) * 0.88));

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
Terminal POS kedua (buka di peramban/profil lain untuk mencoba serah-terima order antar-terminal):
  API     http://localhost:${port}
  TOKEN   ${pos2Token}
Layar dapur (KDS): sama dengan terminal POS, tetapi tempel token ini di layar "Hubungkan terminal":
  API     http://localhost:${port}
  TOKEN   ${kdsToken}
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

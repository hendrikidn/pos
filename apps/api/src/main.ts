import { Database } from './db/database';
import { PgDriver, PgliteDriver } from './db/driver';
import { createApp } from './bootstrap';

async function main() {
  const url = process.env['DATABASE_URL'];
  const db = new Database(url ? new PgDriver(url) : await PgliteDriver.create());
  if (!url) console.warn('DATABASE_URL tidak diset: memakai PostgreSQL in-memory (data hilang saat proses berhenti)');
  const applied = await db.migrate();
  if (applied.length > 0) console.log(`migrasi diterapkan: ${applied.join(', ')}`);

  const corsOrigins = process.env['CORS_ORIGINS']?.split(',').map((o) => o.trim()).filter(Boolean);
  // Jumlah proxy tepercaya di depan API (mis. TRUST_PROXY=1 untuk nginx/Caddy). Kosong = tidak ada proxy.
  const tp = process.env['TRUST_PROXY'];
  const trustProxy = tp === undefined || tp === '' ? undefined : /^\d+$/.test(tp) ? Number(tp) : tp;
  console.log(process.env['SMTP_HOST']
    ? `email kode masuk: SMTP ${process.env['SMTP_HOST']}:${process.env['SMTP_PORT'] ?? 587}, pengirim ${process.env['MAIL_FROM'] ?? '(MAIL_FROM kosong)'}`
    : 'PERINGATAN: SMTP_HOST belum diisi; kode masuk email tidak bisa dikirim (owner hanya bisa masuk dengan token)');
  const mode = process.env['EVALUATE_MODE'] === 'sync' ? 'sync' : 'background';
  const app = await createApp(db, { corsOrigins, trustProxy, logRequests: process.env['LOG_REQUESTS'] !== '0', evaluateMode: mode });
  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);
  console.log(`API berjalan di http://localhost:${port} (evaluasi aturan: ${mode}${process.env['METRICS_TOKEN'] ? ', metrik aktif' : ''}${process.env['ALERT_WEBHOOK_URL'] ? ', peringatan webhook aktif' : ''})`);

  // Penutupan rapi: berhenti menerima permintaan, selesaikan evaluasi yang tertunda, lalu tutup pool. Docker memberi waktu terbatas, jadi ada batas keras.
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ level: 'info', msg: 'menutup server', signal }));
    setTimeout(() => process.exit(1), 25_000).unref();
    try {
      await app.close();
      await db.close();
      process.exit(0);
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', msg: 'penutupan gagal', error: e instanceof Error ? e.message : String(e) }));
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  // Kesalahan yang lolos dari semua penangan dicatat dengan jelas lalu proses dimulai ulang oleh Docker (restart: unless-stopped), bukan diam-diam setengah mati.
  process.on('unhandledRejection', (e) => console.error(JSON.stringify({ level: 'error', msg: 'unhandledRejection', error: e instanceof Error ? e.stack : String(e) })));
  process.on('uncaughtException', (e) => {
    console.error(JSON.stringify({ level: 'fatal', msg: 'uncaughtException', error: e.stack }));
    process.exit(1);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

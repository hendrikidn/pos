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
  const app = await createApp(db, { corsOrigins, trustProxy });
  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);
  console.log(`API berjalan di http://localhost:${port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

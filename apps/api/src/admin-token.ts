import { Database } from './db/database';
import { PgDriver } from './db/driver';
import { createPlatformAdmin, resetAdmin2fa } from './onboard';

/**
 * Membuat admin platform pertama (login konsol admin). Dijalankan sekali di server:
 *   DATABASE_URL=postgres://... npm run api:admin -- --id hendrik --name "Hendrik"
 * Token hilang: tambahkan --rotate (token lama langsung tidak berlaku).
 * Ponsel 2FA hilang: --reset-2fa mematikan verifikasi 2 langkah admin itu dan mencabut semua sesinya.
 */
function args(): Map<string, string> {
  const m = new Map<string, string>();
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]!.startsWith('--')) continue;
    const key = a[i]!.slice(2);
    if (key === 'rotate' || key === 'reset-2fa') m.set(key, 'true');
    else if (a[i + 1] !== undefined) m.set(key, a[++i]!);
  }
  return m;
}

async function main() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL wajib diisi');
  const a = args();
  const id = a.get('id');
  if (!id) throw new Error('--id wajib. Contoh: --id hendrik --name "Hendrik"');
  const db = new Database(new PgDriver(url));
  try {
    const applied = await db.migrate();
    if (applied.length) console.log(`migrasi diterapkan: ${applied.join(', ')}`);
    if (a.has('reset-2fa')) {
      await resetAdmin2fa(db, id);
      console.log(`verifikasi 2 langkah admin ${id} dimatikan dan semua sesinya dicabut. Masuk dengan token, lalu aktifkan 2FA lagi.`);
      return;
    }
    const r = await createPlatformAdmin(db, { id, name: a.get('name') ?? id, rotate: a.has('rotate') });
    console.log(`admin ${r.created ? 'dibuat' : 'diterbitkan ulang'}: ${id}`);
    console.log(`\nToken ADMIN (simpan sekarang; tidak akan ditampilkan lagi):\n  ${r.token}\n`);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

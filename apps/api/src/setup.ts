import { Database } from './db/database';
import { PgDriver } from './db/driver';
import { onboard } from './onboard';

/**
 * Menyiapkan database PostgreSQL untuk pemakaian tetap: migrasi, tenant, outlet, dan token OWNER.
 *   DATABASE_URL=postgres://... npm run setup -w @pos/api -- --tenant usahaku --tenant-name "Usahaku" \
 *     --outlet senopati --outlet-name "Kopi Senopati" --terminals pos-1,pos-2
 */
function args(): Map<string, string> {
  const m = new Map<string, string>();
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i]!.startsWith('--') && a[i + 1] !== undefined) m.set(a[i]!.slice(2), a[++i]!);
  return m;
}

async function main() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL wajib diisi (mis. postgres://user:sandi@localhost:5432/posguard)');
  const a = args();
  const need = (k: string) => {
    const v = a.get(k);
    if (!v) throw new Error(`--${k} wajib. Contoh: --tenant usahaku --tenant-name "Usahaku" --outlet senopati --outlet-name "Kopi Senopati"`);
    return v;
  };

  const db = new Database(new PgDriver(url));
  try {
    const applied = await db.migrate();
    if (applied.length) console.log(`migrasi diterapkan: ${applied.join(', ')}`);
    const r = await onboard(db, {
      tenantId: need('tenant'),
      tenantName: need('tenant-name'),
      outletId: need('outlet'),
      outletName: need('outlet-name'),
      ownerId: a.get('owner') ?? 'owner',
      terminals: (a.get('terminals') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    console.log(`tenant ${r.tenantCreated ? 'dibuat' : 'sudah ada'}, outlet ${r.outletCreated ? 'dibuat' : 'sudah ada'}`);
    console.log(`\nToken OWNER (simpan sekarang; tidak akan ditampilkan lagi):\n  ${r.ownerToken}\n`);
    console.log('Tempel token ini di halaman login dashboard. Menjalankan ulang perintah ini menerbitkan token baru.');
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

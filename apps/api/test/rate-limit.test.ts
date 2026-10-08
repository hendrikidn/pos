import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate-limit';
import { createHarness, type Harness } from './harness';

describe('pembatas laju bersama (database)', () => {
  let h: Harness;
  let rl: RateLimiter;
  beforeAll(async () => {
    h = await createHarness(Date.parse('2026-10-08T12:00:00+07:00'));
    rl = new RateLimiter(h.db);
  });
  afterAll(() => h.close());

  it('menghitung dalam jendela, berhenti di batas, dan mulai lagi setelah jendela berakhir', async () => {
    const T = 1_000_000;
    for (let i = 1; i <= 3; i++) expect((await rl.hit('k1', 60_000, T)).count).toBe(i);
    await expect(rl.enforce('k2', 2, 60_000, T, 'penuh')).resolves.toBeUndefined();
    await expect(rl.enforce('k2', 2, 60_000, T, 'penuh')).resolves.toBeUndefined();
    await expect(rl.enforce('k2', 2, 60_000, T, 'penuh')).rejects.toMatchObject({ status: 429, message: 'penuh' });
    expect(await rl.count('k2', T + 59_999)).toBe(3);
    expect(await rl.count('k2', T + 60_000)).toBe(0); // jendela berakhir
    expect((await rl.hit('k2', 60_000, T + 60_000)).count).toBe(1); // mulai dari awal
  });

  it('atomik: 50 permintaan serentak mendapat hitungan 1..50 tanpa ada yang sama (tidak ada yang lolos di batas)', async () => {
    const T = 2_000_000;
    const counts = (await Promise.all(Array.from({ length: 50 }, () => rl.hit('serentak', 60_000, T)))).map((r) => r.count).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('bertahan lewat restart: instance baru melihat hitungan yang sama (sebelumnya hilang bersama proses)', async () => {
    const T = 3_000_000;
    await rl.hit('restart', 60_000, T);
    await rl.hit('restart', 60_000, T);
    const baru = new RateLimiter(h.db); // proses/instance lain
    expect(await baru.count('restart', T)).toBe(2);
    await expect(baru.assertBelow('restart', 2, T, 'blokir')).rejects.toMatchObject({ status: 429 });
    await expect(baru.assertBelow('restart', 3, T, 'blokir')).resolves.toBeUndefined();
  });

  it('banyak alamat berbeda tidak menghapus hitungan alamat lain (dulu: peta di memori dikosongkan total di atas 5.000 entri)', async () => {
    const T = 4_000_000;
    for (let i = 1; i <= 3; i++) await rl.hit('korban', 3_600_000, T);
    await h.db.admin.query("insert into rate_limit (key, count, reset_at_ms) select 'banjir:' || g, 1, $1 from generate_series(1, 6000) g", [T + 3_600_000]);
    expect(await rl.count('korban', T + 1)).toBe(3);
    expect((await rl.hit('korban', 3_600_000, T + 2)).count).toBe(4);
  });

  it('undo mengembalikan satu hitungan dan tidak pernah negatif', async () => {
    const T = 5_000_000;
    await rl.hit('undo', 60_000, T);
    await rl.undo('undo');
    await rl.undo('undo');
    expect(await rl.count('undo', T)).toBe(0);
    expect((await rl.hit('undo', 60_000, T)).count).toBe(1);
  });

  it('baris yang sudah lama berakhir dibersihkan sesekali', async () => {
    const T = 10_000_000_000;
    await h.db.admin.query("insert into rate_limit (key, count, reset_at_ms) values ('basi', 5, 1)");
    for (let i = 0; i < 200; i++) await rl.hit('bersih', 60_000, T);
    expect((await h.db.admin.query("select 1 from rate_limit where key = 'basi'")).rowCount).toBe(0);
    expect((await h.db.admin.query("select 1 from rate_limit where key = 'bersih'")).rowCount).toBe(1);
  });
});

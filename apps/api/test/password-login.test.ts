import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCK_MS } from '../src/login.service';
import { createPlatformAdmin } from '../src/onboard';
import { burnVerify, hashPassword, verifyPassword } from '../src/password';
import { createHarness, type Harness } from './harness';

const T0 = Date.parse('2026-10-07T10:00:00+07:00');
const MIN = 60_000;
const GOOD = 'kopi-susu-hangat-pagi';

describe('password: hash dan kebijakan', () => {
  it('hash scrypt berasin: dua hash dari password sama berbeda, cocok hanya dengan password yang benar', async () => {
    const a = await hashPassword(GOOD);
    const b = await hashPassword(GOOD);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$65536\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toContain(GOOD);
    expect(await verifyPassword(GOOD, a)).toBe(true);
    expect(await verifyPassword(`${GOOD}!`, a)).toBe(false);
    expect(await verifyPassword('', a)).toBe(false);
  });

  it('bentuk Unicode yang setara dianggap sama (NFKC), dan hash rusak tidak pernah cocok', async () => {
    const h = await hashPassword('café-susu-hangat');
    expect(await verifyPassword('café-susu-hangat', h)).toBe(true); // e + aksen gabung = é
    for (const bad of ['', 'bukan-hash', 'scrypt$1$2', 'argon2$x$y$z$a$b']) expect(await verifyPassword(GOOD, bad)).toBe(false);
  });

  it('verifikasi tiruan memakan waktu verifikasi sungguhan (agar email tak terdaftar tak terbedakan lewat waktu)', async () => {
    await burnVerify('x'); // pemanasan: hash tiruan dibuat sekali
    const t0 = performance.now();
    await burnVerify('apa saja');
    expect(performance.now() - t0).toBeGreaterThan(30);
  });
});

describe('login email + password', () => {
  let h: Harness;
  let admin: string;
  let t = T0;
  const BOS = 'bos@kopi.id';

  const adm = (method: string, path: string, body?: unknown) => h.http(method, `/v1/admin${path}`, admin, body);
  const auth = (path: string, body: unknown, token?: string) => h.http('POST', `/v1/auth/${path}`, token, body);
  const pwLogin = (email: string, password: string) => auth('login', { email, password });
  const forgot = (email: string) => auth('password/forgot', { email });
  const tick = (ms: number) => { t += ms; h.setNow(t); };
  /** Meminta kode atur ulang (maju 13 menit agar batas kode per jam tidak menahan) dan mengembalikan kodenya. */
  const resetCode = async (email: string) => {
    tick(13 * MIN);
    await forgot(email);
    return h.mailer.lastCode(email)!;
  };
  /** Menyetel password sebuah pengguna lewat alur lupa password; mengembalikan sesi yang didapat. */
  const setPassword = async (email: string, password = GOOD) => {
    const r = await auth('password/reset', { email, code: await resetCode(email), password });
    expect(r.status).toBe(201);
    return r.body as { token: string; role: string; userId: string };
  };
  const user = async (email: string) => (await adm('GET', '/tenants/kopi')).body.users.find((u: { email: string }) => u.email === email);

  beforeAll(async () => {
    h = await createHarness(T0);
    admin = (await createPlatformAdmin(h.db, { id: 'adm', name: 'Adm' })).token;
    const mk = (id: string, mail: string) =>
      adm('POST', '/tenants', { tenantId: id, tenantName: id, outletId: `${id}-o`, outletName: 'O', ownerId: 'bos', ownerEmail: mail });
    expect((await mk('kopi', BOS)).status).toBe(201);
    expect((await mk('teh', 'bos@teh.id')).status).toBe(201);
  });
  afterAll(() => h.close());

  describe('mengatur password lewat kode email', () => {
    it('pengguna baru belum punya password: login ditolak; lupa password mengirim kode jenis "reset"', async () => {
      expect((await pwLogin(BOS, GOOD)).status).toBe(400);
      expect((await user(BOS)).has_password).toBe(false);
      await forgot(BOS);
      const mail = h.mailer.sent.filter((m) => m.to === BOS).at(-1)!;
      expect(mail.subject).toMatch(/^Kode atur ulang password POS Guard: \d{6}$/);
      expect(mail.text).toMatch(/password Anda tidak berubah/);
    });

    it('kode + password baru: password tersimpan, langsung masuk, dan login berikutnya cukup dengan password', async () => {
      const s = await setPassword(BOS);
      expect(s).toMatchObject({ role: 'OWNER', userId: 'bos' });
      expect((await h.http('GET', '/v1/me', s.token)).body).toMatchObject({ tenantId: 'kopi', role: 'OWNER' });
      expect((await user(BOS)).has_password).toBe(true);

      const l = await pwLogin(BOS, GOOD);
      expect(l.status).toBe(201);
      expect(l.body).toMatchObject({ role: 'OWNER', userId: 'bos', tenantId: 'kopi' });
      expect((await h.http('GET', '/v1/outlets', l.body.token)).status).toBe(200);
      // Email dinormalkan.
      expect((await pwLogin(`  ${BOS.toUpperCase()} `, GOOD)).status).toBe(201);
    });

    it('semua kegagalan memakai pesan yang sama: email tak dikenal, salah password, belum punya password, nonaktif', async () => {
      await adm('POST', '/tenants/kopi/users', { email: 'baru@kopi.id', role: 'MANAGER' }); // belum punya password
      await adm('POST', '/tenants/kopi/users', { email: 'off@kopi.id', role: 'OPS' });
      await setPassword('off@kopi.id');
      await adm('PUT', `/tenants/kopi/users/${(await user('off@kopi.id')).id}`, { active: false });

      const cases = [
        await pwLogin('hantu@kopi.id', GOOD),
        await pwLogin(BOS, 'password-yang-salah'),
        await pwLogin('baru@kopi.id', GOOD),
        await pwLogin('off@kopi.id', GOOD), // password benar, tetapi nonaktif
        await pwLogin('bukan-email', GOOD),
        await pwLogin(BOS, ''),
      ];
      for (const c of cases) {
        expect(c.status).toBe(400);
        expect(c.body.message).toBe('email atau password salah');
      }
    });

    it('email tak dikenal tetap memakan waktu verifikasi (tidak terbedakan lewat lama respons)', async () => {
      await pwLogin('pemanasan@kopi.id', 'x');
      const t0 = performance.now();
      await pwLogin('hantu2@kopi.id', GOOD);
      expect(performance.now() - t0).toBeGreaterThan(30);
    });

    it('kebijakan password: terlalu pendek, panjang, umum, berulang, memuat nama email; kode tidak hangus karenanya', async () => {
      // Aturan "memuat nama email" hanya berlaku untuk nama minimal 4 huruf, jadi pakai pengguna dengan nama yang cukup panjang.
      const mail = 'budiman@kopi.id';
      await adm('POST', '/tenants/kopi/users', { email: mail, role: 'OPS' });
      const code = await resetCode(mail);
      const weak = ['pendek', 'x'.repeat(129), 'password123', '1234567890', 'aaaaaaaaaaaa', 'Budiman-rahasia-saya', 12345678901];
      for (const password of weak) {
        const r = await auth('password/reset', { email: mail, code, password });
        expect(r.status, String(password)).toBe(400);
        expect(r.body.message).not.toMatch(/kode salah/); // ditolak karena password, bukan karena kode
      }
      // Kode yang sama masih utuh untuk password yang layak.
      expect((await auth('password/reset', { email: mail, code, password: 'sekarang-cukup-panjang-ya' })).status).toBe(201);
    });

    it('kode "login" tidak bisa dipakai mengatur password, dan kode "reset" tidak bisa dipakai masuk', async () => {
      tick(13 * MIN);
      await h.http('POST', '/v1/auth/otp/request', undefined, { email: BOS });
      const loginCode = h.mailer.lastCode(BOS)!;
      expect((await auth('password/reset', { email: BOS, code: loginCode, password: 'penyusup-ganti-password' })).status).toBe(400);
      expect((await pwLogin(BOS, 'penyusup-ganti-password')).status).toBe(400);

      const reset = await resetCode(BOS);
      expect((await h.http('POST', '/v1/auth/otp/verify', undefined, { email: BOS, code: reset })).status).toBe(400);
      // Kode reset yang gagal dipakai di jalur salah tetap utuh untuk jalur yang benar.
      expect((await auth('password/reset', { email: BOS, code: reset, password: GOOD })).status).toBe(201);
    });

    it('kode reset: sekali pakai, kedaluwarsa 10 menit, dan mati setelah 5 kali salah', async () => {
      const code = await resetCode(BOS);
      expect((await auth('password/reset', { email: BOS, code, password: GOOD })).status).toBe(201);
      expect((await auth('password/reset', { email: BOS, code, password: GOOD })).status).toBe(400);

      const old = await resetCode(BOS);
      tick(11 * MIN);
      expect((await auth('password/reset', { email: BOS, code: old, password: GOOD })).status).toBe(400);

      const c = await resetCode(BOS);
      const wrong = c === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) expect((await auth('password/reset', { email: BOS, code: wrong, password: GOOD })).status).toBe(400);
      expect((await auth('password/reset', { email: BOS, code: c, password: GOOD })).status).toBe(400);
    });

    it('mengatur ulang memutus semua sesi lama, dan lupa password untuk email tak dikenal tidak mengirim apa pun', async () => {
      const a = await pwLogin(BOS, GOOD);
      const b = await pwLogin(BOS, GOOD);
      const fresh = await setPassword(BOS, 'password-baru-yang-aman');
      expect((await h.http('GET', '/v1/me', a.body.token)).status).toBe(401);
      expect((await h.http('GET', '/v1/me', b.body.token)).status).toBe(401);
      expect((await h.http('GET', '/v1/me', fresh.token)).status).toBe(200);
      expect((await pwLogin(BOS, GOOD)).status).toBe(400); // password lama mati
      expect((await pwLogin(BOS, 'password-baru-yang-aman')).status).toBe(201);
      await setPassword(BOS); // kembali ke GOOD

      const before = h.mailer.sent.length;
      tick(2 * MIN);
      expect((await forgot('hantu@kopi.id')).body).toEqual({ ok: true });
      expect(h.mailer.sent.length).toBe(before);
    });
  });

  describe('penguncian akun', () => {
    it('5 password salah mengunci akun 15 menit (429, walau password benar); sesudahnya bisa lagi', async () => {
      tick(20 * MIN);
      for (let i = 0; i < 5; i++) expect((await pwLogin(BOS, `salah-${i}-salah-salah`)).status).toBe(400);
      const locked = await pwLogin(BOS, GOOD);
      expect(locked.status).toBe(429);
      expect(locked.body.message).toMatch(/15 menit/);
      tick(LOCK_MS + 1000);
      expect((await pwLogin(BOS, GOOD)).status).toBe(201);
    });

    it('login berhasil mereset hitungan gagal', async () => {
      tick(20 * MIN);
      for (let i = 0; i < 4; i++) await pwLogin(BOS, 'salah-salah-salah');
      expect((await pwLogin(BOS, GOOD)).status).toBe(201);
      for (let i = 0; i < 4; i++) await pwLogin(BOS, 'salah-salah-salah');
      expect((await pwLogin(BOS, GOOD)).status).toBe(201); // 4 + 4 tidak terakumulasi
    });

    it('saat terkunci: kode email tetap bisa masuk, dan mengatur ulang password membuka kunci', async () => {
      tick(20 * MIN);
      for (let i = 0; i < 5; i++) await pwLogin(BOS, 'salah-salah-salah');
      expect((await pwLogin(BOS, GOOD)).status).toBe(429);

      tick(13 * MIN);
      await h.http('POST', '/v1/auth/otp/request', undefined, { email: BOS });
      expect((await h.http('POST', '/v1/auth/otp/verify', undefined, { email: BOS, code: h.mailer.lastCode(BOS)! })).status).toBe(201);

      for (let i = 0; i < 5; i++) await pwLogin(BOS, 'salah-salah-salah');
      expect((await pwLogin(BOS, GOOD)).status).toBe(429);
      await setPassword(BOS);
      expect((await pwLogin(BOS, GOOD)).status).toBe(201);
    });

    it('penguncian satu akun tidak memengaruhi akun lain', async () => {
      await setPassword('bos@teh.id');
      tick(20 * MIN);
      for (let i = 0; i < 5; i++) await pwLogin(BOS, 'salah-salah-salah');
      expect((await pwLogin('bos@teh.id', GOOD)).status).toBe(201);
    });
  });

  describe('ganti password dari dalam sesi', () => {
    it('perlu password lama; sesi lain diputus, sesi ini tetap; password lama mati', async () => {
      tick(20 * MIN);
      const here = await pwLogin(BOS, GOOD);
      const other = await pwLogin(BOS, GOOD);
      const tk = here.body.token;

      expect((await auth('password/change', { current: 'bukan-yang-benar', password: 'password-ganti-baru-1' }, tk)).status).toBe(400);
      expect((await auth('password/change', { current: GOOD, password: GOOD }, tk)).body.message).toMatch(/berbeda/);
      expect((await auth('password/change', { current: GOOD, password: 'pendek' }, tk)).status).toBe(400);
      expect((await auth('password/change', { current: GOOD, password: 'password-ganti-baru-1' }, tk)).status).toBe(201);

      expect((await h.http('GET', '/v1/me', tk)).status).toBe(200);
      expect((await h.http('GET', '/v1/me', other.body.token)).status).toBe(401);
      expect((await pwLogin(BOS, GOOD)).status).toBe(400);
      expect((await pwLogin(BOS, 'password-ganti-baru-1')).status).toBe(201);
      await setPassword(BOS);
    });

    it('menebak password lama dari sesi curian ikut menghitung penguncian', async () => {
      tick(20 * MIN);
      const s = await pwLogin(BOS, GOOD);
      for (let i = 0; i < 5; i++) await auth('password/change', { current: `tebak-${i}-tebak-tebak`, password: 'password-ganti-baru-2' }, s.body.token);
      expect((await auth('password/change', { current: GOOD, password: 'password-ganti-baru-2' }, s.body.token)).status).toBe(429);
      expect((await pwLogin(BOS, GOOD)).status).toBe(429);
      await setPassword(BOS);
    });

    it('akun tanpa password atau tanpa sesi ditolak dengan petunjuk yang jelas', async () => {
      const mgr = await h.http('POST', '/v1/auth/otp/request', undefined, { email: 'baru@kopi.id' });
      expect(mgr.status).toBe(201);
      tick(13 * MIN);
      await h.http('POST', '/v1/auth/otp/request', undefined, { email: 'baru@kopi.id' });
      const s = await h.http('POST', '/v1/auth/otp/verify', undefined, { email: 'baru@kopi.id', code: h.mailer.lastCode('baru@kopi.id')! });
      const r = await auth('password/change', { current: 'apa-saja-kata-sandi', password: 'password-ganti-baru-3' }, s.body.token);
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/Lupa password/);
      expect((await auth('password/change', { current: GOOD, password: 'password-ganti-baru-3' })).status).toBe(401);
    });
  });

  describe('akses dan siklus hidup pengguna', () => {
    it('tenant ditangguhkan: password benar tetap 403, tanpa mengubah apa pun untuk yang salah', async () => {
      await adm('POST', '/tenants/teh/suspend', { reason: 'uji' });
      const ok = await pwLogin('bos@teh.id', GOOD);
      expect(ok.status).toBe(403);
      expect(ok.body.message).toMatch(/ditangguhkan/);
      expect((await pwLogin('bos@teh.id', 'salah-salah-salah')).body.message).toBe('email atau password salah');
      const code = await resetCode('bos@teh.id');
      expect((await auth('password/reset', { email: 'bos@teh.id', code, password: 'password-baru-teh-1' })).status).toBe(403);
      await adm('POST', '/tenants/teh/reactivate');
      expect((await pwLogin('bos@teh.id', GOOD)).status).toBe(201); // password lama utuh
    });

    it('menonaktifkan memutus akses password; mengaktifkan kembali memulihkannya', async () => {
      await adm('POST', '/tenants/kopi/users', { email: 'sementara@kopi.id', role: 'OPS' });
      await setPassword('sementara@kopi.id');
      const ref = (await user('sementara@kopi.id')).id;
      const s = await pwLogin('sementara@kopi.id', GOOD);
      await adm('PUT', `/tenants/kopi/users/${ref}`, { active: false });
      expect((await h.http('GET', '/v1/me', s.body.token)).status).toBe(401);
      expect((await pwLogin('sementara@kopi.id', GOOD)).status).toBe(400);
      await adm('PUT', `/tenants/kopi/users/${ref}`, { active: true });
      expect((await pwLogin('sementara@kopi.id', GOOD)).status).toBe(201);
    });

    it('mengganti email menghapus password: pemilik email baru harus mengaturnya sendiri', async () => {
      await adm('POST', '/tenants/kopi/users', { email: 'lama@kopi.id', role: 'MANAGER' });
      await setPassword('lama@kopi.id');
      const ref = (await user('lama@kopi.id')).id;
      expect((await user('lama@kopi.id')).has_password).toBe(true);
      await adm('PUT', `/tenants/kopi/users/${ref}`, { email: 'pengganti@kopi.id' });
      expect((await user('pengganti@kopi.id')).has_password).toBe(false);
      expect((await pwLogin('pengganti@kopi.id', GOOD)).status).toBe(400);
      expect((await pwLogin('lama@kopi.id', GOOD)).status).toBe(400);
      await setPassword('pengganti@kopi.id');
      expect((await pwLogin('pengganti@kopi.id', GOOD)).status).toBe(201);
    });

    it('owner yang mengganti email pengguna lain juga menghapus password-nya, dan melihat statusnya', async () => {
      const owner = (await pwLogin(BOS, GOOD)).body.token;
      await h.http('POST', '/v1/users', owner, { email: 'staf@kopi.id', role: 'SUPERVISOR' });
      await setPassword('staf@kopi.id');
      const row = (await h.http('GET', '/v1/users', owner)).body.find((u: { email: string }) => u.email === 'staf@kopi.id');
      expect(row.has_password).toBe(true);
      await h.http('PUT', `/v1/users/${row.id}`, owner, { email: 'staf2@kopi.id' });
      const after = (await h.http('GET', '/v1/users', owner)).body.find((u: { id: number }) => u.id === row.id);
      expect(after.has_password).toBe(false);
      expect((await pwLogin('staf2@kopi.id', GOOD)).status).toBe(400);
    });
  });

  describe('penyimpanan dan jejak', () => {
    it('hash tersimpan berasin dan tidak pernah muncul di respons, daftar pengguna, atau audit_log', async () => {
      const rows = (await h.db.admin.query<{ password_hash: string }>('select password_hash from dashboard_user where password_hash is not null')).rows;
      expect(rows.length).toBeGreaterThan(3);
      for (const r of rows) {
        expect(r.password_hash).toMatch(/^scrypt\$65536\$8\$1\$/);
        expect(r.password_hash).not.toContain(GOOD);
      }
      expect(new Set(rows.map((r) => r.password_hash)).size).toBe(rows.length); // password sama di akun berbeda tetap beda hash

      const owner = (await pwLogin(BOS, GOOD)).body.token;
      expect(JSON.stringify((await h.http('GET', '/v1/users', owner)).body)).not.toMatch(/scrypt\$|password_hash/);
      expect(JSON.stringify((await adm('GET', '/tenants/kopi')).body)).not.toMatch(/scrypt\$|password_hash/);
      const audit = JSON.stringify((await h.db.admin.query('select actor, action, detail from audit_log')).rows);
      expect(audit).not.toContain(GOOD);
      expect(audit).not.toMatch(/scrypt\$/);
      expect(audit).toContain('auth.password.reset');
      expect(audit).toContain('auth.password.change');
      expect(audit).toContain('"method":"password"');
    });

    it('jalur tenant (app_user) tidak bisa membaca atau mengubah kolom password sama sekali', async () => {
      const q = (sql: string) => h.db.tenantTx('kopi', (c) => c.query(sql));
      await expect(q('select password_hash from dashboard_user')).rejects.toThrow(/permission denied/);
      await expect(q('select failed_logins, locked_until from dashboard_user')).rejects.toThrow(/permission denied/);
      await expect(q("update dashboard_user set password_hash = 'x'")).rejects.toThrow(/permission denied/);
      await expect(q('select * from dashboard_user')).rejects.toThrow(/permission denied/); // `*` menyentuh kolom terlarang
      await expect(q('select id, email, role, active from dashboard_user')).resolves.toBeTruthy();
    });
  });

  it('pembatas per alamat: terlalu banyak percobaan password dari satu alamat menghasilkan 429', async () => {
    const h2 = await createHarness(T0);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 24; i++) statuses.push((await h2.http('POST', '/v1/auth/login', undefined, { email: `x${i}@kopi.id`, password: 'salah-salah-salah' })).status);
      expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
      expect(statuses.slice(20)).toContain(429);
    } finally {
      await h2.close();
    }
  });
});

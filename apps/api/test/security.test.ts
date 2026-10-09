import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllowList } from '../src/ip-allow';
import { createPlatformAdmin, resetAdmin2fa } from '../src/onboard';
import { base32Decode, base32Encode, open, otpauthUrl, seal, stepOf, totpAt, verifyTotp } from '../src/totp';
import { createHarness, type Harness } from './harness';

describe('TOTP (RFC 6238)', () => {
  // Rahasia uji RFC 6238: ASCII "12345678901234567890"; nilai 8 angka di RFC, 6 angka = 6 digit terakhir.
  const SECRET = base32Encode(Buffer.from('12345678901234567890'));
  it('cocok dengan vektor uji resmi RFC 6238', () => {
    expect(SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    for (const [t, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']] as const) {
      expect(totpAt(SECRET, stepOf(t * 1000))).toBe(code);
    }
  });

  it('verifikasi: toleransi satu langkah, bukan lebih; langkah yang sudah dipakai ditolak; format salah ditolak', () => {
    const now = 1_700_000_000_000;
    const s = stepOf(now);
    expect(verifyTotp(SECRET, totpAt(SECRET, s), now)).toBe(s);
    expect(verifyTotp(SECRET, totpAt(SECRET, s - 1), now)).toBe(s - 1);
    expect(verifyTotp(SECRET, totpAt(SECRET, s + 1), now)).toBe(s + 1);
    expect(verifyTotp(SECRET, totpAt(SECRET, s - 2), now)).toBeNull();
    expect(verifyTotp(SECRET, totpAt(SECRET, s + 2), now)).toBeNull();
    expect(verifyTotp(SECRET, totpAt(SECRET, s), now, s)).toBeNull(); // langkah itu sudah dipakai
    expect(verifyTotp(SECRET, totpAt(SECRET, s - 1), now, s)).toBeNull(); // dan tidak bisa mundur ke yang lebih lama
    for (const bad of ['', '12345', '1234567', 'abcdef', null, 123456, undefined]) expect(verifyTotp(SECRET, bad, now)).toBeNull();
    expect(verifyTotp(SECRET, ` ${totpAt(SECRET, s).slice(0, 3)} ${totpAt(SECRET, s).slice(3)} `, now)).toBe(s); // spasi dari aplikasi diabaikan
  });

  it('base32 bolak-balik; otpauth memuat rahasia dan penerbit', () => {
    for (const len of [1, 5, 10, 20, 33]) {
      const b = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255));
      expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    }
    expect(() => base32Decode('1!')).toThrow();
    expect(otpauthUrl('hendrik', SECRET)).toBe(`otpauth://totp/Anatta%20POS%3Ahendrik?secret=${SECRET}&issuer=Anatta%20POS&algorithm=SHA1&digits=6&period=30`);
  });

  it('rahasia dienkripsi bila kunci ada; tanpa kunci tersimpan dengan penanda; diubah atau kunci salah gagal', () => {
    const sealed = seal('RAHASIA123', 'kunci-1');
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain('RAHASIA123');
    expect(open(sealed, 'kunci-1')).toBe('RAHASIA123');
    expect(seal('RAHASIA123', 'kunci-1')).not.toBe(sealed); // IV acak
    expect(() => open(sealed, 'kunci-2')).toThrow();
    expect(() => open(sealed, undefined)).toThrow();
    const parts = sealed.split(':');
    parts[3] = Buffer.from('lain').toString('base64');
    expect(() => open(parts.join(':'), 'kunci-1')).toThrow(); // GCM mendeteksi perubahan
    expect(open(seal('X', ''), undefined)).toBe('X'); // tanpa kunci: bisa dibaca; kunci bisa dipasang belakangan
    expect(open(seal('Y', ''), 'kunci-1')).toBe('Y');
  });
});

describe('daftar alamat yang diizinkan', () => {
  it('kosong = terbuka; IPv4 tunggal, CIDR, IPv6 tunggal, dan bentuk ::ffff: dinormalkan', () => {
    expect(parseAllowList('').test('8.8.8.8')).toBe(true);
    expect(parseAllowList(undefined).open).toBe(true);
    const a = parseAllowList('203.0.113.10, 198.51.100.0/24 ,2001:db8::1');
    expect(a.test('203.0.113.10')).toBe(true);
    expect(a.test('::ffff:203.0.113.10')).toBe(true);
    expect(a.test('203.0.113.11')).toBe(false);
    expect(a.test('198.51.100.7')).toBe(true);
    expect(a.test('198.51.101.7')).toBe(false);
    expect(a.test('2001:db8::1')).toBe(true);
    expect(a.test('2001:db8::2')).toBe(false);
    expect(a.test(undefined)).toBe(false);
    expect(parseAllowList('10.0.0.0/8').test('10.255.1.1')).toBe(true);
    expect(parseAllowList('0.0.0.0/0').test('1.2.3.4')).toBe(true);
    expect(parseAllowList('1.2.3.4/32').test('1.2.3.5')).toBe(false);
  });

  it('entri rusak membuat daftar menolak semua (gagal tertutup)', () => {
    for (const bad of ['203.0.113.0/33', 'bukan-ip', '1.2.3.4/abc', '999.1.1.1/8']) {
      const a = parseAllowList(`${bad}, 203.0.113.10`);
      expect(a.test('203.0.113.10')).toBe(false);
    }
  });
});

describe('login admin dengan 2FA dan sesi', () => {
  let h: Harness;
  let rawToken: string;
  const IP = '127.0.0.1';
  const A = '/v1/admin/auth';
  const login = (body: unknown) => h.http('POST', `${A}/login`, undefined, body);
  const tick = (ms: number) => h.setNow(now += ms);
  let now = Date.now();

  beforeAll(async () => {
    process.env['SECRETS_KEY'] = 'kunci-uji-rahasia-totp';
    h = await createHarness(now);
    rawToken = (await createPlatformAdmin(h.db, { id: 'hendrik', name: 'Hendrik' })).token;
  });
  afterAll(async () => { delete process.env['ADMIN_ALLOWED_IPS']; delete process.env['SECRETS_KEY']; await h.close(); });

  it('tanpa 2FA: token ditukar sesi; keduanya bekerja; token tak dikenal ditolak; sesi tidak memuat token mentah', async () => {
    expect((await login({ token: 'adm_salah' })).status).toBe(401);
    expect((await login({})).status).toBe(401);
    expect((await login({ token: 'api_bukanadmin' })).status).toBe(401);
    const r = await login({ token: rawToken });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ adminId: 'hendrik', twoFactor: false });
    expect(r.body.token).toMatch(/^adm_/);
    expect(r.body.token).not.toBe(rawToken);
    expect((await h.http('GET', '/v1/admin/me', r.body.token)).body).toEqual({ adminId: 'hendrik' });
    expect((await h.http('GET', '/v1/admin/me', rawToken)).status).toBe(200); // token mentah tetap bekerja selama 2FA mati
    expect((await h.db.admin.query("select 1 from admin_session where token_hash = $1", [r.body.token])).rowCount).toBe(0); // hanya hash yang disimpan
    expect(Number((await h.db.admin.query<{ n: string }>('select count(*) n from admin_session')).rows[0]!.n)).toBe(1);
  });

  it('daftar alamat: alamat luar daftar ditolak 403 sebelum token diperiksa; dalam daftar lolos', async () => {
    process.env['ADMIN_ALLOWED_IPS'] = '203.0.113.0/24';
    expect((await login({ token: rawToken })).status).toBe(403);
    process.env['ADMIN_ALLOWED_IPS'] = `${IP},::1,::ffff:127.0.0.1`;
    expect((await login({ token: rawToken })).status).toBe(201);
    delete process.env['ADMIN_ALLOWED_IPS'];
  });

  it('mengaktifkan 2FA: setup, kode pertama membuktikan, kode pemulihan sekali tampil; token mentah lalu ditolak API', async () => {
    const s = (await login({ token: rawToken })).body.token as string;
    expect((await h.http('POST', `${A}/2fa/enable`, s, { code: '123456' })).status).toBe(400); // belum setup
    const setup = await h.http('POST', `${A}/2fa/setup`, s);
    expect(setup.status).toBe(201);
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.otpauthUrl).toContain(`secret=${setup.body.secret}`);
    const sealed = (await h.db.admin.query<{ totp_pending: string }>("select totp_pending from platform_admin where id = 'hendrik'")).rows[0]!.totp_pending;
    expect(sealed).not.toContain(setup.body.secret); // tidak tersimpan polos
    expect((await h.http('POST', `${A}/2fa/enable`, s, { code: '000000' })).status).toBe(400);
    const en = await h.http('POST', `${A}/2fa/enable`, s, { code: totpAt(setup.body.secret, stepOf(now)) });
    expect(en.status).toBe(201);
    expect(en.body.recoveryCodes).toHaveLength(8);
    expect(en.body.recoveryCodes[0]).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(new Set(en.body.recoveryCodes).size).toBe(8);
    const stored = (await h.db.admin.query<{ code_hash: string }>('select code_hash from admin_recovery_code')).rows;
    expect(stored).toHaveLength(8);
    expect(stored.every((r) => !en.body.recoveryCodes.includes(r.code_hash))).toBe(true); // hanya hash
    expect((await h.http('POST', `${A}/2fa/setup`, s)).status).toBe(400); // sudah aktif
    // sesi yang sudah ada tetap sah; token mentah tidak lagi diterima
    expect((await h.http('GET', '/v1/admin/me', s)).status).toBe(200);
    const raw = await h.http('GET', '/v1/admin/me', rawToken);
    expect(raw.status).toBe(401);
    expect(JSON.stringify(raw.body)).toContain('2 langkah');
    (globalThis as { __secret?: string; __codes?: string[] }).__secret = setup.body.secret;
    (globalThis as { __codes?: string[] }).__codes = en.body.recoveryCodes;
  });

  it('login dengan 2FA: kode wajib, salah ditolak, benar lolos, kode yang sama tidak bisa dipakai dua kali, langkah berikutnya lolos', async () => {
    const secret = (globalThis as { __secret?: string }).__secret!;
    tick(60_000);
    const noCode = await login({ token: rawToken });
    expect(noCode.status).toBe(401);
    expect(noCode.body.needs2fa).toBe(true);
    const bad = await login({ token: rawToken, code: '000000' });
    expect(bad.status).toBe(401);
    expect(bad.body.needs2fa).toBe(true);
    const code = totpAt(secret, stepOf(now));
    const ok = await login({ token: rawToken, code });
    expect(ok.status).toBe(201);
    expect(ok.body.twoFactor).toBe(true);
    expect((await h.http('GET', '/v1/admin/me', ok.body.token)).status).toBe(200);
    expect((await login({ token: rawToken, code })).status).toBe(401); // diputar ulang: ditolak
    tick(30_000);
    expect((await login({ token: rawToken, code: totpAt(secret, stepOf(now)) })).status).toBe(201);
    // Dua permintaan serentak dengan kode yang sama: hanya satu yang boleh menang (pembaruan langkah terakhir bersifat atomik).
    tick(30_000);
    const race = totpAt(secret, stepOf(now));
    const both = await Promise.all([login({ token: rawToken, code: race }), login({ token: rawToken, code: race })]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 401]);
  });

  it('kode pemulihan: sekali pakai; format salah ditolak', async () => {
    tick(16 * 60_000); // kegagalan di tes sebelumnya sudah lewat jendela pembatas
    const [first, second] = (globalThis as { __codes?: string[] }).__codes!;
    expect((await login({ token: rawToken, code: first })).status).toBe(201);
    expect((await login({ token: rawToken, code: first })).status).toBe(401); // sudah dipakai
    expect((await login({ token: rawToken, code: second!.replace(/-/g, '') })).status).toBe(201); // tanpa tanda hubung pun sah
    expect((await login({ token: rawToken, code: 'zzzz-zzzz-zzzz' })).status).toBe(401);
    const st = (await h.http('GET', `${A}/status`, (await login({ token: rawToken, code: (globalThis as { __codes?: string[] }).__codes![2] })).body.token)).body;
    expect(st.recoveryCodesLeft).toBe(5);
  });

  it('percobaan kode salah dibatasi per admin: setelah 5 kegagalan sekalipun kode benar ditolak 429 sampai jendela lewat', async () => {
    const secret = (globalThis as { __secret?: string }).__secret!;
    tick(16 * 60_000); // jendela pembatas sebelumnya sudah lewat
    for (let i = 0; i < 5; i++) expect((await login({ token: rawToken, code: '000000' })).status).toBe(401);
    expect((await login({ token: rawToken, code: totpAt(secret, stepOf(now)) })).status).toBe(429);
    tick(16 * 60_000);
    expect((await login({ token: rawToken, code: totpAt(secret, stepOf(now)) })).status).toBe(201);
  });

  it('sesi: daftar menandai yang sedang dipakai; cabut satu; keluar dari semua yang lain; keluar mencabut sesinya; sesi kedaluwarsa ditolak', async () => {
    const secret = (globalThis as { __secret?: string }).__secret!;
    tick(60_000);
    const a = (await login({ token: rawToken, code: totpAt(secret, stepOf(now)) })).body.token as string;
    tick(30_000);
    const b = (await login({ token: rawToken, code: totpAt(secret, stepOf(now)) })).body.token as string;
    const st = (await h.http('GET', `${A}/status`, b)).body;
    expect(st.twoFactor).toBe(true);
    expect(st.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const aRow = st.sessions.find((s: { id: number; current: boolean }) => !s.current);
    expect(aRow.ip).toBe(IP);
    expect(JSON.stringify(st)).not.toContain('adm_');
    expect((await h.http('DELETE', `${A}/sessions/99999`, b)).status).toBe(404);
    expect((await h.http('DELETE', `${A}/sessions/abc`, b)).status).toBe(400);
    expect((await h.http('GET', '/v1/admin/me', a)).status).toBe(200);
    const out = await h.http('POST', `${A}/sessions/revoke-others`, b);
    expect(out.body.revoked).toBeGreaterThanOrEqual(1);
    expect((await h.http('GET', '/v1/admin/me', a)).status).toBe(401);
    expect((await h.http('GET', '/v1/admin/me', b)).status).toBe(200);
    expect((await h.http('POST', `${A}/logout`, b)).status).toBe(201);
    expect((await h.http('GET', '/v1/admin/me', b)).status).toBe(401);
    // kedaluwarsa 12 jam
    tick(60_000);
    const c = (await login({ token: rawToken, code: totpAt(secret, stepOf(now)) })).body.token as string;
    await h.db.admin.query("update admin_session set expires_at = now() - interval '1 minute' where token_hash = $1", [(await import('../src/auth')).sha256(c)]);
    expect((await h.http('GET', '/v1/admin/me', c)).status).toBe(401);
  });

  it('menonaktifkan 2FA butuh kode sah; setelah itu token mentah bekerja lagi dan kode pemulihan dihapus', async () => {
    const secret = (globalThis as { __secret?: string }).__secret!;
    tick(60_000);
    const s = (await login({ token: rawToken, code: totpAt(secret, stepOf(now)) })).body.token as string;
    expect((await h.http('POST', `${A}/2fa/disable`, s, { code: '000000' })).status).toBe(400);
    expect((await h.http('POST', `${A}/2fa/disable`, s, {})).status).toBe(400);
    tick(30_000);
    expect((await h.http('POST', `${A}/2fa/disable`, s, { code: totpAt(secret, stepOf(now)) })).status).toBe(201);
    expect((await h.http('GET', '/v1/admin/me', rawToken)).status).toBe(200);
    expect(Number((await h.db.admin.query<{ n: string }>('select count(*) n from admin_recovery_code')).rows[0]!.n)).toBe(0);
    expect((await h.http('POST', `${A}/2fa/disable`, s, { code: '123456' })).status).toBe(400); // sudah mati
  });

  it('pemulihan darurat dari server: 2FA dimatikan, kode pemulihan dihapus, semua sesi dicabut, token mentah bekerja lagi', async () => {
    const secret = (globalThis as { __secret?: string }).__secret!;
    tick(60_000);
    const s1 = (await h.http('POST', `${A}/login`, undefined, { token: rawToken })).body.token as string; // 2FA mati sejak tes sebelumnya
    expect((await h.http('POST', `${A}/2fa/setup`, s1)).status).toBe(201);
    const sec = (await h.db.admin.query<{ totp_pending: string }>("select totp_pending from platform_admin where id = 'hendrik'")).rows[0]!.totp_pending;
    const plain = (await import('../src/totp')).open(sec);
    expect((await h.http('POST', `${A}/2fa/enable`, s1, { code: totpAt(plain, stepOf(now)) })).status).toBe(201);
    expect((await h.http('GET', '/v1/admin/me', rawToken)).status).toBe(401);
    await resetAdmin2fa(h.db, 'hendrik');
    expect((await h.http('GET', '/v1/admin/me', s1)).status).toBe(401); // sesi dicabut
    expect((await h.http('GET', '/v1/admin/me', rawToken)).status).toBe(200); // token mentah bekerja lagi
    expect(Number((await h.db.admin.query<{ n: string }>('select count(*) n from admin_recovery_code')).rows[0]!.n)).toBe(0);
    await expect(resetAdmin2fa(h.db, 'tidak-ada')).rejects.toThrow('tidak ditemukan');
    void secret;
  });

  it('endpoint admin tidak bisa dipakai token tenant, dan sebaliknya', async () => {
    await h.admin.createTenant('t1', 'T1');
    await h.admin.createOutlet('t1', 'o1', 'O1');
    const owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    for (const p of [`${A}/status`, '/v1/admin/me']) expect((await h.http('GET', p, owner)).status).toBe(403);
    expect((await h.http('POST', `${A}/2fa/setup`, owner)).status).toBe(403);
    expect((await h.http('GET', `${A}/status`)).status).toBe(401);
  });
});

describe('sesi pengguna dashboard', () => {
  let h: Harness;
  let admin: string;
  const now = Date.now();
  const auth = (path: string, body: unknown, token?: string, ua?: string) => h.http('POST', `/v1/auth/${path}`, token, body).then((r) => r);
  const GOOD = 'kopi-susu-hangat-pagi';

  beforeAll(async () => {
    h = await createHarness(now);
    admin = (await createPlatformAdmin(h.db, { id: 'adm', name: 'Adm' })).token;
    const mk = (id: string, mail: string) => h.http('POST', '/v1/admin/tenants', admin, { tenantId: id, tenantName: id, outletId: `${id}-o`, outletName: 'O', ownerId: 'bos', ownerEmail: mail });
    expect((await mk('kopi', 'bos@kopi.id')).status).toBe(201);
    expect((await mk('teh', 'bos@teh.id')).status).toBe(201);
  });
  afterAll(() => h.close());

  const session = async (email: string): Promise<string> => {
    await auth('password/forgot', { email });
    const r = await auth('password/reset', { email, code: h.mailer.lastCode(email)!, password: GOOD });
    return r.body.token as string;
  };

  it('daftar sesi memuat alamat dan waktu, menandai sesi ini, dan tidak pernah memuat token', async () => {
    const first = await session('bos@kopi.id');
    // login lagi dari "perangkat lain" (password sekarang sudah ada)
    const second = (await auth('login', { email: 'bos@kopi.id', password: GOOD })).body.token as string;
    const list = (await h.http('GET', '/v1/auth/sessions', second)).body.sessions as { id: number; current: boolean; ip: string; lastUsedAt: string | null; createdAt: string }[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list[0]!.ip).toBeTruthy();
    expect(JSON.stringify(list)).not.toContain(second);
    expect(JSON.stringify(list)).not.toContain(first);
    expect((await h.http('GET', '/v1/auth/sessions')).status).toBe(401);
  });

  it('cabut satu sesi sendiri; sesi orang lain dan tenant lain tidak tersentuh (404); keluar dari semua yang lain', async () => {
    const mine1 = (await auth('login', { email: 'bos@kopi.id', password: GOOD })).body.token as string;
    const mine2 = (await auth('login', { email: 'bos@kopi.id', password: GOOD })).body.token as string;
    const other = await session('bos@teh.id');
    const myList = (await h.http('GET', '/v1/auth/sessions', mine2)).body.sessions as { id: number; current: boolean }[];
    const otherList = (await h.http('GET', '/v1/auth/sessions', other)).body.sessions as { id: number }[];
    expect((await h.http('DELETE', `/v1/auth/sessions/${otherList[0]!.id}`, mine2)).status).toBe(404); // sesi milik tenant lain
    expect((await h.http('GET', '/v1/me', other)).status).toBe(200);
    const target = myList.find((s) => !s.current)!;
    expect((await h.http('DELETE', `/v1/auth/sessions/${target.id}`, mine2)).status).toBe(200);
    expect((await h.http('DELETE', `/v1/auth/sessions/${target.id}`, mine2)).status).toBe(404); // sudah dicabut
    expect((await h.http('DELETE', '/v1/auth/sessions/abc', mine2)).status).toBe(400);
    const gone = [mine1, mine2].filter(async (t) => (await h.http('GET', '/v1/me', t)).status === 401);
    expect(gone.length).toBeGreaterThan(0);
    const out = await h.http('POST', '/v1/auth/sessions/revoke-others', mine2);
    expect(out.status).toBe(201);
    expect((await h.http('GET', '/v1/me', mine2)).status).toBe(200); // yang sedang dipakai tetap hidup
    expect((await h.http('GET', '/v1/me', mine1)).status).toBe(401);
    expect(((await h.http('GET', '/v1/auth/sessions', mine2)).body.sessions as unknown[]).length).toBe(1);
    expect((await h.http('GET', '/v1/me', other)).status).toBe(200);
    expect((await h.db.admin.query("select 1 from audit_log where action in ('auth.session.revoke', 'auth.session.revoke_others')")).rowCount).toBe(2);
  });

  it('terakhir dipakai diperbarui paling sering sekali per 5 menit', async () => {
    const tok = (await auth('login', { email: 'bos@kopi.id', password: GOOD })).body.token as string;
    const { sha256 } = await import('../src/auth');
    const read = async () => (await h.db.admin.query<{ t: string | null }>('select last_used_at::text t from api_token where token_hash = $1', [sha256(tok)])).rows[0]!.t;
    const t0 = await read();
    await h.http('GET', '/v1/me', tok);
    expect(await read()).toBe(t0); // baru dipakai: tidak ditulis ulang
    await h.db.admin.query("update api_token set last_used_at = now() - interval '10 minutes' where token_hash = $1", [sha256(tok)]);
    const old = await read();
    await h.http('GET', '/v1/me', tok);
    expect(await read()).not.toBe(old);
  });
});

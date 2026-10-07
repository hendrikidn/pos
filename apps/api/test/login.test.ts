import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODE_TTL_MS, SESSION_TTL_MS } from '../src/login.service';
import { SmtpMailer } from '../src/mailer';
import { createPlatformAdmin } from '../src/onboard';
import { createHarness, type Harness } from './harness';

const T0 = Date.parse('2026-10-07T10:00:00+07:00');
const MIN = 60_000;

describe('login owner dengan email dan kode sekali pakai', () => {
  let h: Harness;
  let admin: string;
  let t = T0;
  const OWNER = 'teguh@contoh.id';

  const adm = (method: string, path: string, body?: unknown) => h.http(method, `/v1/admin${path}`, admin, body);
  const request = (email: string) => h.http('POST', '/v1/auth/otp/request', undefined, { email });
  const verify = (email: string, code: string) => h.http('POST', '/v1/auth/otp/verify', undefined, { email, code });
  const tick = (ms: number) => { t += ms; h.setNow(t); };
  /**
   * Meminta kode baru dan mengembalikan kodenya. Maju 13 menit dulu supaya batas 5 kode per jam dan batas per alamat tidak menahan
   * permintaan; akibatnya kode lama sudah kedaluwarsa. Tes yang butuh dua kode hidup sekaligus memajukan waktu sendiri.
   */
  const freshCode = async (email: string) => {
    tick(13 * MIN);
    await request(email);
    return h.mailer.lastCode(email)!;
  };

  beforeAll(async () => {
    h = await createHarness(T0);
    admin = (await createPlatformAdmin(h.db, { id: 'adm', name: 'Adm' })).token;
    const r = await adm('POST', '/tenants', { tenantId: 'kopi', tenantName: 'Kopi', outletId: 'kopi-o', outletName: 'O', ownerId: 'teguh', ownerEmail: OWNER });
    expect(r.status).toBe(201);
  });
  afterAll(() => h.close());

  it('tenant dengan email owner tidak mendapat token; token hanya bila diminta', async () => {
    const r = await adm('POST', '/tenants', { tenantId: 'tk-a', tenantName: 'A', outletId: 'tk-a-o', outletName: 'O', ownerEmail: 'a@contoh.id' });
    expect(r.body.ownerToken).toBeUndefined();
    expect(r.body.ownerEmail).toBe('a@contoh.id');
    const both = await adm('POST', '/tenants', { tenantId: 'tk-b', tenantName: 'B', outletId: 'tk-b-o', outletName: 'O', ownerEmail: 'b@contoh.id', issueToken: true });
    expect(both.body.ownerToken).toMatch(/^api_/);
    // Tanpa email, perilaku lama: token diterbitkan.
    const old = await adm('POST', '/tenants', { tenantId: 'tk-c', tenantName: 'C', outletId: 'tk-c-o', outletName: 'O' });
    expect(old.body.ownerToken).toMatch(/^api_/);
  });

  it('alur lengkap: minta kode, terima email, masukkan kode, dapat sesi yang bekerja di dashboard', async () => {
    expect((await request(OWNER)).body).toEqual({ ok: true });
    expect(h.mailer.count(OWNER)).toBe(1);
    const mail = h.mailer.sent.find((m) => m.to === OWNER)!;
    expect(mail.subject).toMatch(/^Kode masuk POS Guard: \d{6}$/);
    expect(mail.text).toContain('10 menit');
    const code = h.mailer.lastCode(OWNER)!;

    const v = await verify(OWNER, code);
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ userId: 'teguh', role: 'OWNER', tenantId: 'kopi' });
    expect(v.body.token).toMatch(/^api_/);
    expect(Date.parse(v.body.expiresAt)).toBe(t + SESSION_TTL_MS);

    expect((await h.http('GET', '/v1/me', v.body.token)).body).toMatchObject({ userId: 'teguh', role: 'OWNER', tenantId: 'kopi' });
    expect((await h.http('GET', '/v1/outlets', v.body.token)).status).toBe(200);
    expect((await h.http('POST', '/v1/outlets', v.body.token, { name: 'Cabang' })).status).toBe(201); // hak owner penuh
  });

  it('email dinormalkan (huruf besar dan spasi), kode boleh berspasi', async () => {
    const code = await freshCode(OWNER);
    const v = await verify(`  ${OWNER.toUpperCase()} `, `${code.slice(0, 3)} ${code.slice(3)}`);
    expect(v.status).toBe(201);
  });

  it('kode hanya berlaku sekali', async () => {
    const code = await freshCode(OWNER);
    expect((await verify(OWNER, code)).status).toBe(201);
    const again = await verify(OWNER, code);
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/salah atau sudah kedaluwarsa/);
  });

  it('kode kedaluwarsa setelah 10 menit', async () => {
    const code = await freshCode(OWNER);
    tick(CODE_TTL_MS + 1000);
    expect((await verify(OWNER, code)).status).toBe(400);
  });

  it('hanya kode terbaru yang berlaku', async () => {
    tick(2 * 3600_000); // jendela satu jam baru
    await request(OWNER);
    const first = h.mailer.lastCode(OWNER)!;
    tick(61_000); // melewati jeda 60 detik; kode pertama masih belum kedaluwarsa
    await request(OWNER);
    const second = h.mailer.lastCode(OWNER)!;
    expect(second).not.toBe(first);
    expect((await verify(OWNER, first)).status).toBe(400);
    expect((await verify(OWNER, second)).status).toBe(201);
  });

  it('lima kali salah mematikan kode itu, kode yang benar pun ditolak', async () => {
    const code = await freshCode(OWNER);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await verify(OWNER, wrong)).status).toBe(400);
    expect((await verify(OWNER, code)).status).toBe(400);
    // Kode baru tetap bisa diminta dan dipakai.
    expect((await verify(OWNER, await freshCode(OWNER))).status).toBe(201);
  });

  it('respons permintaan kode sama untuk email terdaftar dan tidak; email tak dikenal tidak dikirimi apa pun', async () => {
    const known = await request(OWNER);
    const before = h.mailer.sent.length;
    const unknown = await request('tidak-ada@contoh.id');
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(h.mailer.sent.length).toBe(before);
    expect((await verify('tidak-ada@contoh.id', '123456')).status).toBe(400);
    expect((await request('bukan-email')).status).toBe(400);
  });

  it('jeda 60 detik antar permintaan dan maksimal 5 kode per jam', async () => {
    tick(2 * 3600_000); // jendela satu jam baru
    const start = h.mailer.count(OWNER);
    await request(OWNER);
    await request(OWNER); // dalam jeda 60 detik: tidak dikirim
    expect(h.mailer.count(OWNER)).toBe(start + 1);
    for (let i = 0; i < 6; i++) { tick(61_000); await request(OWNER); }
    expect(h.mailer.count(OWNER) - start).toBe(5); // permintaan ke-6 dan ke-7 dalam jam yang sama diam-diam ditahan
    tick(2 * 3600_000);
    await request(OWNER);
    expect(h.mailer.count(OWNER) - start).toBe(6); // jam berganti: boleh lagi
  });

  it('kegagalan SMTP tidak terlihat oleh pemanggil', async () => {
    tick(2 * 3600_000);
    h.mailer.failNext = true;
    const r = await request(OWNER);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ ok: true });
  });

  it('kode tidak disimpan polos dan tidak masuk log audit', async () => {
    const code = await freshCode(OWNER);
    const rows = (await h.db.admin.query<{ code_hash: string; salt: string }>('select code_hash, salt from login_code order by id desc limit 1')).rows[0]!;
    expect(rows.code_hash).not.toContain(code);
    expect(rows.code_hash).toMatch(/^[0-9a-f]{64}$/);
    await verify(OWNER, code);
    const audit = JSON.stringify((await h.db.admin.query("select actor, action, detail from audit_log where action like 'auth.%'")).rows);
    expect(audit).toContain('auth.login');
    expect(audit).not.toContain(code);
    expect(audit).not.toMatch(/api_[A-Za-z0-9_-]{20,}/);
  });

  describe('sesi', () => {
    it('sesi tidak muncul sebagai token di konsol admin, tetapi dihitung per pengguna', async () => {
      const v = await verify(OWNER, await freshCode(OWNER));
      const d = (await adm('GET', '/tenants/kopi')).body;
      expect(d.tokens.every((x: { label: string }) => x.label !== 'sesi email')).toBe(true);
      expect(JSON.stringify(d)).not.toContain(v.body.token);
      expect(d.users[0]).toMatchObject({ user_id: 'teguh', email: OWNER, role: 'OWNER', active: true });
      expect(d.users[0].active_sessions).toBeGreaterThan(0);
      expect(d.users[0].last_login_at).not.toBeNull();
    });

    it('sesi kedaluwarsa ditolak (401)', async () => {
      const v = await verify(OWNER, await freshCode(OWNER));
      expect((await h.http('GET', '/v1/me', v.body.token)).status).toBe(200);
      await h.db.admin.query("update api_token set expires_at = now() - interval '1 minute' where session");
      expect((await h.http('GET', '/v1/me', v.body.token)).status).toBe(401);
    });

    it('keluar mencabut sesi itu saja; token tetap dari admin tidak ikut mati', async () => {
      const staticToken = await h.admin.createApiToken('kopi', 'teguh', 'OWNER');
      const v = await verify(OWNER, await freshCode(OWNER));
      const other = await verify(OWNER, await freshCode(OWNER));
      expect((await h.http('POST', '/v1/auth/logout', v.body.token)).status).toBe(201);
      expect((await h.http('GET', '/v1/me', v.body.token)).status).toBe(401);
      expect((await h.http('GET', '/v1/me', other.body.token)).status).toBe(200); // sesi lain (perangkat lain) tetap hidup
      // Logout dengan token tetap tidak mencabutnya.
      expect((await h.http('POST', '/v1/auth/logout', staticToken)).status).toBe(201);
      expect((await h.http('GET', '/v1/me', staticToken)).status).toBe(200);
      expect((await h.http('POST', '/v1/auth/logout')).status).toBe(401);
    });
  });

  describe('admin mengelola pengguna', () => {
    it('email kembar, format salah, dan peran tidak dikenal ditolak', async () => {
      expect((await adm('POST', '/tenants', { tenantId: 'dup', tenantName: 'D', outletId: 'dup-o', outletName: 'O', ownerEmail: OWNER.toUpperCase() })).status).toBe(409);
      expect((await adm('GET', '/tenants/dup')).status).toBe(404); // transaksi dibatalkan utuh
      expect((await adm('POST', '/tenants', { tenantId: 'bad', tenantName: 'D', outletId: 'bad-o', outletName: 'O', ownerEmail: 'tanpa-at' })).status).toBe(400);
      expect((await adm('POST', '/tenants/kopi/users', { email: OWNER })).status).toBe(409);
      expect((await adm('POST', '/tenants/kopi/users', { email: 'x@contoh.id', role: 'SUPER' })).status).toBe(400);
      expect((await adm('POST', '/tenants/tidak-ada/users', { email: 'y@contoh.id' })).status).toBe(404);
    });

    it('menambah pengguna dengan peran lain: login memberi peran itu', async () => {
      const u = await adm('POST', '/tenants/kopi/users', { email: 'Sari.Manager@contoh.id', role: 'MANAGER' });
      expect(u.status).toBe(201);
      expect(u.body).toMatchObject({ userId: 'sari-manager', email: 'sari.manager@contoh.id', role: 'MANAGER' });
      const v = await verify('sari.manager@contoh.id', await freshCode('sari.manager@contoh.id'));
      expect(v.body).toMatchObject({ role: 'MANAGER', userId: 'sari-manager' });
      expect((await h.http('POST', '/v1/outlets', v.body.token, { name: 'Tidak boleh' })).status).toBe(403);
    });

    it('menonaktifkan pengguna mencabut sesinya, menghentikan kode baru, dan mematikan kode yang sudah terkirim', async () => {
      const mail = 'nonaktif@contoh.id';
      await adm('POST', '/tenants/kopi/users', { email: mail, role: 'OPS' });
      const ref = (await adm('GET', '/tenants/kopi')).body.users.find((u: { email: string }) => u.email === mail).id;
      const v = await verify(mail, await freshCode(mail));
      const pending = await freshCode(mail);
      expect((await adm('PUT', `/tenants/kopi/users/${ref}`, { active: false })).status).toBe(200);
      expect((await h.http('GET', '/v1/me', v.body.token)).status).toBe(401);
      expect((await verify(mail, pending)).status).toBe(400);
      const before = h.mailer.count(mail);
      tick(2 * MIN);
      await request(mail);
      expect(h.mailer.count(mail)).toBe(before);
      // Diaktifkan lagi: bisa login lagi.
      await adm('PUT', `/tenants/kopi/users/${ref}`, { active: true });
      expect((await verify(mail, await freshCode(mail))).status).toBe(201);
    });

    it('mengganti email mencabut sesi dan mematikan kode ke email lama; login pindah ke email baru', async () => {
      await adm('POST', '/tenants/kopi/users', { email: 'lama@contoh.id', role: 'OPS' });
      const ref = (await adm('GET', '/tenants/kopi')).body.users.find((u: { email: string }) => u.email === 'lama@contoh.id').id;
      const v = await verify('lama@contoh.id', await freshCode('lama@contoh.id'));
      const stale = await freshCode('lama@contoh.id');
      expect((await adm('PUT', `/tenants/kopi/users/${ref}`, { email: 'baru@contoh.id' })).status).toBe(200);
      expect((await h.http('GET', '/v1/me', v.body.token)).status).toBe(401);
      expect((await verify('lama@contoh.id', stale)).status).toBe(400);
      expect((await verify('baru@contoh.id', await freshCode('baru@contoh.id'))).status).toBe(201);
      expect((await adm('PUT', `/tenants/kopi/users/${ref}`, { email: OWNER })).status).toBe(409);
      expect((await adm('PUT', `/tenants/kopi/users/${ref}`, {})).status).toBe(400);
      expect((await adm('PUT', '/tenants/kopi/users/999999', { active: false })).status).toBe(404);
      expect((await adm('PUT', '/tenants/kopi/users/abc', { active: false })).status).toBe(400);
    });

    it('pengguna tenant lain tidak bisa diubah lewat tenant yang salah', async () => {
      const ref = (await adm('GET', '/tenants/kopi')).body.users[0].id;
      expect((await adm('PUT', `/tenants/tk-a/users/${ref}`, { active: false })).status).toBe(404);
    });

    it('token dan sesi pengguna biasa tidak bisa memakai endpoint pengguna admin', async () => {
      const v = await verify(OWNER, await freshCode(OWNER));
      expect((await h.http('POST', '/v1/admin/tenants/kopi/users', v.body.token, { email: 'z@contoh.id' })).status).toBe(403);
    });
  });

  it('tenant ditangguhkan: kode benar tidak memberi sesi (403), dan kode itu terpakai', async () => {
    await adm('POST', '/tenants/kopi/suspend', { reason: 'uji' });
    const code = await freshCode(OWNER);
    const v = await verify(OWNER, code);
    expect(v.status).toBe(403);
    expect(v.body.message).toMatch(/ditangguhkan/);
    await adm('POST', '/tenants/kopi/reactivate');
    expect((await verify(OWNER, code)).status).toBe(400);
    expect((await verify(OWNER, await freshCode(OWNER))).status).toBe(201);
  });

  it('pembatas per alamat: terlalu banyak permintaan kode atau percobaan salah menghasilkan 429', async () => {
    const h2 = await createHarness(T0);
    try {
      await h2.admin.createTenant('t', 'T');
      await h2.admin.createOutlet('t', 'to', 'O');
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) statuses.push((await h2.http('POST', '/v1/auth/otp/request', undefined, { email: `x${i}@contoh.id` })).status);
      expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
      expect(statuses.slice(20)).toContain(429);

      const h3 = await createHarness(T0);
      try {
        const fails: number[] = [];
        for (let i = 0; i < 25; i++) fails.push((await h3.http('POST', '/v1/auth/otp/verify', undefined, { email: 'a@contoh.id', code: '123456' })).status);
        expect(fails.slice(0, 20).every((s) => s === 400)).toBe(true);
        expect(fails.slice(20)).toContain(429);
      } finally { await h3.close(); }
    } finally { await h2.close(); }
  });
});

describe('SmtpMailer terhadap server SMTP', () => {
  let server: Server;
  let port = 0;
  const received: string[] = [];

  beforeAll(async () => {
    server = createServer((sock) => {
      let buf = '';
      let inData = false;
      sock.write('220 sink ESMTP\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (;;) {
          if (inData) {
            const end = buf.indexOf('\r\n.\r\n');
            if (end < 0) break;
            received.push(buf.slice(0, end));
            buf = buf.slice(end + 5);
            inData = false;
            sock.write('250 diterima\r\n');
            continue;
          }
          const nl = buf.indexOf('\r\n');
          if (nl < 0) break;
          const line = buf.slice(0, nl).toUpperCase();
          buf = buf.slice(nl + 2);
          if (line.startsWith('EHLO') || line.startsWith('HELO')) sock.write('250-sink\r\n250 8BITMIME\r\n');
          else if (line === 'DATA') { sock.write('354 kirim\r\n'); inData = true; }
          else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('mengirim email sungguhan lewat SMTP dengan pengirim, penerima, subjek, dan isi yang benar', async () => {
    const mailer = new SmtpMailer({ host: '127.0.0.1', port, secure: false, from: 'POS Guard <no-reply@contoh.id>', allowPlain: true });
    await mailer.send({ to: 'owner@contoh.id', subject: 'Kode masuk POS Guard: 482913', text: 'Kode masuk POS Guard Anda: 482913' });
    expect(received).toHaveLength(1);
    const raw = received[0]!;
    expect(raw).toMatch(/^From: .*no-reply@contoh\.id/mi);
    expect(raw).toMatch(/^To: owner@contoh\.id/mi);
    expect(raw).toMatch(/^Subject: Kode masuk POS Guard: 482913/mi);
    expect(raw).toContain('482913');
  });

  it('kegagalan koneksi menjadi error (bukan diam-diam)', async () => {
    const mailer = new SmtpMailer({ host: '127.0.0.1', port: 1, secure: false, from: 'a@b.id', allowPlain: true });
    await expect(mailer.send({ to: 'x@y.id', subject: 's', text: 't' })).rejects.toThrow();
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIGNUPS_PER_IP_PER_HOUR } from '../src/signup.service';
import { createHarness, type Harness } from './harness';

const T0 = Date.parse('2026-10-08T10:00:00+07:00');

describe('pendaftaran mandiri', () => {
  let h: Harness;
  let t = T0;
  const signup = (body: unknown) => h.http('POST', '/v1/auth/signup', undefined, body);
  const tenants = async () => (await h.db.admin.query<{ id: string; name: string }>('select id, name from tenant order by id')).rows;
  const good = { businessName: 'Kopi Senja', outletName: 'Cabang Utama', ownerName: 'Teguh', email: 'Teguh@Contoh.id' };

  beforeAll(async () => {
    h = await createHarness(T0);
  });
  afterAll(() => h.close());

  it('membuat usaha, outlet, owner, dan uji coba 14 hari; kode untuk mengatur password dikirim; owner bisa masuk dan melihat uji cobanya', async () => {
    const r = await signup(good);
    expect(r).toEqual({ status: 201, body: { ok: true } });
    const [tenant] = await tenants();
    expect(tenant).toMatchObject({ name: 'Kopi Senja' });
    expect(tenant!.id).toMatch(/^kopi-senja-[0-9a-f]{4}$/);
    const outlet = (await h.db.admin.query<{ id: string; name: string; terminals: string[]; shadow_days: number }>('select id, name, terminals, shadow_days from outlet')).rows;
    expect(outlet).toEqual([{ id: `${tenant!.id}-utama`, name: 'Cabang Utama', terminals: [], shadow_days: expect.any(Number) }]);
    expect((await h.db.admin.query<{ email: string; role: string; user_id: string }>('select email, role, user_id from dashboard_user')).rows).toEqual([{ email: 'teguh@contoh.id', role: 'OWNER', user_id: 'teguh' }]);
    expect((await h.db.admin.query<{ detail: { ownerName: string } }>("select detail from audit_log where action = 'signup.self'")).rows[0]!.detail.ownerName).toBe('Teguh');

    const code = h.mailer.lastCode('teguh@contoh.id');
    expect(code).toMatch(/^\d{6}$/);
    const login = await h.http('POST', '/v1/auth/password/reset', undefined, { email: 'teguh@contoh.id', code, password: 'rahasia-sangat-panjang-1' });
    expect(login.status).toBeLessThan(300);
    expect(login.body).toMatchObject({ role: 'OWNER', tenantId: tenant!.id });
    const billing = (await h.http('GET', '/v1/billing', login.body.token)).body;
    expect(billing.subscription).toMatchObject({ status: 'TRIAL', trialEnd: '2026-10-21', trialDaysLeft: 14, outlets: 1, planId: 'standard' });
  });

  it('email yang sudah terdaftar: respons sama persis, tidak ada usaha baru, dan hanya kode masuk dikirim ke pemiliknya', async () => {
    const before = await tenants();
    const mails = h.mailer.sent.length;
    t += 61_000; h.setNow(t); // lewati jeda kirim ulang kode
    const r = await signup({ ...good, businessName: 'Usaha Lain', email: 'teguh@contoh.id' });
    expect(r).toEqual({ status: 201, body: { ok: true } });
    expect(await tenants()).toEqual(before);
    expect(h.mailer.sent.length).toBe(mails + 1);
    expect(h.mailer.sent.at(-1)!.to).toBe('teguh@contoh.id');
  });

  it('isian tidak sah ditolak 400 dan tidak membuat apa pun; jebakan bot berpura-pura berhasil tanpa membuat atau mengirim apa pun', async () => {
    const before = (await tenants()).length;
    const mails = h.mailer.sent.length;
    for (const bad of [
      { ...good, businessName: 'X' }, { ...good, businessName: 'x'.repeat(61) }, { ...good, outletName: '' }, { ...good, ownerName: undefined },
      { ...good, email: 'bukan-email' }, { ...good, email: `${'a'.repeat(250)}@x.id` }, { ...good, businessName: 12345 }, {},
    ]) expect((await signup(bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    expect((await signup({ ...good, email: 'bot@spam.id', website: 'http://spam.example' })).body).toEqual({ ok: true });
    expect((await tenants()).length).toBe(before);
    expect(h.mailer.sent.length).toBe(mails);
  });

  it('dibatasi per alamat per jam (429), dan pulih setelah satu jam', async () => {
    t += 3_700_000; h.setNow(t);
    const base = (await tenants()).length;
    for (let i = 0; i < SIGNUPS_PER_IP_PER_HOUR; i++) expect((await signup({ ...good, businessName: `Usaha ${i}`, email: `u${i}@contoh.id` })).status).toBe(201);
    expect((await tenants()).length).toBe(base + SIGNUPS_PER_IP_PER_HOUR);
    const blocked = await signup({ ...good, email: 'terlalu-banyak@contoh.id' });
    expect(blocked.status).toBe(429);
    expect((await tenants()).length).toBe(base + SIGNUPS_PER_IP_PER_HOUR);
    t += 3_700_000; h.setNow(t);
    expect((await signup({ ...good, businessName: 'Setelah Jeda', email: 'setelah@contoh.id' })).status).toBe(201);
  });

  it('nama usaha dengan aksen dan simbol menjadi id yang sah; nama kosong setelah dibersihkan memakai "usaha"', async () => {
    t += 3_700_000; h.setNow(t);
    expect((await signup({ ...good, businessName: 'Café Dörfer & Co.', email: 'cafe@contoh.id' })).status).toBe(201);
    expect((await signup({ ...good, businessName: '!!!', email: 'simbol@contoh.id' })).status).toBe(201);
    const ids = (await tenants()).map((x) => x.id);
    expect(ids.some((id) => /^cafe-dorfer-co-[0-9a-f]{4}$/.test(id))).toBe(true);
    expect(ids.some((id) => /^usaha-[0-9a-f]{4}$/.test(id))).toBe(true);
  });
});

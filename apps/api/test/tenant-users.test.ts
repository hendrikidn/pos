import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformAdmin } from '../src/onboard';
import { createHarness, type Harness } from './harness';

const T0 = Date.parse('2026-10-07T10:00:00+07:00');
const MIN = 60_000;

describe('owner mengelola pengguna dashboard dengan peran OPS, manager, supervisor', () => {
  let h: Harness;
  let admin: string;
  let owner: string; // sesi owner tenant "kopi" (login email)
  let ownerB: string; // tenant lain
  let t = T0;

  const api = (method: string, path: string, body?: unknown, token = owner) => h.http(method, `/v1${path}`, token, body);
  const request = (email: string) => h.http('POST', '/v1/auth/otp/request', undefined, { email });
  const verify = (email: string, code: string) => h.http('POST', '/v1/auth/otp/verify', undefined, { email, code });
  /** Login email penuh; maju 13 menit agar batas kode per jam tidak menahan. */
  const login = async (email: string) => {
    t += 13 * MIN;
    h.setNow(t);
    await request(email);
    return (await verify(email, h.mailer.lastCode(email)!)).body as { token: string; role: string; userId: string };
  };
  const find = async (email: string) => (await api('GET', '/users')).body.find((u: { email: string }) => u.email === email);

  beforeAll(async () => {
    h = await createHarness(T0);
    admin = (await createPlatformAdmin(h.db, { id: 'adm', name: 'Adm' })).token;
    const mk = (id: string, mail: string) =>
      h.http('POST', '/v1/admin/tenants', admin, { tenantId: id, tenantName: id, outletId: `${id}-o`, outletName: 'O', ownerId: 'bos', ownerEmail: mail });
    await mk('kopi', 'bos@kopi.id');
    await mk('teh', 'bos@teh.id');
    owner = (await login('bos@kopi.id')).token;
    ownerB = (await login('bos@teh.id')).token;
  });
  afterAll(() => h.close());

  it('owner mengundang manager: ID dibuat dari email, lalu manager login dan hanya punya hak manager', async () => {
    const r = await api('POST', '/users', { email: 'Rina.Putri@Kopi.ID', role: 'MANAGER' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ userId: 'rina-putri', email: 'rina.putri@kopi.id', role: 'MANAGER' });

    const s = await login('rina.putri@kopi.id');
    expect(s).toMatchObject({ role: 'MANAGER', userId: 'rina-putri' });
    expect((await h.http('GET', '/v1/outlets', s.token)).status).toBe(200); // lihat insiden/outlet
    expect((await h.http('GET', '/v1/menu', s.token)).status).toBe(200); // manager boleh melihat menu
    expect((await h.http('POST', '/v1/outlets', s.token, { name: 'X' })).status).toBe(403); // tidak boleh mengelola
    expect((await h.http('GET', '/v1/users', s.token)).status).toBe(403);
  });

  it('OPS dan supervisor mendapat hak masing-masing', async () => {
    await api('POST', '/users', { email: 'ops@kopi.id', role: 'OPS' });
    await api('POST', '/users', { email: 'spv@kopi.id', role: 'SUPERVISOR' });
    const ops = await login('ops@kopi.id');
    const spv = await login('spv@kopi.id');
    expect(ops.role).toBe('OPS');
    expect((await h.http('GET', '/v1/devices', ops.token)).status).toBe(200); // OPS: perangkat
    expect((await h.http('POST', '/v1/outlets', ops.token, { name: 'X' })).status).toBe(403); // bukan outlet
    expect(spv.role).toBe('SUPERVISOR');
    expect((await h.http('GET', '/v1/outlets', spv.token)).status).toBe(200); // supervisor: insiden saja
    expect((await h.http('GET', '/v1/devices', spv.token)).status).toBe(403);
    expect((await h.http('GET', '/v1/menu', spv.token)).status).toBe(403);
  });

  it('ID pengguna bisa disamakan dengan ID staf; bentrok ditolak, dan nama dasar yang sama diberi akhiran', async () => {
    const a = await api('POST', '/users', { email: 'budi@kopi.id', userId: 'budi', role: 'MANAGER' });
    expect(a.body.userId).toBe('budi');
    expect((await api('POST', '/users', { email: 'budi2@kopi.id', userId: 'budi', role: 'MANAGER' })).status).toBe(409);
    expect((await api('POST', '/users', { email: 'budi@lain.id', role: 'OPS' })).body.userId).toBe('budi-2'); // otomatis unik
    expect((await api('POST', '/users', { email: 'Budi!@x.id', userId: 'Budi Besar', role: 'OPS' })).status).toBe(400);
  });

  it('OWNER tidak bisa dibuat atau diubah oleh owner; peran dan email tidak valid ditolak', async () => {
    expect((await api('POST', '/users', { email: 'dua@kopi.id', role: 'OWNER' })).status).toBe(400);
    expect((await api('POST', '/users', { email: 'dua@kopi.id', role: 'ADMIN' })).status).toBe(400);
    expect((await api('POST', '/users', { email: 'bukan-email', role: 'OPS' })).status).toBe(400);
    expect((await api('POST', '/users', { role: 'OPS' })).status).toBe(400);
    const me = await find('bos@kopi.id');
    expect((await api('PUT', `/users/${me.id}`, { active: false })).status).toBe(403); // tidak bisa menonaktifkan diri/owner
    expect((await api('PUT', `/users/${me.id}`, { email: 'curang@kopi.id' })).status).toBe(403);
    expect((await api('PUT', `/users/${me.id}`, { role: 'OPS' })).status).toBe(403);
    expect((await h.http('GET', '/v1/me', owner)).status).toBe(200);
  });

  it('email unik di seluruh platform, termasuk milik tenant lain, tanpa membocorkan tenant mana', async () => {
    const dup = await api('POST', '/users', { email: 'BOS@TEH.ID', role: 'OPS' });
    expect(dup.status).toBe(409);
    expect(JSON.stringify(dup.body)).not.toMatch(/teh/);
  });

  it('mengubah peran memutus sesi lama; sesi baru memakai peran baru', async () => {
    await api('POST', '/users', { email: 'naik@kopi.id', role: 'SUPERVISOR' });
    const old = await login('naik@kopi.id');
    const u = await find('naik@kopi.id');
    expect((await api('PUT', `/users/${u.id}`, { role: 'MANAGER' })).status).toBe(200);
    expect((await h.http('GET', '/v1/me', old.token)).status).toBe(401);
    expect((await login('naik@kopi.id')).role).toBe('MANAGER');
  });

  it('menonaktifkan pengguna memutus sesi dan kode; mengganti email memindahkan login', async () => {
    await api('POST', '/users', { email: 'pergi@kopi.id', role: 'OPS' });
    const s = await login('pergi@kopi.id');
    t += 13 * MIN; h.setNow(t);
    await request('pergi@kopi.id');
    const pending = h.mailer.lastCode('pergi@kopi.id')!;
    const u = await find('pergi@kopi.id');
    expect((await api('PUT', `/users/${u.id}`, { active: false })).status).toBe(200);
    expect((await h.http('GET', '/v1/me', s.token)).status).toBe(401);
    expect((await verify('pergi@kopi.id', pending)).status).toBe(400);
    expect((await find('pergi@kopi.id')).active).toBe(false);

    await api('PUT', `/users/${u.id}`, { active: true, email: 'pindah@kopi.id' });
    expect((await login('pindah@kopi.id')).role).toBe('OPS');
    expect((await api('PUT', `/users/${u.id}`, { email: 'bos@teh.id' })).status).toBe(409);
    expect((await api('PUT', `/users/${u.id}`, {})).status).toBe(400);
    expect((await api('PUT', '/users/999999', { active: false })).status).toBe(404);
    expect((await api('PUT', '/users/abc', { active: false })).status).toBe(400);
  });

  it('daftar menampilkan peran, status, login terakhir, dan jumlah sesi, tanpa token', async () => {
    const list = (await api('GET', '/users')).body;
    expect(list.find((x: { email: string }) => x.email === 'bos@kopi.id')).toMatchObject({ role: 'OWNER', active: true });
    expect(list.find((x: { email: string }) => x.email === 'rina.putri@kopi.id').last_login_at).not.toBeNull();
    expect(list.some((x: { active_sessions: number }) => x.active_sessions > 0)).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/api_[A-Za-z0-9_-]{20,}|token_hash/);
  });

  it('tenant lain: tidak terlihat dan tidak bisa diubah (RLS), dan hanya OWNER yang boleh memakai endpoint ini', async () => {
    const mine = (await api('GET', '/users')).body.map((u: { email: string }) => u.email);
    const theirs = (await api('GET', '/users', undefined, ownerB)).body.map((u: { email: string }) => u.email);
    expect(mine.every((e: string) => e.endsWith('@kopi.id') || e.endsWith('@lain.id') || e.endsWith('@x.id'))).toBe(true);
    expect(theirs).toEqual(['bos@teh.id']);

    const victim = await find('rina.putri@kopi.id');
    expect((await api('PUT', `/users/${victim.id}`, { active: false }, ownerB)).status).toBe(404);
    expect((await find('rina.putri@kopi.id')).active).toBe(true);

    const mgr = await login('rina.putri@kopi.id');
    expect((await h.http('POST', '/v1/users', mgr.token, { email: 'x@kopi.id', role: 'OPS' })).status).toBe(403);
    expect((await h.http('POST', '/v1/users', undefined, { email: 'x@kopi.id', role: 'OPS' })).status).toBe(401);
  });

  it('semua perubahan tercatat di audit_log tanpa token', async () => {
    const r = await h.db.admin.query<{ action: string }>("select distinct action from audit_log where action like 'user.%'");
    expect(r.rows.map((x) => x.action).sort()).toEqual(['user.invite', 'user.update']);
    expect(JSON.stringify((await h.db.admin.query("select detail from audit_log where action like 'user.%'")).rows)).not.toMatch(/api_[A-Za-z0-9_-]{20,}/);
  });
});

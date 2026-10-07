import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformAdmin } from '../src/onboard';
import { createHarness, type Harness } from './harness';

describe('konsol admin platform', () => {
  let h: Harness;
  let admin: string;

  const a = (method: string, path: string, body?: unknown, token = admin) => h.http(method, `/v1/admin${path}`, token, body);
  const newTenant = { tenantId: 'kopi-a', tenantName: 'Kopi A', outletId: 'kopi-a-pusat', outletName: 'Kopi A Pusat', terminals: ['pos-1', 'pos-2'] };

  beforeAll(async () => {
    h = await createHarness(Date.parse('2026-10-07T10:00:00+07:00'));
    admin = (await createPlatformAdmin(h.db, { id: 'hendrik', name: 'Hendrik' })).token;
  });
  afterAll(() => h.close());

  describe('akses', () => {
    it('tanpa token ditolak, dan token admin dikenali', async () => {
      expect((await h.http('GET', '/v1/admin/tenants')).status).toBe(401);
      expect(admin).toMatch(/^adm_/);
      expect((await a('GET', '/me')).body).toEqual({ adminId: 'hendrik' });
    });

    it('token pengguna tenant dan token perangkat TIDAK bisa memakai endpoint admin', async () => {
      await h.admin.createTenant('t0', 'T0');
      await h.admin.createOutlet('t0', 'o0', 'O0');
      const owner = await h.admin.createApiToken('t0', 'o', 'OWNER');
      const dev = await h.admin.createDevice('t0', 'o0', 'pos-x', 'terminal');
      for (const token of [owner, dev]) {
        expect((await a('GET', '/tenants', undefined, token)).status).toBe(403);
        expect((await a('POST', '/tenants', newTenant, token)).status).toBe(403);
      }
    });

    it('token admin TIDAK bisa dipakai sebagai pengguna tenant', async () => {
      expect((await h.http('GET', '/v1/me', admin)).status).toBe(403);
      expect((await h.http('GET', '/v1/outlets', admin)).status).toBe(403);
      expect((await h.http('POST', '/v1/devices/pairing', admin, { outletId: 'o0', kind: 'sensor' })).status).toBe(403);
    });
  });

  describe('membuat tenant', () => {
    it('membuat tenant, outlet, dan token owner yang langsung bisa dipakai', async () => {
      const r = await a('POST', '/tenants', newTenant);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ tenantId: 'kopi-a', outletId: 'kopi-a-pusat', ownerId: 'owner' });
      expect(r.body.ownerToken).toMatch(/^api_/);

      const owner = r.body.ownerToken;
      expect((await h.http('GET', '/v1/me', owner)).body).toMatchObject({ role: 'OWNER', tenantId: 'kopi-a' });
      const outlets = (await h.http('GET', '/v1/outlets', owner)).body;
      expect(outlets.map((o: { id: string }) => o.id)).toEqual(['kopi-a-pusat']);
      // Owner baru langsung bisa memasang sensor.
      expect((await h.http('POST', '/v1/devices/pairing', owner, { outletId: 'kopi-a-pusat', kind: 'sensor', terminalId: 'pos-1' })).status).toBe(201);
    });

    it('tenant dan outlet kembar ditolak, dan tidak meninggalkan data setengah jadi', async () => {
      expect((await a('POST', '/tenants', newTenant)).status).toBe(409);
      // Outlet sudah dipakai tenant lain: seluruh transaksi dibatalkan, tenant baru tidak boleh tersisa.
      const dupOutlet = await a('POST', '/tenants', { ...newTenant, tenantId: 'kopi-b', outletId: 'kopi-a-pusat' });
      expect(dupOutlet.status).toBe(409);
      expect((await a('GET', '/tenants/kopi-b')).status).toBe(404);
    });

    it('masukan tidak valid ditolak', async () => {
      const bad = (over: object) => a('POST', '/tenants', { ...newTenant, tenantId: 'x-ok', outletId: 'x-ok-o', ...over });
      expect((await bad({ tenantId: 'Kopi Besar' })).status).toBe(400);
      expect((await bad({ tenantName: '   ' })).status).toBe(400);
      expect((await bad({ outletName: 'x'.repeat(81) })).status).toBe(400);
      expect((await bad({ terminals: ['POS 1'] })).status).toBe(400);
      expect((await bad({ terminals: ['pos-1', 'pos-1'] })).status).toBe(400);
      expect((await bad({ terminals: 'pos-1' })).status).toBe(400);
      expect((await bad({ ownerId: 'Owner Besar' })).status).toBe(400);
      expect((await a('GET', '/tenants/x-ok')).status).toBe(404);
    });
  });

  describe('mengelola tenant', () => {
    it('daftar tenant memuat ringkasan, detail memuat outlet, perangkat, dan token tanpa rahasia', async () => {
      const list = (await a('GET', '/tenants')).body;
      const row = list.find((t: { id: string }) => t.id === 'kopi-a');
      expect(row).toMatchObject({ name: 'Kopi A', outlets: 1, devices: 0, owner_tokens: 1 });

      const d = (await a('GET', '/tenants/kopi-a')).body;
      expect(d.tenant.name).toBe('Kopi A');
      expect(d.outlets).toEqual([{ id: 'kopi-a-pusat', name: 'Kopi A Pusat', terminals: ['pos-1', 'pos-2'] }]);
      expect(d.tokens).toHaveLength(1);
      expect(d.tokens[0]).toMatchObject({ user_id: 'owner', role: 'OWNER', revoked_at: null });
      expect(JSON.stringify(d)).not.toMatch(/api_[A-Za-z0-9_-]{20,}|token_hash/);
    });

    it('menambah outlet; ID outlet bersifat global sehingga tidak boleh sama dengan tenant lain', async () => {
      const ok = await a('POST', '/tenants/kopi-a/outlets', { outletId: 'kopi-a-cabang', outletName: 'Cabang', terminals: ['pos-1'] });
      expect(ok.status).toBe(201);
      expect((await a('POST', '/tenants/kopi-a/outlets', { outletId: 'kopi-a-cabang', outletName: 'Lagi' })).status).toBe(409);
      expect((await a('POST', '/tenants/kopi-a/outlets', { outletId: 'o0', outletName: 'Milik t0' })).status).toBe(409);
      expect((await a('POST', '/tenants/tidak-ada/outlets', { outletId: 'baru-o', outletName: 'X' })).status).toBe(404);
    });

    it('menerbitkan token owner tambahan, dan mencabutnya: token langsung tidak berlaku, yang lain tetap', async () => {
      const first = (await a('GET', '/tenants/kopi-a')).body.tokens[0];
      const issued = await a('POST', '/tenants/kopi-a/owner-tokens', { ownerId: 'bu-sari', label: 'HP baru' });
      expect(issued.status).toBe(201);
      expect(issued.body.ownerToken).toMatch(/^api_/);
      expect((await h.http('GET', '/v1/me', issued.body.ownerToken)).body).toMatchObject({ userId: 'bu-sari', tenantId: 'kopi-a' });

      expect((await a('POST', `/tenants/kopi-a/tokens/${issued.body.tokenId}/revoke`)).status).toBe(201);
      expect((await h.http('GET', '/v1/me', issued.body.ownerToken)).status).toBe(401);
      expect((await a('POST', `/tenants/kopi-a/tokens/${issued.body.tokenId}/revoke`)).status).toBe(404); // sudah dicabut

      // Token awal owner tidak ikut terdampak.
      expect(first.revoked_at).toBeNull();
      const tokens = (await a('GET', '/tenants/kopi-a')).body.tokens;
      expect(tokens.find((t: { id: number }) => t.id === issued.body.tokenId).revoked_at).not.toBeNull();
      expect(tokens.find((t: { id: number }) => t.id === first.id).revoked_at).toBeNull();
    });

    it('token tenant lain tidak bisa dicabut lewat tenant yang salah', async () => {
      const made = await a('POST', '/tenants', { tenantId: 'kopi-c', tenantName: 'Kopi C', outletId: 'kopi-c-o', outletName: 'C Pusat' });
      expect(made.status).toBe(201);
      const cTokenId = (await a('GET', '/tenants/kopi-c')).body.tokens[0].id;
      expect((await a('POST', `/tenants/kopi-a/tokens/${cTokenId}/revoke`)).status).toBe(404);
      expect((await a('POST', '/tenants/kopi-c/tokens/abc/revoke')).status).toBe(400);
    });
  });

  it('semua tindakan admin tercatat di audit_log, tanpa token', async () => {
    const r = await h.db.admin.query<{ action: string; actor: string }>("select action, actor from audit_log where action like 'platform.%'");
    expect(new Set(r.rows.map((x) => x.action))).toEqual(
      new Set(['platform.tenant.create', 'platform.outlet.add', 'platform.owner_token.issue', 'platform.token.revoke']),
    );
    expect(r.rows.every((x) => x.actor === 'admin:hendrik')).toBe(true);
    const dump = JSON.stringify((await h.db.admin.query("select detail from audit_log where action like 'platform.%'")).rows);
    expect(dump).not.toMatch(/api_[A-Za-z0-9_-]{20,}|adm_/);
  });

  it('admin pertama dibuat lewat CLI; token hilang diterbitkan ulang dengan rotate dan token lama mati', async () => {
    await expect(createPlatformAdmin(h.db, { id: 'hendrik', name: 'x' })).rejects.toThrow(/--rotate/);
    await expect(createPlatformAdmin(h.db, { id: 'Admin Besar', name: 'x' })).rejects.toThrow(/tidak valid/);
    const old = admin;
    const r = await createPlatformAdmin(h.db, { id: 'hendrik', name: 'Hendrik', rotate: true });
    expect(r.created).toBe(false);
    expect((await a('GET', '/me', undefined, old)).status).toBe(401);
    expect((await a('GET', '/me', undefined, r.token)).status).toBe(200);
    admin = r.token;
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onboard } from '../src/onboard';
import { createHarness, type Harness } from './harness';

describe('onboarding database kosong', () => {
  let h: Harness;
  const opts = { tenantId: 'usahaku', tenantName: 'Usahaku', outletId: 'senopati', outletName: 'Kopi Senopati', ownerId: 'owner', terminals: ['pos-1', 'pos-2'] };

  beforeAll(async () => {
    h = await createHarness(Date.parse('2026-10-07T10:00:00+07:00'));
  });
  afterAll(() => h.close());

  it('membuat tenant, outlet, dan token owner yang langsung bisa dipakai', async () => {
    const r = await onboard(h.db, opts);
    expect(r).toMatchObject({ tenantCreated: true, outletCreated: true });
    expect(r.ownerToken).toMatch(/^api_/);

    expect((await h.http('GET', '/v1/me', r.ownerToken)).body).toMatchObject({ role: 'OWNER', userId: 'owner', tenantId: 'usahaku' });
    const outlets = await h.http('GET', '/v1/outlets', r.ownerToken);
    expect(outlets.body.map((o: { id: string }) => o.id)).toEqual(['senopati']);

    // Owner baru bisa langsung membuat kode pairing sensor.
    const p = await h.http('POST', '/v1/devices/pairing', r.ownerToken, { outletId: 'senopati', kind: 'sensor', terminalId: 'pos-1' });
    expect(p.status).toBe(201);
  });

  it('aman dijalankan ulang: data dibiarkan, token baru terbit, token lama tetap berlaku', async () => {
    const first = await onboard(h.db, { ...opts, tenantId: 'u2', outletId: 'o2' });
    const again = await onboard(h.db, { ...opts, tenantId: 'u2', outletId: 'o2' });
    expect(again).toMatchObject({ tenantCreated: false, outletCreated: false });
    expect(again.ownerToken).not.toBe(first.ownerToken);
    expect((await h.http('GET', '/v1/me', first.ownerToken)).status).toBe(200);
    expect((await h.http('GET', '/v1/me', again.ownerToken)).status).toBe(200);
  });

  it('menolak ID tidak valid dan outlet milik tenant lain', async () => {
    await expect(onboard(h.db, { ...opts, tenantId: 'Usaha Baru' })).rejects.toThrow(/tenant/);
    await expect(onboard(h.db, { ...opts, terminals: ['POS 1'] })).rejects.toThrow(/terminal/);
    await expect(onboard(h.db, { ...opts, tenantId: 'lain', outletId: 'senopati' })).rejects.toThrow(/tenant lain/);
  });
});

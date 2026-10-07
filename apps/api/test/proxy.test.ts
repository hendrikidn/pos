import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

/** Di belakang reverse proxy (nginx/Caddy), pembatas kode pairing harus membedakan pemanggil lewat X-Forwarded-For, bukan memakai IP proxy. */
describe('pembatas percobaan di belakang reverse proxy', () => {
  let h: Harness;
  let port: number;

  beforeAll(async () => {
    h = await createHarness(Date.parse('2026-10-07T10:00:00+07:00'), { trustProxy: 1 });
    port = (h.app.getHttpServer().address() as { port: number }).port;
    await h.admin.createTenant('t1', 'T1');
    await h.admin.createOutlet('t1', 'o1', 'O1');
  });
  afterAll(() => h.close());

  const enroll = async (code: string, forwardedFor: string) =>
    (await fetch(`http://127.0.0.1:${port}/v1/device/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
      body: JSON.stringify({ code }),
    })).status;

  it('penyerang yang salah kode berulang diblokir, pengguna lain dari alamat berbeda tetap bisa', async () => {
    const owner = await h.admin.createApiToken('t1', 'owner', 'OWNER');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push(await enroll(`BAAD-${1000 + i}`, '203.0.113.9'));
    expect(statuses).toContain(429);

    const p = await h.http('POST', '/v1/devices/pairing', owner, { outletId: 'o1', kind: 'sensor', deviceId: 'sensor-sah' });
    expect(await enroll(p.body.code, '203.0.113.9')).toBe(429); // penyerang tetap diblokir
    expect(await enroll(p.body.code, '198.51.100.7')).toBe(201); // pemilik sah dari alamat lain tidak terdampak
  });
});

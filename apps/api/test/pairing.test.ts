import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAIRING_TTL_MS } from '../src/pairing.service';
import { createHarness, type Harness } from './harness';

const T0 = Date.parse('2026-10-02T10:00:00+07:00');

describe('pairing perangkat dengan kode sekali pakai', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let manager: string;
  let otherOwner: string;

  beforeAll(async () => {
    h = await createHarness(T0);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['pos-1'] });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    manager = await h.admin.createApiToken('t1', 'mgr-1', 'MANAGER');
    otherOwner = await h.admin.createApiToken('t2', 'owner-2', 'OWNER');
  });
  afterAll(() => h.close());

  const pair = (token: string, body: unknown) => h.http('POST', '/v1/devices/pairing', token, body);
  const enroll = (code: string, hardwareId?: string) => h.http('POST', '/v1/device/enroll', undefined, { code, hardwareId });

  it('owner membuat kode, sensor menukarnya dengan token yang langsung bisa mengirim event', async () => {
    h.setNow(T0);
    const p = await pair(owner, { outletId: 'o1', kind: 'sensor', deviceId: 'sensor-pos1', terminalId: 'pos-1' });
    expect(p.status).toBe(201);
    expect(p.body.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(p.body).toMatchObject({ deviceId: 'sensor-pos1', kind: 'sensor', outletId: 'o1', terminalId: 'pos-1' });

    const e = await enroll(p.body.code, 'AA:BB:CC:DD:EE:FF');
    expect(e.status).toBe(201);
    expect(e.body).toMatchObject({ deviceId: 'sensor-pos1', kind: 'sensor', outletId: 'o1', terminalId: 'pos-1' });
    expect(e.body.token).toMatch(/^dev_/);

    // Token itu sah: perangkat bisa memanggil endpoint perangkat.
    const res = await h.http('POST', '/v1/events', e.body.token, { events: [] });
    expect(res.status).toBeLessThan(300);

    const list = await h.http('GET', '/v1/devices', owner);
    expect(list.body.find((d: { id: string }) => d.id === 'sensor-pos1')).toMatchObject({ kind: 'sensor', terminal_id: 'pos-1', revoked_at: null });
  });

  it('kode boleh diketik dengan huruf kecil, spasi, atau tanpa tanda hubung', async () => {
    const p = await pair(ops, { outletId: 'o1', kind: 'terminal', deviceId: 'pos-baru' });
    expect(p.status).toBe(201);
    const typed = p.body.code.toLowerCase().replace('-', ' ');
    const e = await enroll(typed);
    expect(e.status).toBe(201);
    expect(e.body.deviceId).toBe('pos-baru');
  });

  it('kode hanya berlaku sekali', async () => {
    const p = await pair(owner, { outletId: 'o1', kind: 'sensor', deviceId: 'sensor-sekali' });
    expect((await enroll(p.body.code)).status).toBe(201);
    const again = await enroll(p.body.code);
    expect(again.status).toBe(400);
    expect(again.body.token).toBeUndefined();
  });

  it('kode kedaluwarsa setelah 15 menit', async () => {
    h.setNow(T0);
    const p = await pair(owner, { outletId: 'o1', kind: 'sensor', deviceId: 'sensor-lambat' });
    h.setNow(T0 + PAIRING_TTL_MS + 1000);
    expect((await enroll(p.body.code)).status).toBe(400);
    // Setelah kedaluwarsa, ID perangkat bisa diberi kode baru.
    h.setNow(T0 + PAIRING_TTL_MS + 2000);
    const p2 = await pair(owner, { outletId: 'o1', kind: 'sensor', deviceId: 'sensor-lambat' });
    expect(p2.status).toBe(201);
    expect((await enroll(p2.body.code)).status).toBe(201);
  });

  it('kode yang dihasilkan tidak bisa ditebak dan kode ngawur ditolak', async () => {
    expect((await enroll('')).status).toBe(400);
    expect((await enroll('AAAA-AAAA')).status).toBe(400);
    expect((await h.http('POST', '/v1/device/enroll', undefined, {})).status).toBe(400);
  });

  it('percobaan kode salah dibatasi', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await enroll(`ZZZZ-${String(1000 + i)}`)).status);
    expect(statuses).toContain(429);
    // Kode yang benar pun ditolak selama pembatasan aktif dari alamat yang sama.
    const p = await pair(owner, { outletId: 'o1', kind: 'sensor', deviceId: 'sensor-diblokir' });
    expect((await enroll(p.body.code)).status).toBe(429);
    // Jendela pembatasan lewat: berjalan lagi.
    h.setNow(T0 + PAIRING_TTL_MS + 2000 + 16 * 60 * 1000);
    const p2 = await pair(owner, { outletId: 'o1', kind: 'sensor', deviceId: 'sensor-sudah-bisa' });
    expect((await enroll(p2.body.code)).status).toBe(201);
  });

  it('hanya OWNER dan OPS yang boleh membuat kode; outlet tenant lain ditolak', async () => {
    expect((await pair(manager, { outletId: 'o1', kind: 'sensor' })).status).toBe(403);
    expect((await h.http('POST', '/v1/devices/pairing', undefined, { outletId: 'o1', kind: 'sensor' })).status).toBe(401);
    expect((await pair(otherOwner, { outletId: 'o1', kind: 'sensor' })).status).toBe(404);
    expect((await pair(owner, { outletId: 'ox', kind: 'sensor' })).status).toBe(404);
  });

  it('masukan tidak valid ditolak', async () => {
    expect((await pair(owner, { kind: 'sensor' })).status).toBe(400);
    expect((await pair(owner, { outletId: 'o1', kind: 'printer' })).status).toBe(400);
    expect((await pair(owner, { outletId: 'o1', kind: 'sensor', deviceId: 'Sensor Besar!' })).status).toBe(400);
    expect((await pair(owner, { outletId: 'o1', kind: 'terminal', terminalId: 'pos-1' })).status).toBe(400);
  });

  it('ID perangkat yang sudah dipakai atau punya kode aktif ditolak', async () => {
    expect((await pair(owner, { outletId: 'o1', kind: 'sensor', deviceId: 'sensor-pos1' })).status).toBe(409);
    expect((await pair(owner, { outletId: 'o1', kind: 'sensor', deviceId: 'sensor-ganda' })).status).toBe(201);
    expect((await pair(ops, { outletId: 'o1', kind: 'sensor', deviceId: 'sensor-ganda' })).status).toBe(409);
  });

  it('tanpa deviceId, server membuatkan ID unik', async () => {
    const a = await pair(owner, { outletId: 'o1', kind: 'sensor' });
    expect(a.status).toBe(201);
    expect(a.body.deviceId).toMatch(/^sensor-o1-\d{4}$/);
  });

  it('daftar kode aktif tidak membocorkan kode, dan kode bisa dibatalkan', async () => {
    const p = await pair(owner, { outletId: 'o1', kind: 'sensor', deviceId: 'sensor-batal' });
    const pending = await h.http('GET', '/v1/devices/pairing', ops);
    expect(pending.status).toBe(200);
    const row = pending.body.find((r: { device_id: string }) => r.device_id === 'sensor-batal');
    expect(row).toMatchObject({ kind: 'sensor', outlet_id: 'o1' });
    expect(JSON.stringify(pending.body)).not.toContain(p.body.code);

    // Tenant lain tidak melihatnya.
    expect((await h.http('GET', '/v1/devices/pairing', otherOwner)).body).toEqual([]);

    expect((await h.http('DELETE', '/v1/devices/pairing/sensor-batal', ops)).status).toBe(200);
    expect((await enroll(p.body.code)).status).toBe(400);
    expect((await h.http('DELETE', '/v1/devices/pairing/sensor-batal', ops)).status).toBe(404);
  });

  it('owner mencabut perangkat: token langsung ditolak, event lama tetap ada', async () => {
    const p = await pair(owner, { outletId: 'o1', kind: 'sensor', deviceId: 'sensor-hilang' });
    const e = await enroll(p.body.code);
    expect((await h.http('POST', '/v1/events', e.body.token, { events: [] })).status).toBeLessThan(300);

    expect((await h.http('POST', '/v1/devices/sensor-hilang/revoke', ops)).status).toBe(403);
    expect((await h.http('POST', '/v1/devices/sensor-hilang/revoke', otherOwner)).status).toBe(404);
    expect((await h.http('POST', '/v1/devices/sensor-hilang/revoke', owner)).status).toBe(201);
    expect((await h.http('POST', '/v1/events', e.body.token, { events: [] })).status).toBe(401);
    expect((await h.http('POST', '/v1/devices/sensor-hilang/revoke', owner)).status).toBe(404);

    const list = await h.http('GET', '/v1/devices', owner);
    expect(list.body.find((d: { id: string }) => d.id === 'sensor-hilang').revoked_at).not.toBeNull();
  });

  it('pembuatan, penukaran, dan pencabutan tercatat di audit_log', async () => {
    const r = await h.db.admin.query<{ action: string }>("select distinct action from audit_log where action like 'device.%' order by action");
    const actions = r.rows.map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['device.pairing.create', 'device.pairing.redeem', 'device.pairing.cancel', 'device.revoke']));
    // Kode polos dan token tidak pernah masuk ke log.
    const dump = JSON.stringify((await h.db.admin.query('select detail from audit_log')).rows);
    expect(dump).not.toMatch(/dev_[A-Za-z0-9_-]{20,}/);
  });
});

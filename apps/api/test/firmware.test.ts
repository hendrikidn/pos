import { createHash, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformAdmin } from '../src/onboard';
import { fwCanonical } from '../src/firmware.service';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const T0 = Date.parse('2026-10-08T10:00:00+07:00');

/** Citra ESP palsu: kepala berbyte 0xE9 dan chip id ESP32-C3 (5) di offset 12. */
export function fakeImage(size = 120_000, chip = 5, fill = 0x33): Buffer {
  const b = Buffer.alloc(size, fill);
  b[0] = 0xe9;
  b.writeUInt16LE(chip, 12);
  return b;
}

describe('distribusi firmware (OTA)', () => {
  let h: Harness;
  let admin: string;
  let owner: string;
  let releasePriv: KeyObject;
  let other: KeyObject;
  let sensor: string;
  let tick = T0;
  const base = () => (h.app.getHttpServer().address() as { port: number }).port;

  const publish = (over: Record<string, unknown> = {}, tok: string | undefined | null = admin, image = fakeImage(), key: KeyObject = releasePriv) => {
    const meta = { board: 'esp32c3', channel: 'stable', version: '1.0.1', build: 2, size: image.length, sha256: createHash('sha256').update(image).digest('hex'), ...over } as Parameters<typeof fwCanonical>[0];
    const signature = nodeSign('sha256', Buffer.from(fwCanonical(meta)), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return h.http('POST', '/v1/admin/firmware', tok ?? undefined, { board: meta.board, channel: meta.channel, version: meta.version, build: meta.build, notes: 'uji', binary: image.toString('base64'), signature, ...over });
  };
  const latest = (q: string) => h.http('GET', `/v1/public/firmware/latest?${q}`);

  beforeAll(async () => {
    const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    releasePriv = kp.privateKey;
    other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    process.env['FIRMWARE_RELEASE_PUBKEY'] = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    h = await createHarness(T0);
    admin = (await createPlatformAdmin(h.db, { id: 'hendrik', name: 'Hendrik' })).token;
    await h.admin.createTenant('t1', 'T1');
    await h.admin.createOutlet('t1', 'o1', 'O1', { terminals: ['pos-1'] });
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    sensor = await h.admin.createDevice('t1', 'o1', 'sensor-1', 'sensor');
  });
  afterAll(async () => { delete process.env['FIRMWARE_RELEASE_PUBKEY']; await h.close(); });

  it('tanpa kunci rilis di server, unggahan dinonaktifkan (503)', async () => {
    const keep = process.env['FIRMWARE_RELEASE_PUBKEY']!;
    delete process.env['FIRMWARE_RELEASE_PUBKEY'];
    expect((await publish({ build: 1 })).status).toBe(503);
    process.env['FIRMWARE_RELEASE_PUBKEY'] = keep;
  });

  it('hanya admin platform yang mengunggah, melihat daftar, dan menarik rilis', async () => {
    expect((await publish({}, null)).status).toBe(401);
    expect((await publish({}, owner)).status).toBe(403);
    expect((await h.http('GET', '/v1/admin/firmware', owner)).status).toBe(403);
    expect((await h.http('POST', '/v1/admin/firmware/1/revoke', owner, { reason: 'uji' })).status).toBe(403);
    expect((await h.http('GET', '/v1/admin/firmware')).status).toBe(401);
  });

  it('rilis sah diterima; daftar tidak memuat berkas; sha256 dan ukuran dihitung server', async () => {
    const img = fakeImage(150_000);
    const r = await publish({ build: 2, version: '1.0.1' }, admin, img);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ size: 150_000, sha256: createHash('sha256').update(img).digest('hex') });
    const list = (await h.http('GET', '/v1/admin/firmware', admin)).body as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ board: 'esp32c3', channel: 'stable', version: '1.0.1', build: 2, createdBy: 'hendrik', revokedAt: null });
    expect(Object.keys(list[0]!)).not.toContain('data');
  });

  it('menolak: tanda tangan kunci lain, berkas diubah setelah ditandatangani, kolom diubah, bukan citra ESP, chip salah, ukuran di luar batas, base64 rusak', async () => {
    expect((await publish({ build: 3 }, admin, fakeImage(), other)).status).toBe(400);
    const img = fakeImage();
    const good = await publish({ build: 3 }, admin, img); // dibuat valid dulu untuk mengambil tanda tangannya
    expect(good.status).toBe(201);
    const meta = { board: 'esp32c3', channel: 'stable', version: '1.0.2', build: 4, size: img.length, sha256: createHash('sha256').update(img).digest('hex') };
    const signature = nodeSign('sha256', Buffer.from(fwCanonical(meta)), { key: releasePriv, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const tampered = Buffer.from(img); tampered[5000] = 0x99;
    expect((await h.http('POST', '/v1/admin/firmware', admin, { ...meta, binary: tampered.toString('base64'), signature })).status).toBe(400);
    expect((await h.http('POST', '/v1/admin/firmware', admin, { ...meta, version: '9.9.9', binary: img.toString('base64'), signature })).status).toBe(400);
    expect((await h.http('POST', '/v1/admin/firmware', admin, { ...meta, channel: 'beta', binary: img.toString('base64'), signature })).status).toBe(400);
    const notEsp = fakeImage(); notEsp[0] = 0x7f;
    expect((await publish({ build: 4 }, admin, notEsp)).status).toBe(400);
    expect((await publish({ build: 4 }, admin, fakeImage(120_000, 9))).status).toBe(400); // chip id bukan ESP32-C3
    expect((await publish({ build: 4 }, admin, fakeImage(60_000))).status).toBe(400);
    expect((await publish({ build: 4 }, admin, fakeImage(0x1e0001))).status).toBe(400);
    expect((await h.http('POST', '/v1/admin/firmware', admin, { ...meta, binary: '***', signature })).status).toBe(400);
    expect((await h.http('POST', '/v1/admin/firmware', admin, { ...meta, signature: 'pendek', binary: img.toString('base64') })).status).toBe(400);
    for (const bad of [{ board: 'ESP32 C3' }, { channel: 'x' }, { version: 'a/b' }, { build: 0 }, { build: 1.5 }, { build: 'dua' }]) expect((await publish(bad)).status, JSON.stringify(bad)).toBe(400);
  });

  it('build harus naik per papan dan kanal; kanal dan papan lain berdiri sendiri', async () => {
    expect((await publish({ build: 3 })).status).toBe(409); // sama dengan yang ada
    expect((await publish({ build: 2 })).status).toBe(409); // lebih kecil
    expect((await publish({ build: 1, channel: 'beta', version: '0.9.0' })).status).toBe(201); // kanal lain mulai sendiri
    expect((await publish({ build: 10, board: 'esp32c3', channel: 'stable', version: '1.1.0' })).status).toBe(201);
  });

  it('manifest publik: hanya build lebih baru; kanal baku stable; papan wajib; build tak valid dianggap 0; tidak ada yang bocor', async () => {
    const m = (await latest('board=esp32c3&build=2')).body;
    expect(m).toMatchObject({ update: true, board: 'esp32c3', channel: 'stable', version: '1.1.0', build: 10, size: 120_000 });
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(m.url).toMatch(/^\/v1\/public\/firmware\/\d+\/download$/);
    expect(Object.keys(m).sort()).toEqual(['board', 'build', 'channel', 'notes', 'sha256', 'signature', 'size', 'update', 'url', 'version']);
    expect((await latest('board=esp32c3&build=10')).body).toEqual({ update: false });
    expect((await latest('board=esp32c3&build=11')).body).toEqual({ update: false });
    expect((await latest('board=esp32c3&build=abc')).body.update).toBe(true);
    expect((await latest('board=esp32c3&channel=beta&build=0')).body).toMatchObject({ update: true, version: '0.9.0' });
    expect((await latest('board=esp32s3&build=0')).body).toEqual({ update: false });
    expect((await latest('build=0')).status).toBe(400);
    expect((await latest('board=ESP%2032')).status).toBe(400);
  });

  it('unduhan publik: byte sama dengan yang diunggah; id bukan angka 400; tidak ada 404; rilis ditarik 404', async () => {
    const m = (await latest('board=esp32c3&build=2')).body;
    const res = await fetch(`http://127.0.0.1:${base()}${m.url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(m.size);
    expect(createHash('sha256').update(body).digest('hex')).toBe(m.sha256);
    expect((await h.http('GET', '/v1/public/firmware/abc/download')).status).toBe(400);
    expect((await h.http('GET', '/v1/public/firmware/99999/download')).status).toBe(404);
  });

  it('menarik rilis: alasan wajib; tidak ditawarkan lagi dan tidak bisa diunduh; build berikutnya tetap harus lebih besar', async () => {
    const m = (await latest('board=esp32c3&build=2')).body;
    const id = Number(/\/(\d+)\/download/.exec(m.url)![1]);
    expect((await h.http('POST', `/v1/admin/firmware/${id}/revoke`, admin, { reason: '' })).status).toBe(400);
    expect((await h.http('POST', `/v1/admin/firmware/${id}/revoke`, admin, { reason: 'bug radar' })).status).toBe(201);
    expect((await h.http('POST', `/v1/admin/firmware/${id}/revoke`, admin, { reason: 'lagi' })).status).toBe(404);
    expect((await h.http('GET', m.url.replace('/v1', '/v1'))).status).toBe(404);
    expect((await latest('board=esp32c3&build=2')).body).toMatchObject({ update: true, build: 3 }); // jatuh ke rilis aktif berikutnya
    expect((await publish({ build: 10 })).status).toBe(409);
    const rows = (await h.http('GET', '/v1/admin/firmware', admin)).body as { build: number; revokedAt: string | null; revokedReason: string | null }[];
    expect(rows.find((r) => r.build === 10)).toMatchObject({ revokedReason: 'bug radar' });
    expect(rows.find((r) => r.build === 10)!.revokedAt).not.toBeNull();
  });

  it('pembatas laju: pemeriksaan dan unduhan per alamat dibatasi per jam', async () => {
    h.setNow(T0 + 10 * 3_600_000);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await fetch(`http://127.0.0.1:${base()}/v1/public/firmware/1/download`)).status;
    expect(last).toBe(429);
    h.setNow(T0 + 20 * 3_600_000);
    for (let i = 0; i < 121; i++) last = (await latest('board=esp32c3&build=0')).status;
    expect(last).toBe(429);
  });

  it('versi firmware yang berjalan dilaporkan sensor lewat header dan terlihat di daftar perangkat; tidak berlaku untuk jenis lain', async () => {
    h.setNow(T0 + 30 * 3_600_000);
    const s = new Sim('o1', '2026-10-08', 'sensor-1', 'sensor-1');
    s.heartbeat('sensor', '10:00:00');
    const post = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${base()}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sensor}`, ...headers }, body: JSON.stringify({ events: s.events }) });
    expect((await post({ 'x-firmware-build': '7', 'x-firmware-version': '1.0.7' })).status).toBe(201);
    const dev = (await h.http('GET', '/v1/devices', owner)).body.find((d: { id: string }) => d.id === 'sensor-1');
    expect(dev).toMatchObject({ firmware_version: '1.0.7', firmware_build: 7 });
    expect((await post({ 'x-firmware-build': 'x; drop', 'x-firmware-version': '<script>' })).status).toBe(201);
    expect((await h.http('GET', '/v1/devices', owner)).body.find((d: { id: string }) => d.id === 'sensor-1')).toMatchObject({ firmware_version: '1.0.7' }); // header tak sah diabaikan
  });
});

import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fwCanonical } from '../../../apps/api/src/firmware.service';
import { createPlatformAdmin } from '../../../apps/api/src/onboard';
import { createHarness, type Harness } from '../../../apps/api/test/harness';
import { build, hasCompiler } from './helpers';

/**
 * Alur OTA penuh lintas komponen: admin mengunggah rilis ke API sungguhan, lalu kode C inti firmware (yang sama dengan yang berjalan di ESP32)
 * memeriksa manifest dari API dan berkas hasil unduhan. Hanya bagian yang bergantung pada perangkat keras (menulis ke flash) yang tidak tercakup.
 */
describe.skipIf(!hasCompiler)('pembaruan firmware: API sungguhan ↔ verifikasi C inti', () => {
  let h: Harness;
  let admin: string;
  let sigtool: string;
  let releasePub: string;
  const dir = mkdtempSync(join(tmpdir(), 'fw-ota-'));
  const image = Buffer.alloc(200_000, 0x42);
  image[0] = 0xe9;
  image.writeUInt16LE(5, 12);
  const port = () => (h.app.getHttpServer().address() as { port: number }).port;

  beforeAll(async () => {
    sigtool = build()!.sigtool;
    const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    releasePub = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    process.env['FIRMWARE_RELEASE_PUBKEY'] = releasePub;
    h = await createHarness(Date.parse('2026-10-08T10:00:00+07:00'));
    admin = (await createPlatformAdmin(h.db, { id: 'hendrik', name: 'Hendrik' })).token;
    const meta = { board: 'esp32c3', channel: 'stable', version: '1.4.0', build: 14, size: image.length, sha256: createHash('sha256').update(image).digest('hex') };
    const signature = nodeSign('sha256', Buffer.from(fwCanonical(meta)), { key: kp.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const r = await h.http('POST', '/v1/admin/firmware', admin, { ...meta, binary: image.toString('base64'), signature });
    expect(r.status).toBe(201);
  });
  afterAll(async () => { delete process.env['FIRMWARE_RELEASE_PUBKEY']; await h.close(); });

  const c = (...a: (string | number)[]) => execFileSync(sigtool, a.map(String)).toString().trim();
  const manifestFile = async (build = 1) => {
    const res = await fetch(`http://127.0.0.1:${port()}/v1/public/firmware/latest?board=esp32c3&channel=stable&build=${build}`);
    const text = await res.text();
    const p = join(dir, `m-${build}.json`);
    writeFileSync(p, text);
    return { p, json: JSON.parse(text) };
  };

  it('manifest dari API lolos tanda tangan, kelayakan, dan pemeriksaan unduhan di kode C firmware', async () => {
    const { p, json } = await manifestFile(1);
    expect(json.update).toBe(true);
    expect(c('verify', releasePub, p)).toBe('0');
    expect(c('install', p, 'esp32c3', 'stable', 1)).toBe('0');
    const bin = Buffer.from(await (await fetch(`http://127.0.0.1:${port()}${json.url}`)).arrayBuffer());
    const bp = join(dir, 'fw.bin');
    writeFileSync(bp, bin);
    expect(c('download', p, bp)).toBe('0');
  });

  it('firmware menolak: kunci rilis lain, manifest yang diubah penyerang, build sama atau lebih lama, unduhan yang dirusak', async () => {
    const { p, json } = await manifestFile(1);
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(c('verify', other, p)).toBe('-2'); // server palsu yang tanda tangannya bukan dari kunci rilis kita
    const forged = join(dir, 'forged.json');
    writeFileSync(forged, JSON.stringify({ ...json, build: 99, version: '9.9.9' }));
    expect(c('verify', releasePub, forged)).toBe('-2');
    expect(c('install', p, 'esp32c3', 'stable', 14)).toBe('-4');
    expect(c('install', p, 'esp32c3', 'stable', 20)).toBe('-4');
    const evil = Buffer.from(await (await fetch(`http://127.0.0.1:${port()}${json.url}`)).arrayBuffer());
    evil[100_000] = evil[100_000]! ^ 0xff;
    const ep = join(dir, 'evil.bin');
    writeFileSync(ep, evil);
    expect(c('download', p, ep)).toBe('-6');
  });

  it('perangkat yang sudah memakai build terbaru tidak ditawari apa pun', async () => {
    const res = await fetch(`http://127.0.0.1:${port()}/v1/public/firmware/latest?board=esp32c3&channel=stable&build=14`);
    expect(await res.json()).toEqual({ update: false });
  });
});

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformAdmin } from '../../../apps/api/src/onboard';
import { createHarness, type Harness } from '../../../apps/api/test/harness';
import { build, hasCompiler } from './helpers';

const TOOL = resolve(__dirname, '../tools/release.mts');
// Unggah memanggil server di proses yang sama: harus async, kalau tidak server ikut terblokir.
const runAsync = async (...a: string[]) => (await promisify(execFile)('npx', ['tsx', TOOL, ...a], { encoding: 'utf8' })).stdout;
const run = (...a: string[]) => execFileSync('npx', ['tsx', TOOL, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe.skipIf(!hasCompiler)('alat rilis (release.mts): keygen, sign, publish', () => {
  let h: Harness;
  let admin: string;
  const dir = mkdtempSync(join(tmpdir(), 'fw-rel-'));
  const image = Buffer.alloc(150_000, 0x21);
  image[0] = 0xe9;
  image.writeUInt16LE(5, 12);
  const bin = join(dir, 'firmware.bin');
  let pub = '';

  beforeAll(async () => {
    writeFileSync(bin, image);
    run('keygen', dir);
    pub = readFileSync(join(dir, 'release-public.b64'), 'utf8').trim();
    process.env['FIRMWARE_RELEASE_PUBKEY'] = pub;
    h = await createHarness(Date.parse('2026-10-08T10:00:00+07:00'));
    admin = (await createPlatformAdmin(h.db, { id: 'hendrik', name: 'Hendrik' })).token;
  }, 120_000);
  afterAll(async () => { delete process.env['FIRMWARE_RELEASE_PUBKEY']; await h.close(); });
  const server = () => `http://127.0.0.1:${(h.app.getHttpServer().address() as { port: number }).port}`;

  it('keygen: kunci privat hanya bisa dibaca pemilik; kunci publik berupa SPKI P-256', () => {
    expect(statSync(join(dir, 'release-private.pem')).mode & 0o777).toBe(0o600);
    expect(Buffer.from(pub, 'base64')).toHaveLength(91);
  });

  it('sign: metadata dan tanda tangan; menolak berkas yang bukan citra ESP dan papan yang tidak disebut', () => {
    const out = run('sign', bin, '--key', join(dir, 'release-private.pem'), '--board', 'esp32c3', '--version', '1.2.3', '--build', '12', '--notes', 'uji');
    expect(out).toContain('anatta-fw1|esp32c3|stable|1.2.3|12|150000|');
    const meta = JSON.parse(readFileSync(`${bin}.release.json`, 'utf8'));
    expect(meta).toMatchObject({ board: 'esp32c3', channel: 'stable', version: '1.2.3', build: 12, size: 150_000, notes: 'uji' });
    expect(meta.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const text = join(dir, 'bukan.bin');
    writeFileSync(text, Buffer.alloc(100_000, 0x41));
    expect(() => run('sign', text, '--key', join(dir, 'release-private.pem'), '--board', 'esp32c3', '--version', '1', '--build', '1')).toThrow();
    expect(() => run('sign', bin, '--key', join(dir, 'release-private.pem'), '--version', '1', '--build', '1')).toThrow();
  }, 60_000);

  it('hasil sign lolos verifikasi kode C firmware; publish ke API sungguhan diterima, dan menerbitkan ulang build yang sama ditolak', async () => {
    const sigtool = build()!.sigtool;
    // manifest seperti yang akan diumumkan server
    const meta = JSON.parse(readFileSync(`${bin}.release.json`, 'utf8'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify({ ...meta, signature: meta.signature, url: '/v1/public/firmware/1/download' }));
    expect(execFileSync(sigtool, ['verify', pub, join(dir, 'm.json')]).toString().trim()).toBe('0');
    expect(await runAsync('publish', bin, '--server', server(), '--token', admin)).toContain('terunggah: id ');
    await expect(runAsync('publish', bin, '--server', server(), '--token', admin)).rejects.toThrow(); // build sama: 409
    await expect(runAsync('publish', bin, '--server', server(), '--token', 'adm_salah')).rejects.toThrow();
  }, 60_000);
});

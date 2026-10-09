/**
 * Alat rilis firmware sensor (jalankan di komputer Anda, BUKAN di server):
 *
 *   npx tsx firmware/sensor-node/tools/release.mts keygen <folder>
 *       Membuat pasangan kunci rilis ECDSA P-256. Kunci PRIVAT (release-private.pem) tidak boleh masuk repositori atau server; simpan di pengelola
 *       sandi atau perangkat keras. Kunci PUBLIK dicetak untuk OTA_RELEASE_PUBKEY (firmware, app/secrets.h) dan FIRMWARE_RELEASE_PUBKEY (server).
 *
 *   npx tsx firmware/sensor-node/tools/release.mts sign <firmware.bin> --key <release-private.pem> --board esp32c3 --channel stable --version 1.1.0 --build 2 [--notes "teks"]
 *       Menulis <firmware.bin>.release.json berisi metadata dan tanda tangan (tanpa berkas firmware).
 *
 *   npx tsx firmware/sensor-node/tools/release.mts publish <firmware.bin> --server https://anatta-pos.example.com --token adm_... [--code 123456]
 *       Mengunggah ke server (memakai <firmware.bin>.release.json). Bila admin memakai 2FA, beri --code (kode TOTP): alat ini login dulu lalu memakai sesi.
 *
 * Pesan yang ditandatangani HARUS sama dengan fw_canonical() di firmware dan fwCanonical() di server:
 *   anatta-fw1|<board>|<channel>|<versi>|<build>|<ukuran>|<sha256 hex>
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i]!.startsWith('--')) flags.set(rest[i]!.slice(2), rest[++i] ?? '');
  else positional.push(rest[i]!);
}
const need = (k: string) => { const v = flags.get(k); if (!v) { console.error(`--${k} wajib`); process.exit(2); } return v; };
const canonical = (m: { board: string; channel: string; version: string; build: number; size: number; sha256: string }) => `anatta-fw1|${m.board}|${m.channel}|${m.version}|${m.build}|${m.size}|${m.sha256}`;

if (cmd === 'keygen' && positional[0]) {
  const dir = positional[0];
  mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const priv = join(dir, 'release-private.pem');
  writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  chmodSync(priv, 0o600);
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  writeFileSync(join(dir, 'release-public.b64'), `${spki}\n`);
  console.log(`Kunci privat: ${priv}  (SIMPAN AMAN, jangan di server atau repositori)`);
  console.log(`Kunci publik (isi OTA_RELEASE_PUBKEY di firmware dan FIRMWARE_RELEASE_PUBKEY di deploy/.env):\n${spki}`);
} else if (cmd === 'sign' && positional[0]) {
  const data = readFileSync(positional[0]);
  const key = createPrivateKey(readFileSync(need('key')));
  if (createPublicKey(key).asymmetricKeyDetails?.namedCurve !== 'prime256v1') { console.error('kunci harus ECDSA P-256'); process.exit(2); }
  if (data[0] !== 0xe9) { console.error('bukan citra firmware ESP (byte pertama harus 0xE9). Pakai firmware.bin dari .pio/build/<env>/'); process.exit(2); }
  const meta = { board: need('board'), channel: flags.get('channel') ?? 'stable', version: need('version'), build: Number(need('build')), size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  const signature = sign('sha256', Buffer.from(canonical(meta)), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const out = `${positional[0]}.release.json`;
  writeFileSync(out, JSON.stringify({ ...meta, notes: flags.get('notes') ?? '', signature }, null, 2));
  console.log(`${out}\n${canonical(meta)}`);
} else if (cmd === 'publish' && positional[0]) {
  const server = need('server').replace(/\/$/, '');
  let token = need('token');
  const meta = JSON.parse(readFileSync(`${positional[0]}.release.json`, 'utf8'));
  const call = async (path: string, body: unknown, bearer?: string) => {
    const res = await fetch(`${server}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
  };
  if (flags.get('code')) {
    const login = await call('/v1/admin/auth/login', { token, code: flags.get('code') });
    if (login.status !== 201) { console.error('login gagal:', login.body['message']); process.exit(1); }
    token = login.body['token'] as string;
  }
  const r = await call('/v1/admin/firmware', { ...meta, binary: readFileSync(positional[0]).toString('base64') }, token);
  if (r.status !== 201) { console.error(`gagal (${r.status}):`, r.body['message']); process.exit(1); }
  console.log(`terunggah: id ${r.body['id']}, ${r.body['size']} byte, sha256 ${r.body['sha256']}`);
} else {
  console.error('pakai: keygen <folder> | sign <bin> --key ... | publish <bin> --server ... --token ... (lihat komentar di berkas)');
  process.exit(2);
}

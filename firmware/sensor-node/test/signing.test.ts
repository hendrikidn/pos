import { createECDH, createHash, createPublicKey, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashEvent, verifyChain, type PosEvent } from '@pos/events';
import { parsePublicKey, verifySignature } from '../../../apps/api/src/ingest.service';
import { createHarness, type Harness } from '../../../apps/api/test/harness';
import { build, hasCompiler } from './helpers';

const T0 = Date.parse('2026-10-02T10:00:00+07:00');
const SPKI_HEAD = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
let bins: NonNullable<ReturnType<typeof build>>;
let dir: string;

beforeAll(() => {
  if (hasCompiler) bins = build()!;
  dir = mkdtempSync(join(tmpdir(), 'fw-sign-'));
});

const sig = (...args: (string | number)[]) => execFileSync(bins.sigtool, args.map(String)).toString().trim();
const privHex = (seed: number) => Buffer.alloc(32, seed).toString('hex');
/** SPKI base64 yang dihitung Node dari kunci privat mentah (pembanding independen untuk kode C). */
const spkiFromNode = (priv: string) => { const e = createECDH('prime256v1'); e.setPrivateKey(Buffer.from(priv, 'hex')); return Buffer.concat([SPKI_HEAD, e.getPublicKey()]).toString('base64'); };

describe.skipIf(!hasCompiler)('base64 dan SPKI dari kode C inti sama dengan Node', () => {
  it('base64url tanpa padding dan base64 baku dengan padding untuk semua sisa panjang', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 31, 32, 33, 64, 91]) {
      const b = Buffer.from(Array.from({ length: len }, (_, i) => (i * 53 + 7) & 255));
      expect(sig('b64', 'enc', b.toString('hex'))).toBe(b.toString('base64url'));
      expect(sig('b64', 'encstd', b.toString('hex'))).toBe(b.toString('base64'));
      expect(sig('b64', 'dec', b.toString('base64url'))).toBe(b.toString('hex'));
      expect(sig('b64', 'dec', b.toString('base64'))).toBe(b.toString('hex'));
    }
    for (const bad of ['a', 'abc$', 'ab cd', 'a===b']) expect(sig('b64', 'dec', bad)).toBe('ERR');
  });

  it('kunci publik SPKI dari kunci privat sama persis dengan hitungan Node, dan diterima parsePublicKey server', () => {
    for (const seed of [1, 2, 0x7f, 0xab]) {
      const spki = sig('pub', privHex(seed));
      expect(spki).toBe(spkiFromNode(privHex(seed)));
      expect(parsePublicKey(spki)).not.toBeNull();
    }
  });
});

describe.skipIf(!hasCompiler)('event bertanda tangan dari firmware', () => {
  const events = (seed: number, seq = 0, prev = '-', n = 9, device = 'sensor-sen') => {
    const lines = sig('events', privHex(seed), device, 'o1', seq, prev, n, T0, 'pos-1').split('\n');
    const [, s, h] = lines.pop()!.split(' ');
    return { events: lines.map((l) => JSON.parse(l) as PosEvent & { sig?: string }), seq: Number(s), hash: h! };
  };

  it('setiap event membawa sig base64url 64 byte yang sah menurut verifySignature server, dan hash tidak berubah', () => {
    const key = parsePublicKey(sig('pub', privHex(1)))!;
    const { events: ev } = events(1);
    expect(ev).toHaveLength(9);
    for (const e of ev) {
      expect(e.sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
      expect(verifySignature(key, e.hash, e.sig!)).toBe(true);
      const { hash, sig: _s, ...rest } = e;
      expect(hashEvent(rest as Parameters<typeof hashEvent>[0])).toBe(hash); // tanda tangan di luar hash
    }
    expect(verifyChain(ev)).toEqual([]);
  });

  it('tanda tangan tidak sah untuk kunci lain, untuk hash yang diubah, atau yang dipotong', () => {
    const other = parsePublicKey(sig('pub', privHex(2)))!;
    const mine = parsePublicKey(sig('pub', privHex(1)))!;
    const e = events(1).events[0]!;
    expect(verifySignature(other, e.hash, e.sig!)).toBe(false);
    expect(verifySignature(mine, `${e.hash.slice(0, 63)}0`, e.sig!)).toBe(false);
    expect(verifySignature(mine, e.hash, e.sig!.slice(0, 80))).toBe(false);
  });

  it('penanda tangan gagal: event tidak dibuat dan rantai tidak maju (tidak pernah ada event tanpa tanda tangan)', () => {
    expect(sig('signfail')).toBe(`-1 5 ${'0'.repeat(64)}`);
  });

  describe('ke API sungguhan', () => {
    let h: Harness;
    let token: string;
    beforeAll(async () => {
      h = await createHarness(T0 + 3_600_000);
      await h.admin.createTenant('t1', 'Tenant 1');
      await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['pos-1'] });
      token = await h.admin.createDevice('t1', 'o1', 'sensor-sen', 'sensor');
    });
    afterAll(() => h.close());
    const kinds = (r: { body: { issues: { kind: string }[] } }) => r.body.issues.map((i) => i.kind);

    it('sebelum kunci didaftarkan, event bertanda tangan tetap diterima tanpa masalah (tanda tangan baru diperiksa setelah kunci terdaftar)', async () => {
      const a = events(1, 0, '-', 6);
      const r = await h.postEvents(token, a.events);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ accepted: 6, issues: [] });
    });

    it('mendaftarkan kunci publik buatan firmware lewat POST /v1/device/key; kunci berbeda ditolak sampai owner mengatur ulang', async () => {
      const ok = await h.http('POST', '/v1/device/key', token, { publicKey: sig('pub', privHex(1)) });
      expect(ok.status).toBe(201);
      expect(ok.body).toEqual({ enrolled: true, alreadyEnrolled: false });
      expect((await h.http('POST', '/v1/device/key', token, { publicKey: sig('pub', privHex(1)) })).body.alreadyEnrolled).toBe(true);
      expect((await h.http('POST', '/v1/device/key', token, { publicKey: sig('pub', privHex(2)) })).status).toBe(409);
    });

    it('setelah terdaftar: event bertanda tangan sah diterima bersih; tanpa tanda tangan dan dengan kunci lain ditandai', async () => {
      const last = (await h.db.admin.query<{ last_seq: number; last_hash: string }>("select last_seq, last_hash from device where id = 'sensor-sen'")).rows[0]!;
      const good = events(1, last.last_seq, last.last_hash, 4);
      const r1 = await h.postEvents(token, good.events);
      expect(r1.body).toMatchObject({ accepted: 4, issues: [] });
      // tanpa tanda tangan (firmware lama atau pemalsu yang hanya tahu token)
      const unsigned = execFileSync(bins.genEvents, ['sensor-sen', 'o1', String(good.seq), good.hash, '2', String(T0 + 900_000), '0', 'pos-1']).toString().trim().split('\n');
      unsigned.pop();
      const r2 = await h.postEvents(token, unsigned.map((l) => JSON.parse(l)));
      expect(kinds(r2)).toEqual(['MISSING_SIGNATURE', 'MISSING_SIGNATURE']);
      // ditandatangani kunci lain
      const prev = (await h.db.admin.query<{ last_seq: number; last_hash: string }>("select last_seq, last_hash from device where id = 'sensor-sen'")).rows[0]!;
      const forged = events(2, prev.last_seq, prev.last_hash, 2);
      expect(kinds(await h.postEvents(token, forged.events))).toEqual(['BAD_SIGNATURE', 'BAD_SIGNATURE']);
    });
  });
});

describe.skipIf(!hasCompiler)('manifest firmware: tanda tangan rilis, anti-downgrade, dan verifikasi unduhan', () => {
  let releasePriv: KeyObject;
  let releasePubB64: string;
  const BIN = Buffer.alloc(300_000, 0x5a);
  const sha = createHash('sha256').update(BIN).digest('hex');
  const manifest = (over: Record<string, unknown> = {}, signWith: KeyObject = releasePriv) => {
    const m = { board: 'esp32c3', channel: 'stable', version: '1.2.0', build: 7, size: BIN.length, sha256: sha, url: '/v1/public/firmware/3/download', ...over } as Record<string, string | number>;
    const canon = `anatta-fw1|${m['board']}|${m['channel']}|${m['version']}|${m['build']}|${m['size']}|${m['sha256']}`;
    const signature = over['signature'] ?? nodeSign('sha256', Buffer.from(canon), { key: signWith, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return { ...m, signature };
  };
  const file = (m: unknown, name = 'm.json') => { const p = join(dir, `${Math.random().toString(36).slice(2)}-${name}`); writeFileSync(p, typeof m === 'string' ? m : JSON.stringify(m)); return p; };

  beforeAll(() => {
    const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    releasePriv = kp.privateKey;
    releasePubB64 = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  });

  it('manifest yang ditandatangani Node (kunci rilis) lolos verifikasi di kode C; kunci publik lain dan kunci rusak ditolak', () => {
    const p = file(manifest());
    expect(sig('verify', releasePubB64, p)).toBe('0');
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(sig('verify', other, p)).toBe('-2');
    expect(sig('verify', 'bukan-kunci', p)).toBe('-7');
    expect(sig('verify', releasePubB64.slice(0, 60), p)).toBe('-7');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(sig('verify', rsa, p)).toBe('-7');
  });

  it('mengubah satu kolom apa pun yang ditandatangani (papan, kanal, versi, build, ukuran, sha256) membatalkan tanda tangan', () => {
    const good = manifest();
    for (const [k, v] of [['board', 'esp32s3'], ['channel', 'beta'], ['version', '9.9.9'], ['build', 99], ['size', BIN.length + 1], ['sha256', 'f'.repeat(64)]] as const) {
      expect(sig('verify', releasePubB64, file({ ...good, [k]: v })), k).toBe('-2');
    }
    expect(sig('verify', releasePubB64, file({ ...good, url: '/v1/public/firmware/9/download' }))).toBe('0'); // url bukan bagian tanda tangan; keamanannya dari sha256 yang ditandatangani
  });

  it('tanda tangan dari kunci lain, terpotong, atau bukan base64 ditolak', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    expect(sig('verify', releasePubB64, file(manifest({}, other)))).toBe('-2');
    expect(sig('verify', releasePubB64, file(manifest({ signature: 'abc' })))).toBe('-2');
    expect(sig('verify', releasePubB64, file(manifest({ signature: '!'.repeat(86) })))).toBe('-2');
  });

  it('format: kolom hilang, sha256 salah panjang, url bukan jalur lokal, teks berisi escape atau kutip, build nol atau di luar 32 bit', () => {
    const good = manifest();
    for (const drop of ['board', 'channel', 'version', 'build', 'size', 'sha256', 'signature', 'url']) {
      const { [drop]: _x, ...rest } = good as Record<string, unknown>;
      expect(sig('verify', releasePubB64, file(rest)), drop).toBe('-1');
    }
    for (const over of [{ sha256: 'abc' }, { sha256: 'G'.repeat(64) }, { url: 'https://jahat.example/x.bin' }, { url: 'x' }, { build: 0 }, { build: 4294967296 }, { board: 'esp 32' }, { version: '1.0/../x' }]) {
      expect(sig('verify', releasePubB64, file({ ...good, ...over })), JSON.stringify(over)).toBe('-1');
    }
    expect(sig('verify', releasePubB64, file('{"board":"esp32c3\\"x"}'))).toBe('-1');
    expect(sig('verify', releasePubB64, file('bukan json'))).toBe('-1');
  });

  it('layak dipasang: hanya build LEBIH BARU untuk papan dan kanal yang sama, ukuran wajar (anti-downgrade)', () => {
    const p = file(manifest());
    expect(sig('install', p, 'esp32c3', 'stable', 6)).toBe('0');
    expect(sig('install', p, 'esp32c3', 'stable', 7)).toBe('-4'); // build sama
    expect(sig('install', p, 'esp32c3', 'stable', 8)).toBe('-4'); // downgrade
    expect(sig('install', p, 'esp32s3', 'stable', 1)).toBe('-3');
    expect(sig('install', p, 'esp32c3', 'beta', 1)).toBe('-3');
    expect(sig('install', file(manifest({ size: 1000 })), 'esp32c3', 'stable', 1)).toBe('-5');
    expect(sig('install', file(manifest({ size: 0x1E0001 })), 'esp32c3', 'stable', 1)).toBe('-5');
  });

  it('unduhan diperiksa: berkas utuh lolos; satu byte berubah (-6) atau terpotong (-5) ditolak', () => {
    const p = file(manifest());
    const bin = (b: Buffer) => { const f = join(dir, `${Math.random().toString(36).slice(2)}.bin`); writeFileSync(f, b); return f; };
    expect(sig('download', p, bin(BIN))).toBe('0');
    const flipped = Buffer.from(BIN); flipped[150_000] = flipped[150_000]! ^ 1;
    expect(sig('download', p, bin(flipped))).toBe('-6');
    expect(sig('download', p, bin(BIN.subarray(0, BIN.length - 1)))).toBe('-5');
    expect(sig('download', p, bin(Buffer.concat([BIN, Buffer.from([0])])))).toBe('-5');
  });

  it('createPublicKey dan kunci rilis hasil Node cocok dengan jalur verifikasi C untuk banyak tanda tangan acak', () => {
    for (let i = 0; i < 25; i++) {
      const p = file(manifest({ build: 100 + i, version: `2.0.${i}` }));
      expect(sig('verify', releasePubB64, p)).toBe('0');
    }
    expect(createPublicKey({ key: Buffer.from(releasePubB64, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType).toBe('ec');
  });
});

import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventChain } from '@pos/events';
import { MemoryStore, Recorder, SyncClient, WebCryptoSigner, type KeyPairHolder } from '@pos/pos-core';
import { createHarness, type Harness } from './harness';

const T0 = Date.parse('2026-10-02T10:00:00+07:00');
const holder = (): KeyPairHolder => {
  let pair: CryptoKeyPair | undefined;
  return { load: async () => pair, save: async (p) => { pair = p; } };
};

describe('kunci perangkat dan tanda tangan event', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let baseUrl: string;
  let now = T0;

  beforeAll(async () => {
    h = await createHarness(T0);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['pos-1', 'pos-2'] });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    baseUrl = `http://127.0.0.1:${(h.app.getHttpServer().address() as { port: number }).port}`;
  });
  afterAll(() => h.close());

  async function terminal(id: string) {
    const token = await h.admin.createDevice('t1', 'o1', id, 'terminal');
    const signer = await WebCryptoSigner.create(holder());
    const recorder = new Recorder({ deviceId: id, outletId: 'o1', store: new MemoryStore(), now: () => now, signer });
    await recorder.init();
    const sync = new SyncClient(recorder, { baseUrl, token, now: () => now });
    return { token, signer, recorder, sync };
  }
  const beat = (r: Recorder) => r.record({ type: 'device.heartbeat', payload: { kind: 'terminal' } });
  const issueKinds = (r: { body: { issues: { kind: string }[] } }) => r.body.issues.map((i) => i.kind);

  it('POS menandatangani, mendaftarkan kunci, dan event diterima tanpa masalah', async () => {
    const t = await terminal('pos-1');
    for (let i = 0; i < 4; i++) await beat(t.recorder);
    const r = await t.sync.flush();
    expect(r).toMatchObject({ ok: true, sent: 4, remaining: 0, issues: [] });
    const stored = await h.db.tenantTx('t1', async (q) =>
      (await q.query<{ sig: string | null }>("select sig from event where device_id = 'pos-1'")).rows,
    );
    expect(stored.every((e) => !!e.sig)).toBe(true);
    const devices = (await h.http('GET', '/v1/devices', owner)).body as { id: string; key_enrolled: boolean }[];
    expect(devices.find((d) => d.id === 'pos-1')!.key_enrolled).toBe(true);
  });

  it('event yang direkam offline (sudah bertanda tangan) tetap sah setelah kunci didaftarkan saat tersambung', async () => {
    const t = await terminal('pos-2');
    for (let i = 0; i < 3; i++) await beat(t.recorder); // direkam sebelum kunci terdaftar di server
    expect(await t.sync.flush()).toMatchObject({ ok: true, sent: 3, issues: [] });
  });

  describe('server menuntut tanda tangan setelah kunci terdaftar', () => {
    let token: string;
    let signer: WebCryptoSigner;
    let chain: EventChain;

    beforeAll(async () => {
      token = await h.admin.createDevice('t1', 'o1', 'pos-3', 'terminal');
      signer = await WebCryptoSigner.create(holder());
      expect((await h.http('POST', '/v1/device/key', token, { publicKey: await signer.publicKey() })).status).toBe(201);
      chain = new EventChain('pos-3', 'o1');
    });

    const ev = () => chain.append({ type: 'device.heartbeat', deviceTime: T0, payload: { kind: 'terminal' } });

    it('tanpa tanda tangan: MISSING_SIGNATURE, event tetap disimpan sebagai bukti', async () => {
      const r = await h.postEvents(token, [ev()]);
      expect(issueKinds(r)).toEqual(['MISSING_SIGNATURE']);
      expect(r.body.accepted).toBe(1);
    });

    it('tanda tangan palsu atau dari kunci lain: BAD_SIGNATURE', async () => {
      const other = await WebCryptoSigner.create(holder());
      const e1 = ev();
      e1.sig = await other.sign(e1.hash);
      const e2 = ev();
      e2.sig = 'A'.repeat(86);
      const r = await h.postEvents(token, [e1, e2]);
      expect(issueKinds(r)).toEqual(['BAD_SIGNATURE', 'BAD_SIGNATURE']);
    });

    it('tanda tangan atas hash yang berbeda (event diubah setelah ditandatangani) ditolak', async () => {
      const a = ev();
      const b = ev();
      b.sig = await signer.sign(a.hash); // tanda tangan event lain
      expect(issueKinds(await h.postEvents(token, [a, b]))).toEqual(expect.arrayContaining(['BAD_SIGNATURE']));
    });

    it('tanda tangan sah diterima', async () => {
      const e = ev();
      e.sig = await signer.sign(e.hash);
      const r = await h.postEvents(token, [e]);
      expect(r.body.issues).toEqual([]);
    });

    it('pelanggaran tanda tangan menjadi insiden R24', async () => {
      h.setNow(T0 + 3_600_000);
      await h.http('POST', '/v1/outlets/o1/evaluate', owner);
      const list = (await h.http('GET', '/v1/outlets/o1/incidents', owner)).body as { hits: { rule: string; note: string }[] }[];
      const notes = list.flatMap((i) => i.hits).filter((x) => x.rule === 'R24').map((x) => x.note);
      expect(notes.some((n) => n.includes('MISSING_SIGNATURE'))).toBe(true);
      expect(notes.some((n) => n.includes('BAD_SIGNATURE'))).toBe(true);
    });
  });

  describe('pendaftaran dan pengaturan ulang kunci', () => {
    it('menolak kunci yang bukan ECDSA P-256 atau bukan kunci sama sekali', async () => {
      const token = await h.admin.createDevice('t1', 'o1', 'pos-4', 'terminal');
      const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      for (const bad of [rsa, p384, 'bukan-kunci', '', 123]) {
        expect((await h.http('POST', '/v1/device/key', token, { publicKey: bad })).status).toBe(400);
      }
    });

    it('idempoten untuk kunci yang sama; kunci berbeda ditolak (409)', async () => {
      const token = await h.admin.createDevice('t1', 'o1', 'pos-5', 'terminal');
      const a = await (await WebCryptoSigner.create(holder())).publicKey();
      const b = await (await WebCryptoSigner.create(holder())).publicKey();
      expect((await h.http('POST', '/v1/device/key', token, { publicKey: a })).body).toMatchObject({ enrolled: true, alreadyEnrolled: false });
      expect((await h.http('POST', '/v1/device/key', token, { publicKey: a })).body).toMatchObject({ alreadyEnrolled: true });
      expect((await h.http('POST', '/v1/device/key', token, { publicKey: b })).status).toBe(409);
    });

    it('pencuri token tidak bisa menimpa kunci yang sudah ada; owner dapat mengatur ulang dan tercatat di audit', async () => {
      const token = await h.admin.createDevice('t1', 'o1', 'pos-6', 'terminal');
      const a = await (await WebCryptoSigner.create(holder())).publicKey();
      const b = await (await WebCryptoSigner.create(holder())).publicKey();
      await h.http('POST', '/v1/device/key', token, { publicKey: a });
      expect((await h.http('POST', '/v1/device/key', token, { publicKey: b })).status).toBe(409);

      expect((await h.http('POST', '/v1/devices/pos-6/key/reset', ops)).status).toBe(403);
      expect((await h.http('POST', '/v1/devices/pos-6/key/reset', owner)).status).toBe(201);
      expect((await h.http('POST', '/v1/device/key', token, { publicKey: b })).body).toMatchObject({ enrolled: true, alreadyEnrolled: false });

      const audit = (await h.db.admin.query<{ action: string }>("select action from audit_log where action like 'device.key.%' order by id")).rows.map((r) => r.action);
      expect(audit).toEqual(expect.arrayContaining(['device.key.enroll', 'device.key.reset']));
    });

    it('SyncClient melaporkan konflik kunci dengan pesan yang bisa ditindaklanjuti', async () => {
      const token = await h.admin.createDevice('t1', 'o1', 'pos-7', 'terminal');
      await h.http('POST', '/v1/device/key', token, { publicKey: await (await WebCryptoSigner.create(holder())).publicKey() }); // kunci lama
      const signer = await WebCryptoSigner.create(holder()); // aplikasi dipasang ulang: kunci baru
      const recorder = new Recorder({ deviceId: 'pos-7', outletId: 'o1', store: new MemoryStore(), now: () => now, signer });
      await recorder.init();
      await beat(recorder);
      const r = await new SyncClient(recorder, { baseUrl, token, now: () => now }).flush();
      expect(r).toMatchObject({ ok: false, reason: 'enrollment' });
      expect(await recorder.pendingCount()).toBe(1); // event tidak dibuang
    });

    it('sensor boleh mendaftarkan kunci, tetapi kunci perangkat tenant lain tidak bisa diatur ulang', async () => {
      const sensor = await h.admin.createDevice('t1', 'o1', 'sensor-9', 'sensor');
      const k = await (await WebCryptoSigner.create(holder())).publicKey();
      expect((await h.http('POST', '/v1/device/key', sensor, { publicKey: k })).status).toBe(201);
      const ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
      expect((await h.http('POST', '/v1/devices/sensor-9/key/reset', ownerB)).status).toBe(404);
      expect((await h.http('GET', '/v1/devices', ownerB)).body).toEqual([]);
    });
  });

  describe('postur perangkat', () => {
    it('event device.posture divalidasi dan postur tidak aman menjadi hit R29', async () => {
      const token = await h.admin.createDevice('t1', 'o1', 'pos-8', 'terminal');
      const c = new EventChain('pos-8', 'o1');
      const posture = (p: object, at: number) => c.append({ type: 'device.posture', deviceTime: at, payload: { autoTime: true, adb: false, devOptions: false, kiosk: true, rooted: false, appVersion: '1.0.0', ...p } });
      const bad = await h.postEvents(token, [{ ...posture({}, T0), payload: { autoTime: 'ya' } } as never]);
      expect(bad.status).toBe(400);

      const c2 = new EventChain('pos-8', 'o1');
      const ok = [
        c2.append({ type: 'device.posture', deviceTime: T0 + 3_600_000, payload: { autoTime: true, adb: false, devOptions: false, kiosk: true, rooted: false, appVersion: '1.0.0' } }),
        c2.append({ type: 'device.posture', deviceTime: T0 + 3_700_000, payload: { autoTime: false, adb: true, devOptions: true, kiosk: true, rooted: false, appVersion: '1.0.0' } }),
      ];
      h.setNow(T0 + 4_000_000);
      expect((await h.postEvents(token, ok)).status).toBe(201);
      const list = (await h.http('GET', '/v1/outlets/o1/incidents', owner)).body as { hits: { rule: string; note: string }[] }[];
      const notes = list.flatMap((i) => i.hits).filter((x) => x.rule === 'R29').map((x) => x.note);
      expect(notes.some((n) => /waktu otomatis dimatikan/.test(n))).toBe(true);
      expect(notes.some((n) => /USB debugging/.test(n))).toBe(true);
      expect(notes.length).toBe(2); // postur aman (event pertama) tidak menghasilkan hit
    });
  });
});

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const jpeg = (seed: number, size = 400) => { const b = Buffer.alloc(size, seed); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return b; };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('foto saat absen', () => {
  let h: Harness;
  let owner: string;
  let ops: string;
  let rina: string;
  let ownerB: string;
  let term: string;
  let kds: string;
  let sim: Sim;
  let sent = 0;

  const post = (path: string, tok: string | undefined, body?: unknown) => h.http('POST', path, tok, body ?? {});
  const get = (path: string, tok = owner) => h.http('GET', path, tok);
  const upload = (b: Buffer, tok = term, hash = sha(b)) => post('/v1/attendance/photos', tok, { hash, data: b.toString('base64') });
  const flush = async () => { const r = await h.postEvents(term, sim.events.slice(sent)); sent = sim.events.length; return r; };
  const clock = (kind: 'IN' | 'OUT', at: string, actor: string, extra: Record<string, unknown> = {}) => sim.pos({ type: 'attendance.clocked', payload: { kind, ...extra } } as never, WIB(at), actor);
  const hits = async (rule: string) => {
    const seen = new Map<string, { note: string; weight: number }>();
    for (const tok of [owner, ops, rina]) for (const i of (await get('/v1/outlets/o1/incidents', tok)).body as { hits: { rule: string; note: string; weight: number }[] }[]) for (const x of i.hits) if (x.rule === rule) seen.set(x.note, x);
    return [...seen.values()];
  };

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-08T10:00:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    rina = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    kds = await h.admin.createDevice('t1', 'o1', 'kds-1', 'kds');
    for (const [id, name, pin] of [['budi', 'Budi', '4827'], ['sari', 'Sari', '5930']]) expect((await post('/v1/staff', owner, { id, name, role: 'CASHIER', pin })).status).toBe(201);
    sim = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
  });
  afterAll(() => h.close());

  it('pengaturan: hanya OWNER; terminal menerimanya di konfigurasi bila aktif', async () => {
    expect((await h.http('PUT', '/v1/outlets/o1/settings', rina, { attendancePhoto: true })).status).toBe(403);
    expect((await h.http('PUT', '/v1/outlets/o1/settings', owner, { attendancePhoto: 'ya' })).status).toBe(400);
    expect((await get('/v1/device/config', term)).body.outlet.attendancePhoto).toBeUndefined();
    expect((await h.http('PUT', '/v1/outlets/o1/settings', owner, { attendancePhoto: true })).status).toBe(200);
    expect((await get('/v1/device/config', term)).body.outlet.attendancePhoto).toBe(true);
    expect((await get('/v1/outlets/o1/settings', owner)).body.attendance_photo).toBe(true);
  });

  it('unggah: hanya terminal; JPEG sah dengan sidik jari cocok; ukuran dibatasi; idempoten', async () => {
    const a = jpeg(1);
    expect((await upload(a, kds)).status).toBe(403);
    expect((await upload(a, owner)).status).toBe(403);
    expect((await post('/v1/attendance/photos', term, { hash: 'x', data: a.toString('base64') })).status).toBe(400);
    expect((await post('/v1/attendance/photos', term, { hash: sha(a), data: '' })).status).toBe(400);
    expect((await post('/v1/attendance/photos', term, { hash: sha(a), data: '***' })).status).toBe(400);
    expect((await upload(a, term, sha(jpeg(2)))).status).toBe(400); // sidik jari tidak cocok
    const png = Buffer.alloc(400, 3); png[0] = 0x89; png[1] = 0x50;
    expect((await upload(png)).status).toBe(400); // bukan JPEG
    expect((await upload(jpeg(4, 99))).status).toBe(400); // terlalu kecil untuk foto
    expect((await upload(jpeg(5, 150_001))).status).toBe(400); // terlalu besar
    expect((await upload(a)).body).toEqual({ stored: true });
    expect((await upload(a)).body).toEqual({ stored: false }); // sama: diterima tanpa efek
  });

  it('lihat: hanya OWNER dan MANAGER; tenant lain dan hash tak dikenal 404; tercatat di audit', async () => {
    const a = jpeg(1);
    const r = await h.raw(`/v1/outlets/o1/attendance-photos/${sha(a)}`, owner);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(r.headers.get('cache-control')).toContain('private');
    expect((await h.raw(`/v1/outlets/o1/attendance-photos/${sha(a)}`, rina)).status).toBe(200);
    expect((await h.raw(`/v1/outlets/o1/attendance-photos/${sha(a)}`, ops)).status).toBe(403);
    expect((await h.raw(`/v1/outlets/o1/attendance-photos/${sha(a)}`, term)).status).toBe(403);
    expect((await h.raw(`/v1/outlets/o1/attendance-photos/${sha(a)}`, ownerB)).status).toBe(404);
    expect((await h.raw(`/v1/outlets/o1/attendance-photos/${sha(jpeg(9))}`, owner)).status).toBe(404);
    expect((await h.raw('/v1/outlets/o1/attendance-photos/bukan-hash', owner)).status).toBe(404);
    expect((await h.db.admin.query("select 1 from audit_log where action = 'attendance.photo.view'")).rowCount).toBe(2);
  });

  it('ingest: photo wajib sidik jari 64 hex dan ukuran sah; photoMissing salah satu alasan; tidak boleh bersamaan', async () => {
    const s = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
    const bad = async (payload: unknown) => expect((await h.postEvents(term, [s.pos({ type: 'attendance.clocked', payload } as never, WIB('2026-10-08T09:00:00'), 'budi')])).status).toBe(400);
    await bad({ kind: 'IN', photo: { hash: 'abc', bytes: 100 } });
    await bad({ kind: 'IN', photo: { hash: sha(jpeg(1)), bytes: 0 } });
    await bad({ kind: 'IN', photo: { hash: sha(jpeg(1)), bytes: 300_000 } });
    await bad({ kind: 'IN', photo: 'x' });
    await bad({ kind: 'IN', photoMissing: 'MALAS' });
    await bad({ kind: 'IN', photo: { hash: sha(jpeg(1)), bytes: 400 }, photoMissing: 'ERROR' });
  });

  it('absensi di dashboard memuat sidik jari foto masuk dan pulang, atau alasan tidak ada', async () => {
    const a = jpeg(1);
    const b = jpeg(6);
    expect((await upload(b)).status).toBe(201);
    clock('IN', '2026-10-08T08:00:00', 'budi', { photo: { hash: sha(a), bytes: a.length } });
    clock('OUT', '2026-10-08T09:30:00', 'budi', { photo: { hash: sha(b), bytes: b.length } });
    clock('IN', '2026-10-08T08:10:00', 'sari', { photoMissing: 'DENIED' });
    expect((await flush()).status).toBe(201);
    h.setNow(WIB('2026-10-08T10:00:00'));
    const v = (await get('/v1/outlets/o1/hr/attendance?from=2026-10-08&to=2026-10-08')).body;
    expect(v.rows[0]).toMatchObject({ staffId: 'budi', inPhoto: sha(a), outPhoto: sha(b), inMissing: null, outMissing: null });
    expect(v.open[0]).toMatchObject({ staffId: 'sari', inPhoto: null, inMissing: 'DENIED' });
  });

  it('R56 dan R57: tanpa foto padahal wajib, foto tidak pernah terunggah, dan foto yang sama dipakai dua staf', async () => {
    const a = jpeg(1);
    const ghost = jpeg(7); // tidak pernah diunggah
    clock('OUT', '2026-10-08T09:40:00', 'sari'); // tanpa foto sama sekali
    clock('IN', '2026-10-08T09:50:00', 'sari', { photo: { hash: sha(ghost), bytes: ghost.length } });
    clock('OUT', '2026-10-08T09:55:00', 'sari', { photo: { hash: sha(a), bytes: a.length } }); // foto yang sama dengan absen masuk Budi
    expect((await flush()).status).toBe(201);
    h.setNow(WIB('2026-10-10T12:00:00')); // lebih dari 24 jam sesudahnya
    expect((await post('/v1/outlets/o1/evaluate', owner)).status).toBeLessThan(300);
    const r56 = await hits('R56');
    expect(r56.some((x) => x.note.includes('Sari') || x.note.includes('sari'))).toBe(true);
    expect(r56.some((x) => x.note.includes('DENIED') || x.note.includes('ditolak'))).toBe(true); // absen masuk sari tadi
    expect(r56.some((x) => x.note.includes('tidak pernah terunggah'))).toBe(true);
    const r57 = await hits('R57');
    expect(r57).toHaveLength(1);
    expect(r57[0]!.note).toContain('2 kali');
    expect(r57[0]!.weight).toBe(40);
  });

  it('tanpa kewajiban foto: absen tanpa foto tidak ditandai (R56 hanya bila outlet mewajibkan)', async () => {
    await h.http('PUT', '/v1/outlets/o1/settings', owner, { attendancePhoto: false });
    await h.db.admin.query("delete from incident where outlet_id = 'o1'");
    await post('/v1/outlets/o1/evaluate', owner);
    expect((await hits('R56')).filter((x) => x.note.includes('tanpa foto'))).toHaveLength(0);
  });
});

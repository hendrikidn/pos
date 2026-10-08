import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const MIN = 60_000;

describe('antrian meja', () => {
  let h: Harness;
  let owner: string;
  let rina: string;
  let ops: string;
  let ownerB: string;
  let term: string;
  let term2: string;
  let kds: string;
  let sim: Sim;
  let clock = WIB('2026-10-08T19:00:00');

  const post = (path: string, tok: string | undefined, body?: unknown) => h.http('POST', path, tok, body ?? {});
  const put = (path: string, tok: string, body: unknown) => h.http('PUT', path, tok, body);
  const get = (path: string, tok?: string) => h.http('GET', path, tok);
  const at = (ms: number) => { clock = ms; h.setNow(ms); };
  const take = (body: Record<string, unknown> = {}) => post('/v1/public/queue/kopi-o1/tickets', undefined, { partySize: 2, ...body });
  const add = (body: Record<string, unknown>, tok = term) => post('/v1/queue/tickets', tok, body);
  const board = async (tok = term) => (await get('/v1/queue/board', tok)).body as { enabled: boolean; tickets: { id: number; label: string; status: string; callCount: number; partySize: number }[] };
  const sync = async () => expect((await h.postEvents(term, sim.events)).status).toBe(201);
  const hits = async (rule: string) => ((await get('/v1/outlets/o1/incidents', owner)).body as { hits: { rule: string; note: string }[] }[]).flatMap((i) => i.hits).filter((x) => x.rule === rule);

  beforeAll(async () => {
    h = await createHarness(clock);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Kopi Satu', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t1', 'o2', 'Kopi Dua', { terminals: ['term-2'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    await h.db.admin.query("update outlet set tables = $1::jsonb where id = 'o1'", [JSON.stringify([{ no: '1', area: 'Indoor', seats: 4 }, { no: '2', area: 'Indoor', seats: 6 }])]);
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    rina = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    term2 = await h.admin.createDevice('t1', 'o2', 'term-2', 'terminal');
    kds = await h.admin.createDevice('t1', 'o1', 'kds-1', 'kds');
    expect((await post('/v1/staff', owner, { id: 'budi', name: 'Budi', role: 'CASHIER', pin: '4827' })).status).toBe(201);
    sim = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
  });
  afterAll(() => h.close());

  it('pengaturan: hanya OWNER; butuh alamat toko dulu; manager boleh membaca', async () => {
    expect((await get('/v1/outlets/o1/queue-settings', rina)).body).toEqual({ slug: null, enabled: false });
    expect((await get('/v1/outlets/o1/queue-settings', ops)).status).toBe(403);
    expect((await put('/v1/outlets/o1/queue-settings', rina, { enabled: true })).status).toBe(403);
    expect((await put('/v1/outlets/o1/queue-settings', owner, { enabled: true })).status).toBe(400); // belum ada alamat
    expect((await put('/v1/outlets/o1/queue-settings', owner, { enabled: 'ya' })).status).toBe(400);
    expect((await put('/v1/outlets/o1/web-shop', owner, { enabled: false, slug: 'kopi-o1' })).status).toBe(200);
    expect((await get('/v1/public/queue/kopi-o1')).status).toBe(404); // antrian belum aktif
    expect((await put('/v1/outlets/o1/queue-settings', owner, { enabled: true })).status).toBe(200);
    expect((await get('/v1/outlets/o1/queue-settings', owner)).body).toEqual({ slug: 'kopi-o1', enabled: true });
    expect((await get('/v1/outlets/o1/queue-settings', ownerB)).status).toBe(404);
    expect((await h.db.admin.query("select 1 from audit_log where action = 'queue.settings'")).rowCount).toBe(1);
  });

  it('papan publik: tanpa login; tidak dikenal dan nonaktif menjawab sama; tenant ditangguhkan 404', async () => {
    const b = await get('/v1/public/queue/kopi-o1');
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ name: 'Kopi Satu', waiting: 0, estimateMin: 0, calling: [] });
    expect(Object.keys(b.body).sort()).toEqual(['at', 'calling', 'estimateMin', 'name', 'waiting']);
    expect((await get('/v1/public/queue/tidak-ada')).body.message).toBe((await get('/v1/public/queue/Bad_Slug!')).body.message);
    await h.db.admin.query("update tenant set suspended_at = now() where id = 't1'");
    expect((await get('/v1/public/queue/kopi-o1')).status).toBe(404);
    await h.db.admin.query("update tenant set suspended_at = null where id = 't1'");
  });

  it('mengambil tiket: validasi, nomor berurutan, perkiraan tunggu, satu tiket aktif per nomor telepon, jebakan bot', async () => {
    expect((await take({ partySize: 0 })).status).toBe(400);
    expect((await take({ partySize: 21 })).status).toBe(400);
    expect((await take({ partySize: 2.5 })).status).toBe(400);
    expect((await take({ name: 'D' })).status).toBe(400);
    expect((await take({ phone: 'abc' })).status).toBe(400);
    const a = await take({ partySize: 6, name: 'Ani', phone: '0812 1111 2222' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ label: 'A001', ahead: 0, estimateMin: 0 });
    const b = await take({ partySize: 2, phone: '0812 3333 4444' });
    expect(b.body).toMatchObject({ label: 'A002', ahead: 1, estimateMin: 4 });
    expect((await take({ phone: '0812 1111 2222' })).status).toBe(409); // sudah punya tiket aktif
    const trap = await take({ website: 'http://spam' });
    expect(trap.status).toBe(201);
    expect((await get('/v1/queue/board', term)).body.tickets).toHaveLength(2); // jebakan tidak menyimpan
    expect(a.body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    (globalThis as { __tokA?: string }).__tokA = a.body.token;
    (globalThis as { __tokB?: string }).__tokB = b.body.token;
  });

  it('melacak tiket: posisi dan perkiraan, tanpa data pribadi; token salah 404; pelanggan bisa membatalkan', async () => {
    const tokB = (globalThis as { __tokB?: string }).__tokB!;
    const t = await get(`/v1/public/queue-tickets/${tokB}`);
    expect(t.body).toMatchObject({ outletName: 'Kopi Satu', label: 'A002', status: 'WAITING', partySize: 2, ahead: 1, estimateMin: 4, callCount: 0, tableNo: null });
    expect(JSON.stringify(t.body)).not.toContain('0812');
    expect((await get('/v1/public/queue-tickets/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await get('/v1/public/queue-tickets/pendek')).status).toBe(404);
    const c = await take({ partySize: 3, phone: '0812 5555 6666' }); // A003, lalu dibatalkan sendiri
    expect((await post(`/v1/public/queue-tickets/${c.body.token}/cancel`, undefined)).status).toBe(201);
    expect((await post(`/v1/public/queue-tickets/${c.body.token}/cancel`, undefined)).status).toBe(409);
    expect((await get(`/v1/public/queue-tickets/${c.body.token}`)).body.status).toBe('CANCELED');
  });

  it('terminal: papan memuat nama dan telepon; hanya terminal outlet itu; kasir menambah tamu dengan staf yang dikenal', async () => {
    const b = await board();
    expect(b.enabled).toBe(true);
    expect(b.tickets.map((t) => [t.label, t.status])).toEqual([['A001', 'WAITING'], ['A002', 'WAITING']]);
    expect((await get('/v1/queue/board', kds)).status).toBe(403);
    expect((await get('/v1/queue/board', rina)).status).toBe(403);
    expect((await board(term2)).tickets).toEqual([]);
    expect((await add({ partySize: 0 })).status).toBe(400);
    expect((await add({ partySize: 2, staffId: 'hantu' })).status).toBe(400);
    const w = await add({ partySize: 2, name: 'Walk-in', staffId: 'budi' });
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({ label: 'A004' }); // A003 sudah dibatalkan, nomor tidak dipakai ulang
    expect((await h.db.admin.query("select created_by, source from queue_ticket where seq = 4")).rows).toEqual([{ created_by: 'budi', source: 'STAFF' }]);
    expect((await post('/v1/queue/9999/call', term)).status).toBe(404);
    expect((await post(`/v1/queue/${w.body.id}/call`, term2, {})).status).toBe(404); // tiket outlet lain
  });

  it('memanggil: yang terlama bebas; melewati antrian wajib beralasan, "meja cocok" diperiksa mesin, tercatat dan beraudit', async () => {
    const [a1, a2, a4] = (await board()).tickets; // A001 (6 orang), A002 (2), A004 (2)
    const call = (id: number, body: Record<string, unknown> = {}) => post(`/v1/queue/${id}/call`, term, body);
    expect((await call(a4!.id)).status).toBe(400); // melewati A001 dan A002 tanpa alasan
    expect((await call(a4!.id, { reason: 'TABLE_SIZE' })).status).toBe(400); // A002 (2 orang) tidak lebih besar dari A004 (2 orang)
    expect((await call(a2!.id, { reason: 'TABLE_SIZE' })).body).toEqual({ label: 'A002', skipped: ['A001'] }); // A001 (6) lebih besar dari A002 (2): sah
    expect((await call(a4!.id, { reason: 'PRIORITY' })).status).toBe(400); // tanpa penjelasan
    expect((await call(a4!.id, { reason: 'PRIORITY', note: 'ibu hamil', staffId: 'budi' })).body).toEqual({ label: 'A004', skipped: ['A001'] }); // A002 sudah dipanggil, tidak dihitung
    expect((await call(a1!.id)).status).toBe(201); // A001 kini yang terlama
    expect((await call(a1!.id)).status).toBe(409); // sudah dipanggil
    const rows = (await h.db.admin.query<{ seq: number; jump_reason: string | null; jump_note: string | null; jumped_over: string[] | null; called_by: string }>('select seq, jump_reason, jump_note, jumped_over, called_by from queue_ticket where status = \'CALLED\' order by seq')).rows;
    expect(rows).toEqual([
      { seq: 1, jump_reason: null, jump_note: null, jumped_over: null, called_by: 'device:term-1' },
      { seq: 2, jump_reason: 'TABLE_SIZE', jump_note: null, jumped_over: ['A001'], called_by: 'device:term-1' },
      { seq: 4, jump_reason: 'PRIORITY', jump_note: 'ibu hamil', jumped_over: ['A001'], called_by: 'budi' },
    ]);
    expect((await h.db.admin.query("select actor from audit_log where action = 'queue.jump' order by id")).rows).toEqual([{ actor: 'device:term-1' }, { actor: 'budi' }]);
    const pub = (await get('/v1/public/queue/kopi-o1')).body;
    expect(pub.calling.map((c: { label: string }) => c.label).sort()).toEqual(['A001', 'A002', 'A004']);
    expect(pub.waiting).toBe(0);
  });

  it('panggil ulang, tidak datang (baru 2 menit sesudah panggilan terakhir), batal beralasan', async () => {
    at(clock + 1 * MIN);
    const t = (await board()).tickets;
    const a1 = t.find((x) => x.label === 'A001')!;
    expect((await post(`/v1/queue/${a1.id}/no-show`, term)).status).toBe(400); // baru 1 menit
    expect((await post(`/v1/queue/${a1.id}/recall`, term)).body).toEqual({ label: 'A001', callCount: 2 });
    at(clock + 1 * MIN);
    expect((await post(`/v1/queue/${a1.id}/no-show`, term)).status).toBe(400); // dihitung dari panggilan terakhir
    at(clock + 2 * MIN);
    expect((await post(`/v1/queue/${a1.id}/no-show`, term, { staffId: 'budi' })).status).toBe(201);
    expect((await post(`/v1/queue/${a1.id}/no-show`, term)).status).toBe(409);
    expect((await post(`/v1/queue/${a1.id}/recall`, term)).status).toBe(409);
    const a2 = t.find((x) => x.label === 'A002')!;
    expect((await post(`/v1/queue/${a2.id}/cancel`, term, { reason: '' })).status).toBe(400);
    for (let i = 0; i < 4; i++) expect((await post(`/v1/queue/${a2.id}/recall`, term)).status).toBe(201);
    expect((await post(`/v1/queue/${a2.id}/recall`, term)).status).toBe(409); // maksimal 5 panggilan
  });

  it('mendudukkan: harus dipanggil dulu; meja harus ada di denah; hanya sekali', async () => {
    const a4 = (await board()).tickets.find((x) => x.label === 'A004')!;
    const w = await add({ partySize: 4, name: 'Baru' }); // A005 masih menunggu
    expect((await post(`/v1/queue/${w.body.id}/seat`, term, { tableNo: '1' })).status).toBe(409); // belum dipanggil
    expect((await post(`/v1/queue/${a4.id}/seat`, term, {})).status).toBe(400);
    expect((await post(`/v1/queue/${a4.id}/seat`, term, { tableNo: '99' })).status).toBe(400);
    expect((await post(`/v1/queue/${a4.id}/seat`, term, { tableNo: '2', staffId: 'budi' })).body).toEqual({ label: 'A004', tableNo: '2', partySize: 2, name: 'Walk-in' });
    expect((await post(`/v1/queue/${a4.id}/seat`, term, { tableNo: '1' })).status).toBe(409);
    expect((await post(`/v1/queue/${a4.id}/cancel`, term, { reason: 'salah' })).status).toBe(409);
    const d = (await get('/v1/outlets/o1/queue', owner)).body;
    expect(d.stats).toMatchObject({ total: 5, seated: 1, noShow: 1, canceled: 1, jumps: 2 });
    expect(d.tickets.find((x: { label: string }) => x.label === 'A004')).toMatchObject({ status: 'SEATED', tableNo: '2', seatedBy: 'budi', jumpReason: 'PRIORITY', jumpNote: 'ibu hamil', jumpedOver: ['A001'] });
    expect((await get('/v1/outlets/o1/queue', ops)).status).toBe(403);
    expect((await get('/v1/outlets/o1/queue?day=2026-02-31', owner)).status).toBe(400);
    expect((await get('/v1/outlets/o1/queue', ownerB)).status).toBe(404);
  });

  it('batas tiket per alamat (4 per jam) dan antrian penuh (60)', async () => {
    at(clock + 3 * 3_600_000);
    for (let i = 0; i < 4; i++) expect((await take({ phone: `0813 0000 000${i}` })).status).toBe(201);
    expect((await take({ phone: '0813 0000 0009' })).status).toBe(429);
    at(clock + 2 * 3_600_000);
    await h.db.admin.query("update queue_ticket set status = 'EXPIRED' where outlet_id = 'o1'");
    const day = (await get('/v1/outlets/o1/queue', owner)).body.day as string;
    const max = Number((await h.db.admin.query<{ m: number }>("select max(seq) as m from queue_ticket where outlet_id = 'o1'")).rows[0]!.m);
    for (let i = 1; i <= 60; i++) await h.db.admin.query("insert into queue_ticket (tenant_id, outlet_id, day, seq, token, party_size, source, created_at_ms) values ('t1', 'o1', $1, $2, $3, 2, 'SELF', $4)", [day, max + i, `tok${String(i).padStart(19, 'x')}`, clock]);
    expect((await take({ phone: '0813 0000 7777' })).status).toBe(429);
    expect((await add({ partySize: 2 })).status).toBe(409);
    await h.db.admin.query("update queue_ticket set status = 'EXPIRED' where outlet_id = 'o1'");
  });

  it('ganti hari: tiket kemarin yang masih menunggu kedaluwarsa dan nomor mulai dari A001', async () => {
    at(WIB('2026-10-10T10:00:00'));
    expect((await board()).tickets).toEqual([]);
    const t = await take({ phone: '0814 0000 0001' });
    expect(t.body.label).toBe('A001');
  });

  it('ingest: order.queue_linked wajib ticketId bulat', async () => {
    const s = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
    const bad = async (p: unknown) => expect((await h.postEvents(term, [s.pos({ type: 'order.queue_linked', payload: p } as never, WIB('2026-10-08T21:00:00'), 'budi')])).status).toBe(400);
    await bad({ orderId: 'x' });
    await bad({ orderId: 'x', ticketId: 1.5 });
    await bad({ orderId: 'x', ticketId: '7' });
  });

  it('R48 dan R49 di insiden: melewati antrian bukan karena meja cocok, tamu didudukkan tanpa order, tautan palsu; yang wajar tidak ditandai', async () => {
    at(WIB('2026-10-10T20:00:00'));
    const day = '2026-10-10';
    const ins = async (seq: number, party: number, status: string, extra: string, vals: unknown[]) => (await h.db.admin.query<{ id: string }>(
      `insert into queue_ticket (tenant_id, outlet_id, day, seq, token, party_size, source, status, created_at_ms, ${extra}) values ('t1', 'o1', $1, $2, $3, $4, 'STAFF', $5, $6, ${vals.map((_, i) => `$${i + 7}`).join(', ')}) returning id`,
      [day, seq, `tk${String(seq).padStart(20, 'y')}`, party, status, clock - 3_600_000, ...vals],
    )).rows[0]!.id;
    // jump karena prioritas (R48), jump karena meja cocok (tidak ditandai)
    await ins(11, 2, 'CALLED', 'called_at_ms, call_count, called_by, jump_reason, jump_note, jumped_over', [clock - 1_800_000, 1, 'budi', 'OTHER', 'teman pemilik', JSON.stringify(['A010'])]);
    await ins(12, 2, 'CALLED', 'called_at_ms, call_count, called_by, jump_reason, jumped_over', [clock - 1_700_000, 1, 'budi', 'TABLE_SIZE', JSON.stringify(['A010'])]);
    // didudukkan: satu dengan order dibayar (wajar), satu tanpa order (R49), satu lagi tautan ke tiket yang tidak didudukkan
    const okId = Number(await ins(13, 2, 'SEATED', 'seated_at_ms, seated_by, table_no', [clock - 3_000_000, 'budi', '1']));
    await ins(14, 2, 'SEATED', 'seated_at_ms, seated_by, table_no', [clock - 3_000_000, 'budi', '2']);
    const s = new Sim('o1', '2026-10-09', 'term-1', 'sensor-1');
    s.pos({ type: 'order.created', payload: { orderId: 'q-ok', orderType: 'DINE_IN', tableNo: '1' } }, clock - 2_900_000, 'budi');
    s.pos({ type: 'order.queue_linked', payload: { orderId: 'q-ok', ticketId: okId } }, clock - 2_899_000, 'budi');
    s.pos({ type: 'payment.received', payload: { orderId: 'q-ok', method: 'CASH', amount: 50_000 } }, clock - 2_000_000, 'budi');
    s.pos({ type: 'order.created', payload: { orderId: 'q-ghost', orderType: 'DINE_IN', tableNo: '2' } }, clock - 2_800_000, 'budi');
    s.pos({ type: 'order.queue_linked', payload: { orderId: 'q-ghost', ticketId: 9999 } }, clock - 2_799_000, 'budi');
    expect((await h.postEvents(term, s.events)).status).toBe(201);
    expect((await post('/v1/outlets/o1/evaluate', owner)).status).toBeLessThan(300);
    const r48 = await hits('R48');
    expect(r48).toHaveLength(2); // A011 (teman pemilik) dan A004 dari tes sebelumnya (prioritas, ibu hamil); meja cocok tidak ditandai
    expect(r48.some((x) => x.note.includes('A011') && x.note.includes('teman pemilik'))).toBe(true);
    expect(r48.some((x) => x.note.includes('A004') && x.note.includes('ibu hamil'))).toBe(true);
    expect(r48.some((x) => x.note.includes('A012') || x.note.includes('A002'))).toBe(false);
    const r49 = await hits('R49');
    expect(r49.some((x) => x.note.includes('A014') && x.note.includes('tidak pernah dibuat'))).toBe(true);
    expect(r49.some((x) => x.note.includes('#9999'))).toBe(true);
    expect(r49.some((x) => x.note.includes('A013'))).toBe(false);
  });
});

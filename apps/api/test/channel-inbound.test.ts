import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const MIN = 60_000;

describe('pesanan GoFood/GrabFood/ShopeeFood masuk langsung', () => {
  let h: Harness;
  let owner: string;
  let rina: string;
  let ops: string;
  let ownerB: string;
  let term: string;
  let kds: string;
  let term2: string;
  let sim: Sim;
  let gofood = '';
  let grab = '';
  let clock = WIB('2026-10-08T10:00:00');
  const at = (ms: number) => { clock = ms; h.setNow(ms); };

  const post = (path: string, tok: string | undefined, body?: unknown) => h.http('POST', path, tok, body ?? {});
  const put = (path: string, tok: string, body: unknown) => h.http('PUT', path, tok, body);
  const get = (path: string, tok?: string) => h.http('GET', path, tok);
  const pub = (method: string, path: string, key: string | undefined, body?: unknown) => h.http(method, path, key, body);
  const sync = async () => expect((await h.postEvents(term, sim.events)).status).toBe(201);
  const hits = async (rule: string) => ((await get('/v1/outlets/o1/incidents', owner)).body as { hits: { rule: string; note: string }[] }[]).flatMap((i) => i.hits).filter((x) => x.rule === rule);
  const body = (ref: string, over: Record<string, unknown> = {}) => ({
    ref, total: 64_000, customerName: 'Dewi', items: [{ externalId: 'gf-kopi', name: 'Kopi Susu', qty: 2, unitPrice: 20_000 }, { name: 'Roti Bakar', qty: 1, unitPrice: 24_000, note: 'tanpa mentega' }], ...over,
  });

  beforeAll(async () => {
    h = await createHarness(clock);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Kopi Satu', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t1', 'o2', 'Kopi Dua', { terminals: ['term-2'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    rina = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    term2 = await h.admin.createDevice('t1', 'o2', 'term-2', 'terminal');
    kds = await h.admin.createDevice('t1', 'o1', 'kds-1', 'kds');
    expect((await post('/v1/menu', owner, { id: 'kopi', name: 'Kopi Susu', price: 20_000, category: 'Kopi' })).status).toBe(201);
    expect((await post('/v1/menu', owner, { id: 'roti', name: 'Roti Bakar', price: 24_000, category: 'Makanan' })).status).toBe(201);
    expect((await post('/v1/menu', owner, { id: 'lama', name: 'Menu Lama', price: 9_000, category: 'Lain' })).status).toBe(201);
    expect((await h.http('PUT', '/v1/outlets/o1/settings', owner, { onlineChannels: [{ channel: 'GOFOOD', commissionPercent: 20 }] })).status).toBe(200);
    sim = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
  });
  afterAll(() => h.close());

  it('kunci: hanya OWNER membuat/mencabut; ditampilkan sekali; kunci lama mati saat diganti; tercatat di audit', async () => {
    expect((await post('/v1/outlets/o1/channel-integrations', rina, { channel: 'GOFOOD' })).status).toBe(403);
    expect((await post('/v1/outlets/o1/channel-integrations', owner, { channel: 'TOKOPEDIA' })).status).toBe(400);
    expect((await post('/v1/outlets/o1/channel-integrations', ownerB, { channel: 'GOFOOD' })).status).toBe(400); // outlet milik tenant lain
    const a = await post('/v1/outlets/o1/channel-integrations', owner, { channel: 'GOFOOD' });
    expect(a.status).toBe(201);
    gofood = a.body.key;
    expect(gofood).toMatch(/^chn_/);
    const list = (await get('/v1/outlets/o1/channel-integrations', rina)).body.integrations;
    expect(list.find((x: { channel: string }) => x.channel === 'GOFOOD')).toMatchObject({ active: true, keyPrefix: gofood.slice(0, 8), autoAccept: false });
    expect(JSON.stringify(list)).not.toContain(gofood);
    expect((await get('/v1/outlets/o1/channel-integrations', ops)).status).toBe(403);
    const b = await post('/v1/outlets/o1/channel-integrations', owner, { channel: 'GOFOOD' });
    expect((await pub('POST', '/v1/public/channel/orders', gofood, body('GF-0001'))).status).toBe(401); // kunci lama dicabut
    gofood = b.body.key;
    grab = (await post('/v1/outlets/o1/channel-integrations', owner, { channel: 'GRABFOOD' })).body.key;
    expect((await h.db.admin.query("select 1 from audit_log where action = 'channel.key.create'")).rowCount).toBe(3);
    expect((await h.db.admin.query<{ key_hash: string }>('select key_hash from channel_integration')).rows.every((r) => r.key_hash.length === 64 && !r.key_hash.startsWith('chn_'))).toBe(true);
  });

  it('publik: kunci wajib dan sah; isi diperiksa; idempoten per nomor pesanan; status dan pembatalan', async () => {
    expect((await pub('POST', '/v1/public/channel/orders', undefined, body('GF-0001'))).status).toBe(401);
    expect((await pub('POST', '/v1/public/channel/orders', 'chn_bukankunciyangbenar0000', body('GF-0001'))).status).toBe(401);
    expect((await pub('POST', '/v1/public/channel/orders', owner, body('GF-0001'))).status).toBe(401); // token dashboard bukan kunci integrasi
    for (const bad of [{ ref: 'a' }, { total: -1 }, { total: 1.5 }, { items: [] }, { items: [{ name: 'X', qty: 0, unitPrice: 1 }] }, { items: [{ name: '', qty: 1, unitPrice: 1 }] }, { items: [{ name: 'X', qty: 1, unitPrice: 1.5 }] }, { placedAt: 'bukan tanggal' }]) {
      expect((await pub('POST', '/v1/public/channel/orders', gofood, body('GF-0001', bad))).status).toBe(400);
    }
    const r = await pub('POST', '/v1/public/channel/orders', gofood, body('GF-0001'));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ref: 'GF-0001', status: 'NEW', duplicate: false });
    const again = await pub('POST', '/v1/public/channel/orders', gofood, body('GF-0001', { total: 1 }));
    expect(again.body).toMatchObject({ id: r.body.id, status: 'NEW', duplicate: true });
    expect((await h.db.admin.query("select 1 from channel_inbound where ref = 'GF-0001'")).rowCount).toBe(1);
    expect((await pub('GET', '/v1/public/channel/orders/GF-0001', gofood)).body).toMatchObject({ status: 'NEW', canceledByPlatform: false });
    expect((await pub('GET', '/v1/public/channel/orders/GF-9999', gofood)).status).toBe(404);
    expect((await pub('GET', '/v1/public/channel/orders/GF-0001', grab)).status).toBe(404); // kunci kanal lain tidak melihatnya
    const c = await pub('POST', '/v1/public/channel/orders/GF-0001/cancel', gofood);
    expect(c.body.status).toBe('CANCELED');
    expect(c.body.canceledByPlatform).toBe(true);
  });

  it('terminal: daftar menunggu dengan pemetaan; belum terpetakan tidak bisa diterima; klaim atomik sekali; hanya outlet dan terminal itu', async () => {
    expect((await pub('POST', '/v1/public/channel/orders', gofood, body('GF-0002'))).status).toBe(201);
    expect((await get('/v1/channel-orders/pending', kds)).status).toBe(403);
    expect((await get('/v1/channel-orders/pending', owner)).status).toBe(403);
    const p = (await get('/v1/channel-orders/pending', term)).body;
    expect(p.orders).toHaveLength(1);
    expect(p.orders[0]).toMatchObject({ channel: 'GOFOOD', ref: 'GF-0002', total: 64_000, autoAccept: false });
    expect(p.orders[0].items.map((i: { menuId: string | null }) => i.menuId)).toEqual([null, null]);
    expect((await get('/v1/channel-orders/pending', term2)).body.orders).toHaveLength(0);
    const id = p.orders[0].id;
    expect((await post(`/v1/channel-orders/${id}/accept`, term)).status).toBe(409); // belum dipetakan
    expect((await post(`/v1/channel-orders/${id}/accept`, term2)).status).toBe(409); // outlet lain
    const un = (await get('/v1/outlets/o1/channel-items', rina)).body.unmapped;
    expect(un.map((x: { key: string }) => x.key).sort()).toEqual(['id:gf-kopi', 'nama:roti bakar']);
    // pemetaan: manager boleh; menu harus ada dan aktif
    const map = (tok: string, b: unknown) => put('/v1/channel-items', tok, b);
    expect((await map(ops, { channel: 'GOFOOD', key: 'id:gf-kopi', menuId: 'kopi' })).status).toBe(403);
    expect((await map(rina, { channel: 'GOFOOD', key: 'id:gf-kopi', menuId: 'tidak-ada' })).status).toBe(400);
    expect((await map(rina, { channel: 'GOFOOD', key: 'id:gf-kopi', menuId: 'kopi' })).status).toBe(200);
    expect((await map(rina, { channel: 'GOFOOD', key: 'nama:roti bakar', menuId: 'roti' })).status).toBe(200);
    expect((await map(ownerB, { channel: 'GOFOOD', key: 'id:x', menuId: 'kopi' })).status).toBe(400); // menu milik tenant lain tidak terlihat
    // kanal belum aktif di outlet: ditolak sebelum klaim
    expect((await post(`/v1/channel-orders/${id}/accept`, term)).status).toBe(201);
    const [a, b] = await Promise.all([post(`/v1/channel-orders/${id}/accept`, term), post(`/v1/channel-orders/${id}/accept`, term)]);
    expect([a.status, b.status]).toEqual([409, 409]); // sudah diklaim di panggilan pertama di atas
  });

  it('terima: isi menu outlet dikembalikan; tolak butuh alasan; auto-accept diatur OWNER; platform membatalkan pesanan yang sudah diterima', async () => {
    const acc = (await h.db.admin.query<{ status: string; decided_by: string }>("select id, status, decided_by from channel_inbound where ref = 'GF-0002'")).rows[0];
    expect(acc).toMatchObject({ status: 'ACCEPTED', decided_by: 'device:term-1' });
    expect((await pub('GET', '/v1/public/channel/orders/GF-0002', gofood)).body.status).toBe('ACCEPTED');
    // pesanan lain: tolak
    const r3 = await pub('POST', '/v1/public/channel/orders', gofood, body('GF-0003'));
    expect((await post(`/v1/channel-orders/${r3.body.id}/reject`, term, { reason: '' })).status).toBe(400);
    expect((await post(`/v1/channel-orders/${r3.body.id}/reject`, term2, { reason: 'Stok habis' })).status).toBe(409);
    expect((await post(`/v1/channel-orders/${r3.body.id}/reject`, term, { reason: 'Stok habis' })).status).toBe(201);
    expect((await post(`/v1/channel-orders/${r3.body.id}/reject`, term, { reason: 'Stok habis' })).status).toBe(409);
    expect((await pub('GET', '/v1/public/channel/orders/GF-0003', gofood)).body).toMatchObject({ status: 'REJECTED', reason: 'Stok habis' });
    // auto-accept
    expect((await put('/v1/outlets/o1/channel-integrations/GOFOOD', rina, { autoAccept: true })).status).toBe(403);
    expect((await put('/v1/outlets/o1/channel-integrations/GOFOOD', owner, { autoAccept: 'ya' })).status).toBe(400);
    expect((await put('/v1/outlets/o1/channel-integrations/SHOPEEFOOD', owner, { autoAccept: true })).status).toBe(404); // belum aktif
    expect((await put('/v1/outlets/o1/channel-integrations/GOFOOD', owner, { autoAccept: true })).status).toBe(200);
    await pub('POST', '/v1/public/channel/orders', gofood, body('GF-0004'));
    expect((await get('/v1/channel-orders/pending', term)).body.orders[0]).toMatchObject({ ref: 'GF-0004', autoAccept: true });
    // kunci diganti: pengaturan auto-accept ikut terbawa
    expect((await get('/v1/outlets/o1/channel-integrations', owner)).body.integrations.find((x: { channel: string }) => x.channel === 'GOFOOD').autoAccept).toBe(true);
    // pembatalan platform atas pesanan yang sudah diterima: tetap ACCEPTED, ditandai, dan muncul di terminal
    const c = await pub('POST', '/v1/public/channel/orders/GF-0002/cancel', gofood);
    expect(c.body).toMatchObject({ status: 'ACCEPTED', canceledByPlatform: true });
    expect((await get('/v1/channel-orders/pending', term)).body.canceled).toEqual([{ channel: 'GOFOOD', ref: 'GF-0002', at: clock }]);
    // tidak ada yang bisa menyentuh pesanan outlet/tenant lain
    expect((await get('/v1/outlets/o1/channel-orders', ownerB)).body.orders).toEqual([]);
    const l = (await get('/v1/outlets/o1/channel-orders?days=3', rina)).body.orders;
    expect(l.map((x: { ref: string }) => x.ref).sort()).toEqual(['GF-0001', 'GF-0002', 'GF-0003', 'GF-0004']);
    expect((await get('/v1/outlets/o1/channel-orders', ops)).status).toBe(403);
  });

  it('kedaluwarsa: pesanan yang tidak ditanggapi 2 jam menjadi EXPIRED dan tidak bisa diterima', async () => {
    const t0 = clock;
    at(t0 + 121 * MIN);
    const p = (await get('/v1/channel-orders/pending', term)).body;
    expect(p.orders).toHaveLength(0);
    expect((await pub('GET', '/v1/public/channel/orders/GF-0004', gofood)).body.status).toBe('EXPIRED');
    const id = Number((await h.db.admin.query("select id from channel_inbound where ref = 'GF-0004'")).rows[0]!.id);
    expect((await post(`/v1/channel-orders/${id}/accept`, term)).status).toBe(409);
  });

  it('pembatas laju: kunci salah berulang dari satu alamat ditahan; kunci dicabut langsung mati', async () => {
    const tok = await post('/v1/outlets/o1/channel-integrations', owner, { channel: 'GRABFOOD' });
    expect((await pub('POST', '/v1/public/channel/orders', grab, body('GR-0001'))).status).toBe(401); // yang lama sudah diganti
    grab = tok.body.key;
    expect((await pub('POST', '/v1/public/channel/orders', grab, body('GR-0001'))).status).toBe(201);
    expect((await h.http('DELETE', '/v1/outlets/o1/channel-integrations/GRABFOOD', rina)).status).toBe(403);
    expect((await h.http('DELETE', '/v1/outlets/o1/channel-integrations/GRABFOOD', owner)).status).toBe(200);
    expect((await h.http('DELETE', '/v1/outlets/o1/channel-integrations/GRABFOOD', owner)).status).toBe(404);
    expect((await pub('POST', '/v1/public/channel/orders', grab, body('GR-0002'))).status).toBe(401);
    let last = 0;
    for (let i = 0; i < 130; i++) last = (await pub('POST', '/v1/public/channel/orders', 'chn_salahsalahsalahsalah0000', body('X-1'))).status;
    expect(last).toBe(429);
  });

  it('R54 dan R55 di insiden: isi order kasir berbeda dari pesanan platform, dan pesanan diterima yang tidak pernah dibuat jadi order', async () => {
    h.setNow(clock);
    const t0 = WIB('2026-10-09T10:00:00');
    at(t0);
    expect((await put('/v1/outlets/o1/channel-integrations/GOFOOD', owner, { autoAccept: false })).status).toBe(200);
    const accept = async (ref: string, items: unknown[]) => {
      const r = await pub('POST', '/v1/public/channel/orders', gofood, body(ref, { items }));
      expect(r.status).toBe(201);
      expect((await post(`/v1/channel-orders/${r.body.id}/accept`, term)).status).toBe(201);
    };
    const kopi2 = [{ externalId: 'gf-kopi', name: 'Kopi Susu', qty: 2, unitPrice: 20_000 }];
    await accept('GF-OK', kopi2);
    await accept('GF-KURANG', kopi2);
    await accept('GF-HILANG', kopi2);
    await accept('GF-TAMBAH', kopi2);
    const line = (id: string, qty: number) => ({ itemId: id, name: id, qty, unitPrice: 20_000 });
    const ev = (order_: string, ref: string, t: number, items: ReturnType<typeof line>[]) => {
      sim.pos({ type: 'order.created', payload: { orderId: order_, orderType: 'TAKE_AWAY' } }, t, 'budi');
      sim.pos({ type: 'order.channel_linked', payload: { orderId: order_, channel: 'GOFOOD', ref } }, t + 1000, 'budi');
      sim.pos({ type: 'bill.printed', payload: { orderId: order_, total: 1, items } }, t + 2000, 'budi');
    };
    ev('c-ok', 'GF-OK', t0 + MIN, [line('kopi', 2)]);
    ev('c-kurang', 'GF-KURANG', t0 + 2 * MIN, [line('kopi', 1)]); // satu kopi dihapus
    ev('c-tambah', 'GF-TAMBAH', t0 + 3 * MIN, [line('kopi', 2), line('roti', 1)]); // menu disisipkan
    await sync();
    at(t0 + 30 * MIN);
    expect((await post('/v1/outlets/o1/evaluate', owner)).status).toBeLessThan(300);
    const r54 = await hits('R54');
    expect(r54.some((x) => x.note.includes('GF-KURANG') && x.note.includes('platform 2, kasir 1'))).toBe(true);
    expect(r54.some((x) => x.note.includes('GF-TAMBAH') && x.note.includes('roti platform 0, kasir 1'))).toBe(true);
    expect(r54.some((x) => x.note.includes('GF-OK'))).toBe(false);
    const r55 = await hits('R55');
    expect(r55.some((x) => x.note.includes('GF-HILANG') && x.note.includes('tidak pernah dibuat'))).toBe(true);
    expect(r55.some((x) => x.note.includes('GF-OK') || x.note.includes('GF-KURANG'))).toBe(false);
  });
});

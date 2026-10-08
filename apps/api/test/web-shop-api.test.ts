import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const MIN = 60_000;
const SIZE = { id: 'size', name: 'Ukuran', min: 1, max: 1, options: [{ id: 'reg', name: 'Regular', price: 0 }, { id: 'lrg', name: 'Large', price: 5000 }] };

describe('toko web', () => {
  let h: Harness;
  let owner: string;
  let rina: string;
  let ops: string;
  let ownerB: string;
  let term: string;
  let kds: string;
  let term2: string;
  let sim: Sim;

  const post = (path: string, tok: string | undefined, body?: unknown) => h.http('POST', path, tok, body ?? {});
  const put = (path: string, tok: string, body: unknown) => h.http('PUT', path, tok, body);
  const get = (path: string, tok?: string) => h.http('GET', path, tok);
  const order = (body: Record<string, unknown>, slug = 'kopi-o1') => post(`/v1/public/shop/${slug}/orders`, undefined, { name: 'Dewi', phone: '0812 3456 7890', type: 'TAKE_AWAY', items: [{ itemId: 'kopi', qty: 1 }], ...body });
  let clock = WIB('2026-10-08T10:00:00');
  const at = (ms: number) => { clock = ms; h.setNow(ms); };
  /** Jam maju 2 jam supaya pembatas per alamat (6/jam) mulai dari nol, tanpa mengganggu urutan pesanan. */
  const freshHour = () => at(clock + 2 * 3_600_000);
  const sync = async () => expect((await h.postEvents(term, sim.events)).status).toBe(201);
  const hits = async (rule: string) => ((await get('/v1/outlets/o1/incidents', owner)).body as { hits: { rule: string; note: string }[] }[]).flatMap((i) => i.hits).filter((x) => x.rule === rule);

  beforeAll(async () => {
    h = await createHarness(clock);
    await h.admin.createTenant('t1', 'Tenant 1');
    await h.admin.createTenant('t2', 'Tenant 2');
    await h.admin.createOutlet('t1', 'o1', 'Kopi Satu', { terminals: ['term-1'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t1', 'o2', 'Kopi Dua', { terminals: ['term-2'], capabilities: { sensor: false, kds: false, printerReportsStatus: false } });
    await h.admin.createOutlet('t2', 'ox', 'Outlet X');
    await h.db.admin.query("update outlet set tables = $1::jsonb where id = 'o1'", [JSON.stringify([{ no: '1', area: 'Indoor', seats: 4 }, { no: '2', area: 'Indoor', seats: 4 }])]);
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    rina = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal');
    term2 = await h.admin.createDevice('t1', 'o2', 'term-2', 'terminal');
    kds = await h.admin.createDevice('t1', 'o1', 'kds-1', 'kds');
    expect((await post('/v1/menu', owner, { id: 'kopi', name: 'Kopi Susu', price: 20_000, category: 'Kopi' })).status).toBe(201);
    expect((await post('/v1/menu', owner, { id: 'teh', name: 'Teh Tarik', price: 15_000, category: 'Non-kopi', modifierGroups: [SIZE] })).status).toBe(201);
    expect((await post('/v1/menu', owner, { id: 'rahasia', name: 'Menu Nonaktif', price: 9_000, category: 'Lain' })).status).toBe(201);
    expect((await put('/v1/menu/rahasia', owner, { active: false })).status).toBe(200);
    sim = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
  });
  afterAll(() => h.close());

  it('pengaturan: hanya OWNER mengubah, manager membaca; alamat sah dan unik antar tenant; wajib alamat untuk aktif', async () => {
    expect((await get('/v1/outlets/o1/web-shop', rina)).body).toEqual({ slug: null, enabled: false, tables: ['1', '2'] });
    expect((await get('/v1/outlets/o1/web-shop', ops)).status).toBe(403);
    const set = (tok: string, body: unknown, outlet = 'o1') => put(`/v1/outlets/${outlet}/web-shop`, tok, body);
    expect((await set(rina, { enabled: true, slug: 'kopi-o1' })).status).toBe(403);
    expect((await set(owner, { enabled: true })).status).toBe(400); // tanpa alamat
    expect((await set(owner, { enabled: true, slug: 'Kopi O1!' })).status).toBe(400);
    expect((await set(owner, { enabled: true, slug: 'ab' })).status).toBe(400);
    expect((await set(owner, { enabled: 'ya', slug: 'kopi-o1' })).status).toBe(400);
    expect((await set(owner, { enabled: true, slug: 'KOPI-o1' })).status).toBe(200); // dinormalkan huruf kecil
    expect((await get('/v1/outlets/o1/web-shop', owner)).body).toMatchObject({ slug: 'kopi-o1', enabled: true });
    expect((await set(owner, { enabled: true, slug: 'kopi-o1' }, 'o2')).status).toBe(409); // dipakai outlet lain
    expect((await set(ownerB, { enabled: true, slug: 'kopi-o1' }, 'ox')).status).toBe(409); // dan tenant lain pun tidak bisa merebut
    expect((await set(owner, { enabled: false, slug: 'kopi-o1' }, 'o1')).status).toBe(200);
    expect((await get('/v1/public/shop/kopi-o1')).status).toBe(404); // nonaktif = tidak ada
    expect((await set(owner, { enabled: true, slug: 'kopi-o1' })).status).toBe(200);
    expect((await h.db.admin.query("select 1 from audit_log where action = 'webshop.settings'")).rowCount).toBe(3);
  });

  it('halaman publik: tanpa login; hanya menu aktif; slug tidak dikenal dan nonaktif menjawab sama', async () => {
    const s = await get('/v1/public/shop/kopi-o1');
    expect(s.status).toBe(200);
    expect(s.body.name).toBe('Kopi Satu');
    expect(s.body.tables).toEqual(['1', '2']);
    expect(s.body.menu.map((m: { id: string }) => m.id)).toEqual(['kopi', 'teh']); // 'rahasia' nonaktif
    expect(s.body.pricing).toMatchObject({ taxPercent: 10 });
    expect(Object.keys(s.body.menu[0]).sort()).toEqual(['category', 'id', 'modifierGroups', 'name', 'price']);
    const nope = await get('/v1/public/shop/tidak-ada');
    expect(nope.status).toBe(404);
    expect(nope.body.message).toBe((await get('/v1/public/shop/Bad_Slug!')).body.message);
    await h.db.admin.query("update tenant set suspended_at = now() where id = 't1'");
    expect((await get('/v1/public/shop/kopi-o1')).status).toBe(404); // tenant ditangguhkan
    await h.db.admin.query("update tenant set suspended_at = null where id = 't1'");
  });

  it('memesan: harga dari server (kiriman pelanggan diabaikan), total dengan PBJT, validasi isian', async () => {
    const bad = async (body: Record<string, unknown>, status = 400) => expect((await order(body)).status, JSON.stringify(body)).toBe(status);
    await bad({ name: 'D' });
    await bad({ phone: '12' });
    await bad({ phone: 'abcdefghij' });
    await bad({ type: 'DELIVERY' });
    await bad({ type: 'DINE_IN' }); // tanpa meja
    await bad({ type: 'DINE_IN', tableNo: '99' }); // tidak ada di denah
    await bad({ items: [] });
    await bad({ items: [{ itemId: 'rahasia', qty: 1 }] }); // nonaktif
    await bad({ items: [{ itemId: 'teh', qty: 1 }] }); // ukuran wajib
    await bad({ items: [{ itemId: 'kopi', qty: 99 }] });
    await bad({ note: 'x'.repeat(201) });
    await bad({ name: 'Dewi', items: [{ itemId: 'kopi', qty: 1 }], website: undefined, phone: undefined });
    expect((await h.db.admin.query('select 1 from web_order')).rowCount).toBe(0);
    const ok = await order({ items: [{ itemId: 'kopi', qty: 2, unitPrice: 1, price: 1, total: 1 }, { itemId: 'teh', qty: 1, options: ['lrg'], note: 'less ice' }], total: 1, estimatedTotal: 1 });
    expect(ok.status).toBe(201);
    // (2 × 20.000 + 20.000) = 60.000 + PBJT 10% = 66.000
    expect(ok.body).toMatchObject({ code: 'W1', total: 66_000 });
    expect(ok.body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const row = (await h.db.admin.query<{ items: { unitPrice: number }[]; estimated_total: string }>('select items, estimated_total from web_order')).rows[0]!;
    expect(row.items.map((l) => l.unitPrice)).toEqual([20_000, 20_000]);
    expect(Number(row.estimated_total)).toBe(66_000);
  });

  it('batas nilai pesanan dan batas pesanan menunggu per nomor telepon', async () => {
    freshHour();
    await h.db.admin.query("update menu_item set price = 2_000_000 where id = 'kopi'");
    expect((await order({ items: [{ itemId: 'kopi', qty: 2 }] })).status).toBe(400); // 4.4 jt > 3 jt
    await h.db.admin.query("update menu_item set price = 20_000 where id = 'kopi'");
    // nomor yang sama boleh punya 3 pesanan menunggu; yang keempat ditahan sampai kasir menanggapi
    for (let i = 0; i < 3; i++) expect((await order({})).status).toBe(201);
    expect((await order({})).status).toBe(429);
    expect((await order({ phone: '0899 1111 2222' })).status).toBe(201); // nomor lain tidak terpengaruh
  });

  it('jebakan bot: isian website terisi pura-pura berhasil tanpa menyimpan; pembatas per alamat 6 pesanan per jam', async () => {
    freshHour();
    const before = Number((await h.db.admin.query<{ n: string }>('select count(*) as n from web_order')).rows[0]!.n);
    const trap = await order({ website: 'http://spam', phone: '0877 0000 0001' });
    expect(trap.status).toBe(201);
    expect(Number((await h.db.admin.query<{ n: string }>('select count(*) as n from web_order')).rows[0]!.n)).toBe(before);
    for (let i = 0; i < 6; i++) expect((await order({ phone: `0877 0000 00${10 + i}` })).status).toBe(201);
    expect((await order({ phone: '0877 0000 0099' })).status).toBe(429);
    freshHour();
    expect((await order({ phone: '0877 0000 0099' })).status).toBe(201);
    // semua pesanan di atas menunggu; kedaluwarsakan lewat jam supaya tes berikutnya bersih
    at(clock + 40 * MIN);
    expect(((await get('/v1/outlets/o1/web-orders', owner)).body as { status: string }[]).every((w) => w.status === 'EXPIRED')).toBe(true);
  });

  it('melacak pesanan: lewat token acak, tanpa data pribadi; token salah 404', async () => {
    freshHour();
    const o = await order({ type: 'DINE_IN', tableNo: '2', note: 'tanpa gula', items: [{ itemId: 'teh', qty: 1, options: ['reg'] }], phone: '0811 2223 3344' });
    expect(o.status).toBe(201);
    const t = await get(`/v1/public/web-orders/${o.body.token}`);
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ outletName: 'Kopi Satu', status: 'NEW', total: 16_500, type: 'DINE_IN', tableNo: '2', reason: null, items: [{ name: 'Teh Tarik', qty: 1, options: ['Regular'], note: null }] });
    expect(JSON.stringify(t.body)).not.toContain('0811');
    expect(JSON.stringify(t.body)).not.toContain('Dewi');
    expect((await get('/v1/public/web-orders/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await get('/v1/public/web-orders/pendek')).status).toBe(404);
    at(clock + 31 * MIN);
    expect((await get(`/v1/public/web-orders/${o.body.token}`)).body.status).toBe('EXPIRED');
  });

  it('terminal: daftar pesanan menunggu; klaim atomik sekali; yang kedaluwarsa tidak bisa diterima; hanya outlet dan terminal itu', async () => {
    freshHour();
    const a = await order({ phone: '0811 0000 0001', items: [{ itemId: 'teh', qty: 2, options: ['lrg'] }] });
    const code = a.body.code as string;
    const id = Number(code.slice(1));
    const list = (await get('/v1/web-orders/pending', term)).body;
    expect(list.orders).toHaveLength(1);
    expect(list.orders[0]).toMatchObject({ id, code, name: 'Dewi', phone: '0811 0000 0001', type: 'TAKE_AWAY', total: 44_000, items: [{ itemId: 'teh', qty: 2, unitPrice: 20_000, options: ['lrg'], optionNames: ['Large'] }] });
    expect((await get('/v1/web-orders/pending', kds)).status).toBe(403);
    expect((await get('/v1/web-orders/pending', rina)).status).toBe(403); // token pengguna bukan terminal
    expect((await get('/v1/web-orders/pending', term2)).body.orders).toEqual([]); // outlet lain
    expect((await post(`/v1/web-orders/${id}/accept`, term2)).status).toBe(409);
    expect((await post(`/v1/web-orders/${id}/accept`, kds)).status).toBe(403);
    const acc = await post(`/v1/web-orders/${id}/accept`, term);
    expect(acc.status).toBe(201);
    expect(acc.body).toEqual({ id, code, name: 'Dewi', type: 'TAKE_AWAY', items: [{ itemId: 'teh', name: 'Teh Tarik', qty: 2, options: ['lrg'] }] });
    expect((await post(`/v1/web-orders/${id}/accept`, term)).status).toBe(409); // sudah
    expect((await post(`/v1/web-orders/${id}/reject`, term, { reason: 'terlambat' })).status).toBe(409);
    expect((await get('/v1/web-orders/pending', term)).body.orders).toEqual([]);
    expect((await get(`/v1/public/web-orders/${a.body.token}`)).body.status).toBe('ACCEPTED');
    expect((await h.db.admin.query("select actor from audit_log where action = 'webshop.accept'")).rows).toEqual([{ actor: 'device:term-1' }]);
    // kedaluwarsa
    const b = await order({ phone: '0811 0000 0002' });
    at(clock + 31 * MIN);
    expect((await post(`/v1/web-orders/${Number(b.body.code.slice(1))}/accept`, term)).status).toBe(409);
    expect((await get('/v1/web-orders/pending', term)).body.orders).toEqual([]);
  });

  it('menolak: alasan wajib; dari terminal atau dashboard; pelanggan melihat alasannya; sekali saja', async () => {
    freshHour();
    const a = await order({ phone: '0811 0000 0003' });
    const b = await order({ phone: '0811 0000 0004' });
    const ida = Number(a.body.code.slice(1));
    const idb = Number(b.body.code.slice(1));
    expect((await post(`/v1/web-orders/${ida}/reject`, term, { reason: '' })).status).toBe(400);
    expect((await post(`/v1/web-orders/${ida}/reject`, term, { reason: 'Stok habis' })).status).toBe(201);
    expect((await get(`/v1/public/web-orders/${a.body.token}`)).body).toMatchObject({ status: 'REJECTED', reason: 'Stok habis' });
    expect((await post(`/v1/outlets/o1/web-orders/${idb}/reject`, ops, { reason: 'x' })).status).toBe(403);
    expect((await post(`/v1/outlets/o1/web-orders/${idb}/reject`, rina, { reason: 'Outlet tutup' })).status).toBe(201);
    expect((await post(`/v1/outlets/o1/web-orders/${idb}/reject`, rina, { reason: 'lagi' })).status).toBe(409);
    expect((await post(`/v1/outlets/o2/web-orders/${ida}/reject`, owner, { reason: 'salah outlet' })).status).toBe(409);
    expect((await post(`/v1/outlets/ox/web-orders/${ida}/reject`, owner, { reason: 'tenant lain' })).status).toBe(409);
    const l = (await get('/v1/outlets/o1/web-orders', owner)).body as { id: number; status: string; decidedBy: string; reason: string; phone: string }[];
    expect(l.find((w) => w.id === idb)).toMatchObject({ status: 'REJECTED', decidedBy: 'rina', reason: 'Outlet tutup' });
    expect(l.find((w) => w.id === ida)).toMatchObject({ decidedBy: 'device:term-1', phone: '0811 0000 0003' });
    expect((await get('/v1/outlets/o1/web-orders', ownerB)).status).toBe(404);
    expect((await get('/v1/outlets/o1/web-orders?days=99', owner)).status).toBe(400);
  });

  it('ingest: order.web_linked wajib webOrderId bulat', async () => {
    const s = new Sim('o1', '2026-10-08', 'term-1', 'sensor-1');
    const bad = async (p: unknown) => expect((await h.postEvents(term, [s.pos({ type: 'order.web_linked', payload: p } as never, WIB('2026-10-08T12:00:00'), 'budi')])).status).toBe(400);
    await bad({ orderId: 'x' });
    await bad({ orderId: 'x', webOrderId: 1.5 });
    await bad({ orderId: 'x', webOrderId: '7' });
    await bad({ orderId: '', webOrderId: 7 });
  });

  it('R45-R47 di insiden: tidak jadi order, di-void, dibayar jauh di bawah nilai, tautan palsu; yang wajar tidak ditandai', async () => {
    freshHour();
    const accept = async (phone: string, items: unknown[] = [{ itemId: 'kopi', qty: 2 }]) => {
      const o = await order({ phone, items });
      const id = Number(o.body.code.slice(1));
      expect((await post(`/v1/web-orders/${id}/accept`, term)).status).toBe(201);
      return id;
    };
    const t0 = clock;
    const okId = await accept('0822 0000 0001'); // 44.000
    const lostId = await accept('0822 0000 0002'); // tidak pernah dibuat jadi order
    const voidId = await accept('0822 0000 0003');
    const lowId = await accept('0822 0000 0004');
    const day = (ms: number) => ms;
    const ev = (order_: string, web: number, t: number, total?: number, void_ = false) => {
      sim.pos({ type: 'order.created', payload: { orderId: order_, orderType: 'TAKE_AWAY' } }, day(t), 'budi');
      sim.pos({ type: 'order.web_linked', payload: { orderId: order_, webOrderId: web } }, day(t + 1000), 'budi');
      if (total !== undefined) sim.pos({ type: 'payment.received', payload: { orderId: order_, method: 'CASH', amount: total } }, day(t + 5 * MIN), 'budi');
      if (void_) sim.pos({ type: 'void.approved', payload: { orderId: order_, reasonCode: 'SALAH', approverIds: ['rina'], amount: 44_000 } } as never, day(t + 6 * MIN), 'budi');
    };
    ev('w-ok', okId, t0 + MIN, 44_000);
    ev('w-void', voidId, t0 + 2 * MIN, undefined, true);
    ev('w-low', lowId, t0 + 3 * MIN, 12_000);
    ev('w-ghost', 9999, t0 + 4 * MIN, 5_000); // pesanan web yang tidak ada
    await sync();
    at(t0 + 20 * MIN);
    expect((await post('/v1/outlets/o1/evaluate', owner)).status).toBeLessThan(300);
    const r45 = await hits('R45');
    expect(r45.some((x) => x.note.includes(`#${lostId}`) && x.note.includes('tidak pernah dibuat'))).toBe(true);
    expect(r45.some((x) => x.note.includes('#9999'))).toBe(true);
    expect(r45.some((x) => x.note.includes(`#${okId}`))).toBe(false);
    expect((await hits('R46')).some((x) => x.note.includes(`#${voidId}`))).toBe(true);
    const r47 = await hits('R47');
    expect(r47.some((x) => x.note.includes(`#${lowId}`))).toBe(true);
    expect([...r45, ...r47].some((x) => x.note.includes(`#${okId}`))).toBe(false);
  });
});

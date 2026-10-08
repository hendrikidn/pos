import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformAdmin } from '../src/onboard';
import { createHarness, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);

describe('langganan dan penagihan', () => {
  let h: Harness;
  let admin: string;
  let owner: string;
  let ops: string;
  let ownerB: string;
  let term: string;

  const view = async (tok = owner) => (await h.http('GET', '/v1/billing', tok)).body;
  const a = (method: string, path: string, body?: unknown, tok = admin) => h.http(method, `/v1/admin${path}`, tok, body);

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-08T10:00:00'));
    admin = (await createPlatformAdmin(h.db, { id: 'hendrik', name: 'Hendrik' })).token;
    await h.admin.createTenant('t1', 'Kopi Satu');
    await h.admin.createTenant('t2', 'Kopi Dua');
    await h.admin.createTenant('pilot', 'Pilot Lama');
    await h.admin.createOutlet('t1', 'o1', 'Outlet 1');
    await h.admin.createOutlet('t2', 'o2', 'Outlet 2');
    await h.admin.createOutlet('pilot', 'op', 'Outlet Pilot');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    ops = await h.admin.createApiToken('t1', 'ops-1', 'OPS');
    ownerB = await h.admin.createApiToken('t2', 'owner-b', 'OWNER');
    term = await h.admin.createDevice('t1', 'o1', 'pos-1', 'terminal');
  });
  afterAll(() => h.close());

  it('tenant tanpa langganan (pilot) tidak ditagih: tampilan kosong dan tidak ada tagihan', async () => {
    const pilot = await h.admin.createApiToken('pilot', 'owner-p', 'OWNER');
    expect((await view(pilot)).body ?? await view(pilot)).toEqual({ subscription: null, invoices: [], paymentInfo: expect.any(String) });
    expect((await a('GET', '/billing')).body.tenants).toEqual([]);
  });

  it('admin memasukkan tenant ke penagihan: uji coba 14 hari (hari terakhir inklusif), sisa hari, belum ada tagihan', async () => {
    expect((await a('PUT', '/tenants/t1/subscription', { status: 'TRIAL' })).status).toBe(200);
    const v = await view();
    expect(v.subscription).toMatchObject({ planId: 'standard', status: 'TRIAL', trialEnd: '2026-10-21', trialDaysLeft: 14, outlets: 1, monthlyAmount: 199_000, paidThrough: null });
    expect(v.invoices).toEqual([]);
  });

  it('tagihan periode pertama terbit 7 hari sebelum uji coba usai; idempoten; memakai jumlah outlet saat terbit; tercatat di audit', async () => {
    h.setNow(WIB('2026-10-14T09:00:00')); // periode pertama mulai 22 Okt: 8 hari lagi
    expect((await view()).invoices).toEqual([]);
    h.setNow(WIB('2026-10-15T09:00:00'));
    await h.admin.createOutlet('t1', 'o1b', 'Outlet 1B'); // dua outlet saat terbit
    const v = await view();
    expect(v.invoices).toHaveLength(1);
    expect(v.invoices[0]).toMatchObject({ periodStart: '2026-10-22', periodEnd: '2026-11-21', outlets: 2, unitPrice: 199_000, amount: 398_000, status: 'ISSUED', dueDate: '2026-10-22', paidAt: null });
    expect(v.invoices[0].id).toMatch(/^INV-202610-0001$/);
    expect(v.subscription.status).toBe('TRIAL');
    expect((await view()).invoices).toHaveLength(1); // buka lagi: tidak menggandakan
    await h.admin.createOutlet('t1', 'o1c', 'Outlet 1C');
    expect((await view()).invoices[0].amount).toBe(398_000); // outlet tambahan tidak mengubah tagihan yang sudah terbit
    const audit = (await h.db.admin.query<{ detail: { period: string; amount: number } }>("select detail from audit_log where action = 'billing.issued'")).rows;
    expect(audit.map((x) => x.detail)).toEqual([{ period: '2026-10-22', amount: 398_000 }]);
  });

  it('pembayaran dicatat admin: lunas, langganan aktif sampai akhir periode; bayar ulang dan membatalkan yang lunas ditolak', async () => {
    h.setNow(WIB('2026-10-23T09:00:00'));
    const id = (await view()).invoices[0].id;
    expect((await a('POST', `/billing/invoices/${id}/pay`, { method: 'KARTU' })).status).toBe(400);
    expect((await a('POST', `/billing/invoices/${id}/pay`, { method: 'TRANSFER', reference: 'BCA-123456' })).status).toBe(201);
    const v = await view();
    expect(v.invoices[0]).toMatchObject({ status: 'PAID', payMethod: 'TRANSFER', payRef: 'BCA-123456' });
    expect(v.invoices[0].paidAt).toBeTruthy();
    expect(v.subscription).toMatchObject({ status: 'ACTIVE', paidThrough: '2026-11-21' });
    expect((await a('POST', `/billing/invoices/${id}/pay`, { method: 'TRANSFER' })).status).toBe(409);
    expect((await a('POST', `/billing/invoices/${id}/void`, { reason: 'salah terbit' })).status).toBe(409);
    expect((await a('POST', '/billing/invoices/INV-TIDAK-ADA/pay', { method: 'TRANSFER' })).status).toBe(404);
  });

  it('periode berikutnya terbit lagi sebulan kemudian; menunggu bayar lalu tertunggak setelah masa tenggang', async () => {
    h.setNow(WIB('2026-11-14T09:00:00')); // 22 Nov mulai: terbit 15 Nov
    expect((await view()).invoices).toHaveLength(1);
    h.setNow(WIB('2026-11-15T09:00:00'));
    const v = await view();
    expect(v.invoices.map((i: { periodStart: string; status: string }) => [i.periodStart, i.status])).toEqual([['2026-11-22', 'ISSUED'], ['2026-10-22', 'PAID']]);
    expect(v.invoices[0]).toMatchObject({ amount: 597_000, outlets: 3, dueDate: '2026-11-22' });
    expect(v.subscription.status).toBe('ACTIVE'); // periode lama masih tercakup
    h.setNow(WIB('2026-11-23T09:00:00'));
    expect((await view()).subscription.status).toBe('DUE');
    h.setNow(WIB('2026-11-29T09:00:00'));
    expect((await view()).subscription.status).toBe('DUE'); // jatuh tempo 22 Nov + 7 hari tenggang: hari terakhir masih menunggu
    h.setNow(WIB('2026-11-30T09:00:00'));
    expect((await view()).subscription.status).toBe('OVERDUE');
    const ov = (await a('GET', '/billing')).body;
    expect(ov.tenants).toEqual([{ tenantId: 't1', tenantName: 'Kopi Satu', planId: 'standard', trialEnd: '2026-10-21', status: 'OVERDUE', outstanding: 597_000, openInvoices: 1 }]);
    expect(ov.openInvoices.map((i: { tenantId: string }) => i.tenantId)).toEqual(['t1']);
  });

  it('membatalkan tagihan butuh alasan; setelah batal tidak lagi menunggak dan periode itu bisa terbit ulang dengan harga baru', async () => {
    const open = (await a('GET', '/billing')).body.openInvoices[0];
    expect((await a('POST', `/billing/invoices/${open.id}/void`, { reason: '' })).status).toBe(400);
    expect((await a('POST', `/billing/invoices/${open.id}/void`, { reason: 'salah jumlah outlet' })).status).toBe(201);
    expect((await a('PUT', '/plans/standard', { pricePerOutlet: 150_000 })).status).toBe(200);
    expect((await a('PUT', '/plans/standard', { pricePerOutlet: -1 })).status).toBe(400);
    expect((await a('PUT', '/plans/tidak-ada', { pricePerOutlet: 1 })).status).toBe(404);
    const v = await view();
    expect(v.subscription.status).toBe('DUE'); // tagihan batal tidak dihitung; periode berbayar sudah habis
    const live = v.invoices.filter((i: { status: string }) => i.status !== 'VOID');
    expect(live.map((i: { periodStart: string; amount: number; unitPrice: number }) => [i.periodStart, i.unitPrice, i.amount])).toEqual([['2026-11-22', 150_000, 450_000], ['2026-10-22', 199_000, 398_000]]);
    expect(v.invoices.find((i: { status: string }) => i.status === 'VOID').id).toBe(open.id);
  });

  it('admin menjalankan penagihan untuk semua tenant; menghentikan langganan menghentikan tagihan baru', async () => {
    expect((await a('PUT', '/tenants/t2/subscription', { status: 'TRIAL', trialEnd: '2026-12-10' })).status).toBe(200);
    h.setNow(WIB('2026-12-05T09:00:00')); // periode t2 mulai 11 Des; terbit 4 Des; periode t1 22 Des terbit 15 Des
    expect((await a('POST', '/billing/run')).body).toEqual({ issued: 1 }); // t2 saja (t1 baru terbit 15 Des)
    expect((await a('POST', '/billing/run')).body).toEqual({ issued: 0 });
    expect((await a('PUT', '/tenants/t1/subscription', { status: 'CANCELED' })).status).toBe(200);
    h.setNow(WIB('2026-12-20T09:00:00'));
    expect((await a('POST', '/billing/run')).body).toEqual({ issued: 0 });
    expect((await view()).subscription.status).toBe('CANCELED');
  });

  it('validasi pengaturan langganan oleh admin', async () => {
    expect((await a('PUT', '/tenants/t1/subscription', { planId: 'tidak-ada' })).status).toBe(400);
    expect((await a('PUT', '/tenants/t1/subscription', { status: 'ACTIVE' })).status).toBe(400);
    expect((await a('PUT', '/tenants/t1/subscription', { trialEnd: '8 Okt' })).status).toBe(400);
    expect((await a('PUT', '/tenants/tidak-ada/subscription', { status: 'TRIAL' })).status).toBe(404);
  });

  it('akses: hanya owner melihat tagihan sendiri; ops, terminal, tanpa token, dan tenant lain ditolak; endpoint admin tertutup bagi selain admin', async () => {
    expect((await h.http('GET', '/v1/billing', ops)).status).toBe(403);
    expect((await h.http('GET', '/v1/billing', term)).status).toBe(403);
    expect((await h.http('GET', '/v1/billing')).status).toBe(401);
    const id = (await view()).invoices[0].id;
    expect((await h.http('GET', `/v1/billing/invoices/${id}`, owner)).body).toMatchObject({ tenantName: 'Kopi Satu', invoice: { id } });
    expect((await h.http('GET', `/v1/billing/invoices/${id}`, ownerB)).status).toBe(404);
    expect((await h.http('GET', '/v1/admin/billing', owner)).status).toBe(403);
    expect((await h.http('POST', '/v1/admin/billing/run', ownerB)).status).toBe(403);
    expect((await h.http('PUT', '/v1/admin/plans/standard', owner, { pricePerOutlet: 1 })).status).toBe(403);
    expect((await h.http('GET', '/v1/admin/billing')).status).toBe(401);
    const b = await view(ownerB);
    expect(b.invoices.every((i: { id: string }) => i.id !== id)).toBe(true);
  });
});

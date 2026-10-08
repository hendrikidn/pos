import { describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { amountTolerance, findingToHit, parseChannelReport, parseReportDate, posOnlineOrders, reconcileChannel, type PosOnlineOrder, type PlatformRow } from '../src/channel-report';

describe('parseReportDate', () => {
  it('berbagai format tanggal laporan platform', () => {
    for (const [v, d] of [['2026-10-02', '2026-10-02'], ['2026-10-02 14:33:10', '2026-10-02'], ['02/10/2026', '2026-10-02'], ['2-10-2026 08:00', '2026-10-02'], ['02.10.2026', '2026-10-02'], ['2 Okt 2026', '2026-10-02'], ['15 Agustus 2026', '2026-08-15'], ['3 Dec 2026 10:00', '2026-12-03']] as const) expect(parseReportDate(v), v).toBe(d);
    for (const v of ['', 'kemarin', '31/02/2026', '2026-13-01', '10/13/2026', '2 Xyz 2026']) expect(parseReportDate(v), v).toBeNull();
  });
});

describe('parseChannelReport', () => {
  it('kolom berbahasa Indonesia dengan titik koma, harga berformat, komisi bertanda minus', () => {
    const p = parseChannelReport('No Pesanan;Tanggal;Harga;Komisi;Diterima\nGF-1001;02/10/2026;"45.000";"-9.000";"36.000"\nGF-1002;2026-10-03;30000;6000;24000\n');
    expect(p.errors).toEqual([]);
    expect(p.rows).toEqual([
      { line: 2, ref: 'GF-1001', date: '2026-10-02', gross: 45_000, commission: 9_000, net: 36_000 },
      { line: 3, ref: 'GF-1002', date: '2026-10-03', gross: 30_000, commission: 6_000, net: 24_000 },
    ]);
  });

  it('net atau komisi dilengkapi dari kolom lain; hanya net tanpa gross dihitung gross = net + komisi', () => {
    expect(parseChannelReport('order id,date,gross\nA-100,2026-10-02,50000\n').rows[0]).toMatchObject({ gross: 50_000, commission: 0, net: 50_000 });
    expect(parseChannelReport('order id,date,gross,commission\nA-100,2026-10-02,50000,10000\n').rows[0]).toMatchObject({ net: 40_000 });
    expect(parseChannelReport('order id,date,net,commission\nA-100,2026-10-02,40000,10000\n').rows[0]).toMatchObject({ gross: 50_000, net: 40_000 });
  });

  it('kesalahan per baris dengan nomor baris; nomor kembar ditolak; baris sah tetap terbaca', () => {
    const p = parseChannelReport('order id,tanggal,harga\nA-1,2026-10-02,1000\n,2026-10-02,1000\nA-2,kemarin,1000\nA-3,2026-10-02,gratis\nA-1,2026-10-03,1000\n');
    expect(p.errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
    expect(p.errors[3]!.message).toContain('kembar dengan baris 2');
    expect(p.rows.map((r) => r.ref)).toEqual(['A-1']);
  });

  it('judul tidak lengkap, kosong, tanpa baris, atau terlalu besar ditolak seluruhnya', () => {
    expect(parseChannelReport('foo,bar\n1,2').errors).toHaveLength(3);
    expect(parseChannelReport('order id,tanggal\nA-1,2026-10-02').errors[0]!.message).toContain('nilai pesanan');
    expect(parseChannelReport('').errors[0]!.message).toBe('berkas kosong');
    expect(parseChannelReport('order id,tanggal,harga\n').errors[0]!.message).toBe('tidak ada baris pesanan');
    expect(parseChannelReport('order id,tanggal,harga\n' + 'x'.repeat(1_100_000)).errors[0]!.message).toContain('KB');
  });
});

const at = (d: string, hms: string) => Date.parse(`${d}T${hms}+07:00`);
function posSim(): Sim {
  const s = new Sim('o1', '2026-10-02', 'term-1', 'sensor-1');
  const order = (id: string, d: string, hms: string, channel: 'GOFOOD' | 'GRABFOOD', ref: string, subtotal: number, actor = 'budi') => {
    s.pos({ type: 'order.created', payload: { orderId: id, orderType: 'TAKE_AWAY' } }, at(d, hms), actor);
    s.pos({ type: 'order.channel_linked', payload: { orderId: id, channel, ref } }, at(d, hms), actor);
    s.pos({ type: 'bill.printed', payload: { orderId: id, total: Math.round(subtotal * 1.1), breakdown: { subtotal, discount: 0, service: 0, tax: Math.round(subtotal * 0.1), rounding: 0 } } }, at(d, hms), actor);
    s.pos({ type: 'payment.received', payload: { orderId: id, method: 'PLATFORM', amount: Math.round(subtotal * 1.1) } }, at(d, hms), actor);
  };
  order('a', '2026-10-02', '12:00:00', 'GOFOOD', 'GF-1', 45_000);
  order('b', '2026-10-02', '13:00:00', 'GOFOOD', 'GF-2', 30_000, 'sari');
  order('c', '2026-10-03', '12:00:00', 'GOFOOD', 'GF-3', 80_000);
  order('d', '2026-10-03', '15:00:00', 'GRABFOOD', 'GR-1', 25_000);
  // order void: tidak dihitung
  order('v', '2026-10-02', '16:00:00', 'GOFOOD', 'GF-VOID', 99_000);
  s.pos({ type: 'void.approved', payload: { orderId: 'v', reasonCode: 'WRONG_ORDER', approverIds: ['hendra'], amount: 108_900 } }, at('2026-10-02', '16:05:00'), 'budi');
  return s;
}
const row = (ref: string, date: string, gross: number, line = 2): { channel: 'GOFOOD'; row: PlatformRow } => ({ channel: 'GOFOOD', row: { line, ref, date, gross, commission: 0, net: gross } });

describe('posOnlineOrders', () => {
  it('order online dibayar Platform; void dikecualikan; nilai = subtotal tagihan; hari menurut zona outlet', () => {
    const o = posOnlineOrders(posSim().events, 420);
    expect(o.map((x) => [x.orderId, x.channel, x.ref, x.date, x.amount])).toEqual([
      ['a', 'GOFOOD', 'GF-1', '2026-10-02', 45_000], ['b', 'GOFOOD', 'GF-2', '2026-10-02', 30_000], ['c', 'GOFOOD', 'GF-3', '2026-10-03', 80_000], ['d', 'GRABFOOD', 'GR-1', '2026-10-03', 25_000],
    ]);
    expect(o[1]).toMatchObject({ actorId: 'sari', terminalId: 'term-1' });
  });
});

describe('reconcileChannel', () => {
  const orders = (): PosOnlineOrder[] => posOnlineOrders(posSim().events, 420);
  const run = (rows: { channel: 'GOFOOD'; row: PlatformRow }[], fromDate = '2026-10-01') => reconcileChannel({ orders: orders(), rows, fromDate, nowMs: at('2026-10-04', '09:00:00') });

  it('cocok semua: tanpa temuan (nomor dicocokkan tanpa peduli huruf, selisih kecil ditoleransi)', () => {
    expect(run([row('gf-1', '2026-10-02', 45_500), row('GF-2', '2026-10-02', 30_000), row('GF-3', '2026-10-03', 80_000)])).toEqual([]);
  });

  it('di POS tetapi tidak di laporan platform pada hari yang tercakup: pesanan fiktif; kanal lain tidak ikut diperiksa', () => {
    const f = run([row('GF-1', '2026-10-02', 45_000), row('GF-3', '2026-10-03', 80_000)]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'MISSING_ON_PLATFORM', ref: 'GF-2', orderId: 'b', actorId: 'sari' });
    expect(f[0]!.note).toContain('2026-10-02 s/d 2026-10-03');
  });

  it('hari di luar cakupan laporan tidak dituduh hilang', () => {
    expect(run([row('GF-1', '2026-10-02', 45_000), row('GF-2', '2026-10-02', 30_000)])).toEqual([]); // GF-3 tanggal 3 di luar [2, 2]
  });

  it('nilai berbeda melebihi toleransi; di dalam toleransi tidak', () => {
    const f = run([row('GF-1', '2026-10-02', 60_000), row('GF-2', '2026-10-02', 30_400), row('GF-3', '2026-10-03', 80_000)]);
    expect(f.map((x) => [x.kind, x.ref])).toEqual([['AMOUNT_MISMATCH', 'GF-1']]);
    expect(amountTolerance(30_000)).toBe(1_000);
    expect(amountTolerance(200_000)).toBe(3_000);
  });

  it('dibayar platform tetapi tidak ada di POS: tidak diketik', () => {
    const f = run([row('GF-1', '2026-10-02', 45_000), row('GF-2', '2026-10-02', 30_000), row('GF-3', '2026-10-03', 80_000), row('GF-404', '2026-10-03', 55_000)]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'UNRECORDED_IN_POS', ref: 'GF-404', orderId: null });
    expect(run([row('GF-1', '2026-10-02', 45_000), row('GF-404', '2026-09-20', 55_000)], '2026-10-01').every((x) => x.ref !== 'GF-404')).toBe(true); // di luar jendela data
  });

  it('temuan menjadi RuleHit dengan aturan dan bobot menurut jenis', () => {
    const [m] = run([row('GF-1', '2026-10-02', 45_000), row('GF-3', '2026-10-03', 80_000)]);
    expect(findingToHit(m!, 'o1')).toMatchObject({ rule: 'R37', weight: 50, outletId: 'o1', orderId: 'b', actorIds: ['sari'], confidence: 'HIGH' });
    const [x] = run([row('GF-1', '2026-10-02', 90_000), row('GF-2', '2026-10-02', 30_000), row('GF-3', '2026-10-03', 80_000)]);
    expect(findingToHit(x!, 'o1')).toMatchObject({ rule: 'R38', confidence: 'LOW' });
    const [u] = run([row('GF-1', '2026-10-02', 45_000), row('GF-2', '2026-10-02', 30_000), row('GF-3', '2026-10-03', 80_000), row('X-1', '2026-10-03', 5_000)]);
    expect(findingToHit(u!, 'o1')).toMatchObject({ rule: 'R39', weight: 25 });
  });

  it('nomor yang dipakai dua order: yang pertama menjadi pasangan platform, tidak ada temuan ganda dari pencocokan', () => {
    const base = orders();
    const dup: PosOnlineOrder = { ...base[0]!, orderId: 'dup', at: base[0]!.at + 1000, amount: 999_999 }; // nomor GF-1 lagi, nilai berbeda jauh
    const f = reconcileChannel({ orders: [...base, dup], rows: [row('GF-1', '2026-10-02', 45_000), row('GF-2', '2026-10-02', 30_000), row('GF-3', '2026-10-03', 80_000)], fromDate: '2026-10-01', nowMs: at('2026-10-04', '09:00:00') });
    expect(f).toEqual([]);
  });
});

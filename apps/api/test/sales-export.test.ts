import { describe, expect, it } from 'vitest';
import { Sim } from '@pos/sim';
import { buildExport, csvCell, toCsv, type ExportKind } from '../src/sales-export';
import { startOfLocalDay, DAY_MS } from '../src/sales-report';

const D1 = '2026-10-01';
const D2 = '2026-10-02';
const NOW = Date.parse('2026-10-03T09:00:00+07:00');

function run(kind: ExportKind, s: Sim, from = D1, to = D2) {
  return buildExport(kind, { events: s.events, from, to, utcOffsetMinutes: 420, now: NOW, fromMs: startOfLocalDay(from, 420), toMs: startOfLocalDay(to, 420) + DAY_MS });
}
const line = (itemId: string, name: string, qty: number, unitPrice: number, extra: Record<string, unknown> = {}) => ({ itemId, name, qty, unitPrice, ...extra });

/** Dua hari: order dine-in meja 5 (diskon promo, member, bayar tunai + QRIS), take-away, order di-void, makan karyawan, refund. */
function sample(): Sim {
  const s = new Sim('o1', D1, 'term-1', 'sensor-1');
  const at = (day: string, hms: string) => Date.parse(`${day}T${hms}+07:00`);
  s.pos({ type: 'order.created', payload: { orderId: 'a', orderType: 'DINE_IN', tableNo: '5' } }, at(D1, '10:00:00'), 'budi');
  s.pos({ type: 'order.table_changed', payload: { orderId: 'a', from: '5', to: '6' } }, at(D1, '10:01:00'), 'budi');
  s.pos({ type: 'order.member_linked', payload: { orderId: 'a', memberId: 'm1' } }, at(D1, '10:02:00'), 'budi');
  s.pos({ type: 'discount.applied', payload: { orderId: 'a', kind: 'PROMO', promoId: 'hemat10', amount: 4_400, percent: 10, verified: true } }, at(D1, '10:03:00'), 'budi');
  s.pos({
    type: 'bill.printed',
    payload: { orderId: 'a', total: 43_560, items: [line('kopi', 'Kopi Susu', 2, 22_000, { options: [{ group: 'Ukuran', name: 'Large', price: 0 }], note: 'es sedikit' })], breakdown: { subtotal: 44_000, discount: 4_400, service: 0, tax: 3_960, rounding: 0 } },
  }, at(D1, '10:04:00'), 'budi');
  s.pos({ type: 'payment.received', payload: { orderId: 'a', method: 'CASH', amount: 20_000 } }, at(D1, '10:05:00'), 'budi');
  s.pos({ type: 'payment.received', payload: { orderId: 'a', method: 'QRIS', amount: 23_560, tid: '12345678' } }, at(D1, '10:06:00'), 'budi');
  s.pos({ type: 'order.created', payload: { orderId: 'b', orderType: 'TAKE_AWAY' } }, at(D2, '09:00:00'), 'sari');
  s.pos({ type: 'bill.printed', payload: { orderId: 'b', total: 20_000, items: [line('=HYPERLINK("http://x")', '=SUM(A1)', 1, 20_000)] } }, at(D2, '09:01:00'), 'sari');
  s.pos({ type: 'payment.received', payload: { orderId: 'b', method: 'CASH', amount: 20_000 } }, at(D2, '09:02:00'), 'sari');
  s.pos({ type: 'refund.created', payload: { refundId: 'b-R1', originalOrderId: 'b', amount: 5_000, method: 'CASH', approverId: 'hendra' } }, at(D2, '09:10:00'), 'sari');
  s.pos({ type: 'order.created', payload: { orderId: 'v', orderType: 'TAKE_AWAY' } }, at(D2, '10:00:00'), 'sari');
  s.pos({ type: 'payment.received', payload: { orderId: 'v', method: 'CASH', amount: 50_000 } }, at(D2, '10:01:00'), 'sari');
  s.pos({ type: 'void.approved', payload: { orderId: 'v', reasonCode: 'WRONG_ORDER', approverIds: ['hendra'], amount: 50_000 } }, at(D2, '10:05:00'), 'sari');
  s.pos({ type: 'order.created', payload: { orderId: 'e', orderType: 'EMPLOYEE', employeeId: 'andi' } }, at(D2, '11:00:00'), 'sari');
  s.pos({ type: 'payment.received', payload: { orderId: 'e', method: 'CASH', amount: 10_000 } }, at(D2, '11:01:00'), 'sari');
  return s;
}

describe('csvCell dan toCsv', () => {
  it('kutip untuk koma, tanda kutip, dan baris baru; angka apa adanya', () => {
    expect(csvCell('Kopi, susu')).toBe('"Kopi, susu"');
    expect(csvCell('Dia berkata "halo"')).toBe('"Dia berkata ""halo"""');
    expect(csvCell('baris\nbaru')).toBe('"baris\nbaru"');
    expect(csvCell(22_000)).toBe('22000');
    expect(csvCell(-500)).toBe('-500');
    expect(csvCell(NaN)).toBe('');
  });

  it('nilai teks yang diawali = + - @ tab CR dibuat teks biasa (anti injeksi rumus), angka negatif tetap angka', () => {
    for (const v of ['=SUM(A1)', '+62812', '-1+1', '@cmd', '\t=x', '\r=x']) expect(csvCell(v).replace(/^"/, '')).toMatch(/^'/);
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('Kopi =enak')).toBe('Kopi =enak'); // hanya karakter pertama yang berbahaya
  });

  it('BOM di awal, CRLF, baris judul lalu data', () => {
    const csv = toCsv({ header: ['A', 'B'], rows: [[1, 'x'], [2, 'y,z']] });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('A,B\r\n1,x\r\n2,"y,z"\r\n');
  });
});

describe('ekspor penjualan', () => {
  it('transaksi: satu baris per order terhitung dengan rincian tagihan, meja terakhir, metode gabungan, diskon, dan member; void dan karyawan tidak ikut', () => {
    const t = run('transactions', sample());
    expect(t.rows.map((r) => r[2])).toEqual(['a', 'b']);
    const [a, b] = t.rows;
    expect(a).toEqual(['2026-10-01', '10:05:00', 'a', 'Dine-in', '6', 'budi', 'term-1', 44_000, 4_400, 0, 3_960, 0, 43_560, 43_560, 'Tunai + QRIS', 'Promo hemat10', 'm1']);
    expect(b).toEqual(['2026-10-02', '09:02:00', 'b', 'Take-away', '', 'sari', 'term-1', '', '', '', '', '', 20_000, 20_000, 'Tunai', '', '']);
    expect(t.header).toHaveLength(a!.length);
  });

  it('pembayaran: satu baris per pembayaran dengan TID; hanya order terhitung dan hanya yang di rentang', () => {
    const p = run('payments', sample());
    expect(p.rows.map((r) => [r[2], r[3], r[4], r[5]])).toEqual([['a', 'Tunai', 20_000, ''], ['a', 'QRIS', 23_560, '12345678'], ['b', 'Tunai', 20_000, '']]);
    expect(run('payments', sample(), D2, D2).rows.map((r) => r[2])).toEqual(['b']);
    expect(p.header).toHaveLength(p.rows[0]!.length);
  });

  it('item: dari tagihan dengan pilihan dan catatan; sel berbahaya diberi apostrof saat dijadikan CSV', () => {
    const i = run('items', sample());
    expect(i.rows[0]).toEqual(['2026-10-01', '10:05:00', 'a', 'kopi', 'Kopi Susu', 'Large', 'es sedikit', 2, 22_000, 44_000]);
    const csv = toCsv(i);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).not.toMatch(/(^|,)=SUM/m);
  });

  it('pengecualian: void (setelah dibayar), refund, dan diskon dengan penyetuju dan alasan', () => {
    const x = run('exceptions', sample());
    expect(x.rows.map((r) => [r[2], r[3], r[6]])).toEqual([['Diskon', 'a', 4_400], ['Refund', 'b', 5_000], ['Void setelah dibayar', 'v', 50_000]]);
    expect(x.rows.find((r) => r[2] === 'Void setelah dibayar')).toMatchObject({ 4: 'sari', 5: 'hendra', 7: 'WRONG_ORDER' });
    expect(x.rows.find((r) => r[2] === 'Diskon')![7]).toBe('PROMO hemat10 · 10%');
  });

  it('harian: semua hari di rentang termasuk yang kosong; refund mengurangi penjualan bersih', () => {
    const d = run('daily', sample(), D1, '2026-10-03');
    expect(d.rows).toEqual([
      ['2026-10-01', 1, 43_560, 0, 43_560, 43_560, 4_400],
      ['2026-10-02', 1, 20_000, 5_000, 15_000, 20_000, 0],
      ['2026-10-03', 0, 0, 0, 0, 0, 0],
    ]);
  });

  it('rentang kosong menghasilkan hanya judul', () => {
    for (const k of ['transactions', 'payments', 'items', 'exceptions'] as const) expect(run(k, new Sim('o1', D1), D1, D1).rows).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventChain, type PosEvent } from '@pos/events';
import { createHarness, type Harness } from './harness';

const slipText = readFileSync(resolve(__dirname, '../../../fixtures/bank-reports/mandiri-settlement-slip-2026-10-01.txt'), 'utf8');
const WIB = (iso: string) => Date.parse(`${iso}+07:00`);
const TID = '12345678';

/** Pembayaran POS yang persis sama dengan slip: 29 QRIS (28 × 26.000 + 1 × 42.000 = 770.000) dan 1 kartu kredit 15.000. */
function matchingEvents(chain: EventChain, date = '2026-10-01', prefix = 'o'): PosEvent[] {
  const events: PosEvent[] = [];
  for (let i = 0; i < 29; i++) {
    const at = WIB(`${date}T08:00:00`) + i * 20 * 60_000;
    events.push(chain.append({
      type: 'payment.received', deviceTime: at, actorId: 'budi',
      payload: { orderId: `${prefix}-${i}`, method: 'QRIS', amount: i === 28 ? 42_000 : 26_000, tid: TID },
    }));
  }
  events.push(chain.append({
    type: 'payment.received', deviceTime: WIB(`${date}T12:05:00`), actorId: 'budi',
    payload: { orderId: `${prefix}-card`, method: 'EDC_CREDIT', amount: 15_000, tid: TID },
  }));
  return events;
}

describe('settlement EDC lewat API', () => {
  let h: Harness;
  let owner: string;
  let manager: string;
  let tokens: Record<string, string> = {};

  const EDCS = [{ tid: TID, bank: 'Mandiri', label: 'EDC Mandiri' }];
  const upload = (outlet: string, body: unknown, token = owner) => h.http('POST', `/v1/outlets/${outlet}/settlements`, token, body);
  const incidents = async (outlet: string) => (await h.http('GET', `/v1/outlets/${outlet}/incidents`, owner)).body as {
    score: number; level: string; order_ids: string[]; actor_ids: string[]; hits: { rule: string; note: string; evidence?: { orderId: string }[] }[];
  }[];

  async function outletWith(id: string, events: (c: EventChain) => PosEvent[]) {
    await h.admin.createOutlet('t1', id, `Outlet ${id}`, { terminals: [`pos-${id}`], capabilities: { sensor: false, kds: false, printerReportsStatus: true } });
    await h.http('PUT', `/v1/outlets/${id}/settings`, owner, { merchantName: id, edcs: EDCS });
    tokens[id] = await h.admin.createDevice('t1', id, `pos-${id}`, 'terminal');
    const evs = events(new EventChain(`pos-${id}`, id));
    expect((await h.postEvents(tokens[id]!, evs)).status).toBe(201);
  }

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-02T09:00:00'));
    await h.admin.createTenant('t1', 'Tenant 1');
    owner = await h.admin.createApiToken('t1', 'owner-1', 'OWNER');
    manager = await h.admin.createApiToken('t1', 'rina', 'MANAGER');
    await outletWith('oa', (c) => matchingEvents(c)); // POS = slip
  });
  afterAll(() => h.close());

  it('slip asli (teks) cocok dengan POS: tidak ada temuan dan tidak ada insiden', async () => {
    const r = await upload('oa', { text: slipText });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ batches: 1, findings: 0, warnings: [] });
    expect(await incidents('oa')).toEqual([]);

    const list = (await h.http('GET', '/v1/outlets/oa/settlements', owner)).body;
    expect(list.batches).toHaveLength(1);
    expect(list.batches[0]).toMatchObject({ tid: TID, batch: '000344', bank: 'MANDIRI' });
    const rows = list.batches[0].result.channels as { channel: string; ok: boolean; pos: { count: number; amount: number } }[];
    expect(rows.every((c) => c.ok)).toBe(true);
    expect(rows.find((c) => c.channel === 'QRIS')!.pos).toEqual({ count: 29, amount: 770_000 });
    expect(list.edcs[0]).toMatchObject({ tid: TID, last_closed_at_ms: WIB('2026-10-01T21:57:19') });
  });

  it('mengunggah slip yang sama lagi menggantikan dan tercatat di audit', async () => {
    const r = await upload('oa', { text: slipText });
    expect(r.body.warnings[0]).toMatch(/sudah pernah diunggah/);
    const audit = (await h.db.admin.query<{ action: string }>("select action from audit_log where action = 'settlement.replace'")).rows;
    expect(audit).toHaveLength(1);
    expect((await h.http('GET', '/v1/outlets/oa/settlements', owner)).body.batches).toHaveLength(1);
  });

  it('isian terstruktur menghasilkan hasil yang sama dengan teks slip', async () => {
    await outletWith('ob', (c) => matchingEvents(c));
    const r = await upload('ob', {
      slip: { tid: TID, batch: '000344', closedAt: '2026-10-01T21:57:19+07:00', channels: { QRIS: { sale: { count: 29, amount: 770_000 } }, CARD_CREDIT: { sale: { count: 1, amount: 15_000 } } } },
    });
    expect(r.status).toBe(201);
    expect(r.body.findings).toBe(0);
  });

  it('QRIS pribadi: POS mencatat satu QRIS yang tidak masuk EDC → insiden terikat ke order itu', async () => {
    await outletWith('oc', (c) => {
      const base = matchingEvents(c);
      return [...base, c.append({
        type: 'payment.received', deviceTime: WIB('2026-10-01T14:30:10'), actorId: 'siti',
        payload: { orderId: 'ghost-1', method: 'QRIS', amount: 64_000, tid: TID },
      })];
    });
    const r = await upload('oc', { text: slipText });
    expect(r.body.findings).toBe(1);
    const [inc] = await incidents('oc');
    expect(inc).toMatchObject({ order_ids: ['ghost-1'], actor_ids: ['siti'] });
    expect(inc!.hits[0]).toMatchObject({ rule: 'R27' });
    expect(inc!.hits[0]!.note).toMatch(/POS 30 transaksi Rp 834\.000 vs slip 29 transaksi Rp 770\.000/);
    expect(inc!.score).toBe(Math.round(35 * 1.4)); // R27 mengaitkan bank dan POS: pengali 1,4
  });

  it('jika beberapa order sama-sama mungkin, insiden tidak diikat ke satu order dan semua kandidat dicantumkan', async () => {
    await outletWith('od', (c) => {
      const base = matchingEvents(c);
      const dup = (id: string, hms: string) => c.append({
        type: 'payment.received', deviceTime: WIB(`2026-10-01T${hms}`), actorId: 'budi',
        payload: { orderId: id, method: 'QRIS', amount: 26_000, tid: TID },
      });
      return [...base, dup('maybe-1', '15:00:00'), dup('maybe-2', '16:00:00')]; // satu dari sekian QRIS 26.000 tidak ada di EDC
    });
    // POS 31 transaksi Rp 822.000 vs slip 29 / 770.000: selisih 2 transaksi Rp 52.000 = 2 × 26.000, banyak kombinasi
    await upload('od', { text: slipText });
    const [inc] = await incidents('od');
    expect(inc!.order_ids).toEqual([]);
    expect(inc!.hits[0]!.note).toMatch(/kemungkinan kombinasi/);
    expect(inc!.hits[0]!.evidence!.length).toBeGreaterThanOrEqual(2);
  });

  it('kartu kredit dicatat sebagai QRIS → R28 berbobot rendah, bukan tuduhan selisih', async () => {
    await outletWith('oe', (c) => {
      const events: PosEvent[] = [];
      for (let i = 0; i < 29; i++) {
        events.push(c.append({ type: 'payment.received', deviceTime: WIB('2026-10-01T08:00:00') + i * 20 * 60_000, actorId: 'budi', payload: { orderId: `q-${i}`, method: 'QRIS', amount: i === 28 ? 42_000 : 26_000, tid: TID } }));
      }
      // kartu kredit Rp 15.000 salah dipilih sebagai QRIS
      events.push(c.append({ type: 'payment.received', deviceTime: WIB('2026-10-01T12:05:00'), actorId: 'budi', payload: { orderId: 'salah-metode', method: 'QRIS', amount: 15_000, tid: TID } }));
      return events;
    });
    await upload('oe', { text: slipText });
    const [inc] = await incidents('oe');
    expect(inc!.hits).toHaveLength(1);
    expect(inc!.hits[0]!.rule).toBe('R28');
    expect(inc!.level).toBe('LOW');
    expect(inc!.order_ids).toEqual(['salah-metode']);
  });

  it('digabung dengan bukti lain pada order yang sama: void setelah pembayaran QR yang tidak masuk EDC', async () => {
    await outletWith('of', (c) => {
      const base = matchingEvents(c);
      const t = (hms: string) => WIB(`2026-10-01T${hms}`);
      return [
        ...base,
        c.append({ type: 'order.created', deviceTime: t('14:20:00'), actorId: 'siti', payload: { orderId: 'ghost-2', orderType: 'TAKE_AWAY' } }),
        c.append({ type: 'order.sent_to_kitchen', deviceTime: t('14:20:10'), actorId: 'siti', payload: { orderId: 'ghost-2' } }),
        c.append({ type: 'payment.received', deviceTime: t('14:21:00'), actorId: 'siti', payload: { orderId: 'ghost-2', method: 'QRIS', amount: 41_800, tid: TID } }),
        c.append({ type: 'void.approved', deviceTime: t('14:31:00'), actorId: 'siti', payload: { orderId: 'ghost-2', reasonCode: 'CUSTOMER_CANCEL', approverIds: ['hendra'], amount: 41_800 } }),
      ];
    });
    await upload('of', { text: slipText });
    const [inc] = await incidents('of');
    expect(inc!.order_ids).toEqual(['ghost-2']);
    expect(inc!.hits.map((x) => x.rule).sort()).toEqual(['R2', 'R27']);
    expect(inc!.level).toBe('CRITICAL');
    expect(inc!.actor_ids).toEqual(expect.arrayContaining(['siti', 'hendra']));
  });

  it('batch berikutnya dimulai dari penutupan batch sebelumnya: pembayaran lama tidak dihitung dua kali', async () => {
    await outletWith('og', (c) => {
      const day1 = matchingEvents(c, '2026-10-01', 'd1');
      const day2 = [c.append({ type: 'payment.received', deviceTime: WIB('2026-10-02T08:30:00'), actorId: 'budi', payload: { orderId: 'd2-0', method: 'QRIS', amount: 30_000, tid: TID } })];
      return [...day1, ...day2];
    });
    await upload('og', { text: slipText });
    const second = await upload('og', {
      slip: { tid: TID, batch: '000345', closedAt: '2026-10-02T08:45:00+07:00', channels: { QRIS: { sale: { count: 1, amount: 30_000 } } } },
    });
    expect(second.body.findings).toBe(0);
    expect(await incidents('og')).toEqual([]);
    const batches = (await h.http('GET', '/v1/outlets/og/settlements', owner)).body.batches;
    expect(batches.map((b: { batch: string }) => b.batch)).toEqual(['000345', '000344']);
    expect(batches[0].result.notes).toEqual([]); // batas awal diketahui dari batch sebelumnya
    expect(batches[1].result.notes[0]).toMatch(/diasumsikan awal hari/); // batch pertama: tidak ada pendahulu
  });

  describe('penolakan', () => {
    it('TID yang tidak terdaftar ditolak dengan pesan jelas', async () => {
      const r = await upload('oa', { text: slipText.replaceAll('12345678', '99999999') });
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/TID 99999999 tidak terdaftar/);
    });

    it('teks bukan slip, isian kosong, dan isian tidak valid', async () => {
      expect((await upload('oa', { text: 'halo' })).status).toBe(400);
      expect((await upload('oa', {})).body.message).toMatch(/kirim `text`/);
      const slip = (over: object) => ({ slip: { tid: TID, batch: '9', closedAt: '2026-10-01T21:00:00+07:00', channels: { QRIS: { sale: { count: 1, amount: 1000 } } }, ...over } });
      expect((await upload('oa', slip({ closedAt: '2026-10-01T21:00:00' }))).body.message).toMatch(/zona waktu/);
      expect((await upload('oa', slip({ batch: 'abc' }))).status).toBe(400);
      expect((await upload('oa', slip({ channels: { QRIS: { sale: { count: 2, amount: 0 } } } }))).body.message).toMatch(/sama-sama/);
      expect((await upload('oa', slip({ channels: { QRIS: { sale: { count: 1, amount: 12.5 } } } }))).status).toBe(400);
      expect((await upload('oa', slip({ channels: { DANA: { sale: { count: 1, amount: 1000 } } } }))).body.message).toMatch(/tidak dikenal/);
      expect((await upload('oa', slip({ channels: {} }))).body.message).toMatch(/minimal satu/);
    });

    it('MANAGER hanya membaca; perangkat tidak boleh', async () => {
      expect((await upload('oa', { text: slipText }, manager)).status).toBe(403);
      expect((await h.http('GET', '/v1/outlets/oa/settlements', manager)).status).toBe(200);
      expect((await h.http('GET', '/v1/outlets/oa/settlements', tokens['oa'])).status).toBe(403);
    });
  });
});

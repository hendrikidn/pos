import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Incident } from '@pos/rules';
import { Sim } from '@pos/sim';
import { renderIncidentMessage, WhatsAppChannel } from '../src/notification.service';
import { createHarness, RecordingChannel, type Harness } from './harness';

const WIB = (iso: string) => Date.parse(`${iso}+07:00`);

async function seed(h: Harness) {
  await h.admin.createTenant('t1', 'Tenant 1');
  await h.admin.createOutlet('t1', 'o1', 'Kopi Senopati', {
    terminals: ['term-1'],
    capabilities: { sensor: true, kds: true, printerReportsStatus: true },
  });
  return {
    term: await h.admin.createDevice('t1', 'o1', 'term-1', 'terminal'),
    sensor: await h.admin.createDevice('t1', 'o1', 'sensor-1', 'sensor'),
    owner: await h.admin.createApiToken('t1', 'owner-1', 'OWNER'),
    manager: await h.admin.createApiToken('t1', 'rina', 'MANAGER'),
  };
}

describe('penerima notifikasi', () => {
  let h: Harness;
  let tok: Awaited<ReturnType<typeof seed>>;

  beforeAll(async () => {
    h = await createHarness(WIB('2026-10-01T14:00:00'), { channel: new RecordingChannel() });
    tok = await seed(h);
  });
  afterAll(() => h.close());

  it('hanya OWNER yang boleh mengelola penerima', async () => {
    const body = { userId: 'owner-1', role: 'OWNER', phone: '628111111111' };
    expect((await h.http('POST', '/v1/notification-recipients', tok.manager, body)).status).toBe(403);
    expect((await h.http('POST', '/v1/notification-recipients', tok.term, body)).status).toBe(403);
    expect((await h.http('POST', '/v1/notification-recipients', tok.owner, body)).status).toBe(201);
  });

  it('memvalidasi nomor, peran, dan outlet', async () => {
    const post = (b: object) => h.http('POST', '/v1/notification-recipients', tok.owner, b);
    expect((await post({ userId: 'x', role: 'OWNER', phone: '+62 811' })).status).toBe(400);
    expect((await post({ userId: 'x', role: 'MANAGER', phone: '628111111111' })).status).toBe(400);
    expect((await post({ userId: 'x', role: 'OWNER', phone: '628111111111', outletId: 'tidak-ada' })).status).toBe(404);
  });

  it('daftar tidak menggandakan penerima yang sama dan bisa dinonaktifkan', async () => {
    await h.http('POST', '/v1/notification-recipients', tok.owner, { userId: 'owner-1', role: 'OWNER', phone: '628111111111' });
    const list = await h.http('GET', '/v1/notification-recipients', tok.owner);
    expect(list.body).toHaveLength(1);
    expect((await h.http('DELETE', `/v1/notification-recipients/${list.body[0].id}`, tok.owner)).status).toBe(200);
    expect((await h.http('GET', '/v1/notification-recipients', tok.owner)).body[0].active).toBe(false);
  });
});

describe('pengiriman insiden kritis', () => {
  let h: Harness;
  let channel: RecordingChannel;
  let tok: Awaited<ReturnType<typeof seed>>;

  const phantom = () => {
    const s = new Sim('o1', '2026-10-01', 'term-1', 'sensor-1');
    s.heartbeats('sensor', '12:50:00', '13:30:00', 60_000);
    s.pos({ type: 'printer.status', payload: { state: 'paperOut', source: 'device' } }, '12:55:00');
    s.presence('13:14:02', '13:15:00');
    s.pos({ type: 'order.created', payload: { orderId: 'o42', orderType: 'TAKE_AWAY' } }, '13:14:30', 'budi');
    s.pos({ type: 'order.sent_to_kitchen', payload: { orderId: 'o42' } }, '13:14:35', 'budi');
    s.pos({ type: 'bill.printed', payload: { orderId: 'o42', total: 185_000 } }, '13:14:40', 'budi');
    s.pos({ type: 'payment.received', payload: { orderId: 'o42', method: 'CASH', amount: 185_000 } }, '13:14:50', 'budi');
    s.pos({ type: 'kitchen.status_changed', payload: { orderId: 'o42', status: 'COOKING' } }, '13:16:00', 'dapur');
    s.pos({ type: 'kitchen.status_changed', payload: { orderId: 'o42', status: 'READY' } }, '13:17:40', 'dapur');
    s.pos({ type: 'void.approved', payload: { orderId: 'o42', reasonCode: 'CUSTOMER_CANCEL', approverIds: ['hendra'], amount: 185_000 } }, '13:18:45', 'budi');
    return s;
  };

  beforeAll(async () => {
    channel = new RecordingChannel();
    h = await createHarness(WIB('2026-10-01T13:30:00'), { channel });
    tok = await seed(h);
    const add = (userId: string, role: 'OWNER' | 'OPS', phone: string) =>
      h.http('POST', '/v1/notification-recipients', tok.owner, { userId, role, phone });
    await add('owner-1', 'OWNER', '628111111111');
    await add('ops-1', 'OPS', '628222222222');
    await add('hendra', 'OWNER', '628333333333'); // approver di insiden: tidak boleh diberi tahu
  });
  afterAll(() => h.close());

  it('dikirim ke owner dan ops, tidak ke orang yang terlibat di insiden', async () => {
    const s = phantom();
    await h.postEvents(tok.sensor, s.events.filter((e) => e.deviceId === 'sensor-1'));
    await h.postEvents(tok.term, s.events.filter((e) => e.deviceId === 'term-1'));

    expect(channel.sent.map((m) => m.to).sort()).toEqual(['628111111111', '628222222222']);
    const text = channel.sent[0]!.text;
    expect(text).toContain('Kopi Senopati');
    expect(text).toContain('Skor 170');
    expect(text).toContain('budi');
    expect(text).toContain('CCTV');
    expect(text).toContain('https://guard.example/incidents/');
    expect(text.toLowerCase()).not.toContain('fraud');
  });

  it('evaluasi ulang tidak mengirim lagi', async () => {
    await h.http('POST', '/v1/outlets/o1/evaluate', tok.owner);
    await h.http('POST', '/v1/outlets/o1/evaluate', tok.owner);
    expect(channel.sent).toHaveLength(2);
  });

  it('jejak pengiriman tercatat per penerima', async () => {
    const log = await h.db.tenantTx('t1', async (q) =>
      (await q.query<{ user_id: string; status: string }>('select user_id, status from notification_log order by user_id')).rows,
    );
    expect(log).toEqual([{ user_id: 'ops-1', status: 'SENT' }, { user_id: 'owner-1', status: 'SENT' }].sort((a, b) => a.user_id.localeCompare(b.user_id)));
  });
});

describe('kegagalan dan eskalasi', () => {
  let h: Harness;
  let channel: RecordingChannel;
  let tok: Awaited<ReturnType<typeof seed>>;

  beforeAll(async () => {
    channel = new RecordingChannel();
    h = await createHarness(WIB('2026-10-01T10:30:00'), { channel });
    tok = await seed(h);
    for (const [u, p] of [['owner-1', '628111111111'], ['ops-1', '628222222222']] as const) {
      await h.http('POST', '/v1/notification-recipients', tok.owner, { userId: u, role: u.startsWith('owner') ? 'OWNER' : 'OPS', phone: p });
    }
  });
  afterAll(() => h.close());

  it('naik dari rendah ke kritis karena bukti tambahan diberitahukan sekali, dan kegagalan satu penerima tidak menghalangi yang lain', async () => {
    channel.failFor.add('628222222222');
    const s = new Sim('o1', '2026-10-01', 'term-1', 'sensor-1');
    s.pos({ type: 'order.created', payload: { orderId: 'o1', orderType: 'DINE_IN' } }, '10:00:00', 'budi');
    s.pos({ type: 'bill.printed', payload: { orderId: 'o1', total: 100_000 } }, '10:00:30', 'budi');
    s.pos({ type: 'discount.applied', payload: { orderId: 'o1', kind: 'MEMBER', amount: 20_000, percent: 20, verified: true } }, '10:01:00', 'budi');
    s.pos({ type: 'payment.received', payload: { orderId: 'o1', method: 'QRIS', amount: 80_000 } }, '10:02:00', 'budi');
    await h.postEvents(tok.term, s.events);

    let incidents = (await h.http('GET', '/v1/outlets/o1/incidents', tok.owner)).body;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ score: 30, level: 'LOW' }); // R18 saja
    expect(channel.sent).toHaveLength(0);

    // lanjutan rantai terminal yang sama (Sim `s` memegang rantai term-1)
    const e = s.emit('term-1', { type: 'payment.method_changed', payload: { orderId: 'o1', from: 'QRIS', to: 'CASH' } }, '10:05:00', 'budi');
    await h.postEvents(tok.term, [e]);

    incidents = (await h.http('GET', '/v1/outlets/o1/incidents', tok.owner)).body;
    expect(incidents[0]).toMatchObject({ score: 78, level: 'CRITICAL' }); // (30 + 30) × 1,3

    expect(channel.sent.map((m) => m.to)).toEqual(['628111111111']);
    const log = await h.db.tenantTx('t1', async (q) =>
      (await q.query<{ user_id: string; status: string; error: string | null }>('select user_id, status, error from notification_log order by user_id')).rows,
    );
    expect(log).toEqual([
      { user_id: 'ops-1', status: 'FAILED', error: 'gagal kirim (simulasi)' },
      { user_id: 'owner-1', status: 'SENT', error: null },
    ]);

    // evaluasi berikutnya tidak mengulang eskalasi
    await h.http('POST', '/v1/outlets/o1/evaluate', tok.owner);
    expect(channel.sent).toHaveLength(1);
  });
});

describe('renderIncidentMessage', () => {
  const incident = {
    id: 'o1:inc:R3:o1', outletId: 'o1', terminalId: 'term-1', orderIds: ['o1'], actorIds: ['budi', 'hendra'],
    startAt: WIB('2026-10-01T13:14:02'), endAt: WIB('2026-10-01T13:18:45'), hits: [
      { rule: 'R2' }, { rule: 'R3' }, { rule: 'R5' }, { rule: 'R3' },
    ], modalities: ['PHYSICAL', 'POS'], multiplier: 2, score: 170, level: 'CRITICAL',
  } as unknown as Incident;

  it('memuat jendela waktu WIB, staf, indikasi unik, dan anjuran cek CCTV', () => {
    const text = renderIncidentMessage(incident, 'Kopi Senopati', 'https://guard.example');
    expect(text).toContain('13:14–13:18 WIB');
    expect(text).toContain('Staf terkait: budi, hendra');
    expect(text).toContain('void setelah pesanan diproduksi; void setelah customer pergi; kertas habis berkepanjangan');
    expect(text.match(/void setelah customer pergi/g)).toHaveLength(1);
    expect(text).toContain('rekaman CCTV');
  });

  it('tanpa dashboard tidak menyertakan tautan', () => {
    expect(renderIncidentMessage(incident, 'X')).not.toContain('http');
  });
});

describe('WhatsAppChannel', () => {
  const ok = (calls: { url: string; init: RequestInit }[], status = 200) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 200 ? '{}' : 'token kedaluwarsa', { status });
    }) as unknown as typeof fetch;

  it('mengirim teks bebas bila tidak ada template', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await new WhatsAppChannel({ token: 'T', phoneNumberId: '123' }, ok(calls)).send({ to: '628111', text: 'halo' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/123/messages');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ type: 'text', to: '628111', text: { body: 'halo' } });
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer T');
  });

  it('memakai template bila dikonfigurasi, dengan isi pesan dipadatkan menjadi satu baris', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await new WhatsAppChannel({ token: 'T', phoneNumberId: '123', template: 'insiden_kritis' }, ok(calls)).send({ to: '628111', text: 'baris 1\nbaris 2' });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('insiden_kritis');
    expect(body.template.components[0].parameters[0].text).toBe('baris 1 | baris 2');
  });

  it('respons bukan 2xx menjadi error', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await expect(new WhatsAppChannel({ token: 'T', phoneNumberId: '1' }, ok(calls, 401)).send({ to: '1', text: 'x' })).rejects.toThrow(/401/);
  });
});

import { EventChain, type EventBody, type PosEvent } from '@pos/events';

/**
 * Simulator sederhana untuk menyusun aliran event satu outlet dalam test dan demo.
 * Waktu ditulis sebagai "HH:MM:SS" pada tanggal simulasi (WIB).
 */
export class Sim {
  readonly events: PosEvent[] = [];
  private readonly chains = new Map<string, EventChain>();

  constructor(
    readonly outletId = 'outlet-1',
    readonly date = '2026-10-01',
    readonly terminalId = 'term-1',
    readonly sensorId = 'sensor-1',
  ) {}

  /** Waktu "HH:MM:SS" pada tanggal simulasi, atau epoch ms yang diteruskan apa adanya. */
  t(at: string | number, ms = 0): number {
    return (typeof at === 'number' ? at : Date.parse(`${this.date}T${at}+07:00`)) + ms;
  }

  private chain(deviceId: string): EventChain {
    let c = this.chains.get(deviceId);
    if (!c) this.chains.set(deviceId, (c = new EventChain(deviceId, this.outletId)));
    return c;
  }

  emit(deviceId: string, body: EventBody, hms: string | number, actorId?: string, clockOffsetMs = 0): PosEvent {
    const e = this.chain(deviceId).append({
      ...body,
      deviceTime: this.t(hms) + clockOffsetMs,
      actorId: actorId ?? null,
      clockOffsetMs,
    });
    this.events.push(e);
    return e;
  }

  /** Event dari terminal POS. */
  pos(body: EventBody, hms: string | number, actorId = 'budi'): PosEvent {
    return this.emit(this.terminalId, body, hms, actorId);
  }

  /** Sesi presence customer dari sensor. */
  presence(startHms: string | number, endHms: string | number, peak = 60): PosEvent {
    return this.emit(
      this.sensorId,
      {
        type: 'presence.session',
        payload: { start: this.t(startHms), end: this.t(endHms), peakMove: peak, peakStatic: peak },
      },
      endHms,
    );
  }

  heartbeat(kind: 'sensor' | 'printer' | 'terminal', hms: string | number): PosEvent {
    const deviceId = kind === 'sensor' ? this.sensorId : this.terminalId;
    return this.emit(deviceId, { type: 'device.heartbeat', payload: { kind } }, hms);
  }

  /** Heartbeat berkala (default tiap 30 detik) dari awal sampai akhir. */
  heartbeats(kind: 'sensor' | 'printer' | 'terminal', fromHms: string | number, toHms: string | number, everyMs = 30_000): void {
    const deviceId = kind === 'sensor' ? this.sensorId : this.terminalId;
    for (let ms = this.t(fromHms); ms <= this.t(toHms); ms += everyMs) {
      const e = this.chain(deviceId).append({
        type: 'device.heartbeat',
        payload: { kind },
        deviceTime: ms,
      });
      this.events.push(e);
    }
  }

  /** Order tunai lengkap: dibuat, dikirim ke dapur, ditagih, dibayar. */
  cashOrder(orderId: string, createdHms: string | number, paidHms: string | number, total = 50_000, actor = 'budi'): void {
    this.pos({ type: 'order.created', payload: { orderId, orderType: 'TAKE_AWAY' } }, createdHms, actor);
    this.pos({ type: 'order.sent_to_kitchen', payload: { orderId } }, createdHms, actor);
    this.pos({ type: 'bill.printed', payload: { orderId, total } }, createdHms, actor);
    this.pos({ type: 'payment.received', payload: { orderId, method: 'CASH', amount: total } }, paidHms, actor);
  }
}

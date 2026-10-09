import { Inject, Injectable, Logger, Optional, type OnApplicationShutdown } from '@nestjs/common';
import type { Incident } from '@pos/rules';
import { Alerter } from './alerter';
import { GuardService, type EvaluateResult } from './guard.service';
import { Telemetry } from './telemetry';

export interface Notifier {
  notifyCritical(tenantId: string, incident: Incident): Promise<void>;
}
export const NOTIFIER = 'NOTIFIER';
export const CLOCK = 'CLOCK';
export type Clock = () => number;

/** Notifier sementara: hanya mencatat log. Diganti WhatsApp/push saat modul notifikasi dibuat. */
export class LogNotifier implements Notifier {
  private readonly log = new Logger('Notifier');
  async notifyCritical(_tenantId: string, incident: Incident): Promise<void> {
    this.log.warn(`insiden kritis ${incident.id} skor ${incident.score}`);
  }
}

/** `sync`: setoran event menunggu evaluasi selesai (tes dan skrip). `background`: evaluasi digabung dan dijalankan di latar belakang (produksi). */
export type EvaluateMode = 'sync' | 'background';
export const EVALUATE_MODE = 'EVALUATE_MODE';
export const EVALUATE_MIN_GAP_MS = 'EVALUATE_MIN_GAP_MS';

interface Slot { running: boolean; dirty: boolean; timer: ReturnType<typeof setTimeout> | null; lastEnd: number; lastDuration: number; tenantId: string; done: Promise<void> | null }

@Injectable()
export class PipelineService implements OnApplicationShutdown {
  private readonly log = new Logger('Pipeline');
  private readonly slots = new Map<string, Slot>();
  private closing = false;

  constructor(
    @Inject(GuardService) private readonly guard: GuardService,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
    @Inject(Telemetry) private readonly telemetry: Telemetry,
    @Inject(Alerter) private readonly alerter: Alerter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(EVALUATE_MODE) private readonly mode: EvaluateMode = 'sync',
    @Optional() @Inject(EVALUATE_MIN_GAP_MS) private readonly minGapMs: number = 15_000,
  ) {
    this.telemetry.gauge('pos_evaluation_pending', 'Outlet yang evaluasinya menunggu atau sedang berjalan di latar belakang.', () => [...this.slots.values()].filter((s) => s.running || s.dirty).length);
  }

  /**
   * Evaluasi aturan lalu notifikasi insiden kritis baru. Kegagalan di sini tidak boleh menggagalkan
   * permintaan pemanggil, karena data sumber (event, laporan bank) sudah tersimpan dan evaluasi bisa diulang.
   */
  async run(tenantId: string, outletId: string, now?: number): Promise<EvaluateResult | null> {
    const t0 = performance.now();
    try {
      const result = await this.guard.evaluate(tenantId, outletId, now ?? this.clock());
      for (const incident of result.newCritical) await this.notifier.notifyCritical(tenantId, incident);
      this.record('ok', (performance.now() - t0) / 1000);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.error(`evaluasi outlet ${outletId} gagal: ${msg}`);
      this.record('error', (performance.now() - t0) / 1000);
      void this.alerter.alert(`evaluate:${outletId}`, `Evaluasi aturan gagal untuk outlet ${outletId}: ${msg}`);
      return null;
    }
  }

  private record(result: 'ok' | 'error', seconds: number): void {
    this.telemetry.inc('pos_evaluations_total', 'Jumlah evaluasi aturan per hasil.', { result });
    this.telemetry.inc('pos_evaluation_seconds_sum_total', 'Total detik yang dipakai evaluasi aturan.', {}, seconds);
    this.telemetry.set('pos_evaluation_last_duration_seconds', 'Lama evaluasi aturan yang terakhir.', seconds);
  }

  /**
   * Dipanggil setelah setoran event. Mode sync mengevaluasi dan menunggu. Mode background menggabungkan: satu outlet paling banyak satu
   * evaluasi berjalan, permintaan yang datang selama itu (atau selama jeda) cukup ditandai dan menghasilkan SATU evaluasi susulan.
   * Jeda antar-evaluasi = yang terbesar antara batas minimum dan 3x lama evaluasi terakhir, sehingga satu outlet tidak pernah memakai
   * lebih dari kira-kira seperempat waktu CPU sekalipun datanya membesar.
   */
  async schedule(tenantId: string, outletId: string): Promise<void> {
    if (this.mode === 'sync') {
      await this.run(tenantId, outletId, undefined);
      return;
    }
    if (this.closing) return;
    const slot = this.slots.get(outletId) ?? { running: false, dirty: false, timer: null, lastEnd: 0, lastDuration: 0, tenantId, done: null };
    this.slots.set(outletId, slot);
    slot.dirty = true;
    this.kick(outletId, slot);
  }

  private kick(outletId: string, slot: Slot): void {
    if (slot.running || slot.timer || !slot.dirty || this.closing) return;
    const gap = Math.max(this.minGapMs, slot.lastDuration * 3000);
    const wait = Math.max(0, slot.lastEnd + gap - Date.now());
    const start = () => {
      slot.timer = null;
      slot.dirty = false;
      slot.running = true;
      const t0 = Date.now();
      slot.done = this.run(slot.tenantId, outletId).then(() => undefined).finally(() => {
        slot.running = false;
        slot.lastDuration = (Date.now() - t0) / 1000;
        slot.lastEnd = Date.now();
        slot.done = null;
        this.kick(outletId, slot);
      });
    };
    if (wait === 0) start();
    else slot.timer = setTimeout(start, wait);
  }

  /** Menunggu semua evaluasi latar belakang yang tertunda selesai (tes dan penutupan server). Evaluasi yang menunggu jeda dijalankan sekarang. */
  async drain(): Promise<void> {
    for (let guard = 0; guard < 20; guard++) {
      const pending = [...this.slots.entries()].filter(([, s]) => s.running || s.dirty || s.timer);
      if (pending.length === 0) return;
      for (const [id, s] of pending) {
        if (s.timer) { clearTimeout(s.timer); s.timer = null; s.lastEnd = 0; }
        this.kick(id, s);
      }
      await Promise.all(pending.map(([, s]) => s.done));
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.drain();
    this.closing = true;
    for (const s of this.slots.values()) if (s.timer) clearTimeout(s.timer);
  }
}

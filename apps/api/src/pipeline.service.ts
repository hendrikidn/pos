import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Incident } from '@pos/rules';
import { GuardService, type EvaluateResult } from './guard.service';

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

@Injectable()
export class PipelineService {
  private readonly log = new Logger('Pipeline');

  constructor(
    @Inject(GuardService) private readonly guard: GuardService,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
  ) {}

  /**
   * Evaluasi aturan lalu notifikasi insiden kritis baru. Kegagalan di sini tidak boleh menggagalkan
   * permintaan pemanggil, karena data sumber (event, laporan bank) sudah tersimpan dan evaluasi bisa diulang.
   */
  async run(tenantId: string, outletId: string, now?: number): Promise<EvaluateResult | null> {
    try {
      const result = await this.guard.evaluate(tenantId, outletId, now);
      for (const incident of result.newCritical) await this.notifier.notifyCritical(tenantId, incident);
      return result;
    } catch (e) {
      this.log.error(`evaluasi outlet ${outletId} gagal: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
}

import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Headers, Inject, NotFoundException, Res, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Alerter } from './alerter';
import { Public } from './auth';
import { Database } from './db/database';
import { Telemetry } from './telemetry';

const READY_TIMEOUT_MS = 3_000;
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Operasional: `/readyz` (siap melayani: database terjangkau dan skema termigrasi; dipakai health check Docker dan pemantau uptime) dan
 * `/metrics` (format Prometheus; mati kecuali `METRICS_TOKEN` diisi, lalu wajib `Authorization: Bearer <token>`).
 */
@Controller()
export class OpsController {
  private lastReady = true;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Telemetry) private readonly telemetry: Telemetry,
    @Inject(Alerter) private readonly alerter: Alerter,
  ) {
    const stats = db.driver.stats?.bind(db.driver);
    if (stats) {
      telemetry.gauge('pos_db_pool_connections', 'Koneksi pool database menurut keadaan.', () => {
        const s = stats();
        return [{ labels: { state: 'total' }, value: s.total }, { labels: { state: 'idle' }, value: s.idle }, { labels: { state: 'waiting' }, value: s.waiting }];
      });
    }
    // Umur laporan terakhir tiap terminal: terminal yang diam berjam-jam saat jam buka berarti internet/perangkatnya bermasalah.
    telemetry.gauge('pos_terminal_last_seen_age_seconds', 'Detik sejak terminal terakhir menyetor data ke server.', async () => {
      const rows = (await this.db.admin.query<{ id: string; outlet_id: string; age: number }>(
        "select id, outlet_id, extract(epoch from now()) - last_seen_ms / 1000 as age from device where kind = 'terminal' and revoked_at is null and last_seen_ms is not null",
      )).rows;
      return rows.map((r) => ({ labels: { device: r.id, outlet: r.outlet_id }, value: Math.max(0, Math.round(Number(r.age))) }));
    });
    telemetry.gauge('pos_open_critical_incidents', 'Insiden kritis yang belum ditinjau.', async () =>
      Number((await this.db.admin.query<{ n: string }>("select count(*) n from incident where level = 'CRITICAL' and status = 'OPEN' and not shadow")).rows[0]?.n ?? 0));
  }

  @Public()
  @Get('readyz')
  async ready(@Res({ passthrough: true }) _res: unknown) {
    try {
      await Promise.race([
        this.db.admin.query('select 1'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('database tidak menjawab dalam 3 detik')), READY_TIMEOUT_MS).unref()),
      ]);
      if (!this.lastReady) void this.alerter.alert('ready:up', 'Database kembali terjangkau.');
      this.lastReady = true;
      return { ok: true };
    } catch (e) {
      if (this.lastReady) void this.alerter.alert('ready:down', `Database tidak terjangkau: ${e instanceof Error ? e.message : String(e)}`);
      this.lastReady = false;
      throw new ServiceUnavailableException('database tidak siap');
    }
  }

  @Public()
  @Get('metrics')
  async metrics(@Headers('authorization') authorization: string | undefined, @Res({ passthrough: true }) res: { setHeader(k: string, v: string): void }) {
    const expected = process.env['METRICS_TOKEN'];
    if (!expected) throw new NotFoundException();
    const got = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!same(got, expected)) throw new UnauthorizedException('token metrik tidak valid');
    res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return this.telemetry.render();
  }
}

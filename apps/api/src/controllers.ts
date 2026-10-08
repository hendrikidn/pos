import { BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { Public, requireApi, requireDevice, type AuthedRequest } from './auth';
import { BankService } from './bank.service';
import { Database } from './db/database';
import { IncidentService } from './incident.service';
import { IngestService } from './ingest.service';
import { NotificationService } from './notification.service';
import { CLOCK, PipelineService, type Clock } from './pipeline.service';
import { ReportService } from './report.service';
import { SettlementService, type SlipInput } from './settlement.service';
import { ShadowService } from './shadow.service';

@Controller()
export class ApiController {
  constructor(
    @Inject(IngestService) private readonly ingest: IngestService,
    @Inject(BankService) private readonly bank: BankService,
    @Inject(IncidentService) private readonly incidents: IncidentService,
    @Inject(PipelineService) private readonly pipeline: PipelineService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(SettlementService) private readonly settlements: SettlementService,
    @Inject(ReportService) private readonly reports: ReportService,
    @Inject(ShadowService) private readonly shadow: ShadowService,
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Public()
  @Get('healthz')
  health() {
    return { ok: true };
  }

  /** Perangkat mengirim batch event. Respons memuat ackedSeq agar perangkat bisa menghapus outbox-nya. */
  @Post('v1/events')
  async postEvents(@Req() req: AuthedRequest, @Body() body: { events?: unknown }) {
    const device = requireDevice(req);
    const result = await this.ingest.ingest(device, body?.events, this.clock());
    if (result.accepted > 0) await this.pipeline.run(device.tenantId, device.outletId, this.clock());
    return result;
  }

  @Post('v1/outlets/:outletId/bank-reports')
  async postBankReport(
    @Req() req: AuthedRequest,
    @Param('outletId') outletId: string,
    @Body() body: { text?: string; filename?: string },
  ) {
    const auth = requireApi(req, ['OWNER', 'OPS']);
    await this.assertOutlet(auth.tenantId, outletId);
    const result = await this.bank.importReport(auth.tenantId, outletId, auth.userId, body?.text ?? '', body?.filename, this.clock());
    await this.pipeline.run(auth.tenantId, outletId, this.clock());
    return result;
  }

  /** Slip settlement EDC: `{ text }` (isi slip) atau `{ slip }` (isian terstruktur). */
  @Post('v1/outlets/:outletId/settlements')
  async postSettlement(
    @Req() req: AuthedRequest,
    @Param('outletId') outletId: string,
    @Body() body: { text?: string; slip?: SlipInput },
  ) {
    const auth = requireApi(req, ['OWNER', 'OPS']);
    await this.assertOutlet(auth.tenantId, outletId);
    const result = await this.settlements.importSlip(auth, outletId, body ?? {}, this.clock());
    await this.pipeline.run(auth.tenantId, outletId, this.clock());
    return result;
  }

  @Get('v1/outlets/:outletId/settlements')
  async listSettlements(@Req() req: AuthedRequest, @Param('outletId') outletId: string) {
    const auth = requireApi(req, ['OWNER', 'OPS', 'MANAGER']);
    await this.assertOutlet(auth.tenantId, outletId);
    return this.settlements.list(auth, outletId);
  }

  /** Laporan penjualan outlet. `from`/`to` = tanggal lokal outlet (YYYY-MM-DD, inklusif, maks. 31 hari), atau `range` = today|yesterday|7d|30d|month. `compare=1` menambahkan `comparison` terhadap periode sebelumnya yang sama panjang. */
  @Get('v1/outlets/:outletId/reports/sales')
  async salesReport(
    @Req() req: AuthedRequest,
    @Param('outletId') outletId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('range') range?: string,
    @Query('compare') compare?: string,
  ) {
    const auth = requireApi(req, ['OWNER', 'OPS', 'MANAGER']);
    await this.assertOutlet(auth.tenantId, outletId);
    return this.reports.sales(auth, outletId, { from, to, range, compare }, this.clock());
  }

  @Post('v1/outlets/:outletId/evaluate')
  async evaluate(@Req() req: AuthedRequest, @Param('outletId') outletId: string) {
    const auth = requireApi(req, ['OWNER', 'OPS']);
    await this.assertOutlet(auth.tenantId, outletId);
    const result = await this.pipeline.run(auth.tenantId, outletId, this.clock());
    return { incidents: result?.incidents.length ?? 0, newCritical: result?.newCritical.length ?? 0 };
  }

  /** Identitas pemegang token, dipakai dashboard untuk memvalidasi login. */
  @Get('v1/me')
  me(@Req() req: AuthedRequest) {
    const { userId, role, tenantId } = requireApi(req);
    return { userId, role, tenantId };
  }

  @Get('v1/outlets')
  outlets(@Req() req: AuthedRequest) {
    return this.incidents.listOutlets(requireApi(req), this.clock());
  }

  @Get('v1/outlets/:outletId/incidents')
  async list(
    @Req() req: AuthedRequest,
    @Param('outletId') outletId: string,
    @Query('status') status?: string,
    @Query('minLevel') minLevel?: string,
  ) {
    const auth = requireApi(req);
    if (minLevel && !['LOW', 'MEDIUM', 'CRITICAL'].includes(minLevel)) throw new BadRequestException('minLevel tidak valid');
    return this.incidents.list(auth, outletId, { status, minLevel: minLevel as 'LOW' | 'MEDIUM' | 'CRITICAL' | undefined });
  }

  /** Ringkasan mode shadow: insiden yang tercatat tanpa notifikasi, "apa yang akan terdeteksi". */
  @Get('v1/outlets/:outletId/shadow')
  async shadowReport(@Req() req: AuthedRequest, @Param('outletId') outletId: string) {
    const auth = requireApi(req, ['OWNER', 'OPS', 'MANAGER']);
    await this.assertOutlet(auth.tenantId, outletId);
    return this.shadow.report(auth, outletId, this.clock());
  }

  @Get('v1/incidents/:id')
  get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.incidents.get(requireApi(req), id);
  }

  @Post('v1/incidents/:id/review')
  review(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { label?: string; note?: string }) {
    const auth = requireApi(req, ['OWNER', 'OPS']);
    return this.incidents.review(auth, id, body?.label ?? '', body?.note);
  }

  @Post('v1/notification-recipients')
  async addRecipient(
    @Req() req: AuthedRequest,
    @Body() body: { userId?: string; role?: string; phone?: string; outletId?: string },
  ) {
    const auth = requireApi(req, ['OWNER']);
    if (!body?.userId) throw new BadRequestException('userId wajib');
    if (body.role !== 'OWNER' && body.role !== 'OPS') throw new BadRequestException('role harus OWNER atau OPS');
    if (!/^[0-9]{8,15}$/.test(body.phone ?? '')) throw new BadRequestException('phone harus 8–15 digit, format internasional tanpa +');
    if (body.outletId) await this.assertOutlet(auth.tenantId, body.outletId);
    await this.notifications.addRecipient(auth.tenantId, { userId: body.userId, role: body.role, phone: body.phone!, outletId: body.outletId });
    return { ok: true };
  }

  @Get('v1/notification-recipients')
  listRecipients(@Req() req: AuthedRequest) {
    return this.notifications.listRecipients(requireApi(req, ['OWNER']).tenantId);
  }

  @Delete('v1/notification-recipients/:id')
  async removeRecipient(@Req() req: AuthedRequest, @Param('id') id: string) {
    if (!/^[0-9]+$/.test(id)) throw new BadRequestException('id tidak valid');
    await this.notifications.deactivateRecipient(requireApi(req, ['OWNER']).tenantId, Number(id));
    return { ok: true };
  }

  private async assertOutlet(tenantId: string, outletId: string): Promise<void> {
    const found = await this.db.tenantTx(tenantId, async (q) => (await q.query('select 1 from outlet where id = $1', [outletId])).rowCount);
    if (!found) throw new NotFoundException('outlet tidak ditemukan');
  }
}

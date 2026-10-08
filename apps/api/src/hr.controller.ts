import { Body, Controller, Get, Inject, Param, ParseIntPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { requireApi, type AuthedRequest } from './auth';
import { Database } from './db/database';
import { HrService, type LineInput, type ManualInput, type PayInput, type RunInput } from './hr.service';
import { CLOCK, type Clock } from './pipeline.service';

/** Absensi (owner dan manager) dan penggajian (hanya owner: data gaji sensitif). */
@Controller('v1')
export class HrController {
  constructor(
    @Inject(HrService) private readonly hr: HrService,
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('hr/pay')
  listPay(@Req() req: AuthedRequest) {
    return this.hr.listStaffPay(requireApi(req, ['OWNER']));
  }

  @Put('hr/pay/:staffId')
  async setPay(@Req() req: AuthedRequest, @Param('staffId') staffId: string, @Body() body: PayInput) {
    await this.hr.setPay(requireApi(req, ['OWNER']), staffId, body ?? {});
    return { ok: true };
  }

  @Get('outlets/:outletId/hr/attendance')
  attendance(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Query('from') from?: string, @Query('to') to?: string, @Query('range') range?: string) {
    return this.hr.attendance(requireApi(req, ['OWNER', 'MANAGER']), outletId, { from, to, range }, this.clock());
  }

  @Post('outlets/:outletId/hr/attendance')
  addManual(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Body() body: ManualInput) {
    return this.hr.addManual(requireApi(req, ['OWNER', 'MANAGER']), outletId, body ?? {}, this.clock());
  }

  @Post('outlets/:outletId/hr/attendance/:id/void')
  async voidManual(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Param('id', ParseIntPipe) id: number, @Body() body: { reason?: unknown }) {
    await this.hr.voidManual(requireApi(req, ['OWNER', 'MANAGER']), outletId, id, body?.reason);
    return { ok: true };
  }

  @Get('payroll-runs')
  runs(@Req() req: AuthedRequest, @Query('outletId') outletId?: string) {
    return this.hr.listRuns(requireApi(req, ['OWNER']), outletId);
  }

  @Post('outlets/:outletId/payroll-runs')
  createRun(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Body() body: RunInput) {
    return this.hr.createRun(requireApi(req, ['OWNER']), outletId, body ?? {}, this.clock());
  }

  @Get('payroll-runs/:id')
  detail(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number) {
    return this.hr.detail(requireApi(req, ['OWNER']), id);
  }

  @Put('payroll-runs/:id/lines/:staffId')
  async updateLine(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number, @Param('staffId') staffId: string, @Body() body: LineInput) {
    await this.hr.updateLine(requireApi(req, ['OWNER']), id, staffId, body ?? {});
    return { ok: true };
  }

  @Post('payroll-runs/:id/finalize')
  async finalize(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number) {
    await this.hr.finalize(requireApi(req, ['OWNER']), id);
    return { ok: true };
  }

  @Post('payroll-runs/:id/pay')
  pay(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number, @Body() body: { date?: unknown; method?: unknown }) {
    return this.hr.pay(requireApi(req, ['OWNER']), id, body ?? {}, this.clock());
  }

  @Post('payroll-runs/:id/cancel')
  async cancel(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number, @Body() body: { reason?: unknown }) {
    await this.hr.cancel(requireApi(req, ['OWNER']), id, body?.reason);
    return { ok: true };
  }

  @Get('payroll-runs/:id/export')
  async exportCsv(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void }, @Param('id', ParseIntPipe) id: number) {
    const out = await this.hr.exportCsv(requireApi(req, ['OWNER']), id);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('cache-control', 'no-store');
    return out.csv;
  }
}

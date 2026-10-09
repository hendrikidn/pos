import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { IdPipe } from './id-pipe';
import { requireApi, type AuthedRequest } from './auth';
import { TaxFilingService, type EmployerInput } from './tax-filing.service';
import { HrService, type LineInput, type ManualInput, type PayInput, type RunInput, type StaffTaxInput } from './hr.service';
import { CLOCK, type Clock } from './pipeline.service';

/** Absensi (owner dan manager) dan penggajian (hanya owner: data gaji sensitif). */
@Controller('v1')
export class HrController {
  constructor(
    @Inject(HrService) private readonly hr: HrService,
    @Inject(TaxFilingService) private readonly filing: TaxFilingService,
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

  @Get('hr/tax-settings')
  taxSettings(@Req() req: AuthedRequest) {
    return this.hr.getTaxSettings(requireApi(req, ['OWNER']));
  }

  @Put('hr/tax-settings')
  async setTaxSettings(@Req() req: AuthedRequest, @Body() body: unknown) {
    await this.hr.setTaxSettings(requireApi(req, ['OWNER']), body);
    return { ok: true };
  }

  @Get('hr/staff-tax')
  listStaffTax(@Req() req: AuthedRequest) {
    return this.hr.listStaffTax(requireApi(req, ['OWNER']));
  }

  @Put('hr/staff-tax/:staffId')
  async setStaffTax(@Req() req: AuthedRequest, @Param('staffId') staffId: string, @Body() body: StaffTaxInput) {
    await this.hr.setStaffTax(requireApi(req, ['OWNER']), staffId, body ?? {});
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
  async voidManual(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Param('id', IdPipe) id: number, @Body() body: { reason?: unknown }) {
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
  detail(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number) {
    return this.hr.detail(requireApi(req, ['OWNER']), id);
  }

  @Put('payroll-runs/:id/lines/:staffId')
  async updateLine(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Param('staffId') staffId: string, @Body() body: LineInput) {
    await this.hr.updateLine(requireApi(req, ['OWNER']), id, staffId, body ?? {});
    return { ok: true };
  }

  @Post('payroll-runs/:id/finalize')
  async finalize(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number) {
    await this.hr.finalize(requireApi(req, ['OWNER']), id);
    return { ok: true };
  }

  @Post('payroll-runs/:id/pay')
  pay(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: { date?: unknown; method?: unknown }) {
    return this.hr.pay(requireApi(req, ['OWNER']), id, body ?? {}, this.clock());
  }

  @Post('payroll-runs/:id/cancel')
  async cancel(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: { reason?: unknown }) {
    await this.hr.cancel(requireApi(req, ['OWNER']), id, body?.reason);
    return { ok: true };
  }

  @Get('payroll-runs/:id/export')
  async exportCsv(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void }, @Param('id', IdPipe) id: number) {
    const out = await this.hr.exportCsv(requireApi(req, ['OWNER']), id);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('cache-control', 'no-store');
    return out.csv;
  }

  @Get('payroll-runs/:id/export-statutory')
  async exportStatutory(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void }, @Param('id', IdPipe) id: number) {
    const out = await this.hr.exportStatutoryCsv(requireApi(req, ['OWNER']), id);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('cache-control', 'no-store');
    return out.csv;
  }

  @Get('hr/employer-tax')
  employerTax(@Req() req: AuthedRequest) {
    return this.filing.getEmployer(requireApi(req, ['OWNER']));
  }

  @Put('hr/employer-tax')
  async setEmployerTax(@Req() req: AuthedRequest, @Body() body: EmployerInput) {
    await this.filing.setEmployer(requireApi(req, ['OWNER']), body ?? {});
    return { ok: true };
  }

  /** BPMP (bukti pemotongan PPh 21 bulanan) untuk Coretax: pratinjau JSON, atau `format=xml` (hanya bila data lengkap). */
  @Get('hr/tax/bpmp')
  async bpmp(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void }, @Query('year') year?: string, @Query('month') month?: string, @Query('format') format?: string) {
    const auth = requireApi(req, ['OWNER']);
    const r = await this.filing.bpmp(auth, year, month);
    if (format !== 'xml') return { ...r, xml: undefined };
    if (!r.xml) throw new BadRequestException(`BPMP belum bisa dibuat: ${[...r.problems, ...(r.rows.length === 0 ? ['tidak ada pegawai'] : [])].join('; ')}`);
    await this.filing.logExport(auth, 'bpmp', { year: r.year, month: r.month, rows: r.rows.length });
    res.setHeader('content-type', 'application/xml; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="bpmp-${r.year}-${String(r.month).padStart(2, '0')}.xml"`);
    res.setHeader('cache-control', 'no-store');
    return r.xml;
  }

  /** BPA1 (bukti pemotongan A1 tahunan) untuk Coretax. */
  @Get('hr/tax/a1')
  async a1(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void }, @Query('year') year?: string, @Query('format') format?: string) {
    const auth = requireApi(req, ['OWNER']);
    const r = await this.filing.a1(auth, year);
    if (format !== 'xml') return { ...r, xml: undefined };
    if (!r.xml) throw new BadRequestException(`BPA1 belum bisa dibuat: ${[...r.problems, ...(r.rows.length === 0 ? ['tidak ada pegawai dengan masa pajak terakhir'] : [])].join('; ')}`);
    await this.filing.logExport(auth, 'a1', { year: r.year, rows: r.rows.length });
    res.setHeader('content-type', 'application/xml; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="bpa1-${r.year}.xml"`);
    res.setHeader('cache-control', 'no-store');
    return r.xml;
  }

  @Get('hr/tax/pph21-summary')
  pph21Summary(@Req() req: AuthedRequest, @Query('year') year?: string) {
    return this.filing.summary(requireApi(req, ['OWNER']), year);
  }
}

import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { IdPipe } from './id-pipe';
import { requireApi, type AuthedRequest } from './auth';
import { AccountingService } from './accounting.service';
import { Database } from './db/database';
import { CLOCK, type Clock } from './pipeline.service';

/** Akuntansi: baca untuk OWNER dan MANAGER, ubah hanya OWNER. */
@Controller('v1')
export class AccountingController {
  constructor(
    @Inject(AccountingService) private readonly acc: AccountingService,
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async outlet(tenantId: string, outletId: string) {
    const r = await this.db.tenantTx(tenantId, (q) => q.query('select 1 from outlet where id = $1', [outletId]));
    if (r.rowCount === 0) throw new NotFoundException('outlet tidak ditemukan');
  }

  @Get('accounting/accounts')
  accounts(@Req() req: AuthedRequest) {
    return this.acc.listAccounts(requireApi(req, ['OWNER', 'MANAGER']));
  }

  @Post('accounting/accounts')
  async createAccount(@Req() req: AuthedRequest, @Body() body: { code?: unknown; name?: unknown; type?: unknown; normal?: unknown }) {
    await this.acc.createAccount(requireApi(req, ['OWNER']), body ?? {});
    return { ok: true };
  }

  @Put('accounting/accounts/:code')
  async updateAccount(@Req() req: AuthedRequest, @Param('code') code: string, @Body() body: { name?: unknown; active?: unknown }) {
    await this.acc.updateAccount(requireApi(req, ['OWNER']), code, body ?? {});
    return { ok: true };
  }

  @Get('outlets/:outletId/accounting/journal')
  async journal(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Query('from') from?: string, @Query('to') to?: string, @Query('range') range?: string) {
    const auth = requireApi(req, ['OWNER', 'MANAGER']);
    await this.outlet(auth.tenantId, outletId);
    return this.acc.journal(auth, outletId, { from, to, range }, this.clock());
  }

  @Post('outlets/:outletId/accounting/journal')
  async createEntry(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Body() body: { date?: unknown; memo?: unknown; lines?: unknown }) {
    const auth = requireApi(req, ['OWNER']);
    await this.outlet(auth.tenantId, outletId);
    return this.acc.createEntry(auth, outletId, body ?? {}, this.clock());
  }

  @Post('outlets/:outletId/accounting/journal/:id/void')
  async voidEntry(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Param('id', IdPipe) id: number, @Body() body: { reason?: unknown }) {
    const auth = requireApi(req, ['OWNER']);
    await this.outlet(auth.tenantId, outletId);
    await this.acc.voidEntry(auth, outletId, id, body?.reason);
    return { ok: true };
  }

  @Get('outlets/:outletId/accounting/reports')
  async reports(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Query('from') from?: string, @Query('to') to?: string, @Query('range') range?: string) {
    const auth = requireApi(req, ['OWNER', 'MANAGER']);
    await this.outlet(auth.tenantId, outletId);
    return this.acc.reports(auth, outletId, { from, to, range }, this.clock());
  }

  @Get('outlets/:outletId/accounting/ledger/:code')
  async ledger(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Param('code') code: string, @Query('from') from?: string, @Query('to') to?: string, @Query('range') range?: string) {
    const auth = requireApi(req, ['OWNER', 'MANAGER']);
    await this.outlet(auth.tenantId, outletId);
    return this.acc.ledger(auth, outletId, code, { from, to, range }, this.clock());
  }

  /** CSV jurnal (UTF-8 dengan BOM) untuk diimpor ke perangkat lunak akuntansi. Tercatat di audit. */
  @Get('outlets/:outletId/accounting/export')
  async exportCsv(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void },
    @Param('outletId') outletId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('range') range?: string,
  ) {
    const auth = requireApi(req, ['OWNER', 'MANAGER']);
    await this.outlet(auth.tenantId, outletId);
    const out = await this.acc.exportCsv(auth, outletId, { from, to, range }, this.clock());
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('cache-control', 'no-store');
    return out.csv;
  }
}

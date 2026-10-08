import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { requireApi, type AuthedRequest } from './auth';
import { ChannelService } from './channel.service';
import { CLOCK, type Clock } from './pipeline.service';

/** Pesanan online (GoFood, GrabFood, ShopeeFood): unggah laporan platform dan lihat hasil pencocokannya dengan POS. */
@Controller('v1/outlets/:outletId/online')
export class ChannelController {
  constructor(
    @Inject(ChannelService) private readonly channels: ChannelService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post('reports')
  importReport(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Body() body: { channel?: unknown; csv?: unknown; filename?: unknown }) {
    return this.channels.importReport(requireApi(req, ['OWNER', 'OPS']), outletId, body ?? {});
  }

  @Get('reconciliation')
  reconciliation(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Query('from') from?: string, @Query('to') to?: string, @Query('range') range?: string) {
    return this.channels.reconciliation(requireApi(req, ['OWNER', 'OPS', 'MANAGER']), outletId, { from, to, range }, this.clock());
  }
}

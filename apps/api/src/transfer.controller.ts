import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { IdPipe } from './id-pipe';
import { requireApi, type AuthedRequest } from './auth';
import { TransferService, type TransferInput } from './transfer.service';

const ROLES = ['OWNER', 'OPS', 'MANAGER'] as const;

/** Transfer stok antar-outlet (dapur pusat ke outlet). */
@Controller('v1/stock-transfers')
export class TransferController {
  constructor(@Inject(TransferService) private readonly transfers: TransferService) {}

  @Get()
  list(@Req() req: AuthedRequest, @Query('outletId') outletId?: string) {
    return this.transfers.list(requireApi(req, [...ROLES]), outletId);
  }

  @Post()
  send(@Req() req: AuthedRequest, @Body() body: TransferInput) {
    return this.transfers.send(requireApi(req, [...ROLES]), body ?? {});
  }

  @Post(':id/receive')
  receive(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: { lines?: unknown }) {
    return this.transfers.receive(requireApi(req, [...ROLES]), id, body ?? {});
  }

  @Post(':id/cancel')
  async cancel(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: { reason?: unknown }) {
    await this.transfers.cancel(requireApi(req, [...ROLES]), id, body?.reason);
    return { ok: true };
  }
}

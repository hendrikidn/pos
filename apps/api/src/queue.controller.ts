import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { IdPipe } from './id-pipe';
import { Public, requireApi, requireDevice, type AuthedRequest } from './auth';
import { QueueService, type TicketInput } from './queue.service';

type Req_ = AuthedRequest & { ip?: string };

/** Antrian meja: tiket publik untuk pelanggan, pengaturan dan rekap di dashboard, dan terminal kasir yang memanggil dan mendudukkan. */
@Controller('v1')
export class QueueController {
  constructor(@Inject(QueueService) private readonly queue: QueueService) {}

  @Public()
  @Get('public/queue/:slug')
  publicBoard(@Req() req: Req_, @Param('slug') slug: string) {
    return this.queue.publicBoard(slug, req.ip ?? 'unknown');
  }

  @Public()
  @Post('public/queue/:slug/tickets')
  publicTake(@Req() req: Req_, @Param('slug') slug: string, @Body() body: TicketInput) {
    return this.queue.publicTake(slug, body ?? {}, req.ip ?? 'unknown');
  }

  @Public()
  @Get('public/queue-tickets/:token')
  publicTrack(@Req() req: Req_, @Param('token') token: string) {
    return this.queue.publicTrack(token, req.ip ?? 'unknown');
  }

  @Public()
  @Post('public/queue-tickets/:token/cancel')
  async publicCancel(@Req() req: Req_, @Param('token') token: string) {
    await this.queue.publicCancel(token, req.ip ?? 'unknown');
    return { ok: true };
  }

  @Get('outlets/:outletId/queue-settings')
  settings(@Req() req: AuthedRequest, @Param('outletId') outletId: string) {
    return this.queue.settings(requireApi(req, ['OWNER', 'MANAGER']), outletId);
  }

  @Put('outlets/:outletId/queue-settings')
  async setSettings(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Body() body: { enabled?: unknown }) {
    await this.queue.setSettings(requireApi(req, ['OWNER']), outletId, body ?? {});
    return { ok: true };
  }

  @Get('outlets/:outletId/queue')
  dayView(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Query('day') day?: string) {
    return this.queue.dayView(requireApi(req, ['OWNER', 'MANAGER']), outletId, day);
  }

  @Get('queue/board')
  board(@Req() req: AuthedRequest) {
    return this.queue.board(this.terminal(req));
  }

  @Post('queue/tickets')
  add(@Req() req: AuthedRequest, @Body() body: TicketInput) {
    return this.queue.add(this.terminal(req), body ?? {});
  }

  @Post('queue/:id/call')
  call(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: { reason?: unknown; note?: unknown; staffId?: unknown }) {
    return this.queue.call(this.terminal(req), id, body ?? {});
  }

  @Post('queue/:id/recall')
  recall(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number) {
    return this.queue.recall(this.terminal(req), id);
  }

  @Post('queue/:id/seat')
  seat(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: { tableNo?: unknown; staffId?: unknown }) {
    return this.queue.seat(this.terminal(req), id, body ?? {});
  }

  @Post('queue/:id/no-show')
  async noShow(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: { staffId?: unknown }) {
    await this.queue.noShow(this.terminal(req), id, body ?? {});
    return { ok: true };
  }

  @Post('queue/:id/cancel')
  async cancel(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: { reason?: unknown; staffId?: unknown }) {
    await this.queue.cancel(this.terminal(req), id, body ?? {});
    return { ok: true };
  }

  private terminal(req: AuthedRequest) {
    const device = requireDevice(req);
    if (device.deviceKind !== 'terminal') throw new ForbiddenException('hanya terminal yang mengelola antrian');
    return device;
  }
}

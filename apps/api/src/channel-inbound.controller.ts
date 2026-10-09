import { Body, Controller, Delete, ForbiddenException, Get, Headers, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { IdPipe } from './id-pipe';
import { Public, requireApi, requireDevice, type AuthedRequest } from './auth';
import { ChannelInboundService } from './channel-inbound.service';

type Req_ = AuthedRequest & { ip?: string };

/**
 * Pesanan GoFood/GrabFood/ShopeeFood yang masuk langsung: alamat publik untuk platform (kunci per outlet dan kanal), pengelolaan di dashboard,
 * dan terminal kasir yang menerima pesanan.
 */
@Controller('v1')
export class ChannelInboundController {
  constructor(@Inject(ChannelInboundService) private readonly inbound: ChannelInboundService) {}

  @Public()
  @Post('public/channel/orders')
  receive(@Req() req: Req_, @Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    return this.inbound.receive(authorization, body, req.ip ?? 'unknown');
  }

  @Public()
  @Get('public/channel/orders/:ref')
  status(@Req() req: Req_, @Headers('authorization') authorization: string | undefined, @Param('ref') ref: string) {
    return this.inbound.statusOf(authorization, ref, req.ip ?? 'unknown');
  }

  @Public()
  @Post('public/channel/orders/:ref/cancel')
  cancel(@Req() req: Req_, @Headers('authorization') authorization: string | undefined, @Param('ref') ref: string) {
    return this.inbound.cancel(authorization, ref, req.ip ?? 'unknown');
  }

  @Get('outlets/:outletId/channel-integrations')
  integrations(@Req() req: AuthedRequest, @Param('outletId') outletId: string) {
    return this.inbound.integrations(requireApi(req, ['OWNER', 'MANAGER']), outletId);
  }

  @Post('outlets/:outletId/channel-integrations')
  createKey(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Body() body: { channel?: unknown }) {
    return this.inbound.createKey(requireApi(req, ['OWNER']), outletId, body?.channel);
  }

  @Delete('outlets/:outletId/channel-integrations/:channel')
  async revokeKey(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Param('channel') channel: string) {
    await this.inbound.revokeKey(requireApi(req, ['OWNER']), outletId, channel);
    return { ok: true };
  }

  @Put('outlets/:outletId/channel-integrations/:channel')
  async setAutoAccept(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Param('channel') channel: string, @Body() body: { autoAccept?: unknown }) {
    await this.inbound.setAutoAccept(requireApi(req, ['OWNER']), outletId, channel, body?.autoAccept);
    return { ok: true };
  }

  @Get('outlets/:outletId/channel-items')
  itemMap(@Req() req: AuthedRequest, @Param('outletId') outletId: string) {
    return this.inbound.itemMap(requireApi(req, ['OWNER', 'MANAGER']), outletId);
  }

  @Put('channel-items')
  async setMap(@Req() req: AuthedRequest, @Body() body: { channel?: unknown; key?: unknown; menuId?: unknown }) {
    await this.inbound.setMap(requireApi(req, ['OWNER', 'MANAGER']), body ?? {});
    return { ok: true };
  }

  @Post('channel-items/delete')
  async deleteMap(@Req() req: AuthedRequest, @Body() body: { channel?: unknown; key?: unknown }) {
    await this.inbound.deleteMap(requireApi(req, ['OWNER', 'MANAGER']), body?.channel, body?.key);
    return { ok: true };
  }

  @Get('outlets/:outletId/channel-orders')
  list(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Query('days') days?: string) {
    return this.inbound.list(requireApi(req, ['OWNER', 'MANAGER']), outletId, { days });
  }

  @Get('channel-orders/pending')
  pending(@Req() req: AuthedRequest) {
    return this.inbound.pending(this.terminal(req));
  }

  @Post('channel-orders/:id/accept')
  accept(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number) {
    return this.inbound.accept(this.terminal(req), id);
  }

  @Post('channel-orders/:id/reject')
  async reject(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: { reason?: unknown }) {
    await this.inbound.reject(this.terminal(req), id, body?.reason);
    return { ok: true };
  }

  private terminal(req: AuthedRequest) {
    const device = requireDevice(req);
    if (device.deviceKind !== 'terminal') throw new ForbiddenException('hanya terminal yang mengelola pesanan online');
    return device;
  }
}

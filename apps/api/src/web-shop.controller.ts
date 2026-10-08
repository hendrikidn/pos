import { Body, Controller, ForbiddenException, Get, Inject, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Public, requireApi, requireDevice, type AuthedRequest } from './auth';
import { WebShopService, type WebOrderInput } from './web-shop.service';

type Req_ = AuthedRequest & { ip?: string };

/** Toko web: halaman publik pelanggan, pengelolaan di dashboard (owner/manager), dan terminal kasir yang menerima pesanan. */
@Controller('v1')
export class WebShopController {
  constructor(@Inject(WebShopService) private readonly shop: WebShopService) {}

  @Public()
  @Get('public/shop/:slug')
  publicShop(@Req() req: Req_, @Param('slug') slug: string) {
    return this.shop.publicShop(slug, req.ip ?? 'unknown');
  }

  @Public()
  @Post('public/shop/:slug/orders')
  publicOrder(@Req() req: Req_, @Param('slug') slug: string, @Body() body: WebOrderInput) {
    return this.shop.publicOrder(slug, body ?? {}, req.ip ?? 'unknown');
  }

  @Public()
  @Get('public/web-orders/:token')
  publicTrack(@Req() req: Req_, @Param('token') token: string) {
    return this.shop.publicTrack(token, req.ip ?? 'unknown');
  }

  @Get('outlets/:outletId/web-shop')
  settings(@Req() req: AuthedRequest, @Param('outletId') outletId: string) {
    return this.shop.settings(requireApi(req, ['OWNER', 'MANAGER']), outletId);
  }

  @Put('outlets/:outletId/web-shop')
  async setSettings(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Body() body: { enabled?: unknown; slug?: unknown }) {
    await this.shop.setSettings(requireApi(req, ['OWNER']), outletId, body ?? {});
    return { ok: true };
  }

  @Get('outlets/:outletId/web-orders')
  list(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Query('days') days?: string) {
    return this.shop.list(requireApi(req, ['OWNER', 'MANAGER']), outletId, { days });
  }

  @Post('outlets/:outletId/web-orders/:id/reject')
  async reject(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Param('id', ParseIntPipe) id: number, @Body() body: { reason?: unknown }) {
    await this.shop.rejectFromDashboard(requireApi(req, ['OWNER', 'MANAGER']), outletId, id, body?.reason);
    return { ok: true };
  }

  @Get('web-orders/pending')
  pending(@Req() req: AuthedRequest) {
    return this.shop.pending(this.terminal(req));
  }

  @Post('web-orders/:id/accept')
  accept(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number) {
    return this.shop.accept(this.terminal(req), id);
  }

  @Post('web-orders/:id/reject')
  async rejectDevice(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number, @Body() body: { reason?: unknown }) {
    await this.shop.rejectFromDevice(this.terminal(req), id, body?.reason);
    return { ok: true };
  }

  private terminal(req: AuthedRequest) {
    const device = requireDevice(req);
    if (device.deviceKind !== 'terminal') throw new ForbiddenException('hanya terminal yang mengelola pesanan web');
    return device;
  }
}

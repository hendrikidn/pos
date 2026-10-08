import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { requireApi, requireDevice, type AuthedRequest } from './auth';
import { CLOCK, type Clock } from './pipeline.service';
import { ConfigService, type MenuInput, type PromoInput, type OutletInput, type SettingsInput, type StaffInput } from './config.service';

@Controller('v1')
export class ConfigController {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ----- terminal POS -----

  /** Terminal mengunduh konfigurasi (memuat hash PIN, jadi sensor ditolak). Layar dapur boleh, tetapi hanya menerima data outlet. */
  @Get('device/config')
  async deviceConfig(@Req() req: AuthedRequest, @Query('version') version?: string) {
    const device = requireDevice(req);
    if (device.deviceKind === 'sensor') throw new ForbiddenException('sensor tidak dapat mengunduh konfigurasi');
    const cfg = await this.config.deviceConfig(device);
    return version && version === cfg.version ? { unchanged: true, version: cfg.version, serverTime: cfg.serverTime } : cfg;
  }

  // ----- staf (OWNER) -----

  @Get('staff')
  listStaff(@Req() req: AuthedRequest) {
    return this.config.listStaff(requireApi(req, ['OWNER']));
  }

  @Post('staff')
  async createStaff(@Req() req: AuthedRequest, @Body() body: StaffInput) {
    await this.config.createStaff(requireApi(req, ['OWNER']), body ?? {});
    return { ok: true };
  }

  @Put('staff/:id')
  async updateStaff(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: StaffInput) {
    await this.config.updateStaff(requireApi(req, ['OWNER']), id, body ?? {});
    return { ok: true };
  }

  // ----- menu (OWNER, OPS) -----

  @Get('menu')
  listMenu(@Req() req: AuthedRequest) {
    return this.config.listMenu(requireApi(req, ['OWNER', 'OPS', 'MANAGER']));
  }

  @Post('menu')
  async createMenu(@Req() req: AuthedRequest, @Body() body: MenuInput) {
    await this.config.createMenu(requireApi(req, ['OWNER', 'OPS']), body ?? {});
    return { ok: true };
  }

  @Put('menu/:id')
  async updateMenu(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: MenuInput) {
    await this.config.updateMenu(requireApi(req, ['OWNER', 'OPS']), id, body ?? {});
    return { ok: true };
  }

  // ----- promo (OWNER, OPS menulis; MANAGER membaca) -----

  @Get('promos')
  listPromos(@Req() req: AuthedRequest) {
    return this.config.listPromos(requireApi(req, ['OWNER', 'OPS', 'MANAGER']));
  }

  @Post('promos')
  async createPromo(@Req() req: AuthedRequest, @Body() body: PromoInput) {
    await this.config.createPromo(requireApi(req, ['OWNER', 'OPS']), body ?? {});
    return { ok: true };
  }

  @Put('promos/:id')
  async updatePromo(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: PromoInput) {
    await this.config.updatePromo(requireApi(req, ['OWNER', 'OPS']), id, body ?? {});
    return { ok: true };
  }

  @Put('menu/:id/image')
  setMenuImage(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { contentType?: unknown; data?: unknown }) {
    return this.config.setMenuImage(requireApi(req, ['OWNER', 'OPS']), id, body ?? {});
  }

  @Delete('menu/:id/image')
  async clearMenuImage(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.config.clearMenuImage(requireApi(req, ['OWNER', 'OPS']), id);
    return { ok: true };
  }

  /** Foto menu: terminal (menu aktif outletnya) dan pengguna dashboard. Sensor dan layar dapur tidak. */
  @Get('menu/:id/image')
  menuImage(@Req() req: AuthedRequest, @Param('id') id: string) {
    if (req.auth?.kind === 'device') {
      if (req.auth.deviceKind !== 'terminal') throw new ForbiddenException('jenis perangkat ini tidak memerlukan foto menu');
      return this.config.getMenuImage(req.auth.tenantId, id, req.auth.outletId);
    }
    return this.config.getMenuImage(requireApi(req, ['OWNER', 'OPS', 'MANAGER']).tenantId, id);
  }

  // ----- manajemen outlet (OWNER) -----

  @Post('outlets')
  createOutlet(@Req() req: AuthedRequest, @Body() body: OutletInput) {
    if (!body || typeof body !== 'object') throw new BadRequestException('isi permintaan kosong');
    return this.config.createOutlet(requireApi(req, ['OWNER']), body);
  }

  @Put('outlets/:outletId')
  async updateOutlet(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Body() body: OutletInput) {
    if (!body || typeof body !== 'object') throw new BadRequestException('isi permintaan kosong');
    await this.config.updateOutlet(requireApi(req, ['OWNER']), outletId, body);
    return { ok: true };
  }

  // ----- pengaturan outlet (OWNER) -----

  @Get('outlets/:outletId/settings')
  getSettings(@Req() req: AuthedRequest, @Param('outletId') outletId: string) {
    return this.config.getSettings(requireApi(req, ['OWNER', 'OPS']), outletId, this.clock());
  }

  @Put('outlets/:outletId/settings')
  async updateSettings(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Body() body: SettingsInput) {
    if (!body || typeof body !== 'object') throw new BadRequestException('isi permintaan kosong');
    await this.config.updateSettings(requireApi(req, ['OWNER']), outletId, body, this.clock());
    return { ok: true };
  }
}

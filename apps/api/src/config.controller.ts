import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { requireApi, requireDevice, type AuthedRequest } from './auth';
import { ConfigService, type MenuInput, type SettingsInput, type StaffInput } from './config.service';

@Controller('v1')
export class ConfigController {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  // ----- terminal POS -----

  /** Terminal mengunduh konfigurasi. Hanya terminal (bukan sensor) yang boleh, karena memuat hash PIN. */
  @Get('device/config')
  async deviceConfig(@Req() req: AuthedRequest, @Query('version') version?: string) {
    const device = requireDevice(req);
    if (device.deviceKind !== 'terminal') throw new ForbiddenException('hanya terminal POS yang dapat mengunduh konfigurasi');
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

  // ----- pengaturan outlet (OWNER) -----

  @Get('outlets/:outletId/settings')
  getSettings(@Req() req: AuthedRequest, @Param('outletId') outletId: string) {
    return this.config.getSettings(requireApi(req, ['OWNER', 'OPS']), outletId);
  }

  @Put('outlets/:outletId/settings')
  async updateSettings(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Body() body: SettingsInput) {
    if (!body || typeof body !== 'object') throw new BadRequestException('isi permintaan kosong');
    await this.config.updateSettings(requireApi(req, ['OWNER']), outletId, body);
    return { ok: true };
  }
}

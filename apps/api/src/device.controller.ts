import { Body, Controller, Delete, ForbiddenException, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { Public, requireApi, requireDevice, type AuthedRequest } from './auth';
import { DeviceService } from './device.service';
import { PairingService, type PairingInput } from './pairing.service';

@Controller('v1')
export class DeviceController {
  constructor(
    @Inject(DeviceService) private readonly devices: DeviceService,
    @Inject(PairingService) private readonly pairing: PairingService,
  ) {}

  /** Owner/ops membuat kode pairing sekali pakai (berlaku 15 menit) untuk perangkat baru. */
  @Post('devices/pairing')
  createPairing(@Req() req: AuthedRequest, @Body() body: PairingInput) {
    return this.pairing.create(requireApi(req, ['OWNER', 'OPS']), body ?? {});
  }

  @Get('devices/pairing')
  pendingPairing(@Req() req: AuthedRequest) {
    return this.pairing.pending(requireApi(req, ['OWNER', 'OPS']));
  }

  @Delete('devices/pairing/:deviceId')
  async cancelPairing(@Req() req: AuthedRequest, @Param('deviceId') deviceId: string) {
    await this.pairing.cancel(requireApi(req, ['OWNER', 'OPS']), deviceId);
    return { ok: true };
  }

  /** Perangkat menukar kode pairing dengan token. Kode itu sendiri adalah kredensialnya. */
  @Public()
  @Post('device/enroll')
  enrollWithCode(@Req() req: AuthedRequest & { ip?: string }, @Body() body: { code?: unknown; hardwareId?: unknown }) {
    return this.pairing.redeem(body?.code, body?.hardwareId, req.ip ?? 'unknown');
  }

  @Post('devices/:id/revoke')
  async revoke(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.pairing.revoke(requireApi(req, ['OWNER']), id);
    return { ok: true };
  }

  /** Perangkat mendaftarkan kunci publiknya. Pendaftaran pertama dilakukan saat pemasangan. */
  @Post('device/key')
  enroll(@Req() req: AuthedRequest, @Body() body: { publicKey?: unknown }) {
    const device = requireDevice(req);
    if (device.deviceKind === 'kds') throw new ForbiddenException('jenis perangkat ini tidak menandatangani event');
    return this.devices.enrollKey(device, body?.publicKey);
  }

  @Get('devices')
  list(@Req() req: AuthedRequest) {
    return this.devices.list(requireApi(req, ['OWNER', 'OPS']));
  }

  @Post('devices/:id/key/reset')
  async reset(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.devices.resetKey(requireApi(req, ['OWNER']), id);
    return { ok: true };
  }
}

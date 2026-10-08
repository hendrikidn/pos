import { Body, Controller, Delete, ForbiddenException, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { Public, requireApi, requireDevice, type AuthedRequest } from './auth';
import { DeviceService } from './device.service';
import { KdsService } from './kds.service';
import { TablesService } from './tables.service';
import { HandoffService } from './handoff.service';
import { ReceiptService } from './receipt.service';
import { PairingService, type PairingInput } from './pairing.service';

@Controller('v1')
export class DeviceController {
  constructor(
    @Inject(DeviceService) private readonly devices: DeviceService,
    @Inject(PairingService) private readonly pairing: PairingService,
    @Inject(KdsService) private readonly kds: KdsService,
    @Inject(TablesService) private readonly tables: TablesService,
    @Inject(HandoffService) private readonly handoffs: HandoffService,
    @Inject(ReceiptService) private readonly receipts: ReceiptService,
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

  /** Tiket dapur outlet ini, untuk layar dapur (perangkat KDS) dan terminal. */
  @Get('kds/board')
  kdsBoard(@Req() req: AuthedRequest) {
    const device = requireDevice(req);
    if (device.deviceKind === 'sensor') throw new ForbiddenException('jenis perangkat ini tidak membaca tiket dapur');
    return this.kds.board(device);
  }

  /** Order dine-in terbuka per meja dari semua terminal outlet ini (denah meja berwarna). Hanya terminal. */
  @Get('tables/board')
  tableBoard(@Req() req: AuthedRequest) {
    const device = requireDevice(req);
    if (device.deviceKind !== 'terminal') throw new ForbiddenException('hanya terminal yang membaca denah meja');
    return this.tables.board(device);
  }

  /** Order yang diserahkan terminal lain dan menunggu diambil, serta nasib order yang diserahkan terminal ini. Hanya terminal. */
  @Get('handoffs')
  listHandoffs(@Req() req: AuthedRequest) {
    const device = requireDevice(req);
    if (device.deviceKind !== 'terminal') throw new ForbiddenException('hanya terminal yang menangani serah-terima order');
    return this.handoffs.list(device);
  }

  /** Klaim atomik atas order yang diserahkan (mengambil, atau menarik kembali oleh terminal asal). 409 bila sudah diambil atau sedang diklaim terminal lain. */
  @Post('handoffs/:orderId/claim')
  claimHandoff(@Req() req: AuthedRequest, @Param('orderId') orderId: string) {
    const device = requireDevice(req);
    if (device.deviceKind !== 'terminal') throw new ForbiddenException('hanya terminal yang menangani serah-terima order');
    return this.handoffs.claim(device, orderId);
  }

  /** Struk digital untuk customer (halaman /r/<token> di dashboard memanggil ini). Publik: tokennya sendiri yang menjadi kredensial. */
  @Public()
  @Get('receipts/:token')
  receipt(@Param('token') token: string, @Req() req: AuthedRequest & { ip?: string }) {
    return this.receipts.byToken(token, req.ip ?? 'unknown');
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

import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req, Res, StreamableFile } from '@nestjs/common';
import { requireApi, requireDevice, type AuthedRequest } from './auth';
import { AttendancePhotoService, type PhotoUpload } from './attendance-photo.service';

@Controller('v1')
export class AttendancePhotoController {
  constructor(@Inject(AttendancePhotoService) private readonly photos: AttendancePhotoService) {}

  /** Terminal mengunggah foto absen (setelah event absennya tercatat). Idempoten: foto yang sama diterima lagi tanpa efek. */
  @Post('attendance/photos')
  upload(@Req() req: AuthedRequest, @Body() body: PhotoUpload) {
    const device = requireDevice(req);
    if (device.deviceKind !== 'terminal') throw new ForbiddenException('hanya terminal yang mengunggah foto absen');
    return this.photos.store(device, body ?? {});
  }

  /** Owner dan manager melihat foto; setiap pembukaan tercatat di log audit. */
  @Get('outlets/:outletId/attendance-photos/:hash')
  async view(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Param('hash') hash: string, @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void }) {
    const out = await this.photos.get(requireApi(req, ['OWNER', 'MANAGER']), outletId, hash);
    res.setHeader('cache-control', 'private, max-age=3600');
    res.setHeader('x-content-type-options', 'nosniff');
    return new StreamableFile(out.data, { type: out.mime });
  }
}

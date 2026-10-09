import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req, StreamableFile } from '@nestjs/common';
import { IdPipe } from './id-pipe';
import { Public, requireAdmin, type AuthedRequest } from './auth';
import { FirmwareService, type PublishInput } from './firmware.service';

type Req_ = AuthedRequest & { ip?: string };

/** Pembaruan firmware sensor: endpoint publik untuk perangkat (manifest dan unduhan) dan pengelolaan rilis oleh admin platform. */
@Controller('v1')
export class FirmwareController {
  constructor(@Inject(FirmwareService) private readonly fw: FirmwareService) {}

  @Public()
  @Get('public/firmware/latest')
  latest(@Req() req: Req_, @Query('board') board?: string, @Query('channel') channel?: string, @Query('build') build?: string) {
    return this.fw.latest({ board, channel, build }, req.ip ?? 'unknown');
  }

  @Public()
  @Get('public/firmware/:id/download')
  async download(@Req() req: Req_, @Param('id', IdPipe) id: number) {
    const out = await this.fw.download(id, req.ip ?? 'unknown');
    return new StreamableFile(out.data, { type: 'application/octet-stream', disposition: `attachment; filename="firmware-${id}.bin"`, length: out.data.length });
  }

  @Get('admin/firmware')
  list(@Req() req: AuthedRequest) {
    requireAdmin(req);
    return this.fw.list();
  }

  @Post('admin/firmware')
  publish(@Req() req: AuthedRequest, @Body() body: PublishInput) {
    return this.fw.publish(requireAdmin(req), body ?? {});
  }

  @Post('admin/firmware/:id/revoke')
  async revoke(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: { reason?: unknown }) {
    await this.fw.revoke(requireAdmin(req), id, body?.reason);
    return { ok: true };
  }
}

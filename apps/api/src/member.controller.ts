import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { requireApi, type AuthedRequest } from './auth';
import { MemberService } from './member.service';

@Controller('v1')
export class MemberController {
  constructor(@Inject(MemberService) private readonly members: MemberService) {}

  /** Kasir mencari member lewat nomor HP. Hanya terminal. */
  @Get('members/lookup')
  lookup(@Req() req: AuthedRequest, @Query('phone') phone?: string) {
    if (req.auth?.kind !== 'device' || req.auth.deviceKind !== 'terminal') throw new ForbiddenException('hanya terminal yang mencari member');
    return this.members.lookup(req.auth, phone);
  }

  /** Mendaftarkan member baru: dari kasir (dibatasi per jam) atau dari dashboard. */
  @Post('members')
  register(@Req() req: AuthedRequest, @Body() body: { phone?: unknown; name?: unknown }) {
    if (req.auth?.kind === 'device') {
      if (req.auth.deviceKind !== 'terminal') throw new ForbiddenException('hanya terminal yang mendaftarkan member');
      return this.members.register(req.auth, body ?? {});
    }
    return this.members.register(requireApi(req, ['OWNER', 'OPS', 'MANAGER']), body ?? {});
  }

  @Get('members')
  list(@Req() req: AuthedRequest, @Query('search') search?: string) {
    return this.members.list(requireApi(req, ['OWNER', 'OPS', 'MANAGER']), search);
  }

  @Put('members/:id')
  async update(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { name?: unknown; active?: unknown }) {
    await this.members.update(requireApi(req, ['OWNER', 'OPS']), id, body ?? {});
    return { ok: true };
  }
}

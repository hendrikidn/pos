import { Body, Controller, Delete, Get, Headers, Inject, Param, Post, Req } from '@nestjs/common';
import { IdPipe } from './id-pipe';
import { AdminAuthService } from './admin-auth.service';
import { Public, requireAdmin, type AuthedRequest } from './auth';

type Req_ = AuthedRequest & { ip?: string };
const bearer = (req: AuthedRequest): string => {
  const h = req.headers['authorization'];
  const raw = Array.isArray(h) ? h[0] : h;
  return raw?.startsWith('Bearer ') ? raw.slice(7).trim() : '';
};

/** Login konsol admin (token + kode 2 langkah), sesi, dan pengelolaan verifikasi 2 langkah. */
@Controller('v1/admin/auth')
export class AdminAuthController {
  constructor(@Inject(AdminAuthService) private readonly auth: AdminAuthService) {}

  @Public()
  @Post('login')
  login(@Req() req: Req_, @Headers('user-agent') ua: string | undefined, @Body() body: { token?: unknown; code?: unknown }) {
    return this.auth.login(body ?? {}, req.ip ?? 'unknown', ua);
  }

  @Post('logout')
  async logout(@Req() req: Req_) {
    requireAdmin(req);
    await this.auth.logout(bearer(req));
    return { ok: true };
  }

  @Get('status')
  status(@Req() req: Req_) {
    return this.auth.status(requireAdmin(req), bearer(req));
  }

  @Post('2fa/setup')
  setup(@Req() req: Req_) {
    return this.auth.setup(requireAdmin(req));
  }

  @Post('2fa/enable')
  enable(@Req() req: Req_, @Body() body: { code?: unknown }) {
    return this.auth.enable(requireAdmin(req), body?.code);
  }

  @Post('2fa/disable')
  async disable(@Req() req: Req_, @Body() body: { code?: unknown }) {
    await this.auth.disable(requireAdmin(req), body?.code);
    return { ok: true };
  }

  @Delete('sessions/:id')
  async revoke(@Req() req: Req_, @Param('id', IdPipe) id: number) {
    await this.auth.revokeSession(requireAdmin(req), id);
    return { ok: true };
  }

  @Post('sessions/revoke-others')
  revokeOthers(@Req() req: Req_) {
    return this.auth.revokeOthers(requireAdmin(req), bearer(req));
  }
}

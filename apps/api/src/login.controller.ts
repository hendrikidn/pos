import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import { Public, requireApi, type AuthedRequest } from './auth';
import { LoginService } from './login.service';

@Controller('v1/auth')
export class LoginController {
  constructor(@Inject(LoginService) private readonly login: LoginService) {}

  /** Meminta kode masuk. Respons sama untuk email yang terdaftar maupun tidak. */
  @Public()
  @Post('otp/request')
  async request(@Req() req: AuthedRequest & { ip?: string }, @Body() body: { email?: unknown }) {
    await this.login.requestCode(body?.email, req.ip ?? 'unknown');
    return { ok: true };
  }

  @Public()
  @Post('otp/verify')
  verify(@Req() req: AuthedRequest & { ip?: string }, @Body() body: { email?: unknown; code?: unknown }) {
    return this.login.verifyCode(body?.email, body?.code, req.ip ?? 'unknown');
  }

  @Post('logout')
  async logout(@Req() req: AuthedRequest) {
    const auth = requireApi(req);
    const header = req.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    const token = raw?.startsWith('Bearer ') ? raw.slice(7).trim() : '';
    if (token) await this.login.logout(token, auth.tenantId, auth.userId);
    return { ok: true };
  }
}

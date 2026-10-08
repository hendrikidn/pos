import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import { Public, requireApi, type AuthedRequest } from './auth';
import { LoginService } from './login.service';
import { SignupService } from './signup.service';

@Controller('v1/auth')
export class LoginController {
  constructor(
    @Inject(LoginService) private readonly login_: LoginService,
    @Inject(SignupService) private readonly signup_: SignupService,
  ) {}

  /** Pendaftaran mandiri (uji coba 14 hari). Respons selalu sama; kode untuk mengatur password dikirim ke email. */
  @Public()
  @Post('signup')
  signup(@Req() req: AuthedRequest & { ip?: string }, @Body() body: { businessName?: unknown; outletName?: unknown; ownerName?: unknown; email?: unknown; website?: unknown }) {
    return this.signup_.signup(body ?? {}, req.ip ?? 'unknown');
  }

  /** Meminta kode masuk. Respons sama untuk email yang terdaftar maupun tidak. */
  @Public()
  @Post('otp/request')
  async request(@Req() req: AuthedRequest & { ip?: string }, @Body() body: { email?: unknown }) {
    await this.login_.requestCode(body?.email, req.ip ?? 'unknown');
    return { ok: true };
  }

  @Public()
  @Post('otp/verify')
  verify(@Req() req: AuthedRequest & { ip?: string }, @Body() body: { email?: unknown; code?: unknown }) {
    return this.login_.verifyCode(body?.email, body?.code, req.ip ?? 'unknown');
  }

  /** Masuk dengan email dan password. */
  @Public()
  @Post('login')
  login(@Req() req: AuthedRequest & { ip?: string }, @Body() body: { email?: unknown; password?: unknown }) {
    return this.login_.login(body?.email, body?.password, req.ip ?? 'unknown');
  }

  /** Lupa password, atau pengguna baru yang belum punya password: kirim kode ke email. Respons selalu sama. */
  @Public()
  @Post('password/forgot')
  async forgot(@Req() req: AuthedRequest & { ip?: string }, @Body() body: { email?: unknown }) {
    await this.login_.requestCode(body?.email, req.ip ?? 'unknown', 'reset');
    return { ok: true };
  }

  /** Mengatur password baru dengan kode dari email, lalu langsung masuk. */
  @Public()
  @Post('password/reset')
  reset(@Req() req: AuthedRequest & { ip?: string }, @Body() body: { email?: unknown; code?: unknown; password?: unknown }) {
    return this.login_.resetPassword(body?.email, body?.code, body?.password, req.ip ?? 'unknown');
  }

  /** Mengganti password dari dalam sesi. */
  @Post('password/change')
  async change(@Req() req: AuthedRequest & { ip?: string }, @Body() body: { current?: unknown; password?: unknown }) {
    const auth = requireApi(req);
    const header = req.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    await this.login_.changePassword(auth, raw?.startsWith('Bearer ') ? raw.slice(7).trim() : '', body?.current, body?.password, req.ip ?? 'unknown');
    return { ok: true };
  }

  @Post('logout')
  async logout(@Req() req: AuthedRequest) {
    const auth = requireApi(req);
    const header = req.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    const token = raw?.startsWith('Bearer ') ? raw.slice(7).trim() : '';
    if (token) await this.login_.logout(token, auth.tenantId, auth.userId);
    return { ok: true };
  }
}

import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';
import { requireAdmin, type AuthedRequest } from './auth';
import { PlatformService, type NewTenantInput } from './platform.service';

/** Konsol admin platform. Hanya token `adm_`; token pengguna tenant (`api_`) dan perangkat ditolak (403). */
@Controller('v1/admin')
export class PlatformController {
  constructor(@Inject(PlatformService) private readonly platform: PlatformService) {}

  @Get('me')
  me(@Req() req: AuthedRequest) {
    return { adminId: requireAdmin(req).adminId };
  }

  @Get('overview')
  overview(@Req() req: AuthedRequest) {
    requireAdmin(req);
    return this.platform.overview();
  }

  @Get('tenants')
  tenants(@Req() req: AuthedRequest) {
    requireAdmin(req);
    return this.platform.listTenants();
  }

  @Post('tenants')
  createTenant(@Req() req: AuthedRequest, @Body() body: NewTenantInput) {
    return this.platform.createTenant(requireAdmin(req), body ?? {});
  }

  @Get('tenants/:tenantId')
  tenant(@Req() req: AuthedRequest, @Param('tenantId') tenantId: string) {
    requireAdmin(req);
    return this.platform.getTenant(tenantId);
  }

  @Put('tenants/:tenantId')
  async rename(@Req() req: AuthedRequest, @Param('tenantId') tenantId: string, @Body() body: { name?: unknown }) {
    await this.platform.renameTenant(requireAdmin(req), tenantId, body?.name);
    return { ok: true };
  }

  @Post('tenants/:tenantId/suspend')
  async suspend(@Req() req: AuthedRequest, @Param('tenantId') tenantId: string, @Body() body: { reason?: unknown }) {
    await this.platform.setSuspended(requireAdmin(req), tenantId, true, body?.reason);
    return { ok: true };
  }

  @Post('tenants/:tenantId/reactivate')
  async reactivate(@Req() req: AuthedRequest, @Param('tenantId') tenantId: string) {
    await this.platform.setSuspended(requireAdmin(req), tenantId, false);
    return { ok: true };
  }

  @Post('tenants/:tenantId/users')
  addUser(@Req() req: AuthedRequest, @Param('tenantId') tenantId: string, @Body() body: { email?: unknown; userId?: unknown; role?: unknown }) {
    return this.platform.addUser(requireAdmin(req), tenantId, body ?? {});
  }

  @Put('tenants/:tenantId/users/:userRef')
  async updateUser(@Req() req: AuthedRequest, @Param('tenantId') tenantId: string, @Param('userRef') userRef: string, @Body() body: { email?: unknown; active?: unknown }) {
    const admin = requireAdmin(req);
    if (!/^[0-9]{1,9}$/.test(userRef)) throw new BadRequestException('id pengguna tidak valid');
    await this.platform.updateUser(admin, tenantId, Number(userRef), body ?? {});
    return { ok: true };
  }

  @Post('tenants/:tenantId/owner-tokens')
  issue(@Req() req: AuthedRequest, @Param('tenantId') tenantId: string, @Body() body: { ownerId?: unknown; label?: unknown }) {
    return this.platform.issueOwnerToken(requireAdmin(req), tenantId, body ?? {});
  }

  @Post('tenants/:tenantId/tokens/:tokenId/revoke')
  async revoke(@Req() req: AuthedRequest, @Param('tenantId') tenantId: string, @Param('tokenId') tokenId: string) {
    const admin = requireAdmin(req);
    if (!/^[0-9]{1,9}$/.test(tokenId)) throw new BadRequestException('tokenId tidak valid');
    await this.platform.revokeToken(admin, tenantId, Number(tokenId));
    return { ok: true };
  }
}

import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';
import { requireApi, type AuthedRequest } from './auth';
import { TenantUsersService, type InviteInput, type UserChange } from './tenant-users.service';

/** Pengguna dashboard tenant. Hanya OWNER; OWNER lain dikelola oleh admin platform. */
@Controller('v1/users')
export class TenantUsersController {
  constructor(@Inject(TenantUsersService) private readonly users: TenantUsersService) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.users.list(requireApi(req, ['OWNER']));
  }

  @Post()
  invite(@Req() req: AuthedRequest, @Body() body: InviteInput) {
    return this.users.invite(requireApi(req, ['OWNER']), body ?? {});
  }

  @Put(':ref')
  async update(@Req() req: AuthedRequest, @Param('ref') ref: string, @Body() body: UserChange) {
    const auth = requireApi(req, ['OWNER']);
    if (!/^[0-9]{1,9}$/.test(ref)) throw new BadRequestException('id pengguna tidak valid');
    await this.users.update(auth, Number(ref), body ?? {});
    return { ok: true };
  }
}

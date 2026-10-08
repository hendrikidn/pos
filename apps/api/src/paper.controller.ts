import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { requireApi, type AuthedRequest } from './auth';
import { PaperService, type PaperInput } from './paper.service';

const ROLES = ['OWNER', 'OPS', 'MANAGER'] as const;

@Controller('v1')
export class PaperController {
  constructor(@Inject(PaperService) private readonly paper: PaperService) {}

  @Get('outlets/:outletId/paper-rolls')
  list(@Req() req: AuthedRequest, @Param('outletId') outletId: string) {
    return this.paper.list(requireApi(req, [...ROLES]), outletId);
  }

  @Post('outlets/:outletId/paper-rolls')
  add(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Body() body: PaperInput) {
    return this.paper.add(requireApi(req, [...ROLES]), outletId, body ?? {});
  }
}

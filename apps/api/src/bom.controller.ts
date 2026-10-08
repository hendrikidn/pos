import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { requireApi, type AuthedRequest } from './auth';
import { BomService, type CalcInput } from './bom.service';
import { StockService } from './stock.service';

const READ = ['OWNER', 'OPS', 'MANAGER'] as const;

/** Bill of material: BOM bahan setengah jadi, kalkulator kebutuhan bahan, dan rencana kebutuhan. */
@Controller('v1')
export class BomController {
  constructor(
    @Inject(BomService) private readonly bom: BomService,
    @Inject(StockService) private readonly stock: StockService,
  ) {}

  @Get('boms')
  boms(@Req() req: AuthedRequest) {
    return this.stock.boms(requireApi(req, [...READ]));
  }

  @Put('ingredients/:id/bom')
  async setBom(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { lines?: { ingredientId?: string; qty?: number }[] }) {
    await this.stock.setBom(requireApi(req, ['OWNER', 'OPS']), id, body ?? {});
    return { ok: true };
  }

  @Post('bom/calc')
  calc(@Req() req: AuthedRequest, @Body() body: CalcInput) {
    return this.bom.calc(requireApi(req, [...READ]), body ?? {});
  }

  @Get('outlets/:outletId/bom/plan')
  plan(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Query('days') days?: string, @Query('history') history?: string) {
    return this.bom.plan(requireApi(req, [...READ]), outletId, { days, history });
  }
}

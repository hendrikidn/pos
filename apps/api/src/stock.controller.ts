import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { requireApi, type AuthedRequest } from './auth';
import { StockService, type IngredientInput, type MovementInput, type RecipeInput } from './stock.service';

@Controller('v1')
export class StockController {
  constructor(@Inject(StockService) private readonly stock: StockService) {}

  @Get('ingredients')
  list(@Req() req: AuthedRequest) {
    return this.stock.listIngredients(requireApi(req, ['OWNER', 'OPS', 'MANAGER']));
  }

  @Post('ingredients')
  async create(@Req() req: AuthedRequest, @Body() body: IngredientInput) {
    await this.stock.createIngredient(requireApi(req, ['OWNER', 'OPS']), body ?? {});
    return { ok: true };
  }

  @Put('ingredients/:id')
  async update(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: IngredientInput) {
    await this.stock.updateIngredient(requireApi(req, ['OWNER', 'OPS']), id, body ?? {});
    return { ok: true };
  }

  @Get('recipes')
  recipes(@Req() req: AuthedRequest) {
    return this.stock.recipes(requireApi(req, ['OWNER', 'OPS', 'MANAGER']));
  }

  @Put('menu/:id/recipe')
  async setRecipe(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: RecipeInput) {
    await this.stock.setRecipe(requireApi(req, ['OWNER', 'OPS']), id, body ?? {});
    return { ok: true };
  }

  @Get('outlets/:outletId/stock')
  outletStock(@Req() req: AuthedRequest, @Param('outletId') outletId: string) {
    return this.stock.stock(requireApi(req, ['OWNER', 'OPS', 'MANAGER']), outletId);
  }

  @Post('outlets/:outletId/stock/movements')
  addMovement(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Body() body: MovementInput) {
    return this.stock.addMovement(requireApi(req, ['OWNER', 'OPS', 'MANAGER']), outletId, body ?? {});
  }

  @Get('outlets/:outletId/stock/counts')
  counts(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Query('limit') limit?: string) {
    return this.stock.counts(requireApi(req, ['OWNER', 'OPS', 'MANAGER']), outletId, limit ? Number(limit) : 50);
  }
}

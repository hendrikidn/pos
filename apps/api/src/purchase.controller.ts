import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { IdPipe } from './id-pipe';
import { requireApi, type AuthedRequest } from './auth';
import { PurchaseService, type PaymentInput, type PoInput, type ReceiveInput, type SupplierInput } from './purchase.service';

const READ = ['OWNER', 'OPS', 'MANAGER'] as const;
const WRITE = ['OWNER', 'OPS'] as const;

/** Pengadaan: supplier, pesanan pembelian, penerimaan barang, dan utang. Menerima barang boleh manager (di outlet); membayar supplier hanya owner. */
@Controller('v1')
export class PurchaseController {
  constructor(@Inject(PurchaseService) private readonly purchase: PurchaseService) {}

  @Get('suppliers')
  suppliers(@Req() req: AuthedRequest) {
    return this.purchase.listSuppliers(requireApi(req, [...READ]));
  }

  @Post('suppliers')
  async createSupplier(@Req() req: AuthedRequest, @Body() body: SupplierInput) {
    await this.purchase.createSupplier(requireApi(req, [...WRITE]), body ?? {});
    return { ok: true };
  }

  @Put('suppliers/:id')
  async updateSupplier(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: SupplierInput) {
    await this.purchase.updateSupplier(requireApi(req, [...WRITE]), id, body ?? {});
    return { ok: true };
  }

  @Get('suppliers-payables')
  payables(@Req() req: AuthedRequest) {
    return this.purchase.payables(requireApi(req, [...READ]));
  }

  @Post('suppliers/:id/payments')
  pay(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: PaymentInput) {
    return this.purchase.pay(requireApi(req, ['OWNER']), id, body ?? {});
  }

  @Get('purchase-orders')
  list(@Req() req: AuthedRequest, @Query('outletId') outletId?: string, @Query('status') status?: string) {
    return this.purchase.listPos(requireApi(req, [...READ]), { outletId, status });
  }

  @Post('purchase-orders')
  create(@Req() req: AuthedRequest, @Body() body: PoInput) {
    return this.purchase.createPo(requireApi(req, [...WRITE]), body ?? {});
  }

  @Get('purchase-orders/:id')
  detail(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number) {
    return this.purchase.getPoDetail(requireApi(req, [...READ]), id);
  }

  @Put('purchase-orders/:id')
  async update(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: PoInput) {
    await this.purchase.updatePo(requireApi(req, [...WRITE]), id, body ?? {});
    return { ok: true };
  }

  @Post('purchase-orders/:id/order')
  async order(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number) {
    await this.purchase.orderPo(requireApi(req, [...WRITE]), id);
    return { ok: true };
  }

  @Post('purchase-orders/:id/cancel')
  async cancel(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: { reason?: unknown }) {
    await this.purchase.cancelPo(requireApi(req, [...WRITE]), id, body?.reason);
    return { ok: true };
  }

  @Post('purchase-orders/:id/receive')
  receive(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: ReceiveInput) {
    return this.purchase.receive(requireApi(req, [...READ]), id, body ?? {});
  }
}

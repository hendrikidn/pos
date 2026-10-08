import { Body, Controller, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';
import { requireAdmin, requireApi, type AuthedRequest } from './auth';
import { BillingService } from './billing.service';

@Controller('v1')
export class BillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  /** Langganan dan tagihan milik tenant (owner saja: ini soal uang akun). */
  @Get('billing')
  view(@Req() req: AuthedRequest) {
    return this.billing.view(requireApi(req, ['OWNER']));
  }

  @Get('billing/invoices/:id')
  invoice(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.billing.invoice(requireApi(req, ['OWNER']), id);
  }

  // ----- admin platform -----

  @Get('admin/billing')
  overview(@Req() req: AuthedRequest) {
    requireAdmin(req);
    return this.billing.adminOverview();
  }

  @Post('admin/billing/run')
  run(@Req() req: AuthedRequest) {
    return this.billing.runAll(requireAdmin(req));
  }

  @Post('admin/billing/invoices/:id/pay')
  async pay(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { method?: unknown; reference?: unknown; note?: unknown }) {
    await this.billing.markPaid(requireAdmin(req), id, body ?? {});
    return { ok: true };
  }

  @Post('admin/billing/invoices/:id/void')
  async voidInvoice(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { reason?: unknown }) {
    await this.billing.voidInvoice(requireAdmin(req), id, body?.reason);
    return { ok: true };
  }

  @Put('admin/tenants/:tenantId/subscription')
  async setSubscription(@Req() req: AuthedRequest, @Param('tenantId') tenantId: string, @Body() body: { planId?: unknown; status?: unknown; trialEnd?: unknown }) {
    await this.billing.setSubscription(requireAdmin(req), tenantId, body ?? {});
    return { ok: true };
  }

  @Put('admin/plans/:id')
  async setPlan(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { pricePerOutlet?: unknown }) {
    await this.billing.setPlanPrice(requireAdmin(req), id, body?.pricePerOutlet);
    return { ok: true };
  }
}

import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { IdPipe } from './id-pipe';
import { requireApi, requireDevice, type AuthedRequest } from './auth';
import { ReservationService, type ReservationInput } from './reservation.service';

const STAFF = ['OWNER', 'MANAGER'] as const;

/** Reservasi meja dan uang muka: dikelola owner/manager di dashboard; terminal hanya membaca papan dan mendudukkan tamu. */
@Controller('v1')
export class ReservationController {
  constructor(@Inject(ReservationService) private readonly reservations: ReservationService) {}

  @Get('outlets/:outletId/reservations')
  list(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reservations.list(requireApi(req, [...STAFF]), outletId, { from, to });
  }

  @Post('outlets/:outletId/reservations')
  create(@Req() req: AuthedRequest, @Param('outletId') outletId: string, @Body() body: ReservationInput) {
    return this.reservations.create(requireApi(req, [...STAFF]), outletId, body ?? {});
  }

  @Put('reservations/:id')
  async update(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: ReservationInput) {
    await this.reservations.update(requireApi(req, [...STAFF]), id, body ?? {});
    return { ok: true };
  }

  @Post('reservations/:id/deposit')
  async deposit(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: { amount?: unknown; method?: unknown }) {
    await this.reservations.setDeposit(requireApi(req, [...STAFF]), id, body ?? {});
    return { ok: true };
  }

  @Post('reservations/:id/seat')
  async seat(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number) {
    await this.reservations.seat(requireApi(req, [...STAFF]), id);
    return { ok: true };
  }

  @Post('reservations/:id/no-show')
  async noShow(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number) {
    await this.reservations.noShow(requireApi(req, [...STAFF]), id);
    return { ok: true };
  }

  @Post('reservations/:id/cancel')
  async cancel(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: { reason?: unknown }) {
    await this.reservations.cancel(requireApi(req, [...STAFF]), id, body?.reason);
    return { ok: true };
  }

  @Post('reservations/:id/settle')
  settle(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number, @Body() body: { kind?: unknown; reason?: unknown }) {
    return this.reservations.settle(requireApi(req, [...STAFF]), id, body ?? {});
  }

  /** Papan reservasi untuk kasir (tanpa nomor telepon). Hanya terminal. */
  @Get('reservations/board')
  board(@Req() req: AuthedRequest) {
    const device = requireDevice(req);
    if (device.deviceKind !== 'terminal') throw new ForbiddenException('hanya terminal yang membaca reservasi');
    return this.reservations.board(device);
  }

  /** Terminal mendudukkan tamu yang datang. */
  @Post('reservations/:id/seat-device')
  async seatDevice(@Req() req: AuthedRequest, @Param('id', IdPipe) id: number) {
    const device = requireDevice(req);
    if (device.deviceKind !== 'terminal') throw new ForbiddenException('hanya terminal yang mendudukkan tamu');
    return this.reservations.seatFromDevice(device, id);
  }
}

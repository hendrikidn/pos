import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminService } from './admin.service';
import { AuthGuard } from './auth';
import { BankService } from './bank.service';
import { ConfigController } from './config.controller';
import { ConfigService, PIN_ITERATIONS } from './config.service';
import { ApiController } from './controllers';
import { Database } from './db/database';
import { DeviceController } from './device.controller';
import { DeviceService } from './device.service';
import { GuardService } from './guard.service';
import { IncidentService } from './incident.service';
import { LoginController } from './login.controller';
import { LoginService } from './login.service';
import { MAILER, mailerFromEnv, type Mailer } from './mailer';
import { TenantUsersController } from './tenant-users.controller';
import { TenantUsersService } from './tenant-users.service';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PairingService } from './pairing.service';
import { IngestService } from './ingest.service';
import { KdsService } from './kds.service';
import { TablesService } from './tables.service';
import { HandoffService } from './handoff.service';
import { MemberController } from './member.controller';
import { MemberService } from './member.service';
import { BillingService } from './billing.service';
import { AccountingService } from './accounting.service';
import { ChannelService } from './channel.service';
import { PurchaseService } from './purchase.service';
import { PurchaseController } from './purchase.controller';
import { TransferService } from './transfer.service';
import { HrService } from './hr.service';
import { ReservationService } from './reservation.service';
import { ReservationController } from './reservation.controller';
import { ChannelInboundService } from './channel-inbound.service';
import { ChannelInboundController } from './channel-inbound.controller';
import { WebShopService } from './web-shop.service';
import { WebShopController } from './web-shop.controller';
import { RateLimiter } from './rate-limit';
import { QueueService } from './queue.service';
import { QueueController } from './queue.controller';
import { BomService } from './bom.service';
import { BomController } from './bom.controller';
import { PaperService } from './paper.service';
import { PaperController } from './paper.controller';
import { AttendancePhotoService } from './attendance-photo.service';
import { AttendancePhotoController } from './attendance-photo.controller';
import { HrController } from './hr.controller';
import { TransferController } from './transfer.controller';
import { ChannelController } from './channel.controller';
import { AccountingController } from './accounting.controller';
import { SignupService } from './signup.service';
import { BillingController } from './billing.controller';
import { ReceiptService } from './receipt.service';
import { channelFromEnv, NotificationService, type Channel } from './notification.service';
import { ReportService } from './report.service';
import { ShadowService } from './shadow.service';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { SettlementService } from './settlement.service';
import { CLOCK, EVALUATE_MIN_GAP_MS, EVALUATE_MODE, NOTIFIER, PipelineService, type Clock, type EvaluateMode, type Notifier } from './pipeline.service';
import { Alerter, type AlertSink } from './alerter';
import { OpsController } from './ops.controller';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { Telemetry } from './telemetry';

export interface AppOptions {
  /** Mengganti seluruh pengiriman notifikasi (untuk tes). Bila kosong dipakai NotificationService. */
  notifier?: Notifier;
  /** Saluran pengiriman bagi NotificationService. Bila kosong dipilih dari environment. */
  channel?: Channel;
  dashboardUrl?: string;
  /** Iterasi PBKDF2 untuk hash PIN baru. Tes memakai nilai kecil agar cepat. */
  pinIterations?: number;
  clock?: Clock;
  /** Pengirim email kode masuk. Bila kosong dipilih dari environment (SMTP_*). */
  mailer?: Mailer;
  /** Petunjuk pembayaran yang tampil di tagihan (rekening, QRIS). Bila kosong dipakai BILLING_PAYMENT_INFO atau teks bawaan. */
  billingPaymentInfo?: string;
  /** `background` (produksi): evaluasi aturan digabung dan dijalankan di latar belakang setelah setoran event. Bawaan `sync` (tes). */
  evaluateMode?: EvaluateMode;
  /** Jeda minimum antar-evaluasi satu outlet pada mode background (ms). */
  evaluateMinGapMs?: number;
  /** Pengganti pengiriman peringatan operasional (untuk tes). */
  alertSink?: AlertSink;
}

@Module({})
export class AppModule {
  static forRoot(db: Database, opts: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      controllers: [ApiController, OpsController, AdminAuthController, ConfigController, DeviceController, StockController, MemberController, BillingController, AccountingController, ChannelController, ChannelInboundController, PurchaseController, TransferController, HrController, ReservationController, WebShopController, QueueController, BomController, PaperController, AttendancePhotoController, PlatformController, LoginController, TenantUsersController],
      providers: [
        // useFactory, bukan useValue: Nest menyerialisasi metadata modul dinamis untuk membuat token modul,
        // dan objek database (memori WASM) membuat serialisasi itu gagal.
        { provide: Database, useFactory: () => db },
        { provide: 'CHANNEL', useFactory: () => opts.channel ?? channelFromEnv() },
        { provide: 'PIN_ITERATIONS', useFactory: () => opts.pinIterations ?? Number(process.env['PIN_ITERATIONS'] ?? PIN_ITERATIONS) },
        { provide: 'BILLING_PAYMENT_INFO', useFactory: () => opts.billingPaymentInfo ?? process.env['BILLING_PAYMENT_INFO'] ?? 'Transfer ke rekening yang tertera pada faktur dari tim kami, lalu kirim bukti ke email dukungan.' },
        { provide: 'DASHBOARD_URL', useFactory: () => opts.dashboardUrl ?? process.env['DASHBOARD_URL'] },
        { provide: NOTIFIER, useFactory: (svc: NotificationService) => opts.notifier ?? svc, inject: [NotificationService] },
        { provide: MAILER, useFactory: () => opts.mailer ?? mailerFromEnv() },
        { provide: CLOCK, useFactory: () => opts.clock ?? Date.now },
        { provide: EVALUATE_MODE, useFactory: () => opts.evaluateMode ?? 'sync' },
        { provide: EVALUATE_MIN_GAP_MS, useFactory: () => opts.evaluateMinGapMs ?? Number(process.env['EVALUATE_MIN_GAP_MS'] ?? 15_000) },
        Telemetry,
        { provide: Alerter, useFactory: () => { const a = new Alerter(); if (opts.alertSink) a.sink = opts.alertSink; return a; } },
        { provide: APP_GUARD, useClass: AuthGuard },
        AdminService, AdminAuthService, IngestService, GuardService, TablesService, HandoffService, MemberService, BillingService, SignupService, AccountingService, ChannelService, ChannelInboundService, PurchaseService, TransferService, HrService, ReservationService, WebShopService, QueueService, BomService, PaperService, AttendancePhotoService, RateLimiter, BankService, IncidentService, PipelineService, NotificationService, ConfigService, SettlementService, ReportService, ShadowService, KdsService, ReceiptService, StockService, DeviceService, PairingService, PlatformService, LoginService, TenantUsersService,
      ],
      exports: [AdminService, ConfigService],
    };
  }
}

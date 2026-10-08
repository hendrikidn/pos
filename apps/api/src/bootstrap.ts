import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule, type AppOptions } from './app.module';
import { DataErrorFilter } from './data-error.filter';
import type { Database } from './db/database';

export async function createApp(
  db: Database,
  opts: AppOptions & { corsOrigins?: string[]; trustProxy?: number | string } = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(db, opts), { logger: ['error', 'warn'], abortOnError: false });
  app.useGlobalFilters(new DataErrorFilter(app.getHttpAdapter()));
  // Laporan bank diunggah sebagai teks dalam JSON.
  app.useBodyParser('json', { limit: '10mb' });
  // Di belakang reverse proxy (nginx/Caddy), alamat pemanggil sebenarnya ada di X-Forwarded-For. Tanpa ini semua pemanggil terlihat
  // berasal dari proxy, dan pembatas percobaan kode pairing menghukum semua orang sekaligus.
  if (opts.trustProxy !== undefined) app.set('trust proxy', opts.trustProxy);
  // POS berbasis web memanggil API langsung dari browser; asal yang diizinkan harus disebut eksplisit.
  if (opts.corsOrigins?.length) {
    app.enableCors({ origin: opts.corsOrigins, methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['authorization', 'content-type'] });
  }
  return app;
}

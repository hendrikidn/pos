import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Alerter } from './alerter';
import type { AuthedRequest } from './auth';
import type { Telemetry } from './telemetry';

const QUIET = new Set(['/healthz', '/readyz', '/metrics']);
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const SLOW_SECONDS = 2;

/** Header keamanan untuk API (JSON): tidak ada yang perlu di-embed, di-cache, atau ditebak tipenya. HSTS hanya bila sambungannya HTTPS (lewat proxy tepercaya) atau `FORCE_HSTS=1`. */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  if (req.secure || process.env['FORCE_HSTS'] === '1') res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
}

/**
 * Satu baris JSON per permintaan (stdout, siap dikumpulkan Docker/Loki): id permintaan (dari proxy bila sah, kalau tidak dibuat; juga
 * dikembalikan di header `x-request-id`), metode, POLA rute, status, lama, jenis pemanggil, tenant, dan alamat. Tidak pernah mencatat
 * isi, query string, header otorisasi, atau alamat mentah (yang bisa memuat id dan token).
 */
export function requestLogger(telemetry: Telemetry, alerter: Alerter, opts: { log: boolean }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const t0 = process.hrtime.bigint();
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomBytes(8).toString('hex');
    res.setHeader('x-request-id', id);
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
      const path = req.path;
      const route = req.route?.path ? `${req.baseUrl ?? ''}${String(req.route.path)}` : 'unmatched';
      if (!QUIET.has(path)) telemetry.observeHttp(req.method, route, res.statusCode, seconds);
      const auth = (req as AuthedRequest).auth;
      const failed = res.statusCode >= 500;
      // /readyz punya peringatan sendiri (database tidak terjangkau); jangan dobel.
      if (failed && !QUIET.has(path)) void alerter.alert(`http5xx:${req.method} ${route}`, `Kesalahan server ${res.statusCode} pada ${req.method} ${route} (id ${id}).`);
      if (!opts.log || (QUIET.has(path) && !failed)) return;
      const level = failed ? 'error' : seconds > SLOW_SECONDS ? 'warn' : 'info';
      process.stdout.write(`${JSON.stringify({
        ts: new Date().toISOString(), level, msg: 'http', id, method: req.method, route, status: res.statusCode, ms: Math.round(seconds * 1000),
        actor: auth?.kind ?? null, tenant: auth && 'tenantId' in auth ? auth.tenantId : null, ip: req.ip,
      })}\n`);
    });
    next();
  };
}

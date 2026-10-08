import { ArgumentsHost, BadRequestException, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/**
 * Kesalahan data dari PostgreSQL (SQLSTATE kelas 22: byte NUL dalam teks, angka di luar rentang, format salah) berarti masukan pemanggil tidak
 * sah, bukan kerusakan server: dijawab 400. Tanpa ini, id seperti "99999999999999999999" atau "%00" di URL menjadi kesalahan 500.
 */
@Catch()
export class DataErrorFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost) {
    const code = (exception as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && /^22[0-9A-Z]{3}$/.test(code)) return super.catch(new BadRequestException('masukan tidak valid'), host);
    return super.catch(exception, host);
  }
}

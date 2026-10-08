import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

/**
 * Id numerik di jalur URL (`/reservations/:id`). Hanya bilangan bulat tak negatif sampai 15 digit: `ParseIntPipe` bawaan menerima angka
 * sebesar apa pun ("99999999999999999999"), yang lalu ditolak PostgreSQL (di luar rentang bigint) dan menjadi kesalahan 500.
 */
@Injectable()
export class IdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    if (!/^\d{1,15}$/.test(value)) throw new BadRequestException('id tidak valid');
    return Number(value);
  }
}

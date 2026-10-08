import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Database } from './db/database';

/**
 * Pembatas laju berbasis jendela tetap, disimpan di database sehingga bertahan lewat restart, berlaku di semua instance API, dan tidak pernah
 * "lupa" karena memori penuh. Kunci diberi awalan per pemakaian (mis. `web:order:<alamat>`). Satu pernyataan upsert menaikkan hitungan secara
 * atomik: dua permintaan serentak tidak bisa sama-sama lolos di batas.
 */
@Injectable()
export class RateLimiter {
  private ops = 0;

  constructor(@Inject(Database) private readonly db: Database) {}

  /** Menghitung satu kejadian pada `key`; mengembalikan hitungan jendela saat ini dan kapan jendela berakhir. */
  async hit(key: string, windowMs: number, now: number): Promise<{ count: number; resetAt: number }> {
    const r = (await this.db.admin.query<{ count: number; reset_at_ms: number }>(
      `insert into rate_limit (key, count, reset_at_ms) values ($1, 1, $2::float8 + $3::float8)
       on conflict (key) do update set
         count = case when rate_limit.reset_at_ms <= $2::float8 then 1 else rate_limit.count + 1 end,
         reset_at_ms = case when rate_limit.reset_at_ms <= $2::float8 then $2::float8 + $3::float8 else rate_limit.reset_at_ms end
       returning count, reset_at_ms`,
      [key, now, windowMs],
    )).rows[0]!;
    // Baris yang jendelanya sudah berakhir dibersihkan sesekali (tanpa penjadwal terpisah).
    if (++this.ops % 200 === 0) await this.db.admin.query('delete from rate_limit where reset_at_ms < $1', [now - 3_600_000]);
    return { count: Number(r.count), resetAt: Number(r.reset_at_ms) };
  }

  /** Membatalkan satu hitungan (mis. permintaan ternyata tidak sah dan tidak boleh menghabiskan jatah pemanggil). */
  async undo(key: string): Promise<void> {
    await this.db.admin.query('update rate_limit set count = greatest(count - 1, 0) where key = $1', [key]);
  }

  /** Hitungan jendela yang masih berjalan pada `key` tanpa menambah (0 bila tidak ada atau sudah berakhir). */
  async count(key: string, now: number): Promise<number> {
    const r = (await this.db.admin.query<{ count: number }>('select count from rate_limit where key = $1 and reset_at_ms > $2', [key, now])).rows[0];
    return r ? Number(r.count) : 0;
  }

  /** Menghitung satu kejadian dan menolak (429) bila melebihi `max` dalam jendela `windowMs`. */
  async enforce(key: string, max: number, windowMs: number, now: number, message: string): Promise<void> {
    if ((await this.hit(key, windowMs, now)).count > max) throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Menolak (429) bila hitungan `key` sudah mencapai `max`, tanpa menambah. Dipakai untuk pembatas yang hanya menghitung kegagalan. */
  async assertBelow(key: string, max: number, now: number, message: string): Promise<void> {
    if ((await this.count(key, now)) >= max) throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

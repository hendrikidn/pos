import type { Role } from '@pos/order';
import { derivePin, safeEqual } from './kdf';
import type { Staff, StaffPublic } from './types';

const MAX_FAILURES = 5;
const LOCK_MS = 60_000;

/** Daftar staf dan verifikasi PIN (hash PBKDF2 per orang) dengan penguncian setelah beberapa kali salah. */
export class Directory {
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private staff: Staff[],
    private readonly now: () => number,
  ) {}

  /** Mengganti daftar staf (setelah sinkronisasi konfigurasi). Hitungan salah-PIN dipertahankan. */
  setStaff(staff: Staff[]): void {
    this.staff = staff;
  }

  list(): StaffPublic[] {
    return this.staff.map(({ id, name, role }) => ({ id, name, role }));
  }

  get(id: string): StaffPublic | undefined {
    return this.list().find((s) => s.id === id);
  }

  roleOf = (id: string): Role | undefined => this.staff.find((s) => s.id === id)?.role;

  /** Mengembalikan 'OK', 'WRONG', atau 'LOCKED'. */
  async verify(userId: string, pin: string): Promise<'OK' | 'WRONG' | 'LOCKED'> {
    const f = this.failures.get(userId);
    if (f && f.lockedUntil > this.now()) return 'LOCKED';
    const user = this.staff.find((s) => s.id === userId);
    // Pengguna tidak dikenal tetap menjalani derivasi agar waktu respons tidak membedakannya.
    const derived = await derivePin(pin, user?.salt ?? '00'.repeat(16), user?.iterations ?? 1_000);
    if (user && safeEqual(derived, user.hash)) {
      this.failures.delete(userId);
      return 'OK';
    }
    const count = (f?.count ?? 0) + 1;
    // Setelah MAX_FAILURES kesalahan beruntun, user terkunci sementara dan hitungan diulang.
    this.failures.set(userId, count >= MAX_FAILURES ? { count: 0, lockedUntil: this.now() + LOCK_MS } : { count, lockedUntil: 0 });
    return 'WRONG';
  }
}

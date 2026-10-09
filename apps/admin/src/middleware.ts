import { NextResponse, type NextRequest } from 'next/server';
import { allowedByList, clientIp } from '@/lib/ip-allow';

const COOKIE = 'guard_admin_token';

/**
 * Pembatasan alamat (ADMIN_ALLOWED_IPS, bila diisi) berlaku untuk SEMUA jalur konsol, termasuk /login: alamat di luar daftar tidak melihat apa pun.
 * Selain /login, halaman memerlukan cookie sesi; keabsahannya diperiksa API pada setiap permintaan.
 */
export function middleware(req: NextRequest) {
  if (!allowedByList(process.env.ADMIN_ALLOWED_IPS, clientIp(req.headers))) {
    return new NextResponse('Akses konsol admin tidak diizinkan dari alamat ini.', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const { pathname } = req.nextUrl;
  const open = pathname === '/login' || pathname.startsWith('/api/login');
  if (!open && !req.cookies.get(COOKIE)?.value) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|logo.png|icon.png|apple-icon.png).*)'] };

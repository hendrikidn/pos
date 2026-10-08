import { NextResponse, type NextRequest } from 'next/server';
import { TOKEN_COOKIE as COOKIE } from '@/lib/cookie';

/** Halaman selain /login memerlukan cookie token; keabsahannya diperiksa API pada setiap permintaan. */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const open = pathname === '/login' || pathname === '/signup' || pathname.startsWith('/r/') || pathname.startsWith('/api/login') || pathname.startsWith('/api/otp') || pathname.startsWith('/api/auth');
  if (!open && !req.cookies.get(COOKIE)?.value) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|logo.png|icon.png|apple-icon.png).*)'] };

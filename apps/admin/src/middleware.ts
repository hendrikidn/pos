import { NextResponse, type NextRequest } from 'next/server';

const COOKIE = 'guard_admin_token';

/** Halaman selain /login memerlukan cookie token; keabsahannya diperiksa API pada setiap permintaan. */
export function middleware(req: NextRequest) {
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

import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC = ['/login', '/recuperar', '/restablecer'];

/**
 * Redirige a /login si no hay cookie de sesión. Es solo una comodidad de navegación:
 * la autorización real la hace la API en cada petición.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (!req.cookies.get('mg_session')) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname !== '/' ? `?next=${encodeURIComponent(pathname)}` : '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!backend|_next|favicon.ico|.*\\.(?:png|svg|ico|jpg|webp)$).*)'] };

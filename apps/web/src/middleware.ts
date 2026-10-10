import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC = ['/login', '/recuperar', '/restablecer'];

/**
 * Origen público de la aplicación. Detrás de un proxy (Nginx) `req.nextUrl` lleva el host interno
 * (p. ej. localhost:3100), así que se usa APP_URL si está definida o, si no, las cabeceras Host y
 * X-Forwarded-Proto que envía el proxy.
 */
function publicOrigin(req: NextRequest): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? req.nextUrl.host;
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim() ?? req.nextUrl.protocol.replace(':', '');
  return `${proto}://${host}`;
}

/**
 * Redirige a /login si no hay cookie de sesión. Es solo una comodidad de navegación:
 * la autorización real la hace la API en cada petición.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (!req.cookies.get('mg_session')) {
    const target = pathname !== '/' ? `/login?next=${encodeURIComponent(pathname + search)}` : '/login';
    return NextResponse.redirect(new URL(target, publicOrigin(req)), 307);
  }
  return NextResponse.next();
}

// Recursos públicos de la PWA (sw.js, offline.html, manifest) e imágenes no pasan por el control de sesión.
export const config = { matcher: ['/((?!backend|_next|favicon.ico|sw\\.js|offline\\.html|manifest\\.webmanifest|.*\\.(?:png|svg|ico|jpg|webp)$).*)'] };

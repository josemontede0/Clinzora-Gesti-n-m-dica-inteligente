import type { NextConfig } from 'next';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3001';

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  transpilePackages: ['@medigest/shared'],
  poweredByHeader: false,
  // El navegador habla con la API a través de /backend (mismo origen): la cookie httpOnly de sesión
  // viaja sola, SameSite=Strict funciona y no hace falta CORS.
  async rewrites() {
    return [{ source: '/backend/:path*', destination: `${API_URL}/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  experimental: { middlewareClientMaxBodySize: '20mb' },
};

export default nextConfig;

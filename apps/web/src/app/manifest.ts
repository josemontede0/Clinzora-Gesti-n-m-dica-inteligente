import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Clinzora — Gestión médica inteligente',
    short_name: 'Clinzora',
    description: 'Tecnología para una mejor salud. Pacientes, citas, facturación y seguros médicos en una sola plataforma.',
    id: '/',
    start_url: '/',
    scope: '/',
    lang: 'es-DO',
    display: 'standalone',
    orientation: 'any',
    categories: ['medical', 'business', 'productivity'],
    theme_color: '#0B2E4F',
    background_color: '#FFFFFF',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/brand/clinzora-icono.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
    shortcuts: [
      { name: 'Agenda', url: '/agenda', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
      { name: 'Sala de espera', url: '/recepcion', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
      { name: 'Pacientes', url: '/pacientes', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
      { name: 'Caja', url: '/caja', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
    ],
  };
}

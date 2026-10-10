import { expect, test } from '@playwright/test';

test.describe('Aplicación instalable (PWA)', () => {
  test('el manifest, el service worker y la página sin conexión son públicos y correctos', async ({ request }) => {
    const manifest = await request.get('/manifest.webmanifest', { maxRedirects: 0 });
    expect(manifest.status()).toBe(200);
    const m = await manifest.json();
    expect(m.short_name).toBe('Clinzora');
    expect(m.display).toBe('standalone');
    expect(m.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));

    // Sin sesión no deben redirigir al login (si no, la instalación fallaría).
    const sw = await request.get('/sw.js', { maxRedirects: 0 });
    expect(sw.status()).toBe(200);
    const swCode = await sw.text();
    // Política de privacidad del service worker: nunca guarda respuestas de la API.
    expect(swCode).toContain("url.pathname.startsWith('/backend')");

    const offline = await request.get('/offline.html', { maxRedirects: 0 });
    expect(offline.status()).toBe(200);
    expect(await offline.text()).toContain('Sin conexión');
  });
});

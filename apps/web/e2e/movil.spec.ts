import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.describe('Uso en móvil', () => {
  test('el menú lateral se abre desde el botón y las pantallas no desbordan horizontalmente', async ({ page }) => {
    await login(page, 'gerencia');
    await page.getByRole('button', { name: 'Abrir menú' }).click();
    await page.getByRole('link', { name: 'Pacientes' }).click();
    await expect(page).toHaveURL(/\/pacientes$/);

    for (const path of ['/', '/pacientes', '/agenda', '/recepcion', '/facturacion', '/seguros', '/reportes', '/configuracion']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `desborde horizontal en ${path}`).toBeLessThanOrEqual(1);
    }
  });

  test('en móvil la agenda usa vistas legibles (día o agenda)', async ({ page }) => {
    await login(page, 'recepcion');
    await page.goto('/agenda');
    await expect(page.getByRole('button', { name: 'Semana' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Agenda', exact: true })).toBeVisible();
  });
});

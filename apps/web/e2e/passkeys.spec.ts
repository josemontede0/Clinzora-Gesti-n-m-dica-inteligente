import { expect, test } from '@playwright/test';
import { login } from './helpers';

test('activa Face ID / huella en Mi perfil y luego entra sin contraseña', async ({ page, context }) => {
  // Autenticador virtual de Chrome: simula Face ID / huella con verificación del usuario.
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await login(page, 'caja');
  await page.goto('/perfil');
  await page.getByRole('button', { name: /Activar en este dispositivo/ }).click();
  await expect(page.getByText('Listo: la próxima vez puede entrar sin contraseña.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Quitar/ })).toHaveCount(1);

  // Un segundo registro en el mismo equipo se rechaza.
  await page.getByRole('button', { name: /Activar en este dispositivo/ }).click();
  await expect(page.getByText('Este dispositivo ya tiene una llave de acceso registrada.')).toBeVisible();

  await context.clearCookies();
  await page.goto('/login');
  await page.getByRole('button', { name: /Entrar con (Face ID|huella)/ }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto('/perfil');
  await expect(page.getByText('caja@ejemplo.test')).toBeVisible();
});

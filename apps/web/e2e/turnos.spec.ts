import { expect, test } from '@playwright/test';
import { login } from './helpers';

test('se crea una pantalla, recepción emite y llama un turno y la pantalla lo proyecta', async ({ page, browser }) => {
  await login(page, 'admin');
  await page.goto('/configuracion');
  await page.getByRole('tab', { name: 'Turnos y pantallas' }).click();
  await expect(page.getByText('Áreas de turnos')).toBeVisible();
  await page.getByRole('button', { name: 'Pantalla', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Nombre', { exact: true }).fill('TV prueba');
  await page.getByRole('button', { name: 'Crear' }).click();
  const url = await page.getByLabel('Enlace de la pantalla').inputValue();
  expect(url).toMatch(/\/pantalla\/[A-Za-z0-9_-]{20,}$/);

  // La pantalla se abre sin sesión.
  const tv = await (await browser.newContext()).newPage();
  await tv.goto(url);
  await expect(tv.getByText('Esperando el próximo llamado…')).toBeVisible();

  const rec = await (await browser.newContext()).newPage();
  await login(rec, 'recepcion');
  await rec.goto('/turnos');
  await rec.getByLabel('Mi puesto').fill('Ventanilla 2');
  await rec.getByRole('button', { name: 'Nuevo turno' }).click();
  await rec.getByLabel('Área').selectOption({ label: 'I · Información' });
  await rec.getByRole('button', { name: 'Emitir turno' }).click();
  const code = (await rec.getByRole('dialog').getByText(/^I-\d{3}$/).textContent())!;
  await rec.keyboard.press('Escape');
  await rec.getByRole('button', { name: /I · Información/ }).click();
  await rec.getByRole('button', { name: 'Llamar siguiente' }).click();
  await expect(rec.getByRole('button', { name: 'Volver a llamar' })).toBeVisible();

  await expect(tv.getByText(code, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(tv.getByText('Ventanilla 2').first()).toBeVisible();
});

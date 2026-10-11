import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'Prueba#Segura2026';

export async function login(page: Page, user: string) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(`${user}@ejemplo.test`);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Próximo día hábil (lun–vie) en Santo Domingo, como YYYY-MM-DD. */
export function nextBusinessDay(offset = 1): string {
  const d = new Date(Date.now() - 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + offset);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

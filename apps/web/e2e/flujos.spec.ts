import { expect, test } from '@playwright/test';
import { login, nextBusinessDay } from './helpers';

test.describe('Flujos principales en la interfaz', () => {
  test('recepción registra un paciente y le agenda una cita en un espacio disponible', async ({ page }) => {
    await login(page, 'recepcion');
    await page.goto('/pacientes/nuevo');
    await page.getByLabel('Nombres').fill('Interfaz');
    await page.getByLabel('Apellidos').fill('Playwright Prueba');
    await page.getByLabel('Tipo de documento').selectOption('NINGUNO');
    await page.getByPlaceholder('809-555-0000').fill('809-555-7777');
    await page.getByRole('button', { name: 'Registrar paciente' }).click();
    await expect(page).toHaveURL(/\/pacientes\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'Interfaz Playwright Prueba' })).toBeVisible();

    await page.getByRole('link', { name: 'Nueva cita' }).click();
    await expect(page.getByText('Playwright Prueba, Interfaz')).toBeVisible();
    await page.getByLabel('Médico').selectOption({ index: 1 });
    await page.getByLabel('Fecha', { exact: true }).fill(nextBusinessDay(2));
    const slot = page.getByRole('button', { name: /^\d{2}:\d{2}$/ }).first();
    await expect(slot).toBeVisible();
    await slot.click();
    await page.getByRole('button', { name: 'Guardar cita' }).click();
    await expect(page).toHaveURL(/\/recepcion\?cita=/);
    const dialog = page.getByRole('dialog', { name: 'Detalle de la cita' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Interfaz Playwright Prueba')).toBeVisible();
    await expect(dialog.getByText('Confirmada', { exact: true }).first()).toBeVisible();
  });

  test('la búsqueda global encuentra pacientes sin tildes y la médica ve sus alergias', async ({ page }) => {
    await login(page, 'medico');
    await page.getByRole('combobox', { name: /Buscar paciente/ }).fill('martinez');
    await page.getByRole('option', { name: /Martínez Gómez, José/ }).click();
    await expect(page.getByRole('heading', { name: 'José Martínez Gómez' })).toBeVisible();
    await page.getByRole('link', { name: 'Expediente clínico' }).click();
    await expect(page.getByText(/Alergias:.*Penicilina/).first()).toBeVisible();
    await expect(page.getByText('Cronología de consultas')).toBeVisible();
  });

  test('el cajero abre caja y cobra el saldo pendiente de una factura', async ({ page }) => {
    await login(page, 'caja');
    await page.goto('/caja');
    await page.getByLabel(/^Caja/).selectOption({ label: 'Caja 1 · Sede Central' });
    await page.getByLabel('Fondo inicial en efectivo').fill('1000');
    await page.getByRole('button', { name: 'Abrir caja' }).click();
    await expect(page.getByText('Efectivo esperado en caja')).toBeVisible();

    await page.goto('/facturacion');
    await page.getByLabel('Buscar facturas').fill('FAC-000004');
    await page.getByRole('cell', { name: 'FAC-000004' }).click();
    await expect(page.getByRole('heading', { name: 'Factura FAC-000004' })).toBeVisible();
    await page.getByRole('link', { name: 'Cobrar' }).click();
    await expect(page.getByLabel('Monto a aplicar a FAC-000004')).toHaveValue(/^300(.00)?$/);
    await page.getByRole('button', { name: 'Registrar cobro' }).click();
    const dialog = page.getByRole('dialog', { name: /Cobro registrado/ });
    await expect(dialog).toBeVisible();
    const receiptNumber = (await dialog.getByRole('heading').textContent())!.match(/REC-\d+/)![0];
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Descargar' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^recibo-REC-\d+\.pdf$/);

    // Historial de recibos: el cobro aparece y se puede reimprimir (descarga marcada como copia).
    await page.goto('/caja/recibos');
    await page.getByLabel('Buscar recibos').fill(receiptNumber);
    await page.getByRole('cell', { name: receiptNumber }).click();
    const receipt = page.getByRole('dialog', { name: `Recibo ${receiptNumber}` });
    await expect(receipt.getByRole('button', { name: 'Reimprimir' })).toBeVisible();
    const copyPromise = page.waitForEvent('download');
    await receipt.getByRole('button', { name: 'Descargar' }).click();
    expect((await copyPromise).suggestedFilename()).toMatch(/-copia\.pdf$/);

    await page.goto('/facturacion');
    await page.getByLabel('Buscar facturas').fill('FAC-000004');
    await page.getByRole('cell', { name: 'FAC-000004' }).click();
    await expect(page.getByText('Pagada', { exact: true }).first()).toBeVisible();
  });

  test('el cajero no puede abrir el expediente clínico', async ({ page }) => {
    await login(page, 'caja');
    const res = await page.request.get('/backend/patients?q=martinez');
    const { items } = await res.json();
    await page.goto(`/clinico/paciente/${items[0].id}`);
    await expect(page.getByText(/No tiene permiso|relación asistencial/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Expediente clínico' })).toHaveCount(0);
  });

  test('gerencia ve los indicadores financieros separados', async ({ page }) => {
    await login(page, 'gerencia');
    const finanzas = page.getByRole('region', { name: 'Indicadores financieros' });
    await expect(finanzas.getByText('Facturado', { exact: true })).toBeVisible();
    await expect(finanzas.getByText('Cobrado (neto)')).toBeVisible();
    await expect(finanzas.getByText('Por cobrar a aseguradoras')).toBeVisible();
  });

  test('una sesión inválida redirige al inicio de sesión', async ({ page }) => {
    await page.goto('/facturacion');
    await expect(page).toHaveURL(/\/login\?next=%2Ffacturacion/);
  });

  test('detrás de un proxy, la redirección al login usa el dominio público y no el host interno', async ({ request }) => {
    const res = await request.get('/pacientes', { maxRedirects: 0, headers: { Host: 'clinzora.ejemplo.test', 'X-Forwarded-Proto': 'https' } });
    expect(res.status()).toBe(307);
    expect(res.headers()['location']).toBe('https://clinzora.ejemplo.test/login?next=%2Fpacientes');
  });
});

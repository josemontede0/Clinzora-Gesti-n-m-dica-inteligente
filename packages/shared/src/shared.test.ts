import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, fromCents, computeLine, coverageFor, invoiceBalance, formatMoney } from './money';
import { canTransition } from './status';
import { isValidCedula, zonedToUtc, utcToZonedParts, formatDate, normalizePhone, renderTemplate } from './format';
import { passwordPolicy, patientCreateSchema, paymentCreateSchema } from './schemas';

test('toCents/fromCents redondea half-up sin punto flotante binario', () => {
  assert.equal(toCents('1,234.505'), 123451);
  assert.equal(toCents('0.1'), 10);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(fromCents(123450), '1234.50');
  assert.equal(fromCents(-5), '-0.05');
});

test('computeLine aplica descuento, impuesto y cobertura', () => {
  const r = computeLine({ quantity: 2, unitPrice: 150000, discount: 10000, taxRate: '18', insuranceAmount: 200000 });
  assert.equal(r.gross, 300000);
  assert.equal(r.taxable, 290000);
  assert.equal(r.tax, 52200);
  assert.equal(r.total, 342200);
  assert.equal(r.insuranceAmount, 200000);
  assert.equal(r.patientAmount, 142200);
  assert.throws(() => computeLine({ quantity: 1, unitPrice: 100, discount: 200, taxRate: 0 }));
});

test('coverageFor nunca supera el total', () => {
  assert.equal(coverageFor(300000, 500000, null), 300000);
  assert.equal(coverageFor(300000, null, '80'), 240000);
  assert.equal(coverageFor(300000, null, null), 0);
});

test('saldo = facturado − pagos − créditos', () => {
  assert.equal(invoiceBalance(300000, 100000, 50000), 150000);
});

test('formatMoney en DOP', () => {
  assert.equal(formatMoney('3000'), 'RD$3,000.00');
});

test('transiciones de cita', () => {
  assert.equal(canTransition('CONFIRMADA', 'EN_ESPERA'), true);
  assert.equal(canTransition('COMPLETADA', 'CANCELADA'), false);
  assert.equal(canTransition('CANCELADA', 'CONFIRMADA'), false);
});

test('cédula dominicana', () => {
  assert.equal(isValidCedula('001-0000001-7'), true);
  assert.equal(isValidCedula('00100000018'), false);
  assert.equal(isValidCedula('123'), false);
});

test('zonas horarias: Santo Domingo es UTC−4', () => {
  const d = zonedToUtc('2026-10-12', 9 * 60, 'America/Santo_Domingo');
  assert.equal(d.toISOString(), '2026-10-12T13:00:00.000Z');
  const p = utcToZonedParts(d, 'America/Santo_Domingo');
  assert.deepEqual(p, { ymd: '2026-10-12', weekday: 1, minutes: 540 });
  assert.equal(formatDate('2026-10-12T02:00:00.000Z'), '11/10/2026');
  assert.equal(formatDate('1990-05-20'), '20/05/1990');
});

test('normalizePhone y plantillas', () => {
  assert.equal(normalizePhone('+1 (809) 555-1234'), '8095551234');
  assert.equal(renderTemplate('Hola {{nombre}}, cita {{fecha}}', { nombre: 'Ana', fecha: '12/10/2026' }), 'Hola Ana, cita 12/10/2026');
});

test('política de contraseñas', () => {
  assert.equal(passwordPolicy.safeParse('corta').success, false);
  assert.equal(passwordPolicy.safeParse('SinSimbolo123').success, false);
  assert.equal(passwordPolicy.safeParse('Segura#2026x').success, true);
});

test('paciente: cédula obligatoria y válida', () => {
  const base = { firstName: 'Ana', lastName: 'Pérez', documentType: 'CEDULA', sex: 'FEMENINO' };
  assert.equal(patientCreateSchema.safeParse(base).success, false);
  assert.equal(patientCreateSchema.safeParse({ ...base, documentNumber: '00100000017' }).success, true);
  assert.equal(patientCreateSchema.safeParse({ ...base, documentType: 'NINGUNO' }).success, true);
});

test('pago: rechaza importes con más de 2 decimales y tarjeta completa', () => {
  const base = { patientId: '3f0b0c0e-1a2b-4c3d-9e8f-0a1b2c3d4e5f', branchId: '3f0b0c0e-1a2b-4c3d-9e8f-0a1b2c3d4e5f', idempotencyKey: 'abcdefgh12' };
  const method = '3f0b0c0e-1a2b-4c3d-9e8f-0a1b2c3d4e5f';
  assert.equal(paymentCreateSchema.safeParse({ ...base, tenders: [{ methodId: method, amount: '10.123' }] }).success, false);
  assert.equal(paymentCreateSchema.safeParse({ ...base, tenders: [{ methodId: method, amount: '10', cardLast4: '4111111111111111' }] }).success, false);
  assert.equal(paymentCreateSchema.safeParse({ ...base, tenders: [{ methodId: method, amount: '1000.50', cardLast4: '1111' }] }).success, true);
});

import { Prisma } from '@prisma/client';
import { decryptSecret, encryptSecret, signFileUrl, verifyFileUrl } from '../../src/common/crypto';
import { redact } from '../../src/common/logger';
import { claimExpected } from '../../src/modules/insurance/claims.service';
import { montoEnLetras } from '../../src/modules/billing/number-words';

describe('redacción de logs', () => {
  it('oculta contraseñas, tokens, tarjetas y contenido clínico', () => {
    const out = redact({ email: 'a@b.test', password: 'x', token: 'y', cardNumber: '4111', nested: { content: 'nota clínica', diagnosis: 'z', ok: 1 } }) as Record<string, unknown>;
    expect(out.email).toBe('a@b.test');
    expect(out.password).toBe('[REDACTADO]');
    expect(out.token).toBe('[REDACTADO]');
    expect(out.cardNumber).toBe('[REDACTADO]');
    expect((out.nested as Record<string, unknown>).content).toBe('[REDACTADO]');
    expect((out.nested as Record<string, unknown>).diagnosis).toBe('[REDACTADO]');
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
  });
});

describe('enlaces firmados de archivos', () => {
  it('son válidos solo para el mismo archivo, usuario y antes de vencer', () => {
    const exp = Date.now() + 60_000;
    const sig = signFileUrl('f1', 'u1', exp);
    expect(verifyFileUrl('f1', 'u1', exp, sig)).toBe(true);
    expect(verifyFileUrl('f1', 'u2', exp, sig)).toBe(false);
    expect(verifyFileUrl('f2', 'u1', exp, sig)).toBe(false);
    expect(verifyFileUrl('f1', 'u1', Date.now() - 1, signFileUrl('f1', 'u1', Date.now() - 1))).toBe(false);
  });
});

describe('cifrado del secreto MFA', () => {
  it('cifra con AES-GCM y detecta manipulación', () => {
    const enc = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(enc)).toBe('JBSWY3DPEHPK3PXP');
    const [iv, tag, data] = enc.split('.');
    const tampered = [iv, tag, data.slice(0, -2) + (data.endsWith('A') ? 'BB' : 'AA')].join('.');
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

describe('montos de reclamación', () => {
  const base = { claimedAmount: new Prisma.Decimal(2500), approvedAmount: null as Prisma.Decimal | null, glosaAmount: new Prisma.Decimal(0), status: 'SOMETIDA' as const };
  it('sin respuesta de la ARS: reclamado − glosas', () => {
    expect(claimExpected({ ...base, glosaAmount: new Prisma.Decimal(300) })).toBe(220000);
  });
  it('con aprobación: el aprobado manda', () => {
    expect(claimExpected({ ...base, approvedAmount: new Prisma.Decimal(2000) })).toBe(200000);
  });
  it('rechazada: cero', () => {
    expect(claimExpected({ ...base, status: 'RECHAZADA' as never })).toBe(0);
  });
});


describe('monto en letras para recibos', () => {
  it.each([
    [100, 'UN PESO CON 00/100'],
    [300000, 'TRES MIL PESOS CON 00/100'],
    [350050, 'TRES MIL QUINIENTOS PESOS CON 50/100'],
    [2100000, 'VEINTIÚN MIL PESOS CON 00/100'],
    [10000, 'CIEN PESOS CON 00/100'],
    [10100, 'CIENTO UN PESOS CON 00/100'],
    [100000000, 'UN MILLÓN DE PESOS CON 00/100'],
    [123456789, 'UN MILLÓN DOSCIENTOS TREINTA Y CUATRO MIL QUINIENTOS SESENTA Y SIETE PESOS CON 89/100'],
    [3100000000, 'TREINTA Y UN MILLONES DE PESOS CON 00/100'],
    [5, 'CERO PESOS CON 05/100'],
  ])('%i centavos → %s', (cents, txt) => {
    expect(montoEnLetras(cents)).toBe(txt);
  });
});

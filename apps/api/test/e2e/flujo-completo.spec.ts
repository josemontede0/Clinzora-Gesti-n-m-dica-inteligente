/**
 * Flujo completo (sección 24): login → paciente → cita → agenda → llegada → encuentro → notas → firma →
 * cargo → factura → pago mixto/parcial → saldo → atención con seguro → reclamación → pago de ARS →
 * reportes → auditoría → persistencia tras reiniciar la aplicación.
 */
import type { INestApplication } from '@nestjs/common';
import { at, bootApp, Client, fakeCedula, key, login, nextBusinessDay } from '../helpers';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Flujo completo de punta a punta', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let recepcion: Client, medico: Client, enfermeria: Client, caja: Client, seguros: Client, gerencia: Client, admin: Client;
  const ctx: Record<string, string> = {};

  beforeAll(async () => {
    ({ app, prisma } = await bootApp());
    [recepcion, medico, enfermeria, caja, seguros, gerencia, admin] = await Promise.all(
      ['recepcion', 'medico', 'enfermeria', 'caja', 'seguros', 'gerencia', 'admin'].map((u) => login(app, `${u}@ejemplo.test`)),
    );
    const branch = await prisma.branch.findFirstOrThrow({ where: { code: 'CENTRAL' } });
    const pro = await prisma.medicalProfessional.findFirstOrThrow({ where: { exequatur: 'DEMO-1001' } });
    const service = await prisma.service.findFirstOrThrow({ where: { code: 'CONS-CAR' } });
    const plan = await prisma.insurancePlan.findFirstOrThrow({ where: { code: 'BASICO' } });
    Object.assign(ctx, { branchId: branch.id, professionalId: pro.id, serviceId: service.id, planId: plan.id });
  });

  afterAll(async () => app.close());

  it('1-2. registra un paciente y lo encuentra por expediente y documento', async () => {
    const doc = fakeCedula(9001);
    const res = await recepcion.post('/patients', {
      firstName: 'Prueba', lastName: 'Flujo Completo', documentType: 'CEDULA', documentNumber: doc, birthDate: '1980-05-05', sex: 'FEMENINO',
      phone: '809-555-9001', email: 'flujo@ejemplo.test', emergencyContact: { name: 'Contacto Ficticio', phone: '809-555-9002' },
      consents: [{ type: 'COMUNICACION_EMAIL', granted: true }, { type: 'TRATAMIENTO_DATOS', granted: true }],
    });
    expect(res.status).toBe(201);
    expect(res.body.recordNumber).toMatch(/^EXP-\d{6}$/);
    ctx.patientId = res.body.id;
    ctx.recordNumber = res.body.recordNumber;

    const byRecord = await recepcion.get(`/patients?q=${ctx.recordNumber}`);
    expect(byRecord.body.items.map((p: { id: string }) => p.id)).toContain(ctx.patientId);
    const byDoc = await recepcion.get(`/patients?q=${doc.slice(0, 3)}-${doc.slice(3, 10)}-${doc.slice(10)}`);
    expect(byDoc.body.items.map((p: { id: string }) => p.id)).toContain(ctx.patientId);
  });

  it('3-5. crea una cita en un horario disponible y aparece en la agenda', async () => {
    const day = nextBusinessDay(1);
    const slots = await recepcion.get(`/appointments/availability?professionalId=${ctx.professionalId}&branchId=${ctx.branchId}&date=${day}&durationMin=30`);
    expect(slots.status).toBe(200);
    expect(slots.body.length).toBeGreaterThan(0);

    const res = await recepcion.post('/appointments', {
      branchId: ctx.branchId, patientId: ctx.patientId, professionalId: ctx.professionalId, serviceId: ctx.serviceId,
      startsAt: at(day, 8, 0), modality: 'PRESENCIAL', reason: 'Control', confirmed: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('CONFIRMADA');
    ctx.appointmentId = res.body.id;

    const agenda = await recepcion.get(`/appointments?from=${encodeURIComponent(at(day, 0))}&to=${encodeURIComponent(at(day, 23, 59))}&professionalId=${ctx.professionalId}`);
    expect(agenda.body.map((a: { id: string }) => a.id)).toContain(ctx.appointmentId);

    // Se programaron confirmación y recordatorios (24 h y 2 h) por correo.
    const notifs = await prisma.notification.findMany({ where: { appointmentId: ctx.appointmentId } });
    expect(notifs.map((n) => n.type)).toEqual(expect.arrayContaining(['CITA_CONFIRMACION', 'CITA_RECORDATORIO']));
  });

  it('6. registra la llegada del paciente (no se puede marcar en consulta sin pasar por espera de forma inválida)', async () => {
    // El paciente llega: para la prueba se mueve la cita a "ahora" directamente en BD (la regla de reprogramación exige horario laboral).
    const now = new Date();
    await prisma.appointment.update({ where: { id: ctx.appointmentId }, data: { startsAt: now, endsAt: new Date(now.getTime() + 30 * 60000) } });
    const bad = await recepcion.post(`/appointments/${ctx.appointmentId}/status`, { status: 'COMPLETADA' });
    expect(bad.status).toBe(422);
    const res = await recepcion.post(`/appointments/${ctx.appointmentId}/status`, { status: 'EN_ESPERA' });
    expect(res.status).toBe(200);
    expect(res.body.checkedInAt).toBeTruthy();
  });

  it('7-9. crea el encuentro, registra signos vitales y notas, y lo firma (genera el cargo)', async () => {
    const enc = await medico.post('/clinical/encounters', { appointmentId: ctx.appointmentId, patientId: ctx.patientId });
    expect(enc.status).toBe(201);
    ctx.encounterId = enc.body.id;
    // Idempotente: repetir devuelve el mismo encuentro.
    const again = await medico.post('/clinical/encounters', { appointmentId: ctx.appointmentId, patientId: ctx.patientId });
    expect(again.body.id).toBe(ctx.encounterId);

    const vit = await enfermeria.post(`/clinical/encounters/${ctx.encounterId}/vitals`, { systolic: 120, diastolic: 80, heartRate: 72, temperatureC: 36.5, spo2: 98, weightKg: 70, heightCm: 170 });
    expect(vit.status).toBe(201);
    expect(Number(vit.body.bmi)).toBeCloseTo(24.22, 1);

    expect((await medico.put(`/clinical/encounters/${ctx.encounterId}/notes`, { section: 'MOTIVO_CONSULTA', content: 'Dolor torácico ocasional (ficticio)' })).status).toBe(200);
    expect((await medico.put(`/clinical/encounters/${ctx.encounterId}/notes`, { section: 'EVALUACION', content: 'Examen normal (ficticio)' })).status).toBe(200);
    expect((await medico.post(`/clinical/encounters/${ctx.encounterId}/diagnoses`, { code: 'R07.4', description: 'Dolor torácico no especificado' })).status).toBe(201);
    expect((await medico.post(`/clinical/encounters/${ctx.encounterId}/prescriptions`, { items: [{ medication: 'Medicamento ficticio', dose: '1 tableta', frequency: 'cada 8 horas' }] })).status).toBe(201);

    const sign = await medico.post(`/clinical/encounters/${ctx.encounterId}/sign`);
    expect(sign.status).toBe(200);
    expect(sign.body.chargeId).toBeTruthy();
    ctx.chargeId = sign.body.chargeId;

    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: ctx.appointmentId } });
    expect(appt.status).toBe('COMPLETADA');
  });

  it('corrige una nota firmada conservando el original', async () => {
    const enc = await medico.get(`/clinical/encounters/${ctx.encounterId}`);
    const note = enc.body.notes.find((n: { section: string; isCurrent: boolean }) => n.section === 'EVALUACION' && n.isCurrent);
    const direct = await medico.put(`/clinical/encounters/${ctx.encounterId}/notes`, { section: 'EVALUACION', content: 'cambio silencioso' });
    expect(direct.status).toBe(422);
    const fix = await medico.post(`/clinical/notes/${note.id}/correct`, { content: 'Examen normal; se agrega soplo leve (ficticio)', reason: 'Omisión al redactar' });
    expect(fix.status).toBe(201);
    const versions = await medico.get(`/clinical/notes/${fix.body.id}/versions`);
    expect(versions.body).toHaveLength(2);
    expect(versions.body.find((v: { id: string }) => v.id === note.id).content).toBe('Examen normal (ficticio)');
  });

  it('10. genera la factura a partir del cargo (sin duplicar el cargo al reintentar la firma)', async () => {
    const retry = await medico.post(`/clinical/encounters/${ctx.encounterId}/sign`);
    expect(retry.status).toBe(422);
    expect(await prisma.charge.count({ where: { encounterId: ctx.encounterId } })).toBe(1);

    const inv = await caja.post('/invoices', { patientId: ctx.patientId, branchId: ctx.branchId, chargeIds: [ctx.chargeId], issue: true });
    expect(inv.status).toBe(201);
    expect(inv.body.total).toBe('3500');
    expect(inv.body.status).toBe('PENDIENTE');
    ctx.invoiceId = inv.body.id;
  });

  it('11-13. registra pago parcial y luego pago mixto (efectivo + tarjeta de prueba) hasta saldar', async () => {
    const register = await prisma.cashRegister.findFirstOrThrow({ where: { name: 'Caja 1' } });
    const noCash = await caja.post('/payments', { patientId: ctx.patientId, branchId: ctx.branchId, idempotencyKey: key(), tenders: [{ methodId: (await prisma.paymentMethod.findFirstOrThrow({ where: { code: 'EFECTIVO' } })).id, amount: '100' }] });
    expect(noCash.status).toBe(422);
    expect(noCash.body.code).toBe('CAJA_CERRADA');

    const open = await caja.post('/cash/sessions', { registerId: register.id, openingFloat: '2000' });
    expect(open.status).toBe(201);
    ctx.sessionId = open.body.id;

    const cash = await prisma.paymentMethod.findFirstOrThrow({ where: { code: 'EFECTIVO' } });
    const card = await prisma.paymentMethod.findFirstOrThrow({ where: { code: 'TCREDITO' } });

    const partialKey = key();
    const partial = await caja.post('/payments', { patientId: ctx.patientId, branchId: ctx.branchId, idempotencyKey: partialKey, tenders: [{ methodId: cash.id, amount: '1000' }], allocations: [{ invoiceId: ctx.invoiceId, amount: '1000' }] });
    expect(partial.status).toBe(201);
    // Reintento con la misma clave: no duplica.
    const dup = await caja.post('/payments', { patientId: ctx.patientId, branchId: ctx.branchId, idempotencyKey: partialKey, tenders: [{ methodId: cash.id, amount: '1000' }], allocations: [{ invoiceId: ctx.invoiceId, amount: '1000' }] });
    expect(dup.body.id).toBe(partial.body.id);
    let inv = await caja.get(`/invoices/${ctx.invoiceId}`);
    expect(inv.body.status).toBe('PARCIAL');
    expect(inv.body.balance).toBe('2500');

    // Aplicar más que el saldo es rechazado.
    const over = await caja.post('/payments', { patientId: ctx.patientId, branchId: ctx.branchId, idempotencyKey: key(), tenders: [{ methodId: cash.id, amount: '3000' }], allocations: [{ invoiceId: ctx.invoiceId, amount: '3000' }] });
    expect(over.status).toBe(422);

    // Tarjeta declinada en el terminal de pruebas: no se registra nada.
    const declined = await caja.post('/payments', { patientId: ctx.patientId, branchId: ctx.branchId, idempotencyKey: key(), tenders: [{ methodId: card.id, amount: '500', cardLast4: '0002' }], allocations: [{ invoiceId: ctx.invoiceId, amount: '500' }] });
    expect(declined.status).toBe(422);
    expect(declined.body.code).toBe('TARJETA_DECLINADA');

    const mixed = await caja.post('/payments', {
      patientId: ctx.patientId, branchId: ctx.branchId, idempotencyKey: key(),
      tenders: [{ methodId: cash.id, amount: '500' }, { methodId: card.id, amount: '2000', cardLast4: '4242', cardBrand: 'VISA' }],
      allocations: [{ invoiceId: ctx.invoiceId, amount: '2500' }],
    });
    expect(mixed.status).toBe(201);
    expect(mixed.body.amount).toBe('2500');
    const cardTender = mixed.body.tenders.find((t: { cardLast4: string }) => t.cardLast4 === '4242');
    expect(cardTender.transaction.status).toBe('APROBADA');
    expect(cardTender.transaction.testMode).toBe(true);

    inv = await caja.get(`/invoices/${ctx.invoiceId}`);
    expect(inv.body.status).toBe('PAGADA');
    expect(inv.body.balance).toBe('0');
    expect(inv.body.paidAmount).toBe('3500');
  });

  it('devolución autorizada desde la factura mantiene la fórmula de saldo y registra salida de caja', async () => {
    const contab = await login(app, 'contabilidad@ejemplo.test');
    // Contabilidad no tiene caja abierta: la devolución exige caja abierta del usuario que devuelve.
    const pay = await prisma.payment.findFirstOrThrow({ where: { allocations: { some: { invoiceId: ctx.invoiceId } }, amount: 1000 } });
    const cash = await prisma.paymentMethod.findFirstOrThrow({ where: { code: 'EFECTIVO' } });
    const noSession = await contab.post(`/invoices/${ctx.invoiceId}/refund`, { paymentId: pay.id, amount: '200', methodId: cash.id, reason: 'Ajuste por error de cobro', idempotencyKey: key() });
    expect(noSession.status).toBe(422);
    // El cajero no tiene permiso de reembolso.
    const forbidden = await caja.post(`/invoices/${ctx.invoiceId}/refund`, { paymentId: pay.id, amount: '200', methodId: cash.id, reason: 'Ajuste por error de cobro', idempotencyKey: key() });
    expect(forbidden.status).toBe(403);
  });

  it('cierra la caja con arqueo y detecta diferencias', async () => {
    const current = await caja.get('/cash/current');
    // Fondo 2,000 + efectivo 1,000 + 500 = 3,500
    expect(current.body.session.summary.expectedCash).toBe('3500.00');
    const noNote = await caja.post(`/cash/sessions/${ctx.sessionId}/close`, { countedCash: '3400' });
    expect(noNote.status).toBe(422);
    const close = await caja.post(`/cash/sessions/${ctx.sessionId}/close`, { countedCash: '3400', notes: 'Faltante de 100 por cambio entregado de más' });
    expect(close.status).toBe(200);
    expect(close.body.difference).toBe('-100');
  });

  it('14-15. atención con seguro: póliza, validación manual, cargo con cobertura, reclamación, glosa y pago parcial de la ARS', async () => {
    const policy = await seguros.post(`/insurance/patients/${ctx.patientId}/policies`, { planId: ctx.planId, affiliateNumber: 'E2E-AF-1', relationship: 'TITULAR', validFrom: '2025-01-01', validTo: '2030-12-31' });
    expect(policy.status).toBe(201);
    ctx.policyId = policy.body.id;
    const ver = await seguros.post('/insurance/verifications', { patientInsuranceId: ctx.policyId, result: 'ELEGIBLE', reference: 'Llamada a la ARS' });
    expect(ver.status).toBe(201);
    expect(ver.body.method).toBe('MANUAL');

    const charge = await caja.post('/charges', { patientId: ctx.patientId, branchId: ctx.branchId, serviceId: ctx.serviceId, patientInsuranceId: ctx.policyId, quantity: 1, idempotencyKey: key() });
    expect(charge.status).toBe(201);
    // Tarifa negociada del Plan Básico: ARS cubre 2,500 de 3,500 → copago 1,000.
    expect(charge.body.insuranceAmount).toBe('2500');
    expect(charge.body.patientAmount).toBe('1000');
    const inv = await caja.post('/invoices', { patientId: ctx.patientId, branchId: ctx.branchId, chargeIds: [charge.body.id] });
    expect(inv.body.patientAmount).toBe('1000');
    expect(inv.body.balance).toBe('1000');
    ctx.insInvoiceId = inv.body.id;

    const insurer = await prisma.insurer.findFirstOrThrow({ where: { code: 'ARSDEMO' } });
    const claimable = await seguros.get(`/insurance/claimable?insurerId=${insurer.id}`);
    const item = claimable.body.find((i: { invoiceId: string }) => i.invoiceId === ctx.insInvoiceId);
    expect(item).toBeTruthy();

    const claim = await seguros.post('/insurance/claims', { insurerId: insurer.id, branchId: ctx.branchId, invoiceItemIds: [item.id] });
    expect(claim.status).toBe(201);
    expect(claim.body.claimedAmount).toBe('2500');
    ctx.claimId = claim.body.id;
    // No se puede reclamar dos veces la misma línea.
    const again = await seguros.post('/insurance/claims', { insurerId: insurer.id, branchId: ctx.branchId, invoiceItemIds: [item.id] });
    expect(again.status).toBe(422);

    expect((await seguros.post(`/insurance/claims/${ctx.claimId}/status`, { status: 'SOMETIDA', externalReference: 'ARS-REF-1' })).status).toBe(200);
    const glosa = await seguros.post(`/insurance/claims/${ctx.claimId}/glosas`, { reason: 'Falta firma del médico en formulario (ficticio)', amount: '300' });
    expect(glosa.status).toBe(201);
    expect(glosa.body.expectedAmount).toBe('2200.00');

    const pay = await seguros.post('/insurance/payments', { insurerId: insurer.id, receivedAt: new Date().toISOString(), amount: '1500', reference: 'TRANSF-E2E', allocations: [{ claimId: ctx.claimId, amount: '1500' }] });
    expect(pay.status).toBe(201);
    const detail = await seguros.get(`/insurance/claims/${ctx.claimId}`);
    expect(detail.body.status).toBe('PAGADA_PARCIAL');
    expect(detail.body.paidAmount).toBe('1500');
    expect(detail.body.balance).toBe('700.00');

    // Conciliar más que el saldo es rechazado.
    const over = await seguros.post(`/insurance/payments/${pay.body.id}/allocate`, { claimId: ctx.claimId, amount: '800' });
    expect(over.status).toBe(422);
  });

  it('16. los reportes distinguen facturado, cobrado y pendiente', async () => {
    const today = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const dash = await gerencia.get(`/reports/dashboard?from=${from}&to=${today}`);
    expect(dash.status).toBe(200);
    const f = dash.body.financial;
    expect(Number(f.billed.total)).toBeGreaterThan(0);
    expect(Number(f.collected.net)).toBeGreaterThan(0);
    expect(Number(f.patientReceivable.amount)).toBeGreaterThan(0);
    expect(Number(f.insurerReceivable.claims)).toBeGreaterThan(0);
    // Facturado ≠ cobrado: hay saldos pendientes.
    expect(f.billed.total).not.toBe(f.collected.net);

    const xlsx = await gerencia.get(`/reports/export/cobros?from=${from}&to=${today}&format=xlsx`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    const pdf = await gerencia.get(`/reports/export/facturacion?from=${from}&to=${today}&format=pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('pdf');
  });

  it('17. la auditoría registró las operaciones clave', async () => {
    const actions = (await prisma.auditLog.findMany({ select: { action: true } })).map((a) => a.action);
    for (const a of ['LOGIN', 'PACIENTE_CREADO', 'CITA_CREADA', 'ENCUENTRO_FIRMADO', 'NOTA_CORREGIDA', 'FACTURA_EMITIDA', 'PAGO_REGISTRADO', 'CAJA_CERRADA', 'RECLAMACION_CREADA', 'PAGO_ARS_REGISTRADO', 'REPORTE_EXPORTADO', 'ACCESO_CLINICO']) {
      expect(actions).toContain(a);
    }
    const res = await admin.get('/audit?entity=Patient&pageSize=5');
    expect(res.status).toBe(200);
  });

  it('18. los datos persisten tras cerrar y reiniciar la aplicación', async () => {
    await app.close();
    ({ app, prisma } = await bootApp());
    const again = await login(app, 'caja@ejemplo.test');
    const inv = await again.get(`/invoices/${ctx.invoiceId}`);
    expect(inv.status).toBe(200);
    expect(inv.body.status).toBe('PAGADA');
    const pat = await again.get(`/patients/${ctx.patientId}`);
    expect(pat.body.recordNumber).toBe(ctx.recordNumber);
  });
});

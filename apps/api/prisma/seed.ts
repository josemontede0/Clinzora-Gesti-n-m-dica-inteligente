/**
 * Datos de DEMOSTRACIÓN (todos ficticios). No ejecutar en producción.
 *  - Cédulas de la serie 000-… (no corresponden a ningún municipio real).
 *  - Teléfonos 809-555-01XX y correos @ejemplo.test.
 *  - La contraseña de desarrollo se genera al azar y se guarda en infra/seed-credentials.txt (ignorado por git).
 * Uso: pnpm --filter @medigest/api seed            (falla si la base ya tiene datos)
 *      pnpm --filter @medigest/api seed -- --reset (BORRA todo y vuelve a sembrar; solo desarrollo)
 */
import 'reflect-metadata';
import { PrismaClient, Prisma } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_PERMISSIONS, DEFAULT_OPERATIONAL_SETTINGS, DEFAULT_ROLES, PERMISSIONS, zonedToUtc, utcToZonedParts } from '@medigest/shared';
import { API_ROOT, config } from '../src/config';
import { DEFAULT_TEMPLATES } from '../src/modules/notifications/notifications.service';

const prisma = new PrismaClient();
const TZ = 'America/Santo_Domingo';
const D = (v: string | number) => new Prisma.Decimal(v);

function fakeCedula(serial: number): string {
  const base = `000${String(serial).padStart(7, '0')}`;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let n = Number(base[i]) * (i % 2 === 0 ? 1 : 2);
    if (n > 9) n -= 9;
    sum += n;
  }
  return base + String((10 - (sum % 10)) % 10);
}

/** Fecha local relativa a hoy (días) a una hora local (HH, MM). */
function localAt(daysFromToday: number, hh: number, mm = 0): Date {
  const today = utcToZonedParts(new Date(), TZ).ymd;
  const base = new Date(`${today}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + daysFromToday);
  return zonedToUtc(base.toISOString().slice(0, 10), hh * 60 + mm, TZ);
}

function nextWeekday(fromDays: number): number {
  let d = fromDays;
  for (;;) {
    const wd = utcToZonedParts(localAt(d, 12), TZ).weekday;
    if (wd >= 1 && wd <= 5) return d;
    d++;
  }
}

async function reset() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
}

async function main() {
  if (config.isProduction && process.env.SEED_ALLOW_PRODUCTION !== '1') throw new Error('El seed de demostración no se ejecuta en producción.');
  if (process.argv.includes('--reset')) {
    console.log('Borrando datos existentes (--reset)...');
    await reset();
  } else if ((await prisma.organization.count()) > 0) {
    throw new Error('La base ya tiene datos. Use --reset para borrarla y volver a sembrar (solo desarrollo).');
  }

  const password = process.env.SEED_PASSWORD ?? `Demo-${randomBytes(9).toString('base64url')}#1`;
  const passwordHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

  // ── Permisos y organización ──
  await prisma.permission.createMany({ data: ALL_PERMISSIONS.map((code) => ({ code, module: PERMISSIONS[code].module, description: PERMISSIONS[code].description })), skipDuplicates: true });
  const perms = await prisma.permission.findMany();

  const org = await prisma.organization.create({
    data: { name: 'Centro Médico Demo (datos ficticios)', legalName: 'Centro Médico Demo, SRL (ficticio)', rnc: '000000000', phone: '809-555-0100', email: 'contacto@ejemplo.test', address: 'Av. Ficticia 123, Santo Domingo' },
  });
  const O = org.id;
  await prisma.systemSetting.create({ data: { organizationId: O, key: 'operational', value: DEFAULT_OPERATIONAL_SETTINGS as unknown as Prisma.InputJsonValue } });
  await prisma.documentSequence.createMany({
    data: [
      { organizationId: O, key: 'patient', prefix: 'EXP-', padding: 6 },
      { organizationId: O, key: 'invoice', prefix: 'FAC-', padding: 6 },
      { organizationId: O, key: 'payment', prefix: 'REC-', padding: 6 },
      { organizationId: O, key: 'claim', prefix: 'RCL-', padding: 5 },
      { organizationId: O, key: 'creditNote', prefix: 'NC-', padding: 5 },
    ],
  });

  const branch = await prisma.branch.create({ data: { organizationId: O, code: 'CENTRAL', name: 'Sede Central', address: 'Av. Ficticia 123, Santo Domingo', phone: '809-555-0100' } });
  const branch2 = await prisma.branch.create({ data: { organizationId: O, code: 'NORTE', name: 'Sede Norte', address: 'Calle Imaginaria 45, Santiago', phone: '809-555-0200' } });
  const [room1, room2, room3] = await Promise.all(
    ['Consultorio 1', 'Consultorio 2', 'Consultorio 3'].map((name) => prisma.consultationRoom.create({ data: { organizationId: O, branchId: branch.id, name } })),
  );
  await prisma.consultationRoom.create({ data: { organizationId: O, branchId: branch2.id, name: 'Consultorio A' } });

  const roles: Record<string, string> = {};
  for (const r of DEFAULT_ROLES) {
    const role = await prisma.role.create({
      data: {
        organizationId: O, code: r.code, name: r.name, description: r.description, isSystem: true, requiresMfa: r.requiresMfa,
        permissions: { create: r.permissions.map((p) => ({ permissionId: perms.find((x) => x.code === p)!.id })) },
      },
    });
    roles[r.code] = role.id;
  }
  // La médica de demostración puede exportar el expediente.
  await prisma.rolePermission.create({ data: { roleId: roles.MEDICO, permissionId: perms.find((p) => p.code === 'clinical.export')!.id } });

  const mkUser = (email: string, fullName: string, role: string, branches = [branch.id]) =>
    prisma.user.create({
      data: {
        organizationId: O, email, fullName, passwordHash, passwordChangedAt: new Date(),
        roles: { create: [{ roleId: roles[role] }] }, branches: { create: branches.map((branchId) => ({ branchId })) },
      },
    });
  const users = {
    admin: await mkUser('admin@ejemplo.test', 'Ana Administradora (demo)', 'ADMIN', [branch.id, branch2.id]),
    recepcion: await mkUser('recepcion@ejemplo.test', 'Rosa Recepción (demo)', 'RECEPCION'),
    medico: await mkUser('medico@ejemplo.test', 'Dra. Carmen Méndez (demo)', 'MEDICO'),
    medico2: await mkUser('medico2@ejemplo.test', 'Dr. Luis Herrera (demo)', 'MEDICO'),
    enfermeria: await mkUser('enfermeria@ejemplo.test', 'Elena Enfermera (demo)', 'ENFERMERIA'),
    caja: await mkUser('caja@ejemplo.test', 'Carlos Cajero (demo)', 'CAJA'),
    seguros: await mkUser('seguros@ejemplo.test', 'Sofía Seguros (demo)', 'SEGUROS'),
    contabilidad: await mkUser('contabilidad@ejemplo.test', 'Celia Contabilidad (demo)', 'CONTABILIDAD', [branch.id, branch2.id]),
    gerencia: await mkUser('gerencia@ejemplo.test', 'Gerardo Gerente (demo)', 'GERENCIA', [branch.id, branch2.id]),
  };

  // ── Especialidades, profesionales y horarios ──
  const spec = async (code: string, name: string) => prisma.specialty.create({ data: { organizationId: O, code, name } });
  const sGen = await spec('MG', 'Medicina General');
  const sPed = await spec('PED', 'Pediatría');
  const sCar = await spec('CAR', 'Cardiología');
  const sGin = await spec('GIN', 'Ginecología');

  const mkPro = async (data: { firstName: string; lastName: string; title: string; exequatur: string; userId?: string; specs: string[]; room: string; branches?: string[] }) => {
    const p = await prisma.medicalProfessional.create({
      data: {
        organizationId: O, firstName: data.firstName, lastName: data.lastName, title: data.title, exequatur: data.exequatur, userId: data.userId,
        defaultDurationMin: 30, email: `${data.firstName.toLowerCase()}@ejemplo.test`,
        specialties: { create: data.specs.map((specialtyId) => ({ specialtyId })) },
        branches: { create: (data.branches ?? [branch.id]).map((branchId) => ({ branchId })) },
      },
    });
    const blocks = [
      ...[1, 2, 3, 4, 5].flatMap((weekday) => [
        { weekday, startMinute: 8 * 60, endMinute: 12 * 60 },
        { weekday, startMinute: 14 * 60, endMinute: 18 * 60 },
      ]),
      { weekday: 6, startMinute: 8 * 60, endMinute: 12 * 60 },
    ];
    await prisma.schedule.createMany({ data: blocks.map((b) => ({ ...b, professionalId: p.id, branchId: branch.id, roomId: data.room })) });
    return p;
  };
  const drMendez = await mkPro({ firstName: 'Carmen', lastName: 'Méndez', title: 'Dra.', exequatur: 'DEMO-1001', userId: users.medico.id, specs: [sGen.id, sCar.id], room: room1.id });
  const drHerrera = await mkPro({ firstName: 'Luis', lastName: 'Herrera', title: 'Dr.', exequatur: 'DEMO-1002', userId: users.medico2.id, specs: [sPed.id], room: room2.id, branches: [branch.id, branch2.id] });
  const drPolanco = await mkPro({ firstName: 'Patricia', lastName: 'Polanco', title: 'Dra.', exequatur: 'DEMO-1003', specs: [sGin.id], room: room3.id });

  // ── Servicios, tarifas y aseguradora de demostración ──
  const insurer = await prisma.insurer.create({ data: { organizationId: O, code: 'ARSDEMO', name: 'ARS Demo (ficticia)', rnc: '000000001', claimSubmissionDays: 30, paymentTermDays: 45 } });
  const planBasic = await prisma.insurancePlan.create({ data: { insurerId: insurer.id, code: 'BASICO', name: 'Plan Básico Demo', coverageType: 'BASICO', defaultCoveragePercent: D(70) } });
  const planPlus = await prisma.insurancePlan.create({ data: { insurerId: insurer.id, code: 'PLUS', name: 'Plan Plus Demo', coverageType: 'COMPLEMENTARIO', defaultCoveragePercent: D(80) } });

  const services: Record<string, { id: string; price: number }> = {};
  const mkService = async (code: string, name: string, specialtyId: string | null, price: number, category: 'CONSULTA' | 'PROCEDIMIENTO' | 'LABORATORIO' | 'IMAGEN' = 'CONSULTA', duration = 30) => {
    const s = await prisma.service.create({ data: { organizationId: O, code, name, specialtyId, category, durationMin: duration } });
    await prisma.servicePrice.create({ data: { serviceId: s.id, price: D(price), createdById: users.admin.id, validFrom: new Date(Date.now() - 365 * 86400_000) } });
    services[code] = { id: s.id, price };
    return s;
  };
  await mkService('CONS-MG', 'Consulta de medicina general', sGen.id, 2000);
  await mkService('CONS-PED', 'Consulta pediátrica', sPed.id, 2500);
  await mkService('CONS-CAR', 'Consulta de cardiología', sCar.id, 3500);
  await mkService('CONS-GIN', 'Consulta ginecológica', sGin.id, 3000);
  await mkService('ECG', 'Electrocardiograma', sCar.id, 1800, 'PROCEDIMIENTO', 20);
  await mkService('SONO-PEL', 'Sonografía pélvica', sGin.id, 2800, 'IMAGEN', 30);
  // Tarifas negociadas: la ARS cubre un monto fijo; el resto es copago del paciente.
  for (const [code, coverage] of [['CONS-MG', 1400], ['CONS-CAR', 2500], ['ECG', 1300]] as const) {
    await prisma.servicePrice.create({ data: { serviceId: services[code].id, insurancePlanId: planBasic.id, price: D(services[code].price), coverageAmount: D(coverage), createdById: users.admin.id, validFrom: new Date(Date.now() - 365 * 86400_000) } });
  }

  // ── Caja y medios de pago ──
  const methods = {
    cash: await prisma.paymentMethod.create({ data: { organizationId: O, code: 'EFECTIVO', name: 'Efectivo', kind: 'EFECTIVO' } }),
    debit: await prisma.paymentMethod.create({ data: { organizationId: O, code: 'TDEBITO', name: 'Tarjeta de débito', kind: 'TARJETA_DEBITO', requiresReference: true } }),
    credit: await prisma.paymentMethod.create({ data: { organizationId: O, code: 'TCREDITO', name: 'Tarjeta de crédito', kind: 'TARJETA_CREDITO', requiresReference: true } }),
    transfer: await prisma.paymentMethod.create({ data: { organizationId: O, code: 'TRANSF', name: 'Transferencia bancaria', kind: 'TRANSFERENCIA', requiresReference: true } }),
  };
  const register = await prisma.cashRegister.create({ data: { organizationId: O, branchId: branch.id, name: 'Caja 1' } });
  await prisma.cashRegister.create({ data: { organizationId: O, branchId: branch2.id, name: 'Caja Norte' } });

  // ── Plantillas de notificación ──
  await prisma.notificationTemplate.createMany({
    data: DEFAULT_TEMPLATES.flatMap((t) => (['EMAIL', 'WHATSAPP', 'SMS'] as const).map((channel) => ({ organizationId: O, type: t.type, channel, subject: channel === 'EMAIL' ? t.subject : null, body: t.body }))),
  });

  // ── Pacientes ficticios ──
  const names: [string, string, 'FEMENINO' | 'MASCULINO', string][] = [
    ['María', 'Rodríguez Peña', 'FEMENINO', '1985-03-14'], ['José', 'Martínez Gómez', 'MASCULINO', '1979-11-02'], ['Lucía', 'Fernández Díaz', 'FEMENINO', '1992-07-21'],
    ['Pedro', 'Santana Reyes', 'MASCULINO', '1968-01-30'], ['Valentina', 'Castillo Núñez', 'FEMENINO', '2018-05-09'], ['Miguel', 'Taveras Cruz', 'MASCULINO', '2015-09-17'],
    ['Altagracia', 'Jiménez Vargas', 'FEMENINO', '1955-12-24'], ['Ramón', 'De la Cruz Mejía', 'MASCULINO', '1988-04-03'], ['Carolina', 'Abreu Sánchez', 'FEMENINO', '1996-02-11'],
    ['Andrés', 'Batista Ortiz', 'MASCULINO', '2001-08-28'], ['Yesenia', 'Polanco Rosario', 'FEMENINO', '1990-10-05'], ['Francisco', 'Guzmán Paulino', 'MASCULINO', '1973-06-19'],
  ];
  const patients = [];
  for (let i = 0; i < names.length; i++) {
    const [firstName, lastName, sex, birth] = names[i];
    const phone = `809-555-01${String(i + 10).padStart(2, '0')}`;
    const p = await prisma.patient.create({
      data: {
        organizationId: O, recordNumber: `EXP-${String(i + 1).padStart(6, '0')}`, firstName, lastName, sex, birthDate: new Date(birth),
        documentType: Number(birth.slice(0, 4)) > 2008 ? 'NINGUNO' : 'CEDULA', documentNumber: Number(birth.slice(0, 4)) > 2008 ? null : fakeCedula(1000 + i),
        phone, phoneNormalized: phone.replace(/\D/g, ''), email: `${firstName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}.demo${i}@ejemplo.test`,
        address: `Calle Ficticia ${i + 1}, Santo Domingo`, city: 'Santo Domingo', province: 'Distrito Nacional', createdById: users.recepcion.id,
        consents: {
          create: ['TRATAMIENTO_DATOS', 'COMUNICACION_EMAIL', 'COMUNICACION_WHATSAPP'].map((type) => ({ type: type as never, granted: true, recordedById: users.recepcion.id })),
        },
        ...(Number(birth.slice(0, 4)) > 2008 ? { contacts: { create: { kind: 'GUARDIAN', name: `Tutor de ${firstName} (ficticio)`, relationship: 'Madre', phone: '809-555-0199' } } } : {}),
      },
    });
    patients.push(p);
  }
  await prisma.documentSequence.update({ where: { organizationId_key: { organizationId: O, key: 'patient' } }, data: { nextValue: patients.length + 1 } });
  const [maria, jose, lucia, pedro, valentina] = patients;
  const josePolicy = await prisma.patientInsurance.create({ data: { patientId: jose.id, planId: planBasic.id, affiliateNumber: 'DEMO-AF-0001', relationship: 'TITULAR', validFrom: new Date('2025-01-01'), validTo: new Date('2027-12-31') } });
  const pedroPolicy = await prisma.patientInsurance.create({ data: { patientId: pedro.id, planId: planBasic.id, affiliateNumber: 'DEMO-AF-0002', relationship: 'TITULAR', validFrom: new Date('2025-01-01'), validTo: new Date('2027-12-31') } });
  await prisma.patientInsurance.create({ data: { patientId: lucia.id, planId: planPlus.id, affiliateNumber: 'DEMO-AF-0003', relationship: 'TITULAR', validFrom: new Date('2025-06-01') } });
  await prisma.allergy.create({ data: { patientId: jose.id, substance: 'Penicilina', reaction: 'Urticaria', severity: 'MODERADA', recordedById: users.medico.id } });
  await prisma.medicalHistoryEntry.create({ data: { patientId: jose.id, kind: 'PERSONAL', description: 'Hipertensión arterial diagnosticada en 2019 (dato ficticio).', recordedById: users.medico.id } });
  await prisma.medication.create({ data: { patientId: jose.id, name: 'Losartán', dose: '50 mg', frequency: 'Cada 24 horas', route: 'Oral', recordedById: users.medico.id } });

  // ── Historia: consultas pasadas con encuentro firmado, factura y pago ──
  const pastDay = -nextWeekdayBack(7);
  const cashSession = await prisma.cashSession.create({
    data: { organizationId: O, registerId: register.id, branchId: branch.id, openedById: users.caja.id, openedAt: localAt(pastDay, 7, 45), openingFloat: D(5000), status: 'CERRADA', closedById: users.caja.id },
  });
  await prisma.cashMovement.create({ data: { sessionId: cashSession.id, type: 'FONDO_INICIAL', methodKind: 'EFECTIVO', amount: D(5000), description: 'Fondo inicial', createdById: users.caja.id, createdAt: localAt(pastDay, 7, 45) } });

  let invoiceSeq = 1;
  let paymentSeq = 1;
  const pastVisit = async (opts: { patient: typeof maria; pro: typeof drMendez; proUser: string; service: string; hour: number; policyId?: string; coverage?: number; pay: { method: typeof methods.cash; amount: number; ref?: string; last4?: string }[]; dx: string; note: string }) => {
    const startsAt = localAt(pastDay, opts.hour);
    const appt = await prisma.appointment.create({
      data: {
        organizationId: O, branchId: branch.id, patientId: opts.patient.id, professionalId: opts.pro.id, specialtyId: null, serviceId: services[opts.service].id,
        roomId: room1.id, patientInsuranceId: opts.policyId, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60000), status: 'COMPLETADA', checkedInAt: startsAt,
        reason: 'Consulta de control', createdById: users.recepcion.id, createdAt: localAt(pastDay - 3, 10),
        history: {
          create: [
            { toStatus: 'CONFIRMADA', changedById: users.recepcion.id, reason: 'Cita creada', createdAt: localAt(pastDay - 3, 10) },
            { fromStatus: 'CONFIRMADA', toStatus: 'EN_ESPERA', changedById: users.recepcion.id, createdAt: startsAt },
            { fromStatus: 'EN_ESPERA', toStatus: 'EN_CONSULTA', changedById: opts.proUser, createdAt: startsAt },
            { fromStatus: 'EN_CONSULTA', toStatus: 'COMPLETADA', changedById: opts.proUser, reason: 'Encuentro firmado', createdAt: new Date(startsAt.getTime() + 25 * 60000) },
          ],
        },
      },
    });
    // Las marcas de tiempo clínicas corresponden a la consulta, no al momento de sembrar.
    const noteAt = new Date(startsAt.getTime() + 15 * 60000);
    const enc = await prisma.medicalEncounter.create({
      data: {
        organizationId: O, branchId: branch.id, patientId: opts.patient.id, professionalId: opts.pro.id, appointmentId: appt.id, status: 'FIRMADO', startedAt: startsAt,
        signedAt: new Date(startsAt.getTime() + 25 * 60000), signedById: opts.proUser, createdById: opts.proUser,
        notes: {
          create: [
            { section: 'MOTIVO_CONSULTA', content: 'Control de rutina (contenido ficticio de demostración).', authorId: opts.proUser, createdAt: noteAt, updatedAt: noteAt },
            { section: 'EVALUACION', content: opts.note, authorId: opts.proUser, createdAt: noteAt, updatedAt: noteAt },
            { section: 'PLAN', content: 'Continuar tratamiento y control en 3 meses (ficticio).', authorId: opts.proUser, createdAt: noteAt, updatedAt: noteAt },
          ],
        },
        vitals: { create: { recordedById: users.enfermeria.id, recordedAt: new Date(startsAt.getTime() + 5 * 60000), systolic: 128, diastolic: 82, heartRate: 76, respiratoryRate: 16, temperatureC: D('36.6'), spo2: 98, weightKg: D('78.5'), heightCm: D('172'), bmi: D('26.53') } },
        diagnoses: { create: { description: opts.dx, type: 'PRINCIPAL', createdById: opts.proUser, createdAt: noteAt } },
      },
    });
    await prisma.patient.update({ where: { id: opts.patient.id }, data: { lastVisitAt: startsAt } });
    const price = services[opts.service].price;
    const insurance = opts.coverage ?? 0;
    const charge = await prisma.charge.create({
      data: {
        organizationId: O, branchId: branch.id, patientId: opts.patient.id, serviceId: services[opts.service].id, professionalId: opts.pro.id, encounterId: enc.id, appointmentId: appt.id,
        patientInsuranceId: opts.policyId, serviceDate: startsAt, description: `${opts.service} — ${opts.service}`, quantity: 1, unitPrice: D(price), total: D(price),
        insuranceAmount: D(insurance), patientAmount: D(price - insurance), source: 'ENCUENTRO', status: 'FACTURADO', idempotencyKey: `encuentro:${enc.id}:servicio:${services[opts.service].id}`, createdById: opts.proUser,
      },
    });
    const svc = await prisma.service.findUniqueOrThrow({ where: { id: services[opts.service].id } });
    await prisma.charge.update({ where: { id: charge.id }, data: { description: `${svc.code} — ${svc.name}` } });
    const paid = opts.pay.reduce((a, p) => a + p.amount, 0);
    const patientAmount = price - insurance;
    const invoice = await prisma.invoice.create({
      data: {
        organizationId: O, branchId: branch.id, number: `FAC-${String(invoiceSeq++).padStart(6, '0')}`, patientId: opts.patient.id, patientInsuranceId: opts.policyId,
        status: paid >= patientAmount ? 'PAGADA' : paid > 0 ? 'PARCIAL' : 'PENDIENTE', issuedAt: new Date(startsAt.getTime() + 40 * 60000), dueDate: new Date(Date.now() + 20 * 86400_000),
        subtotal: D(price), total: D(price), insuranceAmount: D(insurance), patientAmount: D(patientAmount), paidAmount: D(paid), balance: D(patientAmount - paid), createdById: users.caja.id,
        items: { create: { chargeId: charge.id, serviceId: svc.id, description: `${svc.code} — ${svc.name}`, quantity: 1, unitPrice: D(price), total: D(price), insuranceAmount: D(insurance), patientAmount: D(patientAmount) } },
      },
      include: { items: true },
    });
    if (paid > 0) {
      const number = `REC-${String(paymentSeq++).padStart(6, '0')}`;
      const payment = await prisma.payment.create({
        data: {
          organizationId: O, branchId: branch.id, number, patientId: opts.patient.id, cashSessionId: cashSession.id, receivedAt: new Date(startsAt.getTime() + 45 * 60000), amount: D(paid),
          idempotencyKey: `seed-${number}`, createdById: users.caja.id,
        },
      });
      for (const [i, t] of opts.pay.entries()) {
        let transactionId: string | undefined;
        if (t.method.kind === 'TARJETA_CREDITO' || t.method.kind === 'TARJETA_DEBITO') {
          const tx = await prisma.paymentTransaction.create({
            data: { organizationId: O, provider: 'terminal-pruebas', testMode: true, idempotencyKey: `seed-${number}:${i}`, externalId: `TEST-seed-${number}-${i}`, amount: D(t.amount), status: 'APROBADA', authCode: 'T000123', cardLast4: t.last4, cardBrand: 'VISA', responseCode: '00', responseMessage: 'Aprobada (prueba)', createdById: users.caja.id },
          });
          transactionId = tx.id;
        }
        await prisma.paymentTender.create({ data: { paymentId: payment.id, methodId: t.method.id, amount: D(t.amount), reference: t.ref, cardLast4: t.last4, transactionId } });
        await prisma.cashMovement.create({ data: { sessionId: cashSession.id, type: 'COBRO', methodKind: t.method.kind, amount: D(t.amount), paymentId: payment.id, description: `Recibo ${number}`, createdById: users.caja.id, createdAt: payment.receivedAt } });
      }
      await prisma.paymentAllocation.create({ data: { paymentId: payment.id, invoiceId: invoice.id, amount: D(paid), createdById: users.caja.id } });
    }
    return { appt, enc, invoice };
  };

  await pastVisit({ patient: maria, pro: drMendez, proUser: users.medico.id, service: 'CONS-MG', hour: 8, pay: [{ method: methods.cash, amount: 2000 }], dx: 'Control de salud sin hallazgos (ficticio)', note: 'Paciente estable (ficticio).' });
  // Pago mixto: 3,500 = 1,500 efectivo + 2,000 tarjeta (terminal de pruebas).
  await pastVisit({ patient: lucia, pro: drMendez, proUser: users.medico.id, service: 'CONS-CAR', hour: 9, pay: [{ method: methods.cash, amount: 1500 }, { method: methods.credit, amount: 2000, last4: '1111' }], dx: 'Palpitaciones a estudiar (ficticio)', note: 'Se indica Holter (ficticio).' });
  // Con seguro: ARS cubre 2,500 de 3,500; copago 1,000 pagado.
  const joseVisit = await pastVisit({ patient: jose, pro: drMendez, proUser: users.medico.id, service: 'CONS-CAR', hour: 10, policyId: josePolicy.id, coverage: 2500, pay: [{ method: methods.cash, amount: 1000 }], dx: 'Hipertensión arterial controlada (ficticio)', note: 'TA en metas (ficticio).' });
  // Con seguro y copago pendiente parcialmente.
  const pedroVisit = await pastVisit({ patient: pedro, pro: drMendez, proUser: users.medico.id, service: 'CONS-MG', hour: 11, policyId: pedroPolicy.id, coverage: 1400, pay: [{ method: methods.cash, amount: 300 }], dx: 'Infección respiratoria alta (ficticio)', note: 'Manejo sintomático (ficticio).' });

  // Cierre de la caja de ese día con arqueo exacto.
  const cashTotal = 5000 + 2000 + 1500 + 1000 + 300;
  await prisma.cashSession.update({ where: { id: cashSession.id }, data: { closedAt: localAt(pastDay, 18), expectedCash: D(cashTotal), countedCash: D(cashTotal), difference: D(0) } });

  // Reclamación sometida a la ARS demo por las dos atenciones con seguro.
  const claim = await prisma.claim.create({
    data: {
      organizationId: O, branchId: branch.id, number: 'RCL-00001', insurerId: insurer.id, status: 'SOMETIDA', submittedAt: localAt(pastDay + 1, 10),
      submissionDeadline: new Date(Date.now() + 20 * 86400_000), expectedPaymentDate: new Date(Date.now() + 40 * 86400_000), claimedAmount: D(3900), createdById: users.seguros.id,
      items: {
        create: [
          { invoiceItemId: joseVisit.invoice.items[0].id, patientInsuranceId: josePolicy.id, serviceDate: joseVisit.invoice.issuedAt!, description: `${joseVisit.invoice.number} · Consulta de cardiología`, claimedAmount: D(2500) },
          { invoiceItemId: pedroVisit.invoice.items[0].id, patientInsuranceId: pedroPolicy.id, serviceDate: pedroVisit.invoice.issuedAt!, description: `${pedroVisit.invoice.number} · Consulta de medicina general`, claimedAmount: D(1400) },
        ],
      },
      history: { create: [{ toStatus: 'BORRADOR', changedById: users.seguros.id, note: 'Reclamación creada' }, { fromStatus: 'BORRADOR', toStatus: 'SOMETIDA', changedById: users.seguros.id }] },
    },
  });
  await prisma.insuranceAuthorization.create({ data: { organizationId: O, patientInsuranceId: josePolicy.id, serviceId: services['CONS-CAR'].id, authorizationNumber: 'DEMO-AUT-7788', authorizedAmount: D(2500), status: 'UTILIZADA', createdById: users.recepcion.id } });
  await prisma.coverageVerification.create({ data: { patientInsuranceId: josePolicy.id, method: 'MANUAL', result: 'ELEGIBLE', reference: 'Portal ARS (demo)', notes: 'Validación manual de demostración', verifiedById: users.recepcion.id } });

  await prisma.documentSequence.update({ where: { organizationId_key: { organizationId: O, key: 'invoice' } }, data: { nextValue: invoiceSeq } });
  await prisma.documentSequence.update({ where: { organizationId_key: { organizationId: O, key: 'payment' } }, data: { nextValue: paymentSeq } });
  await prisma.documentSequence.update({ where: { organizationId_key: { organizationId: O, key: 'claim' } }, data: { nextValue: 2 } });

  // ── Agenda de hoy y próximos días ──
  const today = utcToZonedParts(new Date(), TZ);
  const workDay = today.weekday >= 1 && today.weekday <= 5 ? 0 : nextWeekday(1);
  const upcoming: [typeof maria, typeof drMendez, string, number, number, 'CONFIRMADA' | 'PENDIENTE_CONFIRMACION' | 'EN_ESPERA', string?][] = [
    [jose, drMendez, 'CONS-CAR', workDay, 15, 'CONFIRMADA', josePolicy.id],
    [maria, drMendez, 'CONS-MG', workDay, 16, 'PENDIENTE_CONFIRMACION'],
    [valentina, drHerrera, 'CONS-PED', workDay, 15, 'CONFIRMADA'],
    [patients[5], drHerrera, 'CONS-PED', workDay, 16, 'PENDIENTE_CONFIRMACION'],
    [patients[8], drPolanco, 'CONS-GIN', workDay, 17, 'CONFIRMADA'],
    [patients[6], drMendez, 'CONS-MG', nextWeekday(workDay + 1), 9, 'CONFIRMADA'],
    [patients[7], drMendez, 'CONS-MG', nextWeekday(workDay + 1), 10, 'PENDIENTE_CONFIRMACION'],
    [patients[10], drPolanco, 'CONS-GIN', nextWeekday(workDay + 2), 9, 'CONFIRMADA'],
    [patients[11], drMendez, 'CONS-CAR', nextWeekday(workDay + 3), 11, 'CONFIRMADA'],
  ];
  for (const [patient, pro, service, day, hour, status, policy] of upcoming) {
    const startsAt = localAt(day, hour);
    if (startsAt.getTime() < Date.now()) continue; // No crear citas futuras en horas ya pasadas de hoy.
    await prisma.appointment.create({
      data: {
        organizationId: O, branchId: branch.id, patientId: patient.id, professionalId: pro.id, serviceId: services[service].id, patientInsuranceId: policy,
        roomId: pro.id === drMendez.id ? room1.id : pro.id === drHerrera.id ? room2.id : room3.id,
        startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60000), status, reason: 'Consulta', createdById: users.recepcion.id,
        history: { create: { toStatus: status, changedById: users.recepcion.id, reason: 'Cita creada' } },
      },
    });
  }

  // Rangos NCF de EJEMPLO para pruebas (no son autorizaciones reales de la DGII).
  await prisma.fiscalSequence.create({ data: { organizationId: O, type: 'B02', description: 'Consumidor final (RANGO DE PRUEBA, no autorizado por la DGII)', prefix: 'B02', rangeFrom: 1, rangeTo: 500, nextNumber: 1 } });

  await prisma.auditLog.create({ data: { organizationId: O, action: 'SEED_DEMO', entity: 'Organization', entityId: O, details: { nota: 'Datos ficticios de demostración' } } });

  // ── Credenciales de desarrollo ──
  // Las pruebas automáticas usan su propia contraseña fija y no deben sobrescribir el archivo de desarrollo.
  if (config.NODE_ENV === 'test') {
    console.log('Seed de pruebas completado.');
    return;
  }
  const credsDir = join(API_ROOT, '..', '..', 'infra');
  mkdirSync(credsDir, { recursive: true });
  const lines = [
    'CREDENCIALES DE DESARROLLO — DATOS FICTICIOS. NO USAR EN PRODUCCIÓN.',
    'Reemplace o elimine estas cuentas antes de cualquier despliegue real.',
    '',
    `Contraseña común: ${password}`,
    '',
    ...Object.values(users).map((u) => `  ${u.email.padEnd(28)} ${u.fullName}`),
    '',
    `Reclamación de ejemplo: ${claim.number}`,
  ];
  writeFileSync(join(credsDir, 'seed-credentials.txt'), lines.join('\n') + '\n', 'utf8');
  console.log('Seed completado. Credenciales de desarrollo guardadas en infra/seed-credentials.txt (no se versiona).');
}

function nextWeekdayBack(minDays: number): number {
  let d = minDays;
  for (;;) {
    const wd = utcToZonedParts(localAt(-d, 12), TZ).weekday;
    if (wd >= 1 && wd <= 5) return d;
    d++;
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

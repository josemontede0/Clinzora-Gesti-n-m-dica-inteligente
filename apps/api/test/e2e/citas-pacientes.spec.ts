import type { INestApplication } from '@nestjs/common';
import { at, bootApp, Client, fakeCedula, login, nextBusinessDay } from '../helpers';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Pacientes y citas', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let recepcion: Client, admin: Client;
  const ctx: Record<string, string> = {};

  beforeAll(async () => {
    ({ app, prisma } = await bootApp());
    recepcion = await login(app, 'recepcion@ejemplo.test');
    admin = await login(app, 'admin@ejemplo.test');
    const pro = await prisma.medicalProfessional.findFirstOrThrow({ where: { exequatur: 'DEMO-1002' } }); // Dr. Herrera
    const branch = await prisma.branch.findFirstOrThrow({ where: { code: 'CENTRAL' } });
    const patient = await prisma.patient.findFirstOrThrow({ where: { recordNumber: 'EXP-000003' } });
    const patient2 = await prisma.patient.findFirstOrThrow({ where: { recordNumber: 'EXP-000004' } });
    Object.assign(ctx, { proId: pro.id, branchId: branch.id, patientId: patient.id, patient2Id: patient2.id, day: nextBusinessDay(3) });
  });

  afterAll(async () => app.close());

  describe('pacientes', () => {
    it('busca por nombre sin distinguir tildes ni mayúsculas, y trata los comodines como texto', async () => {
      const res = await recepcion.get('/patients?q=martinez%20gomez');
      expect(res.body.items.map((p: { lastName: string }) => p.lastName)).toContain('Martínez Gómez');
      const wildcard = await recepcion.get(`/patients?q=${encodeURIComponent('%')}`);
      expect(wildcard.status).toBe(200);
      expect(wildcard.body.total).toBe(0);
    });

    it('impide duplicar el documento de identidad', async () => {
      const existing = await prisma.patient.findFirstOrThrow({ where: { documentNumber: { not: null } } });
      const res = await recepcion.post('/patients', { firstName: 'Otro', lastName: 'Nombre', documentType: 'CEDULA', documentNumber: existing.documentNumber });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DOCUMENTO_DUPLICADO');
    });

    it('advierte posibles duplicados por nombre y teléfono, y permite continuar confirmando', async () => {
      const existing = await prisma.patient.findFirstOrThrow({ where: { recordNumber: 'EXP-000001' } });
      const body = { firstName: existing.firstName, lastName: existing.lastName, documentType: 'NINGUNO', phone: existing.phone };
      const warn = await recepcion.post('/patients', body);
      expect(warn.status).toBe(409);
      expect(warn.body.code).toBe('POSIBLE_DUPLICADO');
      expect(warn.body.candidates[0].id).toBe(existing.id);
      const ok = await recepcion.post('/patients', { ...body, confirmDuplicate: true });
      expect(ok.status).toBe(201);
      ctx.duplicateId = ok.body.id;
      ctx.originalId = existing.id;
    });

    it('actualiza datos y audita los campos modificados', async () => {
      const res = await recepcion.put(`/patients/${ctx.duplicateId}`, { firstName: 'María', lastName: 'Rodríguez Peña', documentType: 'NINGUNO', phone: '809-555-0110', address: 'Nueva dirección ficticia' });
      expect(res.status).toBe(200);
      const log = await prisma.auditLog.findFirst({ where: { action: 'PACIENTE_ACTUALIZADO', entityId: ctx.duplicateId } });
      expect((log?.details as { campos: string[] }).campos).toContain('address');
    });

    it('fusiona expedientes duplicados preservando el historial', async () => {
      const forbidden = await recepcion.post('/patients/merge', { sourceId: ctx.duplicateId, targetId: ctx.originalId, reason: 'Registro duplicado' });
      expect(forbidden.status).toBe(403);
      const res = await admin.post('/patients/merge', { sourceId: ctx.duplicateId, targetId: ctx.originalId, reason: 'Registro duplicado en recepción' });
      expect(res.status).toBe(200);
      const source = await prisma.patient.findUniqueOrThrow({ where: { id: ctx.duplicateId } });
      expect(source.status).toBe('MERGED');
      expect(source.mergedIntoId).toBe(ctx.originalId);
      const list = await recepcion.get(`/patients?q=${encodeURIComponent('Rodríguez Peña')}`);
      expect(list.body.items.map((p: { id: string }) => p.id)).not.toContain(ctx.duplicateId);
    });

    it('marca inactivo sin borrar el historial', async () => {
      const p = await recepcion.post('/patients', { firstName: 'Temporal', lastName: 'Inactivo', documentType: 'CEDULA', documentNumber: fakeCedula(9200) });
      const res = await recepcion.post(`/patients/${p.body.id}/status`, { status: 'INACTIVE', reason: 'Se mudó' });
      expect(res.status).toBe(200);
      expect((await recepcion.get(`/patients/${p.body.id}`)).body.status).toBe('INACTIVE');
    });
  });

  describe('citas', () => {
    const create = (patientId: string, startsAt: string, extra: object = {}) =>
      recepcion.post('/appointments', { branchId: ctx.branchId, patientId, professionalId: ctx.proId, startsAt, durationMin: 30, ...extra });

    it('crea una cita y evita solapamientos del mismo médico', async () => {
      const a = await create(ctx.patientId, at(ctx.day, 9, 0));
      expect(a.status).toBe(201);
      ctx.apptId = a.body.id;
      const overlap = await create(ctx.patient2Id, at(ctx.day, 9, 15));
      expect(overlap.status).toBe(409);
      expect(overlap.body.code).toBe('SOLAPAMIENTO');
    });

    it('dos reservas simultáneas del mismo espacio: solo una se confirma (concurrencia en la BD)', async () => {
      const [r1, r2] = await Promise.all([create(ctx.patientId, at(ctx.day, 10, 0)), create(ctx.patient2Id, at(ctx.day, 10, 0))]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([201, 409]);
    });

    it('valida horario de atención y bloqueos de agenda', async () => {
      const outside = await create(ctx.patientId, at(ctx.day, 13, 0)); // receso 12:00–14:00
      expect(outside.status).toBe(422);
      expect(outside.body.code).toBe('FUERA_DE_HORARIO');

      const block = await admin.post('/schedule-blocks', { professionalId: ctx.proId, type: 'VACACIONES', startsAt: at(ctx.day, 15, 0), endsAt: at(ctx.day, 17, 0), reason: 'Congreso' });
      expect(block.status).toBe(201);
      const blocked = await create(ctx.patientId, at(ctx.day, 15, 30));
      expect(blocked.status).toBe(422);
      expect(blocked.body.code).toBe('AGENDA_BLOQUEADA');
      const slots = await recepcion.get(`/appointments/availability?professionalId=${ctx.proId}&branchId=${ctx.branchId}&date=${ctx.day}&durationMin=30`);
      expect(slots.body.some((s: { label: string }) => s.label === '15:30')).toBe(false);
      expect(slots.body.some((s: { label: string }) => s.label === '09:00')).toBe(false);
    });

    it('reprograma registrando el historial y reprograma los recordatorios', async () => {
      const res = await recepcion.post(`/appointments/${ctx.apptId}/reschedule`, { startsAt: at(ctx.day, 11, 0), reason: 'Solicitud del paciente' });
      expect(res.status).toBe(200);
      expect(new Date(res.body.startsAt).toISOString()).toBe(new Date(at(ctx.day, 11, 0)).toISOString());
      const hist = res.body.history.find((h: { details: { reprogramada?: unknown } | null }) => h.details?.reprogramada);
      expect(hist).toBeTruthy();
      const cancelled = await prisma.notification.count({ where: { appointmentId: ctx.apptId, status: 'CANCELADO' } });
      expect(cancelled).toBeGreaterThan(0);
    });

    it('cancela solo con motivo, conserva la cita y libera el espacio', async () => {
      const noReason = await recepcion.post(`/appointments/${ctx.apptId}/status`, { status: 'CANCELADA' });
      expect(noReason.status).toBe(422);
      const res = await recepcion.post(`/appointments/${ctx.apptId}/status`, { status: 'CANCELADA', reason: 'El paciente no puede asistir' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELADA');
      const reuse = await create(ctx.patient2Id, at(ctx.day, 11, 0));
      expect(reuse.status).toBe(201);
      const invalid = await recepcion.post(`/appointments/${ctx.apptId}/status`, { status: 'CONFIRMADA' });
      expect(invalid.status).toBe(422);
      expect(invalid.body.code).toBe('TRANSICION_INVALIDA');
    });

    it('administra la lista de espera', async () => {
      const w = await recepcion.post('/appointments/waitlist', { branchId: ctx.branchId, patientId: ctx.patientId, professionalId: ctx.proId, notes: 'Prefiere mañanas' });
      expect(w.status).toBe(201);
      const list = await recepcion.get('/appointments/waitlist');
      expect(list.body.map((e: { id: string }) => e.id)).toContain(w.body.id);
      const a = await create(ctx.patientId, at(ctx.day, 8, 0), { waitlistEntryId: w.body.id });
      expect(a.status).toBe(201);
      const entry = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: w.body.id } });
      expect(entry.status).toBe('AGENDADA');
    });
  });
});

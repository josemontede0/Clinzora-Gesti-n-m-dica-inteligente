import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { at, bootApp, Client, login, nextBusinessDay } from '../helpers';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Turnos de la sala de espera', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let recepcion: Client, medico: Client, admin: Client;
  const ctx: Record<string, string> = {};

  beforeAll(async () => {
    ({ app, prisma } = await bootApp());
    [recepcion, medico, admin] = await Promise.all(['recepcion', 'medico', 'admin'].map((u) => login(app, `${u}@ejemplo.test`)));
    const branch = await prisma.branch.findFirstOrThrow({ where: { code: 'CENTRAL' } });
    const areas = await prisma.queueArea.findMany({ where: { branchId: branch.id } });
    Object.assign(ctx, { branchId: branch.id, consulta: areas.find((a) => a.code === 'C')!.id, caja: areas.find((a) => a.code === 'P')!.id });
  });

  afterAll(async () => app.close());

  it('emite turnos con numeración diaria por área y respeta la prioridad al llamar', async () => {
    const a = await recepcion.post('/queue/tickets', { branchId: ctx.branchId, areaId: ctx.caja, visitorName: 'Visitante Uno' });
    expect(a.status).toBe(201);
    expect(a.body.code).toMatch(/^P-\d{3}$/);
    const b = await recepcion.post('/queue/tickets', { branchId: ctx.branchId, areaId: ctx.caja });
    expect(b.body.number).toBe(a.body.number + 1);
    const noReason = await recepcion.post('/queue/tickets', { branchId: ctx.branchId, areaId: ctx.caja, priority: true });
    expect(noReason.status).toBe(422);
    const prio = await recepcion.post('/queue/tickets', { branchId: ctx.branchId, areaId: ctx.caja, priority: true, priorityReason: 'Adulto mayor' });

    const first = await recepcion.post('/queue/call-next', { branchId: ctx.branchId, areaIds: [ctx.caja], station: 'Caja 1' });
    expect(first.body.ticket.id).toBe(prio.body.id); // prioritario primero
    expect(first.body.ticket.status).toBe('LLAMADO');
    const second = await recepcion.post('/queue/call-next', { branchId: ctx.branchId, areaIds: [ctx.caja], station: 'Caja 1' });
    expect(second.body.ticket.id).toBe(a.body.id); // luego por orden de llegada
    ctx.ticketA = a.body.id;
  });

  it('dos puestos que llaman a la vez nunca reciben el mismo turno', async () => {
    const t1 = await recepcion.post('/queue/tickets', { branchId: ctx.branchId, areaId: ctx.caja });
    const t2 = await recepcion.post('/queue/tickets', { branchId: ctx.branchId, areaId: ctx.caja });
    await prisma.queueTicket.updateMany({ where: { areaId: ctx.caja, status: 'ESPERANDO', id: { notIn: [t1.body.id, t2.body.id] } }, data: { status: 'CANCELADO' } });
    const [r1, r2] = await Promise.all([
      recepcion.post('/queue/call-next', { branchId: ctx.branchId, areaIds: [ctx.caja], station: 'Caja 1' }),
      recepcion.post('/queue/call-next', { branchId: ctx.branchId, areaIds: [ctx.caja], station: 'Caja 2' }),
    ]);
    const ids = [r1.body.ticket?.id, r2.body.ticket?.id];
    expect(new Set(ids).size).toBe(2);
    expect(ids.sort()).toEqual([t1.body.id, t2.body.id].sort());
    const none = await recepcion.post('/queue/call-next', { branchId: ctx.branchId, areaIds: [ctx.caja], station: 'Caja 1' });
    expect(none.body.ticket).toBeNull();
  });

  it('el turno acompaña a la cita: llegada, consulta y firma', async () => {
    const pro = await prisma.medicalProfessional.findFirstOrThrow({ where: { exequatur: 'DEMO-1001' } });
    const patient = await prisma.patient.findFirstOrThrow({ where: { recordNumber: 'EXP-000012' } });
    const appt = await recepcion.post('/appointments', { branchId: ctx.branchId, patientId: patient.id, professionalId: pro.id, startsAt: at(nextBusinessDay(4), 16, 0), confirmed: true });
    expect(appt.status).toBe(201);
    const now = new Date();
    // Ventana que termina hace 2 min: no choca con la cita que flujo-completo mueve a "ahora" para el mismo médico.
    await prisma.appointment.update({ where: { id: appt.body.id }, data: { startsAt: new Date(now.getTime() - 3600000), endsAt: new Date(now.getTime() - 120000) } });
    expect((await recepcion.post(`/appointments/${appt.body.id}/status`, { status: 'EN_ESPERA' })).status).toBe(200);
    const ticket = await prisma.queueTicket.findFirstOrThrow({ where: { appointmentId: appt.body.id } });
    expect(ticket.code).toMatch(/^C-\d{3}$/);
    expect(ticket.status).toBe('ESPERANDO');
    expect(await prisma.queueTicket.count({ where: { appointmentId: appt.body.id } })).toBe(1);

    const called = await medico.post(`/queue/appointments/${appt.body.id}/call`, { station: 'Consultorio 1' });
    expect(called.status).toBe(200);
    expect(called.body.station).toBe('Consultorio 1');
    expect(called.body.status).toBe('LLAMADO');

    const enc = await medico.post('/clinical/encounters', { appointmentId: appt.body.id, patientId: patient.id });
    expect(enc.status).toBe(201);
    expect((await prisma.queueTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('ATENDIENDO');
    await medico.put(`/clinical/encounters/${enc.body.id}/notes`, { section: 'MOTIVO_CONSULTA', content: 'Control (ficticio)' });
    expect((await medico.post(`/clinical/encounters/${enc.body.id}/sign`)).status).toBe(200);
    expect((await prisma.queueTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('ATENDIDO');
  });

  it('deriva un turno a otra área conservando la prioridad', async () => {
    const t = await recepcion.post('/queue/tickets', { branchId: ctx.branchId, areaId: ctx.consulta, priority: true, priorityReason: 'Embarazada', visitorName: 'Visitante Dos' });
    const moved = await recepcion.post(`/queue/tickets/${t.body.id}/transfer`, { areaId: ctx.caja });
    expect(moved.status).toBe(201);
    expect(moved.body.code).toMatch(/^P-/);
    expect(moved.body.priority).toBe(true);
    expect((await prisma.queueTicket.findUniqueOrThrow({ where: { id: t.body.id } })).status).toBe('ATENDIDO');
  });

  it('pantalla de recepción: enlace secreto sin sesión, sin datos personales por defecto y revocable', async () => {
    expect((await recepcion.post('/queue/screens', { branchId: ctx.branchId, name: 'TV recepción' })).status).toBe(403);
    const created = await admin.post('/queue/screens', { branchId: ctx.branchId, name: 'TV recepción' });
    expect(created.status).toBe(201);
    const token = created.body.token as string;
    expect(token.length).toBeGreaterThan(30);
    const stored = await prisma.displayScreen.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.tokenHash).not.toBe(token);

    const server = app.getHttpServer();
    await recepcion.post(`/queue/tickets/${ctx.ticketA}/action`, { action: 'volver_a_llamar', station: 'Caja 3' });
    const pub = await request(server).get(`/public/display/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.current.station).toBe('Caja 3');
    expect(pub.body.current.name).toBeNull();
    expect(JSON.stringify(pub.body)).not.toMatch(/Visitante|patientId|recordNumber|EXP-/);
    expect(pub.body.waitingByArea.length).toBeGreaterThan(0);

    expect((await request(server).get('/public/display/token-inventado-123')).status).toBe(404);
    await admin.put(`/queue/screens/${created.body.id}`, { active: false });
    expect((await request(server).get(`/public/display/${token}`)).status).toBe(404);
  });

  it('el ticket impreso es un PDF', async () => {
    const res = await recepcion.get(`/queue/tickets/${ctx.ticketA}/print`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });
});

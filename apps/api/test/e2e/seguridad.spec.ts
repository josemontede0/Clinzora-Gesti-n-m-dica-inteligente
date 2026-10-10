import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { hash } from '@node-rs/argon2';
import { bootApp, Client, fakeCedula, login, PASSWORD } from '../helpers';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Seguridad', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let recepcion: Client, caja: Client;
  let foreignPatientId: string;
  let foreignUserEmail: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootApp());
    recepcion = await login(app, 'recepcion@ejemplo.test');
    caja = await login(app, 'caja@ejemplo.test');

    // Segunda organización con su propio paciente y usuario.
    const org = await prisma.organization.create({ data: { name: 'Otra Clínica (ficticia)' } });
    const branch = await prisma.branch.create({ data: { organizationId: org.id, code: 'X', name: 'Sede X' } });
    const role = await prisma.role.findFirstOrThrow({ where: { code: 'RECEPCION' }, include: { permissions: true } });
    const foreignRole = await prisma.role.create({ data: { organizationId: org.id, code: 'RECEPCION', name: 'Recepción', permissions: { create: role.permissions.map((p) => ({ permissionId: p.permissionId })) } } });
    foreignUserEmail = 'externo@otra.test';
    const u = await prisma.user.create({
      data: { organizationId: org.id, email: foreignUserEmail, fullName: 'Usuario Externo', passwordHash: await hash(PASSWORD), roles: { create: { roleId: foreignRole.id } }, branches: { create: { branchId: branch.id } } },
    });
    const p = await prisma.patient.create({ data: { organizationId: org.id, recordNumber: 'EXP-000001', firstName: 'Paciente', lastName: 'Ajeno', createdById: u.id } });
    foreignPatientId = p.id;
  });

  afterAll(async () => app.close());

  it('rechaza peticiones sin autenticación', async () => {
    const res = await request(app.getHttpServer()).get('/patients');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/Sesión/);
  });

  it('rechaza cookies de sesión inventadas', async () => {
    const res = await request(app.getHttpServer()).get('/patients').set('cookie', 'mg_session=abc123falsa');
    expect(res.status).toBe(401);
  });

  it('exige la cabecera anti-CSRF y un origen permitido en peticiones que modifican datos', async () => {
    const server = app.getHttpServer();
    const noHeader = await request(server).post('/patients').set('cookie', recepcion.cookie).send({ firstName: 'X', lastName: 'Y', documentType: 'NINGUNO' });
    expect(noHeader.status).toBe(403);
    const badOrigin = await request(server).post('/patients').set('cookie', recepcion.cookie).set('x-requested-with', 'medigest').set('origin', 'https://sitio-malicioso.test').send({});
    expect(badOrigin.status).toBe(403);
  });

  it('rechaza acciones sin permiso aunque la sesión sea válida', async () => {
    expect((await caja.post('/appointments', {})).status).toBe(403);
    expect((await recepcion.get('/audit')).status).toBe(403);
    expect((await recepcion.post('/invoices', {})).status).toBe(403);
  });

  it('el cajero no puede leer el expediente clínico', async () => {
    const patient = await prisma.patient.findFirstOrThrow({ where: { recordNumber: 'EXP-000002' } });
    const res = await caja.get(`/clinical/patients/${patient.id}`);
    expect(res.status).toBe(403);
  });

  it('un médico sin relación asistencial no puede ver el expediente, y el intento queda auditado', async () => {
    const medico2 = await login(app, 'medico2@ejemplo.test');
    const patient = await prisma.patient.findFirstOrThrow({ where: { recordNumber: 'EXP-000002' } }); // atendido solo por la Dra. Méndez
    const res = await medico2.get(`/clinical/patients/${patient.id}`);
    expect(res.status).toBe(403);
    const denied = await prisma.auditLog.findFirst({ where: { action: 'ACCESO_CLINICO_DENEGADO', entityId: patient.id } });
    expect(denied).toBeTruthy();
  });

  it('no permite acceder a datos de otra organización manipulando identificadores', async () => {
    const res = await recepcion.get(`/patients/${foreignPatientId}`);
    expect(res.status).toBe(404);
    const upd = await recepcion.put(`/patients/${foreignPatientId}`, { firstName: 'Hack', lastName: 'Eo', documentType: 'NINGUNO' });
    expect(upd.status).toBe(404);
    const externo = await login(app, foreignUserEmail);
    const list = await externo.get('/patients');
    expect(list.body.items.every((p: { lastName: string }) => p.lastName === 'Ajeno')).toBe(true);
  });

  it('valida entradas y trata texto malicioso como datos', async () => {
    const bad = await recepcion.post('/patients', { firstName: '', lastName: 'X', documentType: 'CEDULA', documentNumber: '123' });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.length).toBeGreaterThan(0);

    const search = await recepcion.get(`/patients?q=${encodeURIComponent("' OR 1=1; DROP TABLE \"Patient\"; --")}`);
    expect(search.status).toBe(200);
    expect(await prisma.patient.count()).toBeGreaterThan(0);

    const xss = await recepcion.post('/patients', { firstName: '<script>alert(1)</script>', lastName: 'Prueba XSS', documentType: 'CEDULA', documentNumber: fakeCedula(9100) });
    expect(xss.status).toBe(201);
    expect(xss.body.firstName).toBe('<script>alert(1)</script>'); // Se guarda literal; React lo escapa al mostrarlo.

    const badId = await recepcion.get('/patients/no-es-un-uuid');
    expect(badId.status).toBe(400);
  });

  it('bloquea la cuenta tras intentos fallidos repetidos', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 5; i++) {
      await request(server).post('/auth/login').set('x-requested-with', 'medigest').send({ email: 'enfermeria@ejemplo.test', password: 'incorrecta' });
    }
    const res = await request(server).post('/auth/login').set('x-requested-with', 'medigest').send({ email: 'enfermeria@ejemplo.test', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/bloqueada/);
    await prisma.user.update({ where: { email: 'enfermeria@ejemplo.test' }, data: { lockedUntil: null, failedLoginCount: 0 } });
  });

  it('el cierre de sesión revoca la sesión en el servidor', async () => {
    const c = await login(app, 'gerencia@ejemplo.test');
    expect((await c.get('/auth/me')).status).toBe(200);
    expect((await c.post('/auth/logout')).status).toBe(200);
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('la recuperación de contraseña no revela si el correo existe y el token es de un solo uso', async () => {
    const server = app.getHttpServer();
    const a = await request(server).post('/auth/password/forgot').set('x-requested-with', 'medigest').send({ email: 'noexiste@ejemplo.test' });
    const b = await request(server).post('/auth/password/forgot').set('x-requested-with', 'medigest').send({ email: 'seguros@ejemplo.test' });
    expect(a.status).toBe(200);
    expect(a.body.message).toBe(b.body.message);
    const token = await prisma.passwordResetToken.findFirst({ where: { user: { email: 'seguros@ejemplo.test' } } });
    expect(token?.tokenHash).toHaveLength(64); // Solo se guarda el hash.
    const bad = await request(server).post('/auth/password/reset').set('x-requested-with', 'medigest').send({ token: 'x'.repeat(40), newPassword: 'Nueva#Clave2026' });
    expect(bad.status).toBe(400);
  });

  it('los archivos privados no son accesibles sin sesión ni con firma inválida', async () => {
    const patient = await prisma.patient.findFirstOrThrow({ where: { recordNumber: 'EXP-000001' } });
    const up = await request(app.getHttpServer())
      .post('/files/patient-documents')
      .set('cookie', recepcion.cookie)
      .set('x-requested-with', 'medigest')
      .field('patientId', patient.id)
      .field('title', 'Copia de cédula (ficticia)')
      .field('isClinical', 'false')
      .attach('file', Buffer.from('%PDF-1.4\n% documento ficticio\n'), { filename: 'cedula.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    const docId = up.body.id;

    const noAuth = await request(app.getHttpServer()).get(`/files/documents/${docId}/download?exp=${Date.now() + 60000}&sig=x`);
    expect(noAuth.status).toBe(401);
    const badSig = await recepcion.get(`/files/documents/${docId}/download?exp=${Date.now() + 60000}&sig=firma-falsa`);
    expect(badSig.status).toBe(403);
    const link = await recepcion.get(`/files/documents/${docId}/link`);
    const ok = await recepcion.get(link.body.url);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toContain('no-store');
    // El enlace está ligado al usuario: otro usuario no puede usarlo.
    const other = await caja.get(link.body.url);
    expect(other.status).toBe(403);

    const exe = await request(app.getHttpServer())
      .post('/files/patient-documents')
      .set('cookie', recepcion.cookie)
      .set('x-requested-with', 'medigest')
      .field('patientId', patient.id).field('title', 'Malicioso').field('isClinical', 'false')
      .attach('file', Buffer.from('MZ\x90\x00 ejecutable'), { filename: 'factura.pdf', contentType: 'application/pdf' });
    expect(exe.status).toBe(400);
  });

  it('la revisión de retención es solo para administración, solo informa y queda auditada', async () => {
    const admin = await login(app, 'admin@ejemplo.test');
    expect((await recepcion.get('/settings/retention')).status).toBe(403);
    const before = await prisma.patient.count();
    const res = await admin.get('/settings/retention');
    expect(res.status).toBe(200);
    expect(res.body.retentionYears).toBe(10);
    expect(typeof res.body.total).toBe('number');
    expect(await prisma.patient.count()).toBe(before);
    expect(await prisma.auditLog.findFirst({ where: { action: 'REVISION_RETENCION' } })).toBeTruthy();
  });

  it('las respuestas de error no exponen trazas internas', async () => {
    const res = await recepcion.get('/ruta-que-no-existe');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|node_modules|stack/);
    expect(res.body.requestId).toBeTruthy();
  });
});

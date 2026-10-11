/**
 * Instalación inicial de PRODUCCIÓN para un cliente: crea la organización vacía con lo mínimo para
 * operar (permisos, roles, una sucursal con caja, consultorio y áreas de turnos, secuencias, plantillas)
 * y su usuario administrador. No crea pacientes ni datos ficticios.
 *
 * Uso: ORG_NAME="Clínica X" ADMIN_EMAIL=admin@clinicax.com ADMIN_NAME="Nombre" node dist/prisma/bootstrap.js
 * Imprime al final una línea `@@RESULT {json}` con el usuario y la contraseña temporal (debe cambiarse al entrar).
 */
import 'reflect-metadata';
import { PrismaClient, Prisma } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { ALL_PERMISSIONS, DEFAULT_OPERATIONAL_SETTINGS, DEFAULT_ROLES, PERMISSIONS } from '@medigest/shared';
import { DEFAULT_TEMPLATES } from '../src/modules/notifications/notifications.service';

const prisma = new PrismaClient();

async function main() {
  const orgName = process.env.ORG_NAME?.trim();
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminName = process.env.ADMIN_NAME?.trim() || 'Administrador';
  if (!orgName) throw new Error('Defina ORG_NAME');
  if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) throw new Error('Defina ADMIN_EMAIL con un correo válido');
  if ((await prisma.organization.count()) > 0) throw new Error('La base ya tiene una organización: no se reinstala encima de datos existentes.');

  const password = `Clz-${randomBytes(9).toString('base64url')}#1`;
  const passwordHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

  await prisma.$transaction(async (tx) => {
    await tx.permission.createMany({ data: ALL_PERMISSIONS.map((code) => ({ code, module: PERMISSIONS[code].module, description: PERMISSIONS[code].description })), skipDuplicates: true });
    const perms = await tx.permission.findMany();

    const org = await tx.organization.create({ data: { name: orgName, legalName: orgName, email: adminEmail } });
    const O = org.id;
    await tx.systemSetting.create({ data: { organizationId: O, key: 'operational', value: DEFAULT_OPERATIONAL_SETTINGS as unknown as Prisma.InputJsonValue } });
    await tx.documentSequence.createMany({
      data: [
        { organizationId: O, key: 'patient', prefix: 'EXP-', padding: 6 },
        { organizationId: O, key: 'invoice', prefix: 'FAC-', padding: 6 },
        { organizationId: O, key: 'payment', prefix: 'REC-', padding: 6 },
        { organizationId: O, key: 'claim', prefix: 'RCL-', padding: 5 },
        { organizationId: O, key: 'creditNote', prefix: 'NC-', padding: 5 },
      ],
    });

    const branch = await tx.branch.create({ data: { organizationId: O, code: 'PRINCIPAL', name: 'Sede principal' } });
    await tx.consultationRoom.create({ data: { organizationId: O, branchId: branch.id, name: 'Consultorio 1' } });
    await tx.cashRegister.create({ data: { organizationId: O, branchId: branch.id, name: 'Caja 1' } });
    await tx.queueArea.createMany({
      data: [
        { organizationId: O, branchId: branch.id, code: 'C', name: 'Consulta', autoCheckin: true, sortOrder: 1 },
        { organizationId: O, branchId: branch.id, code: 'P', name: 'Caja', sortOrder: 2 },
        { organizationId: O, branchId: branch.id, code: 'I', name: 'Información', sortOrder: 3 },
      ],
    });

    let adminRoleId = '';
    for (const r of DEFAULT_ROLES) {
      const role = await tx.role.create({
        data: {
          organizationId: O, code: r.code, name: r.name, description: r.description, isSystem: true, requiresMfa: r.requiresMfa,
          permissions: { create: r.permissions.map((p) => ({ permissionId: perms.find((x) => x.code === p)!.id })) },
        },
      });
      if (r.code === 'ADMIN') adminRoleId = role.id;
    }

    await tx.user.create({
      data: {
        organizationId: O, email: adminEmail, fullName: adminName, passwordHash, mustChangePassword: true,
        roles: { create: [{ roleId: adminRoleId }] }, branches: { create: [{ branchId: branch.id }] },
      },
    });

    await tx.notificationTemplate.createMany({
      data: DEFAULT_TEMPLATES.flatMap((t) => (['EMAIL', 'WHATSAPP', 'SMS'] as const).map((channel) => ({ organizationId: O, type: t.type, channel, subject: channel === 'EMAIL' ? t.subject : null, body: t.body }))),
    });
    await tx.auditLog.create({ data: { organizationId: O, action: 'INSTALACION_INICIAL', entity: 'Organization', entityId: O, details: { admin: adminEmail } } });
  });

  console.log(`@@RESULT ${JSON.stringify({ users: [{ email: adminEmail, role: 'Administrador', password }], note: 'Debe cambiar la contraseña y configurar el autenticador al entrar.' })}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

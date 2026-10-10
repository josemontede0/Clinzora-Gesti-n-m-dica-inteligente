import { BadRequestException, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ALL_PERMISSIONS, PERMISSIONS, passwordPolicy, roleUpsertSchema, userCreateSchema, userUpdateSchema } from '@medigest/shared';
import { z } from 'zod/v4';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { BusinessError } from '../../common/errors';
import { found } from '../../common/scope';
import { ApiZBody, listQuery, page, paginate, ZBody, ZQuery } from '../../common/zod.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { hashPassword } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';

const userSelect = {
  id: true, email: true, fullName: true, active: true, mfaEnabled: true, lockedUntil: true, lastLoginAt: true, mustChangePassword: true, createdAt: true,
  roles: { select: { role: { select: { id: true, code: true, name: true } } } },
  branches: { select: { branch: { select: { id: true, name: true } } } },
  professional: { select: { id: true } },
} as const;

const auditQuery = listQuery.extend({
  action: z.string().max(60).optional(),
  entity: z.string().max(60).optional(),
  entityId: z.string().max(60).optional(),
  userId: z.uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

@ApiTags('usuarios')
@Controller()
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  private async validateRefs(user: AuthUser, roleIds?: string[], branchIds?: string[]) {
    if (roleIds?.length) {
      const n = await this.prisma.role.count({ where: { id: { in: roleIds }, organizationId: user.organizationId } });
      if (n !== roleIds.length) throw new BadRequestException('Rol inválido');
    }
    if (branchIds?.length) {
      const n = await this.prisma.branch.count({ where: { id: { in: branchIds }, organizationId: user.organizationId } });
      if (n !== branchIds.length) throw new BadRequestException('Sucursal inválida');
    }
  }

  @Get('users')
  @RequirePermissions('users.read')
  async list(@CurrentUser() user: AuthUser, @ZQuery(listQuery) q: z.infer<typeof listQuery>) {
    const where = {
      organizationId: user.organizationId,
      deletedAt: null,
      ...(q.q ? { OR: [{ fullName: { contains: q.q, mode: 'insensitive' as const } }, { email: { contains: q.q, mode: 'insensitive' as const } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({ where, select: userSelect, orderBy: { fullName: 'asc' }, ...paginate(q) }),
      this.prisma.user.count({ where }),
    ]);
    return page(items, total, q);
  }

  @Post('users')
  @RequirePermissions('users.manage')
  @ApiZBody(userCreateSchema)
  async create(@CurrentUser() user: AuthUser, @ZBody(userCreateSchema) body: z.infer<typeof userCreateSchema>) {
    await this.validateRefs(user, body.roleIds, body.branchIds);
    const created = await this.prisma.user.create({
      data: {
        organizationId: user.organizationId,
        email: body.email,
        fullName: body.fullName,
        passwordHash: await hashPassword(body.password),
        mustChangePassword: true,
        roles: { create: body.roleIds.map((roleId) => ({ roleId })) },
        branches: { create: body.branchIds.map((branchId) => ({ branchId })) },
      },
      select: userSelect,
    });
    await this.audit.log({ action: 'USUARIO_CREADO', entity: 'User', entityId: created.id, details: { email: body.email, roles: body.roleIds } });
    return created;
  }

  @Put('users/:id')
  @RequirePermissions('users.manage')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(userUpdateSchema) body: z.infer<typeof userUpdateSchema>) {
    found(await this.prisma.user.findFirst({ where: { id, organizationId: user.organizationId, deletedAt: null } }), 'Usuario');
    if (id === user.id && body.active === false) throw new BusinessError('No puede desactivar su propia cuenta');
    await this.validateRefs(user, body.roleIds, body.branchIds);
    const updated = await this.prisma.$transaction(async (tx) => {
      if (body.roleIds) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({ data: body.roleIds.map((roleId) => ({ userId: id, roleId })) });
      }
      if (body.branchIds) {
        await tx.userBranch.deleteMany({ where: { userId: id } });
        await tx.userBranch.createMany({ data: body.branchIds.map((branchId) => ({ userId: id, branchId })) });
      }
      return tx.user.update({ where: { id }, data: { fullName: body.fullName, active: body.active }, select: userSelect });
    });
    if (body.active === false) await this.sessions.revokeAllForUser(id);
    await this.audit.log({ action: 'USUARIO_ACTUALIZADO', entity: 'User', entityId: id, details: { campos: Object.keys(body) } });
    return updated;
  }

  @Post('users/:id/unlock')
  @HttpCode(200)
  @RequirePermissions('users.manage')
  async unlock(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    found(await this.prisma.user.findFirst({ where: { id, organizationId: user.organizationId } }), 'Usuario');
    await this.prisma.user.update({ where: { id }, data: { lockedUntil: null, failedLoginCount: 0 } });
    await this.audit.log({ action: 'USUARIO_DESBLOQUEADO', entity: 'User', entityId: id });
    return { ok: true };
  }

  /** Asigna una contraseña temporal; el usuario deberá cambiarla al entrar. Revoca sus sesiones. */
  @Post('users/:id/reset-password')
  @HttpCode(200)
  @RequirePermissions('users.manage')
  async adminReset(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(z.object({ password: passwordPolicy })) body: { password: string }) {
    found(await this.prisma.user.findFirst({ where: { id, organizationId: user.organizationId } }), 'Usuario');
    await this.prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(body.password), mustChangePassword: true, lockedUntil: null, failedLoginCount: 0 } });
    await this.sessions.revokeAllForUser(id);
    await this.audit.log({ action: 'CONTRASENA_ASIGNADA_POR_ADMIN', entity: 'User', entityId: id });
    return { ok: true };
  }

  @Post('users/:id/reset-mfa')
  @HttpCode(200)
  @RequirePermissions('users.manage')
  async resetMfa(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    found(await this.prisma.user.findFirst({ where: { id, organizationId: user.organizationId } }), 'Usuario');
    await this.prisma.user.update({ where: { id }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaPendingSecretEnc: null } });
    await this.sessions.revokeAllForUser(id);
    await this.audit.log({ action: 'MFA_RESTABLECIDO', entity: 'User', entityId: id });
    return { ok: true };
  }

  @Post('users/:id/revoke-sessions')
  @HttpCode(200)
  @RequirePermissions('users.manage')
  async revokeSessions(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    found(await this.prisma.user.findFirst({ where: { id, organizationId: user.organizationId } }), 'Usuario');
    await this.sessions.revokeAllForUser(id);
    await this.audit.log({ action: 'SESIONES_REVOCADAS', entity: 'User', entityId: id });
    return { ok: true };
  }

  // ── Roles y permisos ──

  @Get('permissions')
  @RequirePermissions('users.read')
  permissions() {
    return ALL_PERMISSIONS.map((code) => ({ code, ...PERMISSIONS[code] }));
  }

  @Get('roles')
  @RequirePermissions('users.read')
  async roles(@CurrentUser() user: AuthUser) {
    const roles = await this.prisma.role.findMany({
      where: { organizationId: user.organizationId },
      include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
      orderBy: { name: 'asc' },
    });
    return roles.map((r) => ({ ...r, permissions: r.permissions.map((p) => p.permission.code) }));
  }

  private async savePermissions(roleId: string, codes: string[]) {
    const valid = codes.filter((c) => (ALL_PERMISSIONS as string[]).includes(c));
    const perms = await this.prisma.permission.findMany({ where: { code: { in: valid } } });
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId } }),
      this.prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId, permissionId: p.id })) }),
    ]);
  }

  @Post('roles')
  @RequirePermissions('roles.manage')
  async createRole(@CurrentUser() user: AuthUser, @ZBody(roleUpsertSchema) body: z.infer<typeof roleUpsertSchema>) {
    const role = await this.prisma.role.create({
      data: { organizationId: user.organizationId, code: body.code, name: body.name, description: body.description, requiresMfa: body.requiresMfa },
    });
    await this.savePermissions(role.id, body.permissions);
    await this.audit.log({ action: 'ROL_CREADO', entity: 'Role', entityId: role.id, details: { code: body.code, permisos: body.permissions } });
    return role;
  }

  @Put('roles/:id')
  @RequirePermissions('roles.manage')
  async updateRole(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(roleUpsertSchema) body: z.infer<typeof roleUpsertSchema>) {
    const role = found(await this.prisma.role.findFirst({ where: { id, organizationId: user.organizationId }, include: { permissions: { include: { permission: true } } } }), 'Rol');
    // Evita que un administrador se quite a sí mismo la capacidad de administrar roles.
    const isOwnRole = await this.prisma.userRole.findFirst({ where: { userId: user.id, roleId: id } });
    if (isOwnRole && role.permissions.some((p) => p.permission.code === 'roles.manage') && !body.permissions.includes('roles.manage')) {
      throw new BusinessError('No puede quitar el permiso de administrar roles a un rol que usted tiene asignado');
    }
    await this.prisma.role.update({ where: { id }, data: { name: body.name, description: body.description, requiresMfa: body.requiresMfa } });
    await this.savePermissions(id, body.permissions);
    const before = role.permissions.map((p) => p.permission.code);
    await this.audit.log({
      action: 'ROL_ACTUALIZADO', entity: 'Role', entityId: id,
      details: { agregados: body.permissions.filter((p) => !before.includes(p)), quitados: before.filter((p) => !body.permissions.includes(p)) },
    });
    return { ok: true };
  }

  // ── Auditoría ──

  @Get('audit')
  @RequirePermissions('audit.read')
  async auditLog(@CurrentUser() user: AuthUser, @ZQuery(auditQuery) q: z.infer<typeof auditQuery>) {
    const where = {
      organizationId: user.organizationId,
      ...(q.action ? { action: q.action } : {}),
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.q ? { OR: [{ userEmail: { contains: q.q, mode: 'insensitive' as const } }, { action: { contains: q.q.toUpperCase() } }] } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q) }),
      this.prisma.auditLog.count({ where }),
    ]);
    return page(items, total, q);
  }
}

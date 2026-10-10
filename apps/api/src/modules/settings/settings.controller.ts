import { Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  branchSchema, cashRegisterSchema, operationalSettingsSchema, organizationSettingsSchema, paymentMethodSchema, roomSchema,
} from '@medigest/shared';
import { z } from 'zod/v4';
import { AuditService, changedFields } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { CurrentUser, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { found } from '../../common/scope';
import { ApiZBody, ZBody } from '../../common/zod.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from './settings.service';

@ApiTags('configuración')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get('organization')
  @RequirePermissions('settings.read')
  organization(@CurrentUser() user: AuthUser) {
    return this.prisma.organization.findUniqueOrThrow({ where: { id: user.organizationId } });
  }

  @Put('organization')
  @RequirePermissions('settings.manage')
  @ApiZBody(organizationSettingsSchema)
  async updateOrganization(@CurrentUser() user: AuthUser, @ZBody(organizationSettingsSchema) body: z.infer<typeof organizationSettingsSchema>) {
    const before = await this.prisma.organization.findUniqueOrThrow({ where: { id: user.organizationId } });
    const updated = await this.prisma.organization.update({ where: { id: user.organizationId }, data: body });
    await this.audit.log({ action: 'ORGANIZACION_ACTUALIZADA', entity: 'Organization', entityId: user.organizationId, details: { campos: changedFields(before, body) } });
    return updated;
  }

  @Get('operational')
  @RequirePermissions('settings.read')
  operational(@CurrentUser() user: AuthUser) {
    return this.settings.operational(user.organizationId);
  }

  @Put('operational')
  @RequirePermissions('settings.manage')
  @ApiZBody(operationalSettingsSchema)
  async updateOperational(@CurrentUser() user: AuthUser, @ZBody(operationalSettingsSchema) body: z.infer<typeof operationalSettingsSchema>) {
    const before = await this.settings.operational(user.organizationId);
    const saved = await this.settings.saveOperational(user.organizationId, body, user.id);
    await this.audit.log({ action: 'PARAMETROS_ACTUALIZADOS', entity: 'SystemSetting', entityId: 'operational', details: { campos: changedFields(before, body) } });
    return saved;
  }

  /**
   * Expedientes que superan el plazo de retención configurado (sin actividad desde hace N años).
   * Solo informa: la eliminación de historia clínica requiere un procedimiento legal validado y no se automatiza.
   */
  @Get('retention')
  @RequirePermissions('settings.manage')
  async retention(@CurrentUser() user: AuthUser) {
    const { dataRetentionYears } = await this.settings.operational(user.organizationId);
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - dataRetentionYears);
    const where = {
      organizationId: user.organizationId,
      status: { not: 'MERGED' as const },
      OR: [{ lastVisitAt: { lt: cutoff } }, { lastVisitAt: null, createdAt: { lt: cutoff } }],
    };
    const [total, sample] = await Promise.all([
      this.prisma.patient.count({ where }),
      this.prisma.patient.findMany({
        where,
        select: { id: true, recordNumber: true, firstName: true, lastName: true, lastVisitAt: true, createdAt: true, status: true },
        orderBy: [{ lastVisitAt: 'asc' }],
        take: 100,
      }),
    ]);
    await this.audit.log({ action: 'REVISION_RETENCION', entity: 'Patient', details: { anos: dataRetentionYears, encontrados: total } });
    return { retentionYears: dataRetentionYears, cutoff: cutoff.toISOString(), total, patients: sample };
  }

  // ── Sucursales y consultorios ──

  @Get('branches')
  branches(@CurrentUser() user: AuthUser) {
    return this.prisma.branch.findMany({
      where: { organizationId: user.organizationId },
      include: { rooms: { orderBy: { name: 'asc' } } },
      orderBy: { name: 'asc' },
    });
  }

  @Post('branches')
  @RequirePermissions('catalogs.manage')
  async createBranch(@CurrentUser() user: AuthUser, @ZBody(branchSchema) body: z.infer<typeof branchSchema>) {
    const b = await this.prisma.branch.create({ data: { ...body, organizationId: user.organizationId } });
    await this.audit.log({ action: 'SUCURSAL_CREADA', entity: 'Branch', entityId: b.id });
    return b;
  }

  @Put('branches/:id')
  @RequirePermissions('catalogs.manage')
  async updateBranch(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(branchSchema) body: z.infer<typeof branchSchema>) {
    found(await this.prisma.branch.findFirst({ where: { id, organizationId: user.organizationId } }), 'Sucursal');
    const b = await this.prisma.branch.update({ where: { id }, data: body });
    await this.audit.log({ action: 'SUCURSAL_ACTUALIZADA', entity: 'Branch', entityId: id });
    return b;
  }

  @Post('rooms')
  @RequirePermissions('catalogs.manage')
  async createRoom(@CurrentUser() user: AuthUser, @ZBody(roomSchema) body: z.infer<typeof roomSchema>) {
    found(await this.prisma.branch.findFirst({ where: { id: body.branchId, organizationId: user.organizationId } }), 'Sucursal');
    const r = await this.prisma.consultationRoom.create({ data: { ...body, organizationId: user.organizationId } });
    await this.audit.log({ action: 'CONSULTORIO_CREADO', entity: 'ConsultationRoom', entityId: r.id });
    return r;
  }

  @Put('rooms/:id')
  @RequirePermissions('catalogs.manage')
  async updateRoom(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(roomSchema) body: z.infer<typeof roomSchema>) {
    found(await this.prisma.consultationRoom.findFirst({ where: { id, organizationId: user.organizationId } }), 'Consultorio');
    found(await this.prisma.branch.findFirst({ where: { id: body.branchId, organizationId: user.organizationId } }), 'Sucursal');
    return this.prisma.consultationRoom.update({ where: { id }, data: body });
  }

  // ── Métodos de pago y cajas ──

  @Get('payment-methods')
  @RequireAnyPermission('billing.read', 'payments.write', 'settings.read')
  paymentMethods(@CurrentUser() user: AuthUser) {
    return this.prisma.paymentMethod.findMany({ where: { organizationId: user.organizationId }, orderBy: { name: 'asc' } });
  }

  @Post('payment-methods')
  @RequirePermissions('settings.manage')
  async createPaymentMethod(@CurrentUser() user: AuthUser, @ZBody(paymentMethodSchema) body: z.infer<typeof paymentMethodSchema>) {
    const m = await this.prisma.paymentMethod.create({ data: { ...body, organizationId: user.organizationId } });
    await this.audit.log({ action: 'METODO_PAGO_CREADO', entity: 'PaymentMethod', entityId: m.id });
    return m;
  }

  @Put('payment-methods/:id')
  @RequirePermissions('settings.manage')
  async updatePaymentMethod(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(paymentMethodSchema) body: z.infer<typeof paymentMethodSchema>) {
    found(await this.prisma.paymentMethod.findFirst({ where: { id, organizationId: user.organizationId } }), 'Método de pago');
    const m = await this.prisma.paymentMethod.update({ where: { id }, data: body });
    await this.audit.log({ action: 'METODO_PAGO_ACTUALIZADO', entity: 'PaymentMethod', entityId: id });
    return m;
  }

  @Get('cash-registers')
  @RequireAnyPermission('cash.operate', 'cash.supervise', 'settings.read')
  cashRegisters(@CurrentUser() user: AuthUser) {
    return this.prisma.cashRegister.findMany({
      where: { organizationId: user.organizationId, ...(user.allBranches ? {} : { branchId: { in: user.branchIds } }) },
      include: { branch: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });
  }

  @Post('cash-registers')
  @RequirePermissions('settings.manage')
  async createCashRegister(@CurrentUser() user: AuthUser, @ZBody(cashRegisterSchema) body: z.infer<typeof cashRegisterSchema>) {
    found(await this.prisma.branch.findFirst({ where: { id: body.branchId, organizationId: user.organizationId } }), 'Sucursal');
    const r = await this.prisma.cashRegister.create({ data: { ...body, organizationId: user.organizationId } });
    await this.audit.log({ action: 'CAJA_CREADA', entity: 'CashRegister', entityId: r.id });
    return r;
  }
}

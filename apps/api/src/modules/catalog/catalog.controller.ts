import { BadRequestException, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { professionalSchema, scheduleBlockSchema, scheduleSchema, servicePriceSchema, serviceSchema, specialtySchema } from '@medigest/shared';
import { Prisma } from '@prisma/client';
import { z } from 'zod/v4';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { CurrentUser, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { found } from '../../common/scope';
import { ApiZBody, ZBody, ZQuery } from '../../common/zod.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { PricingService } from './pricing.service';

const activeQuery = z.object({ active: z.enum(['true', 'false', 'all']).default('true'), branchId: z.uuid().optional(), specialtyId: z.uuid().optional() });

@ApiTags('catálogos')
@Controller()
export class CatalogController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
  ) {}

  private activeFilter(active: string) {
    return active === 'all' ? {} : { active: active === 'true' };
  }

  // ── Especialidades ──

  @Get('specialties')
  specialties(@CurrentUser() user: AuthUser, @ZQuery(activeQuery) q: z.infer<typeof activeQuery>) {
    return this.prisma.specialty.findMany({ where: { organizationId: user.organizationId, ...this.activeFilter(q.active) }, orderBy: { name: 'asc' } });
  }

  @Post('specialties')
  @RequirePermissions('catalogs.manage')
  async createSpecialty(@CurrentUser() user: AuthUser, @ZBody(specialtySchema) body: z.infer<typeof specialtySchema>) {
    const s = await this.prisma.specialty.create({ data: { ...body, organizationId: user.organizationId } });
    await this.audit.log({ action: 'ESPECIALIDAD_CREADA', entity: 'Specialty', entityId: s.id });
    return s;
  }

  @Put('specialties/:id')
  @RequirePermissions('catalogs.manage')
  async updateSpecialty(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(specialtySchema) body: z.infer<typeof specialtySchema>) {
    found(await this.prisma.specialty.findFirst({ where: { id, organizationId: user.organizationId } }), 'Especialidad');
    const s = await this.prisma.specialty.update({ where: { id }, data: body });
    await this.audit.log({ action: 'ESPECIALIDAD_ACTUALIZADA', entity: 'Specialty', entityId: id });
    return s;
  }

  // ── Profesionales ──

  @Get('professionals')
  professionals(@CurrentUser() user: AuthUser, @ZQuery(activeQuery) q: z.infer<typeof activeQuery>) {
    return this.prisma.medicalProfessional.findMany({
      where: {
        organizationId: user.organizationId,
        ...this.activeFilter(q.active),
        ...(q.branchId ? { branches: { some: { branchId: q.branchId } } } : {}),
        ...(q.specialtyId ? { specialties: { some: { specialtyId: q.specialtyId } } } : {}),
      },
      include: {
        specialties: { include: { specialty: true } },
        branches: { include: { branch: { select: { id: true, name: true } } } },
        user: { select: { id: true, email: true } },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
  }

  @Get('professionals/:id')
  async professional(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return found(
      await this.prisma.medicalProfessional.findFirst({
        where: { id, organizationId: user.organizationId },
        include: {
          specialties: { include: { specialty: true } },
          branches: { include: { branch: true } },
          schedules: { where: { active: true }, include: { room: true }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] },
          blocks: { where: { endsAt: { gte: new Date() } }, orderBy: { startsAt: 'asc' } },
          user: { select: { id: true, email: true, fullName: true } },
        },
      }),
      'Profesional',
    );
  }

  private async validateProfessionalRefs(user: AuthUser, body: z.infer<typeof professionalSchema>) {
    const [specs, branches] = await Promise.all([
      this.prisma.specialty.count({ where: { id: { in: body.specialtyIds }, organizationId: user.organizationId } }),
      this.prisma.branch.count({ where: { id: { in: body.branchIds }, organizationId: user.organizationId } }),
    ]);
    if (specs !== body.specialtyIds.length || branches !== body.branchIds.length) throw new BadRequestException('Especialidad o sucursal inválida');
    if (body.userId && !(await this.prisma.user.findFirst({ where: { id: body.userId, organizationId: user.organizationId } }))) {
      throw new BadRequestException('Usuario inválido');
    }
  }

  @Post('professionals')
  @RequirePermissions('catalogs.manage')
  @ApiZBody(professionalSchema)
  async createProfessional(@CurrentUser() user: AuthUser, @ZBody(professionalSchema) body: z.infer<typeof professionalSchema>) {
    await this.validateProfessionalRefs(user, body);
    const { specialtyIds, branchIds, ...data } = body;
    const p = await this.prisma.medicalProfessional.create({
      data: {
        ...data,
        organizationId: user.organizationId,
        specialties: { create: specialtyIds.map((specialtyId) => ({ specialtyId })) },
        branches: { create: branchIds.map((branchId) => ({ branchId })) },
      },
    });
    await this.audit.log({ action: 'PROFESIONAL_CREADO', entity: 'MedicalProfessional', entityId: p.id });
    return p;
  }

  @Put('professionals/:id')
  @RequirePermissions('catalogs.manage')
  async updateProfessional(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(professionalSchema) body: z.infer<typeof professionalSchema>) {
    found(await this.prisma.medicalProfessional.findFirst({ where: { id, organizationId: user.organizationId } }), 'Profesional');
    await this.validateProfessionalRefs(user, body);
    const { specialtyIds, branchIds, ...data } = body;
    const p = await this.prisma.$transaction(async (tx) => {
      await tx.professionalSpecialty.deleteMany({ where: { professionalId: id } });
      await tx.professionalBranch.deleteMany({ where: { professionalId: id } });
      await tx.professionalSpecialty.createMany({ data: specialtyIds.map((specialtyId) => ({ professionalId: id, specialtyId })) });
      await tx.professionalBranch.createMany({ data: branchIds.map((branchId) => ({ professionalId: id, branchId })) });
      // Mantiene sincronizada la marca usada por la restricción de solapamiento en la BD (solo citas futuras).
      await tx.appointment.updateMany({ where: { professionalId: id, startsAt: { gte: new Date() } }, data: { overlapGuard: !data.allowOverlap } });
      return tx.medicalProfessional.update({ where: { id }, data });
    });
    await this.audit.log({ action: 'PROFESIONAL_ACTUALIZADO', entity: 'MedicalProfessional', entityId: id });
    return p;
  }

  // ── Horarios ──

  @Post('professionals/:id/schedules')
  @RequirePermissions('schedules.manage')
  async addSchedule(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(scheduleSchema) body: z.infer<typeof scheduleSchema>) {
    found(await this.prisma.medicalProfessional.findFirst({ where: { id, organizationId: user.organizationId } }), 'Profesional');
    found(await this.prisma.branch.findFirst({ where: { id: body.branchId, organizationId: user.organizationId } }), 'Sucursal');
    const overlapping = await this.prisma.schedule.findFirst({
      where: { professionalId: id, weekday: body.weekday, active: true, startMinute: { lt: body.endMinute }, endMinute: { gt: body.startMinute } },
    });
    if (overlapping) throw new BadRequestException('El horario se solapa con otro bloque del mismo día');
    const s = await this.prisma.schedule.create({
      data: {
        professionalId: id, branchId: body.branchId, roomId: body.roomId, weekday: body.weekday, startMinute: body.startMinute, endMinute: body.endMinute,
        validFrom: body.validFrom ? new Date(body.validFrom) : null, validTo: body.validTo ? new Date(body.validTo) : null,
      },
    });
    await this.audit.log({ action: 'HORARIO_CREADO', entity: 'Schedule', entityId: s.id, details: { professionalId: id } });
    return s;
  }

  @Delete('schedules/:id')
  @RequirePermissions('schedules.manage')
  async removeSchedule(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    found(await this.prisma.schedule.findFirst({ where: { id, professional: { organizationId: user.organizationId } } }), 'Horario');
    await this.prisma.schedule.update({ where: { id }, data: { active: false } });
    await this.audit.log({ action: 'HORARIO_DESACTIVADO', entity: 'Schedule', entityId: id });
    return { ok: true };
  }

  @Get('schedule-blocks')
  @RequireAnyPermission('appointments.read', 'schedules.manage')
  blocks(@CurrentUser() user: AuthUser, @ZQuery(z.object({ from: z.string(), to: z.string(), professionalId: z.uuid().optional() })) q: { from: string; to: string; professionalId?: string }) {
    return this.prisma.scheduleBlock.findMany({
      where: {
        organizationId: user.organizationId,
        startsAt: { lt: new Date(q.to) },
        endsAt: { gt: new Date(q.from) },
        ...(q.professionalId ? { OR: [{ professionalId: q.professionalId }, { professionalId: null }] } : {}),
      },
      orderBy: { startsAt: 'asc' },
    });
  }

  @Post('schedule-blocks')
  @RequirePermissions('schedules.manage')
  async addBlock(@CurrentUser() user: AuthUser, @ZBody(scheduleBlockSchema) body: z.infer<typeof scheduleBlockSchema>) {
    if (body.professionalId) found(await this.prisma.medicalProfessional.findFirst({ where: { id: body.professionalId, organizationId: user.organizationId } }), 'Profesional');
    if (body.branchId) found(await this.prisma.branch.findFirst({ where: { id: body.branchId, organizationId: user.organizationId } }), 'Sucursal');
    const b = await this.prisma.scheduleBlock.create({
      data: { ...body, startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt), organizationId: user.organizationId, createdById: user.id },
    });
    await this.audit.log({ action: 'BLOQUEO_AGENDA_CREADO', entity: 'ScheduleBlock', entityId: b.id, details: { tipo: body.type } });
    return b;
  }

  @Delete('schedule-blocks/:id')
  @RequirePermissions('schedules.manage')
  async removeBlock(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    found(await this.prisma.scheduleBlock.findFirst({ where: { id, organizationId: user.organizationId } }), 'Bloqueo');
    await this.prisma.scheduleBlock.delete({ where: { id } });
    await this.audit.log({ action: 'BLOQUEO_AGENDA_ELIMINADO', entity: 'ScheduleBlock', entityId: id });
    return { ok: true };
  }

  // ── Servicios y tarifas ──

  @Get('services')
  async services(@CurrentUser() user: AuthUser, @ZQuery(activeQuery.extend({ q: z.string().max(80).optional() })) q: z.infer<typeof activeQuery> & { q?: string }) {
    const now = new Date();
    return this.prisma.service.findMany({
      where: {
        organizationId: user.organizationId,
        ...this.activeFilter(q.active),
        ...(q.specialtyId ? { specialtyId: q.specialtyId } : {}),
        ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { code: { contains: q.q.toUpperCase() } }] } : {}),
      },
      include: {
        specialty: { select: { id: true, name: true } },
        prices: {
          where: { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
          include: { plan: { select: { id: true, name: true, insurer: { select: { name: true } } } } },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  @Post('services')
  @RequirePermissions('catalogs.manage')
  @ApiZBody(serviceSchema)
  async createService(@CurrentUser() user: AuthUser, @ZBody(serviceSchema) body: z.infer<typeof serviceSchema>) {
    const { price, taxRate, ...data } = body;
    if (data.specialtyId) found(await this.prisma.specialty.findFirst({ where: { id: data.specialtyId, organizationId: user.organizationId } }), 'Especialidad');
    const s = await this.prisma.service.create({ data: { ...data, taxRate: new Prisma.Decimal(taxRate), organizationId: user.organizationId } });
    if (price) await this.pricing.setPrice(s.id, { insurancePlanId: null, price }, user.id);
    await this.audit.log({ action: 'SERVICIO_CREADO', entity: 'Service', entityId: s.id, details: { code: s.code, precio: price } });
    return s;
  }

  @Put('services/:id')
  @RequirePermissions('catalogs.manage')
  async updateService(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(serviceSchema) body: z.infer<typeof serviceSchema>) {
    found(await this.prisma.service.findFirst({ where: { id, organizationId: user.organizationId } }), 'Servicio');
    const { price: _ignored, taxRate, ...data } = body;
    const s = await this.prisma.service.update({ where: { id }, data: { ...data, taxRate: new Prisma.Decimal(taxRate) } });
    await this.audit.log({ action: 'SERVICIO_ACTUALIZADO', entity: 'Service', entityId: id });
    return s;
  }

  @Get('services/:id/prices')
  async priceHistory(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    found(await this.prisma.service.findFirst({ where: { id, organizationId: user.organizationId } }), 'Servicio');
    return this.prisma.servicePrice.findMany({
      where: { serviceId: id },
      include: { plan: { select: { name: true, insurer: { select: { name: true } } } } },
      orderBy: [{ insurancePlanId: 'asc' }, { validFrom: 'desc' }],
    });
  }

  @Post('services/:id/prices')
  @HttpCode(201)
  @RequireAnyPermission('catalogs.manage', 'insurance.manage')
  async setPrice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(servicePriceSchema) body: z.infer<typeof servicePriceSchema>) {
    found(await this.prisma.service.findFirst({ where: { id, organizationId: user.organizationId } }), 'Servicio');
    if (body.insurancePlanId) {
      found(await this.prisma.insurancePlan.findFirst({ where: { id: body.insurancePlanId, insurer: { organizationId: user.organizationId } } }), 'Plan');
    } else if (!user.permissions.has('catalogs.manage')) {
      throw new BadRequestException('Solo puede registrar tarifas de planes de seguro');
    }
    const p = await this.pricing.setPrice(id, body, user.id);
    await this.audit.log({ action: 'TARIFA_REGISTRADA', entity: 'ServicePrice', entityId: p.id, details: { serviceId: id, planId: body.insurancePlanId, precio: body.price } });
    return p;
  }

  /** Tarifa vigente para un servicio y plan (vista previa al agendar o facturar). */
  @Get('services/:id/quote')
  async quote(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZQuery(z.object({ planId: z.uuid().optional() })) q: { planId?: string }) {
    found(await this.prisma.service.findFirst({ where: { id, organizationId: user.organizationId } }), 'Servicio');
    const r = await this.pricing.resolve(id, q.planId ?? null, new Date());
    const coverage = this.pricing.coverage(r, r.unitPrice, 1);
    return { price: (r.unitPrice / 100).toFixed(2), negotiated: r.negotiated, estimatedCoverage: (coverage / 100).toFixed(2), estimatedPatient: ((r.unitPrice - coverage) / 100).toFixed(2) };
  }
}

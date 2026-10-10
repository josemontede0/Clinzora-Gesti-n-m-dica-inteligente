import { BadRequestException, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  authorizationSchema, claimCreateSchema, claimStatusSchema, coverageVerificationSchema, glosaResolveSchema, glosaSchema, insurancePlanSchema,
  insurerPaymentSchema, insurerSchema, money, patientInsuranceSchema,
} from '@medigest/shared';
import { Prisma } from '@prisma/client';
import { z } from 'zod/v4';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { BusinessError } from '../../common/errors';
import { found } from '../../common/scope';
import { ApiZBody, listQuery, ZBody, ZQuery } from '../../common/zod.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { ClaimsService } from './claims.service';

const claimListQuery = listQuery.extend({ insurerId: z.uuid().optional(), status: z.string().optional(), branchId: z.uuid().optional() });

@ApiTags('seguros')
@Controller('insurance')
export class InsuranceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: ClaimsService,
    private readonly audit: AuditService,
  ) {}

  // ── Aseguradoras y planes ──

  @Get('insurers')
  insurers(@CurrentUser() user: AuthUser) {
    return this.prisma.insurer.findMany({
      where: { organizationId: user.organizationId },
      include: { plans: { orderBy: { name: 'asc' } } },
      orderBy: { name: 'asc' },
    });
  }

  @Post('insurers')
  @RequirePermissions('insurance.manage')
  async createInsurer(@CurrentUser() user: AuthUser, @ZBody(insurerSchema) body: z.infer<typeof insurerSchema>) {
    const i = await this.prisma.insurer.create({ data: { ...body, organizationId: user.organizationId } });
    await this.audit.log({ action: 'ASEGURADORA_CREADA', entity: 'Insurer', entityId: i.id });
    return i;
  }

  @Put('insurers/:id')
  @RequirePermissions('insurance.manage')
  async updateInsurer(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(insurerSchema) body: z.infer<typeof insurerSchema>) {
    found(await this.prisma.insurer.findFirst({ where: { id, organizationId: user.organizationId } }), 'Aseguradora');
    const i = await this.prisma.insurer.update({ where: { id }, data: body });
    await this.audit.log({ action: 'ASEGURADORA_ACTUALIZADA', entity: 'Insurer', entityId: id });
    return i;
  }

  @Post('plans')
  @RequirePermissions('insurance.manage')
  async createPlan(@CurrentUser() user: AuthUser, @ZBody(insurancePlanSchema) body: z.infer<typeof insurancePlanSchema>) {
    found(await this.prisma.insurer.findFirst({ where: { id: body.insurerId, organizationId: user.organizationId } }), 'Aseguradora');
    const p = await this.prisma.insurancePlan.create({ data: { ...body, defaultCoveragePercent: new Prisma.Decimal(body.defaultCoveragePercent) } });
    await this.audit.log({ action: 'PLAN_CREADO', entity: 'InsurancePlan', entityId: p.id });
    return p;
  }

  @Put('plans/:id')
  @RequirePermissions('insurance.manage')
  async updatePlan(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(insurancePlanSchema) body: z.infer<typeof insurancePlanSchema>) {
    found(await this.prisma.insurancePlan.findFirst({ where: { id, insurer: { organizationId: user.organizationId } } }), 'Plan');
    const p = await this.prisma.insurancePlan.update({ where: { id }, data: { ...body, defaultCoveragePercent: new Prisma.Decimal(body.defaultCoveragePercent) } });
    await this.audit.log({ action: 'PLAN_ACTUALIZADO', entity: 'InsurancePlan', entityId: id });
    return p;
  }

  // ── Afiliaciones del paciente ──

  @Get('patients/:patientId/policies')
  @RequirePermissions('insurance.read')
  async policies(@CurrentUser() user: AuthUser, @Param('patientId', ParseUUIDPipe) patientId: string) {
    found(await this.prisma.patient.findFirst({ where: { id: patientId, organizationId: user.organizationId } }), 'Paciente');
    return this.prisma.patientInsurance.findMany({
      where: { patientId },
      include: {
        plan: { include: { insurer: true } },
        verifications: { orderBy: { verifiedAt: 'desc' }, take: 5 },
        authorizations: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
      orderBy: [{ active: 'desc' }, { isPrimary: 'desc' }],
    });
  }

  @Post('patients/:patientId/policies')
  @RequirePermissions('insurance.write')
  async addPolicy(@CurrentUser() user: AuthUser, @Param('patientId', ParseUUIDPipe) patientId: string, @ZBody(patientInsuranceSchema) body: z.infer<typeof patientInsuranceSchema>) {
    found(await this.prisma.patient.findFirst({ where: { id: patientId, organizationId: user.organizationId } }), 'Paciente');
    found(await this.prisma.insurancePlan.findFirst({ where: { id: body.planId, insurer: { organizationId: user.organizationId }, active: true } }), 'Plan');
    if (body.validFrom && body.validTo && body.validTo < body.validFrom) throw new BadRequestException('La vigencia final es anterior a la inicial');
    const policy = await this.prisma.$transaction(async (tx) => {
      if (body.isPrimary) await tx.patientInsurance.updateMany({ where: { patientId }, data: { isPrimary: false } });
      return tx.patientInsurance.create({
        data: { ...body, patientId, validFrom: body.validFrom ? new Date(body.validFrom) : null, validTo: body.validTo ? new Date(body.validTo) : null },
      });
    });
    await this.audit.log({ action: 'AFILIACION_REGISTRADA', entity: 'PatientInsurance', entityId: policy.id, details: { paciente: patientId, plan: body.planId } });
    return policy;
  }

  @Post('policies/:id/active')
  @HttpCode(200)
  @RequirePermissions('insurance.write')
  async setPolicyActive(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(z.object({ active: z.boolean() })) body: { active: boolean }) {
    found(await this.prisma.patientInsurance.findFirst({ where: { id, patient: { organizationId: user.organizationId } } }), 'Afiliación');
    await this.prisma.patientInsurance.update({ where: { id }, data: { active: body.active } });
    await this.audit.log({ action: body.active ? 'AFILIACION_ACTIVADA' : 'AFILIACION_INACTIVADA', entity: 'PatientInsurance', entityId: id });
    return { ok: true };
  }

  /** Validación de cobertura registrada manualmente (portal o llamada a la ARS). No implica validación automática. */
  @Post('verifications')
  @RequirePermissions('insurance.write')
  async verify(@CurrentUser() user: AuthUser, @ZBody(coverageVerificationSchema) body: z.infer<typeof coverageVerificationSchema>) {
    found(await this.prisma.patientInsurance.findFirst({ where: { id: body.patientInsuranceId, patient: { organizationId: user.organizationId } } }), 'Afiliación');
    const v = await this.prisma.coverageVerification.create({ data: { ...body, method: 'MANUAL', verifiedById: user.id } });
    await this.audit.log({ action: 'COBERTURA_VALIDADA_MANUAL', entity: 'CoverageVerification', entityId: v.id, details: { resultado: body.result, referencia: body.reference } });
    return v;
  }

  // ── Autorizaciones ──

  @Get('authorizations')
  @RequirePermissions('insurance.read')
  authorizations(@CurrentUser() user: AuthUser, @ZQuery(z.object({ status: z.string().optional(), patientInsuranceId: z.uuid().optional() })) q: { status?: string; patientInsuranceId?: string }) {
    return this.prisma.insuranceAuthorization.findMany({
      where: { organizationId: user.organizationId, ...(q.status ? { status: q.status as never } : {}), ...(q.patientInsuranceId ? { patientInsuranceId: q.patientInsuranceId } : {}) },
      include: { patientInsurance: { include: { plan: { include: { insurer: true } }, patient: { select: { id: true, firstName: true, lastName: true, recordNumber: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
  }

  @Post('authorizations')
  @RequirePermissions('insurance.write')
  async createAuthorization(@CurrentUser() user: AuthUser, @ZBody(authorizationSchema) body: z.infer<typeof authorizationSchema>) {
    found(await this.prisma.patientInsurance.findFirst({ where: { id: body.patientInsuranceId, patient: { organizationId: user.organizationId } } }), 'Afiliación');
    if (body.status === 'APROBADA' && !body.authorizationNumber) throw new BusinessError('Una autorización aprobada requiere el número de autorización de la ARS');
    const a = await this.prisma.insuranceAuthorization.create({
      data: {
        ...body,
        authorizedAmount: body.authorizedAmount ? new Prisma.Decimal(body.authorizedAmount) : null,
        validUntil: body.validUntil ? new Date(body.validUntil) : null,
        method: 'MANUAL',
        organizationId: user.organizationId,
        createdById: user.id,
      },
    });
    await this.audit.log({ action: 'AUTORIZACION_REGISTRADA', entity: 'InsuranceAuthorization', entityId: a.id, details: { estado: body.status, numero: body.authorizationNumber } });
    return a;
  }

  @Put('authorizations/:id')
  @RequirePermissions('insurance.write')
  async updateAuthorization(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(authorizationSchema) body: z.infer<typeof authorizationSchema>) {
    found(await this.prisma.insuranceAuthorization.findFirst({ where: { id, organizationId: user.organizationId } }), 'Autorización');
    if (body.status === 'APROBADA' && !body.authorizationNumber) throw new BusinessError('Una autorización aprobada requiere el número de autorización de la ARS');
    const a = await this.prisma.insuranceAuthorization.update({
      where: { id },
      data: { ...body, authorizedAmount: body.authorizedAmount ? new Prisma.Decimal(body.authorizedAmount) : null, validUntil: body.validUntil ? new Date(body.validUntil) : null },
    });
    await this.audit.log({ action: 'AUTORIZACION_ACTUALIZADA', entity: 'InsuranceAuthorization', entityId: id, details: { estado: body.status } });
    return a;
  }

  // ── Reclamaciones ──

  @Get('claimable')
  @RequirePermissions('insurance.claims')
  claimable(@CurrentUser() user: AuthUser, @ZQuery(z.object({ insurerId: z.uuid(), branchId: z.uuid().optional() })) q: { insurerId: string; branchId?: string }) {
    return this.claims.claimable(user, q.insurerId, q.branchId);
  }

  @Get('claims')
  @RequirePermissions('insurance.read')
  listClaims(@CurrentUser() user: AuthUser, @ZQuery(claimListQuery) q: z.infer<typeof claimListQuery>) {
    return this.claims.list(user, q);
  }

  @Get('claims/:id')
  @RequirePermissions('insurance.read')
  getClaim(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.claims.get(user, id);
  }

  @Post('claims')
  @RequirePermissions('insurance.claims')
  @ApiZBody(claimCreateSchema)
  createClaim(@CurrentUser() user: AuthUser, @ZBody(claimCreateSchema) body: z.infer<typeof claimCreateSchema>) {
    return this.claims.create(user, body);
  }

  @Post('claims/:id/status')
  @HttpCode(200)
  @RequirePermissions('insurance.claims')
  @ApiZBody(claimStatusSchema)
  claimStatus(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(claimStatusSchema) body: z.infer<typeof claimStatusSchema>) {
    return this.claims.changeStatus(user, id, body);
  }

  @Post('claims/:id/glosas')
  @RequirePermissions('insurance.claims')
  glosa(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(glosaSchema) body: z.infer<typeof glosaSchema>) {
    return this.claims.addGlosa(user, id, body);
  }

  @Post('glosas/:id/resolve')
  @HttpCode(200)
  @RequirePermissions('insurance.claims')
  resolveGlosa(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(glosaResolveSchema) body: z.infer<typeof glosaResolveSchema>) {
    return this.claims.resolveGlosa(user, id, body.status, body.resolution);
  }

  // ── Pagos de ARS y conciliación ──

  @Get('payments')
  @RequirePermissions('insurance.read')
  payments(@CurrentUser() user: AuthUser, @ZQuery(z.object({ insurerId: z.uuid().optional() })) q: { insurerId?: string }) {
    return this.claims.payments(user, q.insurerId);
  }

  @Get('payments/:id')
  @RequirePermissions('insurance.read')
  payment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.claims.getPayment(user, id);
  }

  @Post('payments')
  @RequirePermissions('insurance.claims')
  @ApiZBody(insurerPaymentSchema)
  registerPayment(@CurrentUser() user: AuthUser, @ZBody(insurerPaymentSchema) body: z.infer<typeof insurerPaymentSchema>) {
    return this.claims.registerPayment(user, body);
  }

  @Post('payments/:id/allocate')
  @HttpCode(200)
  @RequirePermissions('insurance.claims')
  allocate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(z.object({ claimId: z.uuid(), amount: money })) body: { claimId: string; amount: string }) {
    return this.claims.allocatePayment(user, id, body.claimId, body.amount);
  }

  @Get('receivables')
  @RequirePermissions('insurance.read')
  receivables(@CurrentUser() user: AuthUser) {
    return this.claims.receivables(user);
  }
}

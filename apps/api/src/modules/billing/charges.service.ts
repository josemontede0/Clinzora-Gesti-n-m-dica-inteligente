import { ForbiddenException, Injectable } from '@nestjs/common';
import { ChargeSource, MedicalEncounter, Prisma } from '@prisma/client';
import { chargeCreateSchema, computeLine, toCents } from '@medigest/shared';
import { z } from 'zod/v4';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { BusinessError } from '../../common/errors';
import { assertBranch, found } from '../../common/scope';
import { PrismaService } from '../../prisma/prisma.service';
import { PricingService } from '../catalog/pricing.service';
import { dec } from './money-db';

interface ChargeInput {
  patientId: string;
  branchId: string;
  serviceId: string;
  professionalId?: string | null;
  encounterId?: string | null;
  appointmentId?: string | null;
  patientInsuranceId?: string | null;
  quantity: number;
  discount: string;
  discountReason?: string | null;
  idempotencyKey: string;
  source: ChargeSource;
}

@Injectable()
export class ChargesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Crea un cargo con la tarifa vigente. Idempotente por idempotencyKey: si el cliente reintenta,
   * devuelve el cargo existente en lugar de duplicarlo.
   */
  private async createCharge(user: AuthUser, input: ChargeInput) {
    const existing = await this.prisma.charge.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      if (existing.organizationId !== user.organizationId) throw new ForbiddenException('Clave de idempotencia inválida');
      return existing;
    }
    assertBranch(user, input.branchId);
    const [patient, service] = await Promise.all([
      this.prisma.patient.findFirst({ where: { id: input.patientId, organizationId: user.organizationId } }),
      this.prisma.service.findFirst({ where: { id: input.serviceId, organizationId: user.organizationId } }),
    ]);
    found(patient, 'Paciente');
    found(service, 'Servicio');
    if (!service!.active) throw new BusinessError('El servicio está inactivo');

    let planId: string | null = null;
    if (input.patientInsuranceId) {
      const ins = found(
        await this.prisma.patientInsurance.findFirst({ where: { id: input.patientInsuranceId, patientId: input.patientId }, include: { plan: true } }),
        'Afiliación',
      );
      const today = new Date();
      if (!ins.active || (ins.validTo && ins.validTo < today) || (ins.validFrom && ins.validFrom > today)) {
        throw new BusinessError('La afiliación del paciente no está vigente');
      }
      planId = ins.planId;
    }
    const discount = toCents(input.discount);
    if (discount > 0 && !user.permissions.has('billing.discount') && input.source === 'MANUAL') {
      throw new ForbiddenException('No tiene permiso para aplicar descuentos');
    }
    if (discount > 0 && !input.discountReason) throw new BusinessError('Indique el motivo del descuento');

    const at = new Date();
    const price = await this.pricing.resolve(service!.id, planId, at);
    const base = computeLine({ quantity: input.quantity, unitPrice: price.unitPrice, discount, taxRate: service!.taxRate.toString() });
    const insurance = planId ? this.pricing.coverage(price, base.total, input.quantity) : 0;
    const line = computeLine({ quantity: input.quantity, unitPrice: price.unitPrice, discount, taxRate: service!.taxRate.toString(), insuranceAmount: insurance });

    try {
      const charge = await this.prisma.charge.create({
        data: {
          organizationId: user.organizationId,
          branchId: input.branchId,
          patientId: input.patientId,
          serviceId: service!.id,
          professionalId: input.professionalId,
          encounterId: input.encounterId,
          appointmentId: input.appointmentId,
          patientInsuranceId: input.patientInsuranceId,
          servicePriceId: price.servicePrice.id,
          serviceDate: at,
          description: `${service!.code} — ${service!.name}`,
          quantity: input.quantity,
          unitPrice: dec(price.unitPrice),
          discount: dec(line.discount),
          discountReason: input.discountReason,
          taxRate: service!.taxRate,
          taxAmount: dec(line.tax),
          total: dec(line.total),
          insuranceAmount: dec(line.insuranceAmount),
          patientAmount: dec(line.patientAmount),
          source: input.source,
          idempotencyKey: input.idempotencyKey,
          createdById: user.id,
        },
      });
      await this.audit.log({
        action: 'CARGO_CREADO', entity: 'Charge', entityId: charge.id, branchId: input.branchId,
        details: { servicio: service!.code, total: charge.total.toString(), seguro: charge.insuranceAmount.toString(), origen: input.source },
      });
      return charge;
    } catch (e) {
      // Dos peticiones simultáneas con la misma clave: gana una, la otra devuelve el mismo cargo.
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        return this.prisma.charge.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
      }
      throw e;
    }
  }

  create(user: AuthUser, input: z.infer<typeof chargeCreateSchema>) {
    return this.createCharge(user, { ...input, source: input.encounterId ? 'ENCUENTRO' : input.appointmentId ? 'CITA' : 'MANUAL' });
  }

  /** Cargo del servicio de la cita al firmar el encuentro (una sola vez por encuentro y servicio). */
  createFromEncounter(user: AuthUser, enc: MedicalEncounter, serviceId: string, patientInsuranceId: string | null) {
    return this.createCharge(user, {
      patientId: enc.patientId,
      branchId: enc.branchId,
      serviceId,
      professionalId: enc.professionalId,
      encounterId: enc.id,
      appointmentId: enc.appointmentId,
      patientInsuranceId,
      quantity: 1,
      discount: '0',
      idempotencyKey: `encuentro:${enc.id}:servicio:${serviceId}`,
      source: 'ENCUENTRO',
    });
  }

  async list(user: AuthUser, q: { patientId?: string; status?: string; branchId?: string }) {
    if (q.branchId) assertBranch(user, q.branchId);
    return this.prisma.charge.findMany({
      where: {
        organizationId: user.organizationId,
        ...(q.patientId ? { patientId: q.patientId } : {}),
        ...(q.status ? { status: q.status as never } : {}),
        ...(q.branchId ? { branchId: q.branchId } : user.allBranches ? {} : { branchId: { in: user.branchIds } }),
      },
      include: { patient: { select: { id: true, firstName: true, lastName: true, recordNumber: true } } },
      orderBy: { serviceDate: 'desc' },
      take: 500,
    });
  }

  async void(user: AuthUser, id: string, reason: string) {
    const charge = found(await this.prisma.charge.findFirst({ where: { id, organizationId: user.organizationId } }), 'Cargo');
    if (charge.status !== 'PENDIENTE') throw new BusinessError('Solo se pueden anular cargos pendientes de facturar');
    await this.prisma.charge.update({ where: { id }, data: { status: 'ANULADO', voidReason: reason } });
    await this.audit.log({ action: 'CARGO_ANULADO', entity: 'Charge', entityId: id, details: { motivo: reason, total: charge.total.toString() } });
    return { ok: true };
  }
}

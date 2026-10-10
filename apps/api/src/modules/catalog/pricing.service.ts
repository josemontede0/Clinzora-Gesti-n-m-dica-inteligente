import { Injectable } from '@nestjs/common';
import { Prisma, ServicePrice } from '@prisma/client';
import { coverageFor, toCents } from '@medigest/shared';
import { BusinessError } from '../../common/errors';
import { PrismaService, Tx } from '../../prisma/prisma.service';

export interface ResolvedPrice {
  servicePrice: ServicePrice;
  /** Precio unitario vigente (centavos). */
  unitPrice: number;
  /** true si existe tarifa negociada para el plan; false si se usa la particular con cobertura por defecto del plan. */
  negotiated: boolean;
  coverageAmount: number | null;
  coveragePercent: string | null;
}

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  private current(db: Tx | PrismaService, serviceId: string, planId: string | null, at: Date) {
    return db.servicePrice.findFirst({
      where: { serviceId, insurancePlanId: planId, validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gt: at } }] },
      orderBy: { validFrom: 'desc' },
    });
  }

  /** Tarifa vigente en una fecha: negociada del plan si existe; si no, la particular con la cobertura por defecto del plan. */
  async resolve(serviceId: string, planId: string | null, at: Date, db: Tx | PrismaService = this.prisma): Promise<ResolvedPrice> {
    if (planId) {
      const negotiated = await this.current(db, serviceId, planId, at);
      if (negotiated) {
        return {
          servicePrice: negotiated,
          unitPrice: toCents(negotiated.price.toString()),
          negotiated: true,
          coverageAmount: negotiated.coverageAmount ? toCents(negotiated.coverageAmount.toString()) : null,
          coveragePercent: negotiated.coveragePercent?.toString() ?? null,
        };
      }
    }
    const particular = await this.current(db, serviceId, null, at);
    if (!particular) throw new BusinessError('El servicio no tiene una tarifa vigente. Configure el precio antes de facturar.');
    let coveragePercent: string | null = null;
    if (planId) {
      const plan = await db.insurancePlan.findUnique({ where: { id: planId } });
      coveragePercent = plan?.defaultCoveragePercent.toString() ?? null;
    }
    return { servicePrice: particular, unitPrice: toCents(particular.price.toString()), negotiated: false, coverageAmount: null, coveragePercent };
  }

  /** Cobertura estimada de la aseguradora para un total de línea (centavos). */
  coverage(resolved: ResolvedPrice, lineTotal: number, quantity: number): number {
    const fixed = resolved.coverageAmount != null ? resolved.coverageAmount * quantity : null;
    return coverageFor(lineTotal, fixed, resolved.coveragePercent);
  }

  /** Nueva tarifa: cierra la vigente del mismo servicio/plan y crea la nueva. Las facturas anteriores no cambian. */
  async setPrice(
    serviceId: string,
    input: { insurancePlanId: string | null; price: string; coverageAmount?: string | null; coveragePercent?: string | null; validFrom?: string },
    userId: string,
  ) {
    const validFrom = input.validFrom ? new Date(input.validFrom) : new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.servicePrice.updateMany({
        where: { serviceId, insurancePlanId: input.insurancePlanId, OR: [{ validTo: null }, { validTo: { gt: validFrom } }], validFrom: { lte: validFrom } },
        data: { validTo: validFrom },
      });
      return tx.servicePrice.create({
        data: {
          serviceId,
          insurancePlanId: input.insurancePlanId,
          price: new Prisma.Decimal(input.price),
          coverageAmount: input.coverageAmount ? new Prisma.Decimal(input.coverageAmount) : null,
          coveragePercent: input.coveragePercent ? new Prisma.Decimal(input.coveragePercent) : null,
          validFrom,
          createdById: userId,
        },
      });
    });
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { ClaimStatus, Prisma } from '@prisma/client';
import { CLAIM_TRANSITIONS, claimCreateSchema, claimStatusSchema, fromCents, glosaSchema, insurerPaymentSchema, sumCents, toCents } from '@medigest/shared';
import { z } from 'zod/v4';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { BusinessError } from '../../common/errors';
import { assertBranch, found } from '../../common/scope';
import { nextNumber } from '../../common/sequence';
import { page, paginate } from '../../common/zod.pipe';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { c, dec } from '../billing/money-db';

const PAYABLE: ClaimStatus[] = ['SOMETIDA', 'EN_REVISION', 'APROBADA', 'APROBADA_PARCIAL', 'PAGADA_PARCIAL'];

/**
 * Montos de una reclamación:
 *  reclamado (claimedAmount) → reconocido esperado = aprobado si la ARS respondió; si no, reclamado − glosas vigentes
 *  pagado (paidAmount) = suma de pagos de ARS conciliados
 *  saldo por cobrar = esperado − pagado
 */
export function claimExpected(claim: { claimedAmount: Prisma.Decimal; approvedAmount: Prisma.Decimal | null; glosaAmount: Prisma.Decimal; status: ClaimStatus }) {
  if (claim.status === 'RECHAZADA') return 0;
  if (claim.approvedAmount != null) return c(claim.approvedAmount);
  return c(claim.claimedAmount) - c(claim.glosaAmount);
}

@Injectable()
export class ClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Líneas de facturas emitidas con parte de seguro aún no reclamada. */
  async claimable(user: AuthUser, insurerId: string, branchId?: string) {
    if (branchId) assertBranch(user, branchId);
    const items = await this.prisma.invoiceItem.findMany({
      where: {
        insuranceAmount: { gt: 0 },
        claimItem: null,
        invoice: {
          organizationId: user.organizationId,
          status: { in: ['PENDIENTE', 'PARCIAL', 'PAGADA'] },
          ...(branchId ? { branchId } : user.allBranches ? {} : { branchId: { in: user.branchIds } }),
          patientInsuranceId: { not: null },
        },
      },
      include: { invoice: { select: { id: true, number: true, issuedAt: true, branchId: true, patientInsuranceId: true, patient: { select: { id: true, firstName: true, lastName: true, recordNumber: true } } } } },
      orderBy: { invoice: { issuedAt: 'asc' } },
    });
    const insIds = [...new Set(items.map((i) => i.invoice.patientInsuranceId!))];
    const insurances = await this.prisma.patientInsurance.findMany({ where: { id: { in: insIds } }, include: { plan: true } });
    return items
      .map((i) => ({ ...i, patientInsurance: insurances.find((p) => p.id === i.invoice.patientInsuranceId) }))
      .filter((i) => i.patientInsurance?.plan.insurerId === insurerId);
  }

  async create(user: AuthUser, input: z.infer<typeof claimCreateSchema>) {
    assertBranch(user, input.branchId);
    const insurer = found(await this.prisma.insurer.findFirst({ where: { id: input.insurerId, organizationId: user.organizationId } }), 'Aseguradora');
    const claim = await this.prisma.serializable(async (tx) => {
      const items = await tx.invoiceItem.findMany({
        where: { id: { in: input.invoiceItemIds }, invoice: { organizationId: user.organizationId } },
        include: { invoice: true, claimItem: true },
      });
      if (items.length !== new Set(input.invoiceItemIds).size) throw new BadRequestException('Una o más líneas no existen');
      for (const it of items) {
        if (it.claimItem) throw new BusinessError(`La línea "${it.description}" de ${it.invoice.number} ya fue reclamada`, 'YA_RECLAMADA');
        if (c(it.insuranceAmount) <= 0) throw new BusinessError(`La línea "${it.description}" no tiene parte de seguro`);
        if (!['PENDIENTE', 'PARCIAL', 'PAGADA'].includes(it.invoice.status)) throw new BusinessError(`La factura ${it.invoice.number} no está emitida`);
        if (it.invoice.branchId !== input.branchId) throw new BusinessError('Todas las líneas deben ser de la sucursal seleccionada');
      }
      const insIds = [...new Set(items.map((i) => i.invoice.patientInsuranceId).filter((x): x is string => !!x))];
      const insurances = await tx.patientInsurance.findMany({ where: { id: { in: insIds } }, include: { plan: true } });
      if (items.some((i) => insurances.find((p) => p.id === i.invoice.patientInsuranceId)?.plan.insurerId !== insurer.id)) {
        throw new BusinessError('Todas las líneas deben corresponder a afiliados de la aseguradora seleccionada');
      }
      const earliest = items.reduce((min, i) => (i.invoice.issuedAt! < min ? i.invoice.issuedAt! : min), items[0].invoice.issuedAt!);
      const claimed = sumCents(items.map((i) => c(i.insuranceAmount)));
      const number = await nextNumber(tx, user.organizationId, 'claim');
      const auths = await tx.insuranceAuthorization.findMany({ where: { patientInsuranceId: { in: insIds }, status: { in: ['APROBADA', 'UTILIZADA'] } } });
      const created = await tx.claim.create({
        data: {
          organizationId: user.organizationId,
          branchId: input.branchId,
          number,
          insurerId: insurer.id,
          claimedAmount: dec(claimed),
          submissionDeadline: new Date(earliest.getTime() + insurer.claimSubmissionDays * 86400_000),
          notes: input.notes,
          createdById: user.id,
          items: {
            create: items.map((i) => ({
              invoiceItemId: i.id,
              patientInsuranceId: i.invoice.patientInsuranceId!,
              authorizationId: auths.find((a) => a.patientInsuranceId === i.invoice.patientInsuranceId && (!a.serviceId || a.serviceId === i.serviceId))?.id ?? null,
              serviceDate: i.invoice.issuedAt!,
              description: `${i.invoice.number} · ${i.description}`,
              claimedAmount: i.insuranceAmount,
            })),
          },
          history: { create: { toStatus: 'BORRADOR', changedById: user.id, note: 'Reclamación creada' } },
        },
      });
      await this.audit.log({ action: 'RECLAMACION_CREADA', entity: 'Claim', entityId: created.id, branchId: input.branchId, details: { numero: number, aseguradora: insurer.code, reclamado: fromCents(claimed), lineas: items.length } }, tx);
      return created;
    });
    return this.get(user, claim.id);
  }

  async list(user: AuthUser, q: { insurerId?: string; status?: string; branchId?: string; page: number; pageSize: number; q?: string }) {
    if (q.branchId) assertBranch(user, q.branchId);
    const where: Prisma.ClaimWhereInput = {
      organizationId: user.organizationId,
      ...(q.branchId ? { branchId: q.branchId } : user.allBranches ? {} : { branchId: { in: user.branchIds } }),
      ...(q.insurerId ? { insurerId: q.insurerId } : {}),
      ...(q.status ? { status: { in: q.status.split(',') as ClaimStatus[] } } : {}),
      ...(q.q ? { OR: [{ number: { contains: q.q.toUpperCase() } }, { externalReference: { contains: q.q } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.claim.findMany({ where, include: { insurer: { select: { id: true, name: true, code: true } }, _count: { select: { items: true } } }, orderBy: { createdAt: 'desc' }, ...paginate(q) }),
      this.prisma.claim.count({ where }),
    ]);
    const today = new Date();
    return page(
      items.map((cl) => {
        const expected = claimExpected(cl);
        return {
          ...cl,
          expectedAmount: fromCents(expected),
          balance: fromCents(Math.max(expected - c(cl.paidAmount), 0)),
          submissionOverdue: cl.status === 'BORRADOR' && !!cl.submissionDeadline && cl.submissionDeadline < today,
          paymentOverdue: PAYABLE.includes(cl.status) && !!cl.expectedPaymentDate && cl.expectedPaymentDate < today,
        };
      }),
      total,
      q,
    );
  }

  async get(user: AuthUser, id: string) {
    const claim = found(
      await this.prisma.claim.findFirst({
        where: { id, organizationId: user.organizationId },
        include: {
          insurer: true,
          items: {
            include: {
              glosas: true,
              authorization: { select: { authorizationNumber: true, status: true } },
              invoiceItem: { select: { invoice: { select: { id: true, number: true, patient: { select: { id: true, firstName: true, lastName: true, recordNumber: true } } } } } },
            },
          },
          history: { orderBy: { createdAt: 'desc' } },
          glosas: { orderBy: { createdAt: 'desc' } },
          allocations: { include: { insurerPayment: { select: { id: true, receivedAt: true, reference: true, amount: true } } } },
        },
      }),
      'Reclamación',
    );
    assertBranch(user, claim.branchId);
    const insIds = [...new Set(claim.items.map((i) => i.patientInsuranceId))];
    const insurances = await this.prisma.patientInsurance.findMany({ where: { id: { in: insIds } }, select: { id: true, affiliateNumber: true, plan: { select: { name: true } } } });
    const expected = claimExpected(claim);
    return {
      ...claim,
      items: claim.items.map((i) => ({ ...i, patientInsurance: insurances.find((p) => p.id === i.patientInsuranceId) })),
      expectedAmount: fromCents(expected),
      balance: fromCents(Math.max(expected - c(claim.paidAmount), 0)),
      difference: fromCents(c(claim.claimedAmount) - expected),
    };
  }

  async changeStatus(user: AuthUser, id: string, input: z.infer<typeof claimStatusSchema>) {
    const claim = found(await this.prisma.claim.findFirst({ where: { id, organizationId: user.organizationId }, include: { items: true, insurer: true } }), 'Reclamación');
    assertBranch(user, claim.branchId);
    if (!CLAIM_TRANSITIONS[claim.status].includes(input.status)) throw new BusinessError(`No se puede pasar de ${claim.status} a ${input.status}`, 'TRANSICION_INVALIDA');
    const data: Prisma.ClaimUpdateInput = { status: input.status };
    if (input.externalReference) data.externalReference = input.externalReference;
    if (input.status === 'SOMETIDA') {
      data.submittedAt = new Date();
      data.expectedPaymentDate = new Date(Date.now() + claim.insurer.paymentTermDays * 86400_000);
    }

    await this.prisma.$transaction(async (tx) => {
      if (input.status === 'APROBADA' || input.status === 'APROBADA_PARCIAL') {
        const approvals = new Map((input.items ?? []).map((i) => [i.id, toCents(i.approvedAmount)]));
        if (input.status === 'APROBADA_PARCIAL' && approvals.size === 0) throw new BusinessError('Indique el monto aprobado por línea');
        let total = 0;
        for (const it of claim.items) {
          const approved = input.status === 'APROBADA' && !approvals.has(it.id) ? c(it.claimedAmount) : (approvals.get(it.id) ?? 0);
          if (approved > c(it.claimedAmount)) throw new BusinessError(`El aprobado de "${it.description}" supera lo reclamado`);
          total += approved;
          await tx.claimItem.update({ where: { id: it.id }, data: { approvedAmount: dec(approved) } });
        }
        data.approvedAmount = dec(total);
        if (total < c(claim.paidAmount)) throw new BusinessError('El aprobado es menor que lo ya pagado por la aseguradora');
      }
      if (input.status === 'RECHAZADA') {
        if (c(claim.paidAmount) > 0) throw new BusinessError('La reclamación tiene pagos conciliados; no puede marcarse rechazada');
        data.approvedAmount = dec(0);
      }
      await tx.claim.update({ where: { id }, data });
      await tx.claimStatusHistory.create({ data: { claimId: id, fromStatus: claim.status, toStatus: input.status, note: input.note, changedById: user.id } });
      if (input.status === 'APROBADA' || input.status === 'APROBADA_PARCIAL') await this.refreshPaymentStatus(tx, id, user.id);
      await this.audit.log({ action: 'RECLAMACION_ESTADO', entity: 'Claim', entityId: id, branchId: claim.branchId, details: { de: claim.status, a: input.status, referencia: input.externalReference } }, tx);
    });
    return this.get(user, id);
  }

  async addGlosa(user: AuthUser, id: string, input: z.infer<typeof glosaSchema>) {
    const claim = found(await this.prisma.claim.findFirst({ where: { id, organizationId: user.organizationId }, include: { items: true } }), 'Reclamación');
    if (claim.status === 'BORRADOR' || claim.status === 'CERRADA') throw new BusinessError('Solo se registran glosas en reclamaciones sometidas');
    if (input.claimItemId && !claim.items.some((i) => i.id === input.claimItemId)) throw new BadRequestException('La línea no pertenece a la reclamación');
    await this.prisma.$transaction(async (tx) => {
      const g = await tx.claimGlosa.create({ data: { claimId: id, claimItemId: input.claimItemId, code: input.code, reason: input.reason, amount: new Prisma.Decimal(input.amount), createdById: user.id } });
      await this.recomputeGlosas(tx, id, user.id);
      await this.audit.log({ action: 'GLOSA_REGISTRADA', entity: 'ClaimGlosa', entityId: g.id, details: { reclamacion: claim.number, monto: input.amount, motivo: input.reason } }, tx);
    });
    return this.get(user, id);
  }

  async resolveGlosa(user: AuthUser, glosaId: string, status: 'ACEPTADA' | 'EN_DISPUTA' | 'RECUPERADA', resolution: string | null) {
    const g = found(await this.prisma.claimGlosa.findFirst({ where: { id: glosaId, claim: { organizationId: user.organizationId } } }), 'Glosa');
    await this.prisma.$transaction(async (tx) => {
      await tx.claimGlosa.update({ where: { id: glosaId }, data: { status, resolution } });
      await this.recomputeGlosas(tx, g.claimId, user.id);
      await this.audit.log({ action: 'GLOSA_ACTUALIZADA', entity: 'ClaimGlosa', entityId: glosaId, details: { estado: status } }, tx);
    });
    return this.get(user, g.claimId);
  }

  /** Glosas vigentes = todas salvo las recuperadas. */
  private async recomputeGlosas(tx: Tx, claimId: string, userId: string) {
    const agg = await tx.claimGlosa.aggregate({ where: { claimId, status: { not: 'RECUPERADA' } }, _sum: { amount: true } });
    const claim = await tx.claim.findUniqueOrThrow({ where: { id: claimId } });
    if (c(agg._sum.amount) > c(claim.claimedAmount)) throw new BusinessError('Las glosas superan el monto reclamado');
    await tx.claim.update({ where: { id: claimId }, data: { glosaAmount: agg._sum.amount ?? dec(0) } });
    await this.refreshPaymentStatus(tx, claimId, userId);
  }

  /** Recalcula pagado y estado de pago de la reclamación a partir de las conciliaciones. */
  private async refreshPaymentStatus(tx: Tx, claimId: string, userId: string) {
    const claim = await tx.claim.findUniqueOrThrow({ where: { id: claimId } });
    const agg = await tx.insurerPaymentAllocation.aggregate({ where: { claimId, insurerPayment: { reversedAt: null } }, _sum: { amount: true } });
    const paid = c(agg._sum.amount);
    const expected = claimExpected(claim);
    let status = claim.status;
    if (paid > 0 && ['SOMETIDA', 'EN_REVISION', 'APROBADA', 'APROBADA_PARCIAL', 'PAGADA_PARCIAL', 'PAGADA'].includes(status)) {
      status = paid >= expected ? 'PAGADA' : 'PAGADA_PARCIAL';
    }
    await tx.claim.update({ where: { id: claimId }, data: { paidAmount: dec(paid), status } });
    if (status !== claim.status) {
      await tx.claimStatusHistory.create({ data: { claimId, fromStatus: claim.status, toStatus: status, note: 'Actualizado por conciliación de pagos', changedById: userId } });
    }
  }

  // ── Pagos de aseguradoras y conciliación ──

  async registerPayment(user: AuthUser, input: z.infer<typeof insurerPaymentSchema>) {
    const insurer = found(await this.prisma.insurer.findFirst({ where: { id: input.insurerId, organizationId: user.organizationId } }), 'Aseguradora');
    const total = toCents(input.amount);
    const allocTotal = sumCents(input.allocations.map((a) => toCents(a.amount)));
    if (allocTotal > total) throw new BusinessError('Lo conciliado supera el monto recibido');
    const payment = await this.prisma.serializable(async (tx) => {
      const p = await tx.insurerPayment.create({
        data: { organizationId: user.organizationId, insurerId: insurer.id, receivedAt: new Date(input.receivedAt), amount: dec(total), reference: input.reference, notes: input.notes, createdById: user.id },
      });
      for (const a of input.allocations) await this.applyInsurerAllocation(tx, user, p.id, insurer.id, a.claimId, toCents(a.amount));
      await this.audit.log({ action: 'PAGO_ARS_REGISTRADO', entity: 'InsurerPayment', entityId: p.id, details: { aseguradora: insurer.code, monto: input.amount, conciliado: fromCents(allocTotal), referencia: input.reference } }, tx);
      return p;
    });
    return this.getPayment(user, payment.id);
  }

  private async applyInsurerAllocation(tx: Tx, user: AuthUser, paymentId: string, insurerId: string, claimId: string, cents: number) {
    await tx.$queryRaw`SELECT id FROM "Claim" WHERE id = ${claimId}::uuid FOR UPDATE`;
    const claim = await tx.claim.findFirst({ where: { id: claimId, organizationId: user.organizationId } });
    if (!claim) throw new BadRequestException('Reclamación no encontrada');
    if (claim.insurerId !== insurerId) throw new BusinessError(`La reclamación ${claim.number} es de otra aseguradora`);
    if (!PAYABLE.includes(claim.status)) throw new BusinessError(`La reclamación ${claim.number} no admite pagos (estado ${claim.status})`);
    const pending = claimExpected(claim) - c(claim.paidAmount);
    if (cents > pending) throw new BusinessError(`El monto conciliado a ${claim.number} supera su saldo (${fromCents(pending)})`, 'CONCILIACION_EXCEDE');
    await tx.insurerPaymentAllocation.upsert({
      where: { insurerPaymentId_claimId: { insurerPaymentId: paymentId, claimId } },
      create: { insurerPaymentId: paymentId, claimId, amount: dec(cents), createdById: user.id },
      update: { amount: { increment: dec(cents) } },
    });
    await this.refreshPaymentStatus(tx, claimId, user.id);
  }

  async allocatePayment(user: AuthUser, paymentId: string, claimId: string, amount: string) {
    const p = found(await this.prisma.insurerPayment.findFirst({ where: { id: paymentId, organizationId: user.organizationId }, include: { allocations: true } }), 'Pago de aseguradora');
    if (p.reversedAt) throw new BusinessError('El pago fue revertido');
    const available = c(p.amount) - sumCents(p.allocations.map((a) => c(a.amount)));
    if (toCents(amount) > available) throw new BusinessError(`Solo quedan ${fromCents(available)} por conciliar de este pago`);
    await this.prisma.serializable(async (tx) => {
      await this.applyInsurerAllocation(tx, user, paymentId, p.insurerId, claimId, toCents(amount));
      await this.audit.log({ action: 'PAGO_ARS_CONCILIADO', entity: 'InsurerPayment', entityId: paymentId, details: { reclamacion: claimId, monto: amount } }, tx);
    });
    return this.getPayment(user, paymentId);
  }

  async getPayment(user: AuthUser, id: string) {
    const p = found(
      await this.prisma.insurerPayment.findFirst({ where: { id, organizationId: user.organizationId }, include: { insurer: true, allocations: { include: { claim: { select: { id: true, number: true, status: true } } } } } }),
      'Pago de aseguradora',
    );
    const allocated = sumCents(p.allocations.map((a) => c(a.amount)));
    return { ...p, allocated: fromCents(allocated), unallocated: fromCents(c(p.amount) - allocated) };
  }

  async payments(user: AuthUser, insurerId?: string) {
    const list = await this.prisma.insurerPayment.findMany({
      where: { organizationId: user.organizationId, ...(insurerId ? { insurerId } : {}) },
      include: { insurer: { select: { name: true } }, allocations: true },
      orderBy: { receivedAt: 'desc' },
      take: 300,
    });
    return list.map((p) => {
      const allocated = sumCents(p.allocations.map((a) => c(a.amount)));
      return { ...p, allocated: fromCents(allocated), unallocated: fromCents(c(p.amount) - allocated) };
    });
  }

  /** Cuentas por cobrar por aseguradora: reclamaciones abiertas + montos de seguro aún no reclamados. */
  async receivables(user: AuthUser) {
    const [insurers, claims, unclaimed, unallocated] = await Promise.all([
      this.prisma.insurer.findMany({ where: { organizationId: user.organizationId }, select: { id: true, name: true, code: true } }),
      this.prisma.claim.findMany({ where: { organizationId: user.organizationId, status: { notIn: ['CERRADA', 'RECHAZADA'] } } }),
      this.prisma.$queryRaw<{ insurerId: string; amount: string }[]>`
        SELECT ip."insurerId", SUM(ii."insuranceAmount")::text AS amount
        FROM "InvoiceItem" ii
        JOIN "Invoice" i ON i.id = ii."invoiceId"
        JOIN "PatientInsurance" pi ON pi.id = i."patientInsuranceId"
        JOIN "InsurancePlan" ip ON ip.id = pi."planId"
        LEFT JOIN "ClaimItem" ci ON ci."invoiceItemId" = ii.id
        WHERE i."organizationId" = ${user.organizationId}::uuid AND i.status IN ('PENDIENTE','PARCIAL','PAGADA')
          AND ii."insuranceAmount" > 0 AND ci.id IS NULL
        GROUP BY ip."insurerId"`,
      this.prisma.$queryRaw<{ insurerId: string; amount: string }[]>`
        SELECT p."insurerId", (SUM(p.amount) - COALESCE(SUM(a.total), 0))::text AS amount
        FROM "InsurerPayment" p
        LEFT JOIN (SELECT "insurerPaymentId", SUM(amount) AS total FROM "InsurerPaymentAllocation" GROUP BY "insurerPaymentId") a ON a."insurerPaymentId" = p.id
        WHERE p."organizationId" = ${user.organizationId}::uuid AND p."reversedAt" IS NULL
        GROUP BY p."insurerId"`,
    ]);
    return insurers.map((ins) => {
      const own = claims.filter((cl) => cl.insurerId === ins.id);
      const claimedOpen = sumCents(own.map((cl) => Math.max(claimExpected(cl) - c(cl.paidAmount), 0)));
      const glosas = sumCents(own.map((cl) => c(cl.glosaAmount)));
      return {
        insurer: ins,
        openClaims: own.length,
        claimsBalance: fromCents(claimedOpen),
        notYetClaimed: fromCents(c(unclaimed.find((u) => u.insurerId === ins.id)?.amount ?? 0)),
        glosas: fromCents(glosas),
        unallocatedPayments: fromCents(c(unallocated.find((u) => u.insurerId === ins.id)?.amount ?? 0)),
      };
    });
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { InvoiceStatus, Prisma } from '@prisma/client';
import { invoiceCreateSchema, sumCents } from '@medigest/shared';
import { z } from 'zod/v4';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { BusinessError } from '../../common/errors';
import { assertBranch, found } from '../../common/scope';
import { nextNumber } from '../../common/sequence';
import { page, paginate } from '../../common/zod.pipe';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { c, dec } from './money-db';

export const invoiceInclude = {
  patient: { select: { id: true, recordNumber: true, firstName: true, lastName: true, documentType: true, documentNumber: true, address: true, phone: true } },
  items: { include: { claimItem: { select: { id: true, claimId: true } } } },
  allocations: { include: { payment: { select: { id: true, number: true, receivedAt: true, status: true } } }, orderBy: { createdAt: 'asc' } },
  creditNotes: { orderBy: { createdAt: 'asc' } },
  fiscalDocuments: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.InvoiceInclude;

/**
 * Recalcula importes derivados de una factura dentro de la transacción en curso.
 * balance = monto del paciente − pagos aplicados vigentes − notas de crédito emitidas.
 */
export async function recomputeInvoice(tx: Tx, invoiceId: string) {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const [alloc, credits] = await Promise.all([
    tx.paymentAllocation.aggregate({ where: { invoiceId, reversedAt: null, payment: { status: 'COMPLETADO' } }, _sum: { amount: true } }),
    tx.creditNote.aggregate({ where: { invoiceId, status: 'EMITIDA' }, _sum: { amount: true } }),
  ]);
  const paid = c(alloc._sum.amount);
  const credited = c(credits._sum.amount);
  const balance = c(inv.patientAmount) - paid - credited;
  if (balance < 0) throw new BusinessError('La operación dejaría la factura con saldo negativo', 'SALDO_NEGATIVO');
  let status: InvoiceStatus = inv.status;
  if (inv.status !== 'ANULADA' && inv.status !== 'BORRADOR') {
    status = balance === 0 ? 'PAGADA' : paid + credited > 0 ? 'PARCIAL' : 'PENDIENTE';
  }
  return tx.invoice.update({ where: { id: invoiceId }, data: { paidAmount: dec(paid), creditedAmount: dec(credited), balance: dec(balance), status } });
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  async list(user: AuthUser, q: { q?: string; status?: string; patientId?: string; branchId?: string; from?: string; to?: string; overdue?: boolean; page: number; pageSize: number }) {
    if (q.branchId) assertBranch(user, q.branchId);
    const today = new Date(new Date().toISOString().slice(0, 10));
    const where: Prisma.InvoiceWhereInput = {
      organizationId: user.organizationId,
      ...(q.branchId ? { branchId: q.branchId } : user.allBranches ? {} : { branchId: { in: user.branchIds } }),
      ...(q.status ? { status: q.status as InvoiceStatus } : {}),
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.overdue ? { status: { in: ['PENDIENTE', 'PARCIAL'] }, dueDate: { lt: today } } : {}),
      ...(q.from || q.to ? { issuedAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
      ...(q.q
        ? { OR: [{ number: { contains: q.q.toUpperCase() } }, { patient: { OR: [{ lastName: { contains: q.q, mode: 'insensitive' } }, { firstName: { contains: q.q, mode: 'insensitive' } }, { recordNumber: q.q.toUpperCase() }] } }] }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: { patient: { select: { id: true, firstName: true, lastName: true, recordNumber: true } } },
        orderBy: { createdAt: 'desc' },
        ...paginate(q),
      }),
      this.prisma.invoice.count({ where }),
    ]);
    // "Vencida" es derivado: con saldo y fecha de vencimiento pasada.
    return page(items.map((i) => ({ ...i, overdue: !!i.dueDate && i.dueDate < today && ['PENDIENTE', 'PARCIAL'].includes(i.status) })), total, q);
  }

  async get(user: AuthUser, id: string) {
    const inv = found(await this.prisma.invoice.findFirst({ where: { id, organizationId: user.organizationId }, include: invoiceInclude }), 'Factura');
    assertBranch(user, inv.branchId);
    const [branch, org, plan] = await Promise.all([
      this.prisma.branch.findUniqueOrThrow({ where: { id: inv.branchId } }),
      this.prisma.organization.findUniqueOrThrow({ where: { id: inv.organizationId } }),
      inv.patientInsuranceId
        ? this.prisma.patientInsurance.findUnique({ where: { id: inv.patientInsuranceId }, include: { plan: { include: { insurer: true } } } })
        : null,
    ]);
    const today = new Date(new Date().toISOString().slice(0, 10));
    return { ...inv, branch, organization: org, patientInsurance: plan, overdue: !!inv.dueDate && inv.dueDate < today && ['PENDIENTE', 'PARCIAL'].includes(inv.status) };
  }

  /** Factura a partir de cargos pendientes del mismo paciente, sucursal y afiliación. Transacción serializable. */
  async create(user: AuthUser, input: z.infer<typeof invoiceCreateSchema>) {
    assertBranch(user, input.branchId);
    const settings = await this.settings.operational(user.organizationId);
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: user.organizationId } });
    const invoice = await this.prisma.serializable(async (tx) => {
      const charges = await tx.charge.findMany({ where: { id: { in: input.chargeIds }, organizationId: user.organizationId } });
      if (charges.length !== new Set(input.chargeIds).size) throw new BadRequestException('Uno o más cargos no existen');
      if (charges.some((ch) => ch.status !== 'PENDIENTE')) throw new BusinessError('Hay cargos ya facturados o anulados', 'CARGO_NO_PENDIENTE');
      if (charges.some((ch) => ch.patientId !== input.patientId)) throw new BusinessError('Todos los cargos deben ser del mismo paciente');
      if (charges.some((ch) => ch.branchId !== input.branchId)) throw new BusinessError('Todos los cargos deben ser de la misma sucursal');
      const insurances = new Set(charges.map((ch) => ch.patientInsuranceId ?? 'particular'));
      if (insurances.size > 1) throw new BusinessError('No mezcle en una factura cargos particulares y de seguro, ni de distintas afiliaciones');

      const subtotal = sumCents(charges.map((ch) => c(ch.unitPrice) * ch.quantity));
      const discountTotal = sumCents(charges.map((ch) => c(ch.discount)));
      const taxTotal = sumCents(charges.map((ch) => c(ch.taxAmount)));
      const total = sumCents(charges.map((ch) => c(ch.total)));
      const insuranceAmount = sumCents(charges.map((ch) => c(ch.insuranceAmount)));
      const patientAmount = total - insuranceAmount;
      const number = await nextNumber(tx, user.organizationId, 'invoice');
      const issue = input.issue;
      const dueDate = input.dueDate ? new Date(input.dueDate) : new Date(Date.now() + settings.invoiceDueDays * 86400_000);

      const inv = await tx.invoice.create({
        data: {
          organizationId: user.organizationId,
          branchId: input.branchId,
          number,
          patientId: input.patientId,
          patientInsuranceId: charges[0].patientInsuranceId,
          status: issue ? (patientAmount === 0 ? 'PAGADA' : 'PENDIENTE') : 'BORRADOR',
          issuedAt: issue ? new Date() : null,
          dueDate: new Date(dueDate.toISOString().slice(0, 10)),
          currency: org.currency,
          subtotal: dec(subtotal),
          discountTotal: dec(discountTotal),
          taxTotal: dec(taxTotal),
          total: dec(total),
          insuranceAmount: dec(insuranceAmount),
          patientAmount: dec(patientAmount),
          balance: dec(patientAmount),
          notes: input.notes,
          createdById: user.id,
          items: {
            create: charges.map((ch) => ({
              chargeId: ch.id, serviceId: ch.serviceId, description: ch.description, quantity: ch.quantity, unitPrice: ch.unitPrice,
              discount: ch.discount, taxRate: ch.taxRate, taxAmount: ch.taxAmount, total: ch.total, insuranceAmount: ch.insuranceAmount, patientAmount: ch.patientAmount,
            })),
          },
        },
      });
      const upd = await tx.charge.updateMany({ where: { id: { in: input.chargeIds }, status: 'PENDIENTE' }, data: { status: 'FACTURADO' } });
      if (upd.count !== charges.length) throw new BusinessError('Otro usuario facturó estos cargos al mismo tiempo', 'CONCURRENCIA');
      await this.audit.log(
        { action: issue ? 'FACTURA_EMITIDA' : 'FACTURA_BORRADOR', entity: 'Invoice', entityId: inv.id, branchId: input.branchId, details: { numero: number, total: inv.total.toString(), paciente: inv.patientAmount.toString(), seguro: inv.insuranceAmount.toString() } },
        tx,
      );
      return inv;
    });
    return this.get(user, invoice.id);
  }

  async issue(user: AuthUser, id: string) {
    const inv = found(await this.prisma.invoice.findFirst({ where: { id, organizationId: user.organizationId } }), 'Factura');
    if (inv.status !== 'BORRADOR') throw new BusinessError('Solo se pueden emitir facturas en borrador');
    await this.prisma.$transaction(async (tx) => {
      await tx.invoice.update({ where: { id }, data: { status: 'PENDIENTE', issuedAt: new Date() } });
      await recomputeInvoice(tx, id);
      await this.audit.log({ action: 'FACTURA_EMITIDA', entity: 'Invoice', entityId: id, details: { numero: inv.number } }, tx);
    });
    return this.get(user, id);
  }

  /**
   * Anulación. No se borra: pasa a ANULADA con motivo. Requiere que no tenga pagos aplicados vigentes,
   * ni reclamaciones sometidas, ni comprobante fiscal emitido (en ese caso corresponde nota de crédito).
   */
  async void(user: AuthUser, id: string, reason: string) {
    const inv = found(await this.prisma.invoice.findFirst({ where: { id, organizationId: user.organizationId }, include: invoiceInclude }), 'Factura');
    assertBranch(user, inv.branchId);
    if (inv.status === 'ANULADA') throw new BusinessError('La factura ya está anulada');
    if (inv.allocations.some((a) => !a.reversedAt && a.payment.status === 'COMPLETADO')) {
      throw new BusinessError('La factura tiene pagos aplicados. Revierta o desaplique los pagos antes de anular.', 'TIENE_PAGOS');
    }
    if (inv.items.some((i) => i.claimItem)) throw new BusinessError('La factura está incluida en una reclamación a la aseguradora', 'EN_RECLAMACION');
    if (inv.fiscalDocuments.some((f) => ['EMITIDO', 'ENVIADO', 'ACEPTADO'].includes(f.status))) {
      throw new BusinessError('La factura tiene comprobante fiscal emitido. Emita una nota de crédito en lugar de anular.', 'TIENE_NCF');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.invoice.update({ where: { id }, data: { status: 'ANULADA', voidedAt: new Date(), voidReason: reason, voidedById: user.id, balance: dec(0) } });
      await tx.charge.updateMany({ where: { id: { in: inv.items.map((i) => i.chargeId).filter((x): x is string => !!x) } }, data: { status: 'ANULADO', voidReason: `Factura ${inv.number} anulada` } });
      await this.audit.log({ action: 'FACTURA_ANULADA', entity: 'Invoice', entityId: id, branchId: inv.branchId, details: { numero: inv.number, motivo: reason, total: inv.total.toString() } }, tx);
    });
    return this.get(user, id);
  }

  async creditNote(user: AuthUser, id: string, amount: string, reason: string) {
    const inv = found(await this.prisma.invoice.findFirst({ where: { id, organizationId: user.organizationId } }), 'Factura');
    assertBranch(user, inv.branchId);
    if (!['PENDIENTE', 'PARCIAL'].includes(inv.status)) throw new BusinessError('Solo se emiten notas de crédito sobre facturas con saldo pendiente');
    await this.prisma.serializable(async (tx) => {
      const number = await nextNumber(tx, user.organizationId, 'creditNote');
      const note = await tx.creditNote.create({ data: { organizationId: user.organizationId, number, invoiceId: id, amount: new Prisma.Decimal(amount), reason, createdById: user.id } });
      await recomputeInvoice(tx, id);
      await this.audit.log({ action: 'NOTA_CREDITO_EMITIDA', entity: 'CreditNote', entityId: note.id, branchId: inv.branchId, details: { factura: inv.number, numero: number, monto: amount, motivo: reason } }, tx);
    });
    return this.get(user, id);
  }
}

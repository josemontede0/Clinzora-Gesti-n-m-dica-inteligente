import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PaymentMethodKind, Prisma } from '@prisma/client';
import { fromCents, paymentCreateSchema, sumCents, toCents } from '@medigest/shared';
import { z } from 'zod/v4';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { BusinessError } from '../../common/errors';
import { assertBranch, found } from '../../common/scope';
import { nextNumber } from '../../common/sequence';
import { page, paginate } from '../../common/zod.pipe';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { CardTerminal } from './card-terminal';
import { recomputeInvoice } from './invoices.service';
import { c, dec } from './money-db';

const CARD_KINDS: PaymentMethodKind[] = ['TARJETA_CREDITO', 'TARJETA_DEBITO'];

export const paymentInclude = {
  patient: { select: { id: true, recordNumber: true, firstName: true, lastName: true } },
  tenders: { include: { method: true, transaction: true } },
  allocations: { include: { invoice: { select: { id: true, number: true } } }, orderBy: { createdAt: 'asc' } },
  refunds: true,
} satisfies Prisma.PaymentInclude;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly terminal: CardTerminal,
  ) {}

  /** Sesión de caja abierta del usuario en la sucursal (obligatoria para cobrar). */
  private async openSession(tx: Tx | PrismaService, user: AuthUser, branchId: string) {
    const session = await tx.cashSession.findFirst({ where: { organizationId: user.organizationId, branchId, openedById: user.id, status: 'ABIERTA' } });
    if (!session) throw new BusinessError('Debe abrir una caja en esta sucursal antes de registrar cobros', 'CAJA_CERRADA');
    return session;
  }

  /** Monto del pago aún no aplicado ni reembolsado (anticipo disponible). */
  async unapplied(tx: Tx | PrismaService, paymentId: string) {
    const [p, alloc, refunds] = await Promise.all([
      tx.payment.findUniqueOrThrow({ where: { id: paymentId } }),
      tx.paymentAllocation.aggregate({ where: { paymentId, reversedAt: null }, _sum: { amount: true } }),
      tx.refund.aggregate({ where: { paymentId, status: 'COMPLETADO' }, _sum: { amount: true } }),
    ]);
    return c(p.amount) - c(alloc._sum.amount) - c(refunds._sum.amount);
  }

  async list(user: AuthUser, q: { patientId?: string; branchId?: string; from?: string; to?: string; cashSessionId?: string; page: number; pageSize: number }) {
    if (q.branchId) assertBranch(user, q.branchId);
    const where: Prisma.PaymentWhereInput = {
      organizationId: user.organizationId,
      ...(q.branchId ? { branchId: q.branchId } : user.allBranches ? {} : { branchId: { in: user.branchIds } }),
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.cashSessionId ? { cashSessionId: q.cashSessionId } : {}),
      ...(q.from || q.to ? { receivedAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({ where, include: paymentInclude, orderBy: { receivedAt: 'desc' }, ...paginate(q) }),
      this.prisma.payment.count({ where }),
    ]);
    return page(items, total, q);
  }

  async get(user: AuthUser, id: string) {
    const p = found(await this.prisma.payment.findFirst({ where: { id, organizationId: user.organizationId }, include: paymentInclude }), 'Pago');
    assertBranch(user, p.branchId);
    return { ...p, unapplied: fromCents(await this.unapplied(this.prisma, id)) };
  }

  /**
   * Registra un cobro (uno o varios medios) y lo aplica a facturas.
   *  - La suma de los medios es el total del recibo.
   *  - Lo aplicado no puede superar el total ni el saldo de cada factura; el resto queda como anticipo.
   *  - Las tarjetas se procesan antes de la transacción; si alguna es declinada, no se registra nada.
   *  - Idempotente por idempotencyKey.
   */
  async create(user: AuthUser, input: z.infer<typeof paymentCreateSchema>) {
    const existing = await this.prisma.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      if (existing.organizationId !== user.organizationId) throw new ForbiddenException('Clave de idempotencia inválida');
      return this.get(user, existing.id);
    }
    assertBranch(user, input.branchId);
    found(await this.prisma.patient.findFirst({ where: { id: input.patientId, organizationId: user.organizationId } }), 'Paciente');
    const session = await this.openSession(this.prisma, user, input.branchId);
    const methods = await this.prisma.paymentMethod.findMany({ where: { organizationId: user.organizationId, id: { in: input.tenders.map((t) => t.methodId) }, active: true } });
    const tenders = input.tenders.map((t, index) => {
      const method = methods.find((m) => m.id === t.methodId);
      if (!method) throw new BadRequestException('Método de pago inválido o inactivo');
      if (method.requiresReference && !t.reference && !CARD_KINDS.includes(method.kind)) throw new BusinessError(`${method.name} requiere número de referencia`);
      return { ...t, index, method, cents: toCents(t.amount) };
    });
    const total = sumCents(tenders.map((t) => t.cents));
    const allocTotal = sumCents(input.allocations.map((a) => toCents(a.amount)));
    if (allocTotal > total) throw new BusinessError('El monto aplicado a facturas supera el total cobrado', 'APLICACION_EXCEDE');
    const invoiceIds = input.allocations.map((a) => a.invoiceId);
    if (new Set(invoiceIds).size !== invoiceIds.length) throw new BusinessError('Una factura aparece más de una vez');

    // 1) Procesar tarjetas (fuera de la transacción: puede tardar). Cada intento queda registrado.
    const cardTx = new Map<number, string>();
    for (const t of tenders.filter((x) => CARD_KINDS.includes(x.method.kind))) {
      const key = `${input.idempotencyKey}:${t.index}`;
      let txRow = await this.prisma.paymentTransaction.findUnique({ where: { idempotencyKey: key } });
      if (!txRow || txRow.status !== 'APROBADA') {
        const result = await this.terminal.charge({ idempotencyKey: key, amountCents: t.cents, currency: 'DOP', cardLast4: t.cardLast4, cardBrand: t.cardBrand, reference: t.reference });
        const data = {
          provider: result.provider, testMode: result.testMode, externalId: result.externalId, amount: dec(t.cents),
          status: result.approved ? ('APROBADA' as const) : ('DECLINADA' as const), authCode: result.authCode, cardLast4: t.cardLast4, cardBrand: t.cardBrand,
          responseCode: result.responseCode, responseMessage: result.responseMessage,
        };
        txRow = txRow
          ? await this.prisma.paymentTransaction.update({ where: { id: txRow.id }, data })
          : await this.prisma.paymentTransaction.create({ data: { ...data, organizationId: user.organizationId, idempotencyKey: key, createdById: user.id } });
        await this.audit.log({ action: result.approved ? 'TARJETA_APROBADA' : 'TARJETA_DECLINADA', entity: 'PaymentTransaction', entityId: txRow.id, details: { proveedor: result.provider, prueba: result.testMode, monto: fromCents(t.cents), codigo: result.responseCode } });
      }
      if (txRow.status !== 'APROBADA') throw new BusinessError(`Pago con tarjeta no aprobado: ${txRow.responseMessage ?? 'declinado'}`, 'TARJETA_DECLINADA');
      cardTx.set(t.index, txRow.id);
    }

    // 2) Registrar el pago, sus medios, movimientos de caja y aplicaciones en una sola transacción.
    const payment = await this.prisma.serializable(async (tx) => {
      const number = await nextNumber(tx, user.organizationId, 'payment');
      const p = await tx.payment.create({
        data: {
          organizationId: user.organizationId, branchId: input.branchId, number, patientId: input.patientId, cashSessionId: session.id,
          amount: dec(total), notes: input.notes, idempotencyKey: input.idempotencyKey, createdById: user.id,
          tenders: {
            create: tenders.map((t) => ({
              methodId: t.methodId, amount: dec(t.cents), reference: t.reference, cardLast4: t.cardLast4, cardBrand: t.cardBrand,
              transactionId: cardTx.get(t.index) ?? null,
            })),
          },
        },
      });
      await tx.cashMovement.createMany({
        data: tenders.map((t) => ({ sessionId: session.id, type: 'COBRO' as const, methodKind: t.method.kind, amount: dec(t.cents), paymentId: p.id, description: `Recibo ${number}`, createdById: user.id })),
      });
      for (const a of input.allocations) await this.applyAllocation(tx, user, p.id, input.patientId, a.invoiceId, toCents(a.amount));
      await this.audit.log(
        { action: 'PAGO_REGISTRADO', entity: 'Payment', entityId: p.id, branchId: input.branchId, details: { recibo: number, total: fromCents(total), medios: tenders.map((t) => ({ metodo: t.method.code, monto: fromCents(t.cents) })), aplicado: fromCents(allocTotal) } },
        tx,
      );
      return p;
    });
    return this.get(user, payment.id);
  }

  private async applyAllocation(tx: Tx, user: AuthUser, paymentId: string, patientId: string, invoiceId: string, cents: number) {
    // Bloquea la fila de la factura para que dos aplicaciones simultáneas no excedan el saldo.
    await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId}::uuid FOR UPDATE`;
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId: user.organizationId } });
    if (!inv) throw new BadRequestException('Factura no encontrada');
    if (inv.patientId !== patientId) throw new BusinessError(`La factura ${inv.number} es de otro paciente`);
    if (!['PENDIENTE', 'PARCIAL'].includes(inv.status)) throw new BusinessError(`La factura ${inv.number} no admite pagos (estado ${inv.status})`);
    if (cents > c(inv.balance)) throw new BusinessError(`El monto aplicado a ${inv.number} supera su saldo (${inv.balance.toString()})`, 'APLICACION_EXCEDE');
    await tx.paymentAllocation.create({ data: { paymentId, invoiceId, amount: dec(cents), createdById: user.id } });
    await recomputeInvoice(tx, invoiceId);
  }

  /** Aplica un anticipo (parte no aplicada de un pago) a una factura. */
  async allocate(user: AuthUser, paymentId: string, invoiceId: string, amount: string) {
    const p = found(await this.prisma.payment.findFirst({ where: { id: paymentId, organizationId: user.organizationId } }), 'Pago');
    assertBranch(user, p.branchId);
    if (p.status !== 'COMPLETADO') throw new BusinessError('El pago no está vigente');
    await this.prisma.serializable(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${paymentId}::uuid FOR UPDATE`;
      const available = await this.unapplied(tx, paymentId);
      const cents = toCents(amount);
      if (cents > available) throw new BusinessError(`El pago solo tiene ${fromCents(available)} disponible para aplicar`, 'APLICACION_EXCEDE');
      await this.applyAllocation(tx, user, paymentId, p.patientId, invoiceId, cents);
      await this.audit.log({ action: 'PAGO_APLICADO', entity: 'Payment', entityId: paymentId, details: { factura: invoiceId, monto: amount } }, tx);
    });
    return this.get(user, paymentId);
  }

  /**
   * Reverso de un pago registrado por error: no se borra; queda REVERTIDO, se revierten sus aplicaciones
   * y se registra la salida en la caja abierta del usuario.
   */
  async reverse(user: AuthUser, paymentId: string, reason: string) {
    const p = found(await this.prisma.payment.findFirst({ where: { id: paymentId, organizationId: user.organizationId }, include: { tenders: { include: { method: true } }, allocations: true, refunds: true } }), 'Pago');
    assertBranch(user, p.branchId);
    if (p.status !== 'COMPLETADO') throw new BusinessError('El pago ya fue revertido');
    if (p.refunds.some((r) => r.status === 'COMPLETADO')) throw new BusinessError('El pago tiene reembolsos; no puede revertirse completo');
    const session = await this.openSession(this.prisma, user, p.branchId);
    await this.prisma.serializable(async (tx) => {
      const r = await tx.payment.updateMany({ where: { id: paymentId, status: 'COMPLETADO' }, data: { status: 'REVERTIDO', reversedAt: new Date(), reverseReason: reason, reversedById: user.id } });
      if (!r.count) throw new BusinessError('El pago ya fue revertido');
      await tx.paymentAllocation.updateMany({ where: { paymentId, reversedAt: null }, data: { reversedAt: new Date() } });
      for (const invoiceId of new Set(p.allocations.map((a) => a.invoiceId))) await recomputeInvoice(tx, invoiceId);
      await tx.cashMovement.createMany({
        data: p.tenders.map((t) => ({ sessionId: session.id, type: 'REVERSO' as const, methodKind: t.method.kind, amount: dec(-c(t.amount)), paymentId, description: `Reverso recibo ${p.number}`, createdById: user.id })),
      });
      for (const t of p.tenders.filter((x) => x.transactionId)) {
        await tx.paymentTransaction.update({ where: { id: t.transactionId! }, data: { status: 'REVERSADA' } });
      }
      await this.audit.log({ action: 'PAGO_REVERTIDO', entity: 'Payment', entityId: paymentId, branchId: p.branchId, details: { recibo: p.number, monto: p.amount.toString(), motivo: reason } }, tx);
    });
    return this.get(user, paymentId);
  }

  /** Reembolso del saldo no aplicado (anticipo) de un pago. */
  async refund(user: AuthUser, paymentId: string, input: { amount: string; methodId: string; reason: string; idempotencyKey: string }) {
    const dup = await this.prisma.refund.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (dup) return this.get(user, dup.paymentId);
    const p = found(await this.prisma.payment.findFirst({ where: { id: paymentId, organizationId: user.organizationId } }), 'Pago');
    assertBranch(user, p.branchId);
    if (p.status !== 'COMPLETADO') throw new BusinessError('El pago no está vigente');
    const method = found(await this.prisma.paymentMethod.findFirst({ where: { id: input.methodId, organizationId: user.organizationId } }), 'Método de pago');
    const session = await this.openSession(this.prisma, user, p.branchId);
    await this.prisma.serializable(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${paymentId}::uuid FOR UPDATE`;
      const available = await this.unapplied(tx, paymentId);
      const cents = toCents(input.amount);
      if (cents > available) throw new BusinessError(`Solo hay ${fromCents(available)} sin aplicar para reembolsar. Para devolver un monto ya aplicado use la devolución desde la factura.`, 'REEMBOLSO_EXCEDE');
      const refund = await tx.refund.create({
        data: { organizationId: user.organizationId, paymentId, methodId: method.id, cashSessionId: session.id, amount: dec(cents), reason: input.reason, idempotencyKey: input.idempotencyKey, approvedById: user.id, createdById: user.id },
      });
      await tx.cashMovement.create({ data: { sessionId: session.id, type: 'REEMBOLSO', methodKind: method.kind, amount: dec(-cents), paymentId, refundId: refund.id, description: `Reembolso recibo ${p.number}`, createdById: user.id } });
      await this.audit.log({ action: 'REEMBOLSO', entity: 'Refund', entityId: refund.id, branchId: p.branchId, details: { recibo: p.number, monto: input.amount, motivo: input.reason } }, tx);
    });
    return this.get(user, paymentId);
  }

  /**
   * Devolución de un monto ya cobrado de una factura: en una transacción reduce la aplicación del pago,
   * emite nota de crédito por el mismo monto y registra el reembolso. El saldo de la factura no cambia
   * (pagado − X, acreditado + X) y la caja refleja la salida.
   */
  async refundInvoice(user: AuthUser, invoiceId: string, input: { paymentId: string; amount: string; methodId: string; reason: string; idempotencyKey: string }) {
    const dup = await this.prisma.refund.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (dup) return { ok: true, refundId: dup.id };
    const inv = found(await this.prisma.invoice.findFirst({ where: { id: invoiceId, organizationId: user.organizationId } }), 'Factura');
    assertBranch(user, inv.branchId);
    const method = found(await this.prisma.paymentMethod.findFirst({ where: { id: input.methodId, organizationId: user.organizationId } }), 'Método de pago');
    const session = await this.openSession(this.prisma, user, inv.branchId);
    const cents = toCents(input.amount);
    const refundId = await this.prisma.serializable(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId}::uuid FOR UPDATE`;
      const allocs = await tx.paymentAllocation.findMany({ where: { invoiceId, paymentId: input.paymentId, reversedAt: null, payment: { status: 'COMPLETADO' } } });
      const allocated = sumCents(allocs.map((a) => c(a.amount)));
      if (cents > allocated) throw new BusinessError(`Ese pago solo tiene ${fromCents(allocated)} aplicado a la factura`, 'REEMBOLSO_EXCEDE');
      const now = new Date();
      await tx.paymentAllocation.updateMany({ where: { id: { in: allocs.map((a) => a.id) } }, data: { reversedAt: now } });
      if (allocated - cents > 0) await tx.paymentAllocation.create({ data: { paymentId: input.paymentId, invoiceId, amount: dec(allocated - cents), createdById: user.id } });
      const number = await nextNumber(tx, user.organizationId, 'creditNote');
      const note = await tx.creditNote.create({ data: { organizationId: user.organizationId, number, invoiceId, amount: dec(cents), reason: `Devolución: ${input.reason}`, createdById: user.id } });
      const refund = await tx.refund.create({
        data: { organizationId: user.organizationId, paymentId: input.paymentId, invoiceId, methodId: method.id, cashSessionId: session.id, amount: dec(cents), reason: input.reason, idempotencyKey: input.idempotencyKey, approvedById: user.id, createdById: user.id },
      });
      await tx.cashMovement.create({ data: { sessionId: session.id, type: 'REEMBOLSO', methodKind: method.kind, amount: dec(-cents), paymentId: input.paymentId, refundId: refund.id, description: `Devolución factura ${inv.number}`, createdById: user.id } });
      await recomputeInvoice(tx, invoiceId);
      await this.audit.log({ action: 'DEVOLUCION_FACTURA', entity: 'Invoice', entityId: invoiceId, branchId: inv.branchId, details: { factura: inv.number, notaCredito: number, monto: input.amount, motivo: input.reason, notaId: note.id } }, tx);
      return refund.id;
    });
    return { ok: true, refundId };
  }

  /** Pagos con saldo sin aplicar del paciente (anticipos). */
  async patientCredits(user: AuthUser, patientId: string) {
    const payments = await this.prisma.payment.findMany({ where: { organizationId: user.organizationId, patientId, status: 'COMPLETADO' }, orderBy: { receivedAt: 'asc' } });
    const out = [];
    for (const p of payments) {
      const available = await this.unapplied(this.prisma, p.id);
      if (available > 0) out.push({ id: p.id, number: p.number, receivedAt: p.receivedAt, amount: p.amount, available: fromCents(available) });
    }
    return out;
  }
}

import { Injectable } from '@nestjs/common';
import { fiscalIssueSchema, fiscalSequenceSchema } from '@medigest/shared';
import { z } from 'zod/v4';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { BusinessError } from '../../common/errors';
import { found } from '../../common/scope';
import { PrismaService } from '../../prisma/prisma.service';

/** Tipos que requieren RNC del comprador (crédito fiscal y gubernamental). */
const REQUIRES_RNC = ['B01', 'B15', 'E31', 'E45'];

/**
 * Comprobantes fiscales (DGII). El sistema NO genera números propios: consume los rangos autorizados que
 * el usuario registra. Los e-CF (serie E) quedan PENDIENTES de envío hasta integrar un proveedor certificado
 * o completar la certificación propia; nunca se marcan como aceptados sin respuesta real.
 */
@Injectable()
export class FiscalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  sequences(user: AuthUser) {
    return this.prisma.fiscalSequence.findMany({ where: { organizationId: user.organizationId }, orderBy: [{ active: 'desc' }, { type: 'asc' }] });
  }

  async addSequence(user: AuthUser, input: z.infer<typeof fiscalSequenceSchema>) {
    const overlap = await this.prisma.fiscalSequence.findFirst({
      where: { organizationId: user.organizationId, prefix: input.prefix, rangeFrom: { lte: input.rangeTo }, rangeTo: { gte: input.rangeFrom } },
    });
    if (overlap) throw new BusinessError('El rango se solapa con uno ya registrado');
    const s = await this.prisma.fiscalSequence.create({
      data: { ...input, validUntil: input.validUntil ? new Date(input.validUntil) : null, nextNumber: input.rangeFrom, organizationId: user.organizationId },
    });
    await this.audit.log({ action: 'RANGO_NCF_REGISTRADO', entity: 'FiscalSequence', entityId: s.id, details: { tipo: input.type, desde: input.rangeFrom, hasta: input.rangeTo } });
    return s;
  }

  async deactivateSequence(user: AuthUser, id: string) {
    found(await this.prisma.fiscalSequence.findFirst({ where: { id, organizationId: user.organizationId } }), 'Rango');
    await this.prisma.fiscalSequence.update({ where: { id }, data: { active: false } });
    await this.audit.log({ action: 'RANGO_NCF_DESACTIVADO', entity: 'FiscalSequence', entityId: id });
    return { ok: true };
  }

  async issueForInvoice(user: AuthUser, invoiceId: string, input: z.infer<typeof fiscalIssueSchema>) {
    const inv = found(await this.prisma.invoice.findFirst({ where: { id: invoiceId, organizationId: user.organizationId }, include: { fiscalDocuments: true, patient: true } }), 'Factura');
    if (['BORRADOR', 'ANULADA'].includes(inv.status)) throw new BusinessError('Solo se emiten comprobantes de facturas emitidas');
    if (inv.fiscalDocuments.some((f) => f.status !== 'ANULADO' && f.status !== 'RECHAZADO')) throw new BusinessError('La factura ya tiene un comprobante fiscal');
    if (REQUIRES_RNC.includes(input.type) && !input.buyerRnc) throw new BusinessError('Este tipo de comprobante requiere el RNC o cédula del comprador');
    const isElectronic = input.type.startsWith('E');

    return this.prisma.$transaction(async (tx) => {
      // Toma el siguiente número del rango activo de forma atómica.
      const rows = await tx.$queryRaw<{ id: string; prefix: string; value: number }[]>`
        UPDATE "FiscalSequence" SET "nextNumber" = "nextNumber" + 1
        WHERE id = (
          SELECT id FROM "FiscalSequence"
          WHERE "organizationId" = ${user.organizationId}::uuid AND type = ${input.type} AND active = true
            AND "nextNumber" <= "rangeTo" AND ("validUntil" IS NULL OR "validUntil" >= CURRENT_DATE)
          ORDER BY "rangeFrom" LIMIT 1 FOR UPDATE
        )
        RETURNING id, prefix, "nextNumber" - 1 AS value`;
      if (!rows.length) throw new BusinessError(`No hay un rango de comprobantes ${input.type} vigente y con números disponibles. Regístrelo en Configuración > Fiscal.`, 'SIN_RANGO_NCF');
      const ncf = `${rows[0].prefix}${String(rows[0].value).padStart(isElectronic ? 10 : 8, '0')}`;
      const doc = await tx.fiscalDocument.create({
        data: {
          organizationId: user.organizationId,
          invoiceId,
          type: input.type,
          ncf,
          status: isElectronic ? 'PENDIENTE' : 'EMITIDO',
          buyerRnc: input.buyerRnc,
          buyerName: input.buyerName ?? `${inv.patient.firstName} ${inv.patient.lastName}`,
          amount: inv.total,
          taxAmount: inv.taxTotal,
          provider: 'MANUAL',
          providerMessage: isElectronic ? 'e-CF pendiente de envío: no hay proveedor de facturación electrónica configurado' : null,
          issuedAt: new Date(),
          createdById: user.id,
        },
      });
      await this.audit.log({ action: 'COMPROBANTE_FISCAL_ASIGNADO', entity: 'FiscalDocument', entityId: doc.id, details: { factura: inv.number, ncf, tipo: input.type } }, tx);
      return doc;
    });
  }

  /** Exportación para conciliación contable / formato 607 (ventas). Revise el formato vigente de la DGII antes de remitir. */
  async salesReport(user: AuthUser, from: Date, to: Date) {
    return this.prisma.fiscalDocument.findMany({
      where: { organizationId: user.organizationId, issuedAt: { gte: from, lte: to } },
      include: { invoice: { select: { number: true, total: true, taxTotal: true, issuedAt: true } } },
      orderBy: { issuedAt: 'asc' },
    });
  }
}

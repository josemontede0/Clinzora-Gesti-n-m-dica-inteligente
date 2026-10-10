import { ForbiddenException, Injectable } from '@nestjs/common';
import { formatCedula, formatDate, formatMoney, formatTime, fromCents, PAYMENT_METHOD_KIND_LABEL, sumCents } from '@medigest/shared';
import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { assertBranch, found } from '../../common/scope';
import { PrismaService } from '../../prisma/prisma.service';
import { BRAND_LOGO } from '../reports/exporters';
import { c } from './money-db';
import { montoEnLetras } from './number-words';

export type ReceiptFormat = 'ticket' | 'carta';

/** Recibo de caja en PDF (ticket térmico de 80 mm o carta). Cada impresión queda en la auditoría. */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async load(user: AuthUser, paymentId: string) {
    const p = found(
      await this.prisma.payment.findFirst({
        where: { id: paymentId, organizationId: user.organizationId },
        include: {
          patient: { select: { recordNumber: true, firstName: true, lastName: true, documentNumber: true, documentType: true } },
          tenders: { include: { method: true, transaction: { select: { authCode: true, testMode: true } } } },
          allocations: { include: { invoice: { select: { number: true, balance: true, patientAmount: true } } }, orderBy: { createdAt: 'asc' } },
          refunds: { where: { status: 'COMPLETADO' } },
          cashSession: { select: { register: { select: { name: true } } } },
        },
      }),
      'Recibo',
    );
    assertBranch(user, p.branchId);
    // Un cajero sin permisos de supervisión solo reimprime recibos de su sucursal (ya validado) — y cualquier recibo
    // de su organización si tiene billing.read. Sin ninguno de los dos permisos no hay acceso.
    if (!user.permissions.has('billing.read') && !user.permissions.has('payments.write')) throw new ForbiddenException('Sin acceso a recibos');
    const [org, branch, cashier, prints] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: p.organizationId } }),
      this.prisma.branch.findUniqueOrThrow({ where: { id: p.branchId } }),
      this.prisma.user.findUnique({ where: { id: p.createdById }, select: { fullName: true } }),
      this.prisma.auditLog.count({ where: { entity: 'Payment', entityId: p.id, action: 'RECIBO_IMPRESO' } }),
    ]);
    return { p, org, branch, cashier, prints };
  }

  /** Historial de impresiones de un recibo (quién y cuándo). */
  async prints(user: AuthUser, paymentId: string) {
    found(await this.prisma.payment.findFirst({ where: { id: paymentId, organizationId: user.organizationId }, select: { id: true } }), 'Recibo');
    return this.prisma.auditLog.findMany({
      where: { entity: 'Payment', entityId: paymentId, action: 'RECIBO_IMPRESO' },
      select: { createdAt: true, userEmail: true, details: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async pdf(user: AuthUser, paymentId: string, format: ReceiptFormat, purpose: 'imprimir' | 'descargar'): Promise<{ buffer: Buffer; filename: string; reprint: boolean }> {
    const { p, org, branch, cashier, prints } = await this.load(user, paymentId);
    const reprint = prints > 0;
    const tz = branch.timezone ?? org.timezone;
    const cur = org.currency;
    const applied = sumCents(p.allocations.filter((a) => !a.reversedAt).map((a) => c(a.amount)));
    const refunded = sumCents(p.refunds.map((r) => c(r.amount)));
    const credit = p.status === 'COMPLETADO' ? c(p.amount) - applied - refunded : 0;

    const ticket = format === 'ticket';
    // 80 mm = 226.77 pt. El ticket se dibuja dos veces: la primera solo mide el alto real del contenido.
    const width = ticket ? 226.77 : 612;
    const margin = ticket ? 12 : 48;
    const info = { Title: `Recibo ${p.number}`, Author: org.name, Creator: 'Clinzora' };
    const draw = (doc: PDFKit.PDFDocument) => {
      const inner = width - margin * 2;
      const fs = (n: number) => (ticket ? n * 0.82 : n);
      const line = () => {
        doc.moveDown(0.3);
        doc.moveTo(margin, doc.y).lineTo(width - margin, doc.y).dash(2, { space: 2 }).strokeColor('#94a3b8').lineWidth(0.5).stroke().undash();
        doc.moveDown(0.4);
      };
      const row = (label: string, value: string, bold = false) => {
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs(9.5)).fillColor('#0f172a');
        doc.text(label, margin, y, { width: inner * 0.58 });
        const yAfterLabel = doc.y;
        doc.text(value, margin + inner * 0.6, y, { width: inner * 0.4, align: 'right' });
        doc.y = Math.max(yAfterLabel, doc.y);
        doc.x = margin; // vuelve al margen izquierdo para el siguiente bloque
      };

      // Encabezado
      if (existsSync(BRAND_LOGO) && !ticket) doc.image(BRAND_LOGO, width - margin - 120, margin - 6, { width: 120 });
      doc.font('Helvetica-Bold').fontSize(fs(13)).fillColor('#0B2E4F').text(org.legalName ?? org.name, margin, ticket ? margin : margin, { width: ticket ? inner : inner - 130, align: ticket ? 'center' : 'left' });
      doc.font('Helvetica').fontSize(fs(8.5)).fillColor('#334155');
      const head = [org.rnc ? `RNC ${org.rnc}` : null, branch.name, branch.address, branch.phone ?? org.phone].filter(Boolean).join(' · ');
      doc.text(head, { width: ticket ? inner : inner - 130, align: ticket ? 'center' : 'left' });
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(fs(12)).fillColor('#0f172a').text('RECIBO DE CAJA', { width: inner, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(fs(11)).text(p.number, { width: inner, align: 'center' });
      if (reprint) doc.font('Helvetica-Bold').fontSize(fs(9)).fillColor('#b45309').text(`REIMPRESIÓN (copia ${prints + 1})`, { width: inner, align: 'center' });
      if (p.status === 'REVERTIDO') doc.font('Helvetica-Bold').fontSize(fs(11)).fillColor('#b91c1c').text('REVERTIDO — SIN VALOR', { width: inner, align: 'center' });
      doc.fillColor('#0f172a');
      line();

      row('Fecha', `${formatDate(p.receivedAt, tz)} ${formatTime(p.receivedAt, tz)}`);
      row('Paciente', `${p.patient.firstName} ${p.patient.lastName}`);
      row('Expediente', p.patient.recordNumber);
      if (p.patient.documentNumber) row('Documento', formatCedula(p.patient.documentNumber));
      row('Cajero', cashier?.fullName ?? '—');
      if (p.cashSession?.register) row('Caja', p.cashSession.register.name);
      line();

      doc.font('Helvetica-Bold').fontSize(fs(9.5)).text('Medios de pago');
      doc.moveDown(0.2);
      for (const t of p.tenders) {
        const detail = [t.cardBrand, t.cardLast4 ? `****${t.cardLast4}` : null, t.reference ? `Ref. ${t.reference}` : t.transaction?.authCode ? `Aut. ${t.transaction.authCode}` : null, t.transaction?.testMode ? 'PRUEBA' : null].filter(Boolean).join(' ');
        row(`${t.method.name || PAYMENT_METHOD_KIND_LABEL[t.method.kind]}${detail ? ` (${detail})` : ''}`, formatMoney(t.amount.toString(), cur));
      }
      doc.moveDown(0.2);
      row('TOTAL RECIBIDO', formatMoney(p.amount.toString(), cur), true);
      doc.font('Helvetica-Oblique').fontSize(fs(8)).fillColor('#334155').text(`Son: ${montoEnLetras(c(p.amount), cur)}`, margin, doc.y + 2, { width: inner });
      doc.fillColor('#0f172a');

      if (p.allocations.length) {
        line();
        doc.font('Helvetica-Bold').fontSize(fs(9.5)).text('Aplicado a facturas');
        doc.moveDown(0.2);
        for (const a of p.allocations) {
          row(`${a.invoice.number}${a.reversedAt ? ' (revertido)' : ''}`, formatMoney(a.amount.toString(), cur));
          doc.font('Helvetica').fontSize(fs(8)).fillColor('#475569').text(`Saldo actual de la factura: ${formatMoney(a.invoice.balance.toString(), cur)}`, margin, doc.y, { width: inner });
          doc.fillColor('#0f172a');
        }
      }
      if (refunded > 0) row('Reembolsado', `- ${formatMoney(fromCents(refunded), cur)}`);
      if (credit > 0) row('Anticipo a favor del paciente', formatMoney(fromCents(credit), cur), true);
      if (p.notes) {
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(fs(8.5)).text(`Nota: ${p.notes}`, { width: inner });
      }
      line();
      doc.font('Helvetica').fontSize(fs(7.5)).fillColor('#475569');
      doc.text('Este recibo no es un comprobante fiscal (NCF).', { width: inner, align: 'center' });
      doc.text(`Impreso ${formatDate(new Date(), tz)} ${formatTime(new Date(), tz)} por ${user.fullName}`, { width: inner, align: 'center' });
      doc.text('Clinzora · un producto de KonviaRD', { width: inner, align: 'center' });
      if (!ticket) {
        doc.moveDown(3);
        const y = doc.y;
        doc.moveTo(margin + 40, y).lineTo(margin + 220, y).strokeColor('#334155').lineWidth(0.5).stroke();
        doc.moveTo(width - margin - 220, y).lineTo(width - margin - 40, y).stroke();
        doc.fontSize(8.5).fillColor('#334155').text('Recibido por', margin + 40, y + 4, { width: 180, align: 'center' });
        doc.text('Firma del paciente', width - margin - 220, y + 4, { width: 180, align: 'center' });
      }
      return doc.y;
    };
    let size: [number, number] | 'LETTER' = 'LETTER';
    if (ticket) {
      const probe = new PDFDocument({ size: [width, 4000], margin, info });
      const height = draw(probe) + margin + 8;
      probe.end();
      size = [width, Math.ceil(height)];
    }
    const doc = new PDFDocument({ size, margin, info });
    const chunks: Buffer[] = [];
    doc.on('data', (d: Buffer) => chunks.push(d));
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
    draw(doc);
    doc.end();
    const buffer = await done;

    await this.audit.log({
      action: 'RECIBO_IMPRESO',
      entity: 'Payment',
      entityId: p.id,
      branchId: p.branchId,
      details: { recibo: p.number, formato: format, uso: purpose, copia: prints + 1 },
    });
    return { buffer, filename: `recibo-${p.number}${reprint ? '-copia' : ''}.pdf`, reprint };
  }
}

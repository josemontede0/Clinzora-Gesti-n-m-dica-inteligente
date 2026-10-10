import { BadRequestException, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ageFrom, formatDate, NOTE_SECTION_LABEL, utcToZonedParts } from '@medigest/shared';
import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import { z } from 'zod/v4';
import { AuditService } from '../../common/audit.service';
import { ClinicalAccessService } from '../../common/clinical-access';
import { AuthUser } from '../../common/context';
import { CurrentUser, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { ZQuery } from '../../common/zod.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { toPdf, toXlsx } from './exporters';
import { ReportFilters, ReportsService, TabularReport } from './reports.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const filters = z.object({
  from: ymd,
  to: ymd,
  branchId: z.uuid().optional(),
  professionalId: z.uuid().optional(),
  serviceId: z.uuid().optional(),
  cashierId: z.uuid().optional(),
  methodKind: z.string().max(30).optional(),
  insurerId: z.uuid().optional(),
  claimStatus: z.string().max(30).optional(),
  patientId: z.uuid().optional(),
  format: z.enum(['xlsx', 'pdf']).optional(),
});

const REPORTS: Record<string, { permission: 'reports.operational' | 'reports.financial'; run: (s: ReportsService, u: AuthUser, f: ReportFilters) => Promise<TabularReport> }> = {
  citas: { permission: 'reports.operational', run: (s, u, f) => s.appointments(u, f) },
  facturacion: { permission: 'reports.financial', run: (s, u, f) => s.invoices(u, f) },
  cobros: { permission: 'reports.financial', run: (s, u, f) => s.payments(u, f) },
  reclamaciones: { permission: 'reports.financial', run: (s, u, f) => s.claimsReport(u, f) },
  caja: { permission: 'reports.financial', run: (s, u, f) => s.cashSessions(u, f) },
};

@ApiTags('reportes')
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: ClinicalAccessService,
    private readonly settings: SettingsService,
  ) {}

  @Get('dashboard')
  @RequireAnyPermission('reports.operational', 'reports.financial', 'appointments.read')
  dashboard(@CurrentUser() user: AuthUser, @ZQuery(z.object({ from: ymd, to: ymd, branchId: z.uuid().optional() })) q: { from: string; to: string; branchId?: string }) {
    return this.reports.dashboard(user, q);
  }

  @Get('run/:type')
  async run(@CurrentUser() user: AuthUser, @Param('type') type: string, @ZQuery(filters) q: z.infer<typeof filters>) {
    const def = REPORTS[type];
    if (!def) throw new BadRequestException('Reporte desconocido');
    if (!user.permissions.has(def.permission)) throw new ForbiddenException('No tiene permiso para este reporte');
    if (q.patientId && !user.permissions.has('patients.read')) throw new ForbiddenException('No tiene permiso para filtrar por paciente');
    return def.run(this.reports, user, q);
  }

  @Get('export/:type')
  @RequirePermissions('reports.export')
  async export(@CurrentUser() user: AuthUser, @Param('type') type: string, @ZQuery(filters) q: z.infer<typeof filters>, @Res() res: Response) {
    const def = REPORTS[type];
    if (!def) throw new BadRequestException('Reporte desconocido');
    if (!user.permissions.has(def.permission)) throw new ForbiddenException('No tiene permiso para este reporte');
    const report = await def.run(this.reports, user, q);
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: user.organizationId } });
    const meta = { organization: org.name, period: `${formatDate(q.from)} al ${formatDate(q.to)}`, generatedBy: user.fullName };
    const format = q.format ?? 'xlsx';
    const buf = format === 'pdf' ? await toPdf(report, meta) : await toXlsx(report, meta);
    await this.audit.log({ action: 'REPORTE_EXPORTADO', entity: 'Report', entityId: type, details: { formato: format, desde: q.from, hasta: q.to, filas: report.rows.length } });
    res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${type}-${q.from}-${q.to}.${format}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  }

  /** Exportación del expediente clínico: permiso específico, relación asistencial y auditoría. */
  @Get('clinical/:patientId')
  @RequirePermissions('clinical.export')
  async clinicalExport(@CurrentUser() user: AuthUser, @Param('patientId', ParseUUIDPipe) patientId: string, @Res() res: Response) {
    await this.access.assertRead(user, patientId, 'exportación PDF del expediente');
    const tz = await this.settings.timezone(user.organizationId);
    const [org, patient] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: user.organizationId } }),
      this.prisma.patient.findUniqueOrThrow({
        where: { id: patientId },
        include: {
          allergies: { where: { active: true } },
          medications: { where: { active: true } },
          history: { where: { active: true } },
          encounters: {
            where: { status: 'FIRMADO' },
            include: {
              professional: true,
              notes: { where: { isCurrent: true }, orderBy: { section: 'asc' } },
              diagnoses: { where: { voidedAt: null } },
              vitals: true,
              prescriptions: { where: { voidedAt: null }, include: { items: true } },
              orders: true,
            },
            orderBy: { startedAt: 'asc' },
          },
        },
      }),
    ]);
    await this.audit.log({ action: 'EXPEDIENTE_EXPORTADO', entity: 'Patient', entityId: patientId, details: { encuentros: patient.encounters.length } });

    const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="expediente-${patient.recordNumber}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    doc.pipe(res);
    doc.fontSize(9).fillColor('#900').text('DOCUMENTO CONFIDENCIAL — Información clínica protegida. Uso exclusivo del personal autorizado.', { align: 'center' });
    doc.moveDown(0.5).fillColor('#0F2A47').fontSize(15).text(org.name);
    doc.fontSize(12).text(`Expediente clínico ${patient.recordNumber}`);
    doc.fillColor('#111').fontSize(10).moveDown(0.5)
      .text(`Paciente: ${patient.firstName} ${patient.lastName}`)
      .text(`Documento: ${patient.documentNumber ?? '—'}   Nacimiento: ${formatDate(patient.birthDate?.toISOString())}   Edad: ${ageFrom(patient.birthDate) ?? '—'}`)
      .text(`Generado por ${user.fullName} el ${formatDate(new Date(), tz)}`);
    const section = (title: string) => doc.moveDown(0.8).fontSize(11).fillColor('#0F2A47').text(title).fillColor('#111').fontSize(9.5);
    section('Alergias');
    doc.text(patient.allergies.length ? patient.allergies.map((a) => `${a.substance} (${a.severity.toLowerCase()})${a.reaction ? ': ' + a.reaction : ''}`).join('; ') : 'Sin alergias registradas');
    section('Medicamentos actuales');
    doc.text(patient.medications.length ? patient.medications.map((m) => [m.name, m.dose, m.frequency].filter(Boolean).join(' ')).join('; ') : 'Ninguno registrado');
    section('Antecedentes');
    doc.text(patient.history.length ? patient.history.map((h) => `${h.kind}: ${h.description}`).join('\n') : 'Ninguno registrado');
    for (const e of patient.encounters) {
      const p = utcToZonedParts(e.startedAt, tz);
      section(`Consulta del ${p.ymd.split('-').reverse().join('/')} — ${e.professional.title} ${e.professional.firstName} ${e.professional.lastName}${e.professional.exequatur ? ` (Exequátur ${e.professional.exequatur})` : ''}`);
      const v = e.vitals[0];
      if (v) doc.text(`Signos vitales: PA ${v.systolic ?? '—'}/${v.diastolic ?? '—'} · FC ${v.heartRate ?? '—'} · FR ${v.respiratoryRate ?? '—'} · T ${v.temperatureC ?? '—'} °C · SpO2 ${v.spo2 ?? '—'} % · Peso ${v.weightKg ?? '—'} kg · Talla ${v.heightCm ?? '—'} cm · IMC ${v.bmi ?? '—'}`);
      for (const n of e.notes) doc.font('Helvetica-Bold').text(`${NOTE_SECTION_LABEL[n.section]}${n.version > 1 ? ` (versión ${n.version}, corregida)` : ''}:`).font('Helvetica').text(n.content);
      if (e.diagnoses.length) doc.font('Helvetica-Bold').text('Diagnósticos:').font('Helvetica').text(e.diagnoses.map((d) => `${d.code ? d.code + ' ' : ''}${d.description} (${d.type.toLowerCase()})`).join('; '));
      for (const rx of e.prescriptions) doc.font('Helvetica-Bold').text('Receta:').font('Helvetica').text(rx.items.map((i) => [i.medication, i.dose, i.route, i.frequency, i.duration].filter(Boolean).join(' ')).join('\n'));
      if (e.orders.length) doc.font('Helvetica-Bold').text('Órdenes:').font('Helvetica').text(e.orders.map((o) => `${o.type}: ${o.description} [${o.status}]${o.resultSummary ? ' — ' + o.resultSummary : ''}`).join('\n'));
      doc.fontSize(8).fillColor('#555').text(`Firmado el ${e.signedAt ? formatDate(e.signedAt, tz) : '—'}`).fillColor('#111').fontSize(9.5);
    }
    doc.end();
  }
}

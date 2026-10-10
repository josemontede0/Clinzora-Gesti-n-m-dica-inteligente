import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { APPOINTMENT_STATUS_LABEL, CLAIM_STATUS_LABEL, fromCents, PAYMENT_METHOD_KIND_LABEL, sumCents, utcToZonedParts, zonedToUtc } from '@medigest/shared';
import { AuthUser } from '../../common/context';
import { assertBranch } from '../../common/scope';
import { PrismaService } from '../../prisma/prisma.service';
import { c } from '../billing/money-db';
import { claimExpected, ClaimsService } from '../insurance/claims.service';
import { SettingsService } from '../settings/settings.service';

export interface ReportFilters {
  from: string; // YYYY-MM-DD (fecha local)
  to: string; // YYYY-MM-DD inclusive
  branchId?: string;
  professionalId?: string;
  serviceId?: string;
  cashierId?: string;
  methodKind?: string;
  insurerId?: string;
  claimStatus?: string;
  patientId?: string;
}

export interface TabularReport {
  title: string;
  columns: { key: string; label: string; money?: boolean }[];
  rows: Record<string, string | number | null>[];
  totals?: Record<string, string>;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly claims: ClaimsService,
  ) {}

  private async range(user: AuthUser, f: { from: string; to: string }) {
    const tz = await this.settings.timezone(user.organizationId);
    return { tz, start: zonedToUtc(f.from, 0, tz), end: zonedToUtc(f.to, 1440, tz) };
  }

  private branch(user: AuthUser, branchId?: string) {
    if (branchId) {
      assertBranch(user, branchId);
      return { branchId };
    }
    return user.allBranches ? {} : { branchId: { in: user.branchIds } };
  }

  /**
   * Panel principal. Distingue siempre: facturado (facturas emitidas), cobrado (dinero recibido neto de
   * reembolsos y reversos) y pendiente (saldos de pacientes y de aseguradoras).
   */
  async dashboard(user: AuthUser, f: { from: string; to: string; branchId?: string }) {
    const { tz, start, end } = await this.range(user, f);
    const b = this.branch(user, f.branchId);
    const org = { organizationId: user.organizationId };
    const today = utcToZonedParts(new Date(), tz).ymd;
    const todayStart = zonedToUtc(today, 0, tz);
    const todayEnd = zonedToUtc(today, 1440, tz);
    const canFinance = user.permissions.has('reports.financial');

    const [todayStats, periodStats, professionalsToday] = await Promise.all([
      this.prisma.appointment.groupBy({ by: ['status'], where: { ...org, ...b, startsAt: { gte: todayStart, lt: todayEnd } }, _count: true }),
      this.prisma.appointment.groupBy({ by: ['status'], where: { ...org, ...b, startsAt: { gte: start, lt: end } }, _count: true }),
      this.prisma.appointment.groupBy({ by: ['professionalId'], where: { ...org, ...b, startsAt: { gte: todayStart, lt: todayEnd }, status: { notIn: ['CANCELADA', 'NO_ASISTIO'] } }, _count: true }),
    ]);
    const count = (rows: { status: string; _count: number }[], s: string) => rows.find((r) => r.status === s)?._count ?? 0;
    const operational = {
      today: {
        total: todayStats.reduce((a, r) => a + r._count, 0),
        confirmed: count(todayStats, 'CONFIRMADA'),
        waiting: count(todayStats, 'EN_ESPERA'),
        inConsultation: count(todayStats, 'EN_CONSULTA'),
        completed: count(todayStats, 'COMPLETADA'),
        pendingConfirmation: count(todayStats, 'PENDIENTE_CONFIRMACION') + count(todayStats, 'SOLICITADA'),
      },
      period: {
        total: periodStats.reduce((a, r) => a + r._count, 0),
        completed: count(periodStats, 'COMPLETADA'),
        cancelled: count(periodStats, 'CANCELADA'),
        noShow: count(periodStats, 'NO_ASISTIO'),
        byStatus: periodStats.map((r) => ({ status: r.status, label: APPOINTMENT_STATUS_LABEL[r.status], count: r._count })),
      },
      professionalsWithAppointmentsToday: professionalsToday.length,
    };

    const professionals = await this.prisma.medicalProfessional.findMany({
      where: { ...org, active: true, ...(f.branchId ? { branches: { some: { branchId: f.branchId } } } : {}) },
      select: { id: true, title: true, firstName: true, lastName: true, schedules: { where: { active: true, weekday: utcToZonedParts(new Date(), tz).weekday }, select: { startMinute: true, endMinute: true } } },
    });
    const availability = professionals.map((p) => ({
      id: p.id,
      name: `${p.title} ${p.firstName} ${p.lastName}`,
      scheduledMinutes: p.schedules.reduce((a, s) => a + (s.endMinute - s.startMinute), 0),
      appointmentsToday: professionalsToday.find((x) => x.professionalId === p.id)?._count ?? 0,
    }));

    if (!canFinance) return { operational, availability, financial: null };

    const [billed, payments, refunds, reversals, patientBalance, claimsOpen, claimsRejected, insurerPayments, cashDiffs, daily] = await Promise.all([
      this.prisma.invoice.aggregate({ where: { ...org, ...b, issuedAt: { gte: start, lt: end }, status: { notIn: ['ANULADA', 'BORRADOR'] } }, _sum: { total: true, patientAmount: true, insuranceAmount: true }, _count: true }),
      this.prisma.$queryRaw<{ kind: string; amount: string }[]>`
        SELECT m.kind, SUM(t.amount)::text AS amount FROM "PaymentTender" t
        JOIN "Payment" p ON p.id = t."paymentId" JOIN "PaymentMethod" m ON m.id = t."methodId"
        WHERE p."organizationId" = ${user.organizationId}::uuid AND p."receivedAt" >= ${start} AND p."receivedAt" < ${end}
          ${f.branchId ? Prisma.sql`AND p."branchId" = ${f.branchId}::uuid` : user.allBranches ? Prisma.empty : Prisma.sql`AND p."branchId" = ANY(${user.branchIds}::uuid[])`}
        GROUP BY m.kind`,
      this.prisma.refund.aggregate({ where: { ...org, status: 'COMPLETADO', createdAt: { gte: start, lt: end }, payment: b }, _sum: { amount: true } }),
      this.prisma.payment.aggregate({ where: { ...org, ...b, status: 'REVERTIDO', reversedAt: { gte: start, lt: end } }, _sum: { amount: true } }),
      this.prisma.invoice.aggregate({ where: { ...org, ...b, status: { in: ['PENDIENTE', 'PARCIAL'] } }, _sum: { balance: true }, _count: true }),
      this.prisma.claim.findMany({ where: { ...org, ...b, status: { in: ['BORRADOR', 'SOMETIDA', 'EN_REVISION', 'APROBADA', 'APROBADA_PARCIAL', 'PAGADA_PARCIAL'] } } }),
      this.prisma.claim.count({ where: { ...org, ...b, status: 'RECHAZADA', updatedAt: { gte: start, lt: end } } }),
      this.prisma.insurerPayment.findMany({ where: { ...org, reversedAt: null }, include: { allocations: true } }),
      this.prisma.cashSession.aggregate({ where: { ...org, ...b, status: 'CERRADA', closedAt: { gte: start, lt: end }, NOT: { difference: 0 } }, _sum: { difference: true }, _count: true }),
      this.prisma.$queryRaw<{ day: string; billed: string; collected: string }[]>`
        WITH days AS (SELECT generate_series(${start}::timestamptz, ${end}::timestamptz - interval '1 day', interval '1 day') AS d)
        SELECT to_char(d AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
          COALESCE((SELECT SUM(total) FROM "Invoice" i WHERE i."organizationId" = ${user.organizationId}::uuid AND i.status NOT IN ('ANULADA','BORRADOR')
            AND i."issuedAt" >= d AND i."issuedAt" < d + interval '1 day' ${f.branchId ? Prisma.sql`AND i."branchId" = ${f.branchId}::uuid` : Prisma.empty}), 0)::text AS billed,
          COALESCE((SELECT SUM(amount) FROM "Payment" p WHERE p."organizationId" = ${user.organizationId}::uuid AND p.status = 'COMPLETADO'
            AND p."receivedAt" >= d AND p."receivedAt" < d + interval '1 day' ${f.branchId ? Prisma.sql`AND p."branchId" = ${f.branchId}::uuid` : Prisma.empty}), 0)::text AS collected
        FROM days ORDER BY d LIMIT 92`,
    ]);
    const grossCollected = sumCents(payments.map((p) => c(p.amount)));
    const netCollected = grossCollected - c(refunds._sum.amount) - c(reversals._sum.amount);
    const insurerReceivable = sumCents(claimsOpen.map((cl) => Math.max(claimExpected(cl) - c(cl.paidAmount), 0)));
    const unallocated = sumCents(insurerPayments.map((p) => c(p.amount) - sumCents(p.allocations.map((a) => c(a.amount)))));
    const receivables = await this.claims.receivables(user);

    return {
      operational,
      availability,
      financial: {
        billed: { total: fromCents(c(billed._sum.total)), patient: fromCents(c(billed._sum.patientAmount)), insurance: fromCents(c(billed._sum.insuranceAmount)), invoices: billed._count },
        collected: {
          gross: fromCents(grossCollected),
          refunds: fromCents(c(refunds._sum.amount)),
          reversals: fromCents(c(reversals._sum.amount)),
          net: fromCents(netCollected),
          byMethod: payments.map((p) => ({ kind: p.kind, label: PAYMENT_METHOD_KIND_LABEL[p.kind] ?? p.kind, amount: fromCents(c(p.amount)) })),
        },
        patientReceivable: { amount: fromCents(c(patientBalance._sum.balance)), invoices: patientBalance._count },
        insurerReceivable: { claims: fromCents(insurerReceivable), notYetClaimed: fromCents(sumCents(receivables.map((r) => c(r.notYetClaimed)))) },
        claims: { pending: claimsOpen.length, rejectedInPeriod: claimsRejected },
        unreconciledInsurerPayments: fromCents(unallocated),
        cashDifferences: { amount: fromCents(c(cashDiffs._sum.difference)), sessions: cashDiffs._count },
        daily: daily.map((d) => ({ day: d.day, billed: fromCents(c(d.billed)), collected: fromCents(c(d.collected)) })),
      },
    };
  }

  // ── Reportes tabulares (también exportables) ──

  async appointments(user: AuthUser, f: ReportFilters): Promise<TabularReport> {
    const { tz, start, end } = await this.range(user, f);
    const rows = await this.prisma.appointment.findMany({
      where: {
        organizationId: user.organizationId, ...this.branch(user, f.branchId), startsAt: { gte: start, lt: end },
        ...(f.professionalId ? { professionalId: f.professionalId } : {}),
        ...(f.serviceId ? { serviceId: f.serviceId } : {}),
        ...(f.patientId ? { patientId: f.patientId } : {}),
      },
      include: { patient: { select: { recordNumber: true, firstName: true, lastName: true } }, professional: { select: { title: true, firstName: true, lastName: true } }, specialty: { select: { name: true } } },
      orderBy: { startsAt: 'asc' },
      take: 10000,
    });
    const fmt = (d: Date) => {
      const p = utcToZonedParts(d, tz);
      return `${p.ymd.split('-').reverse().join('/')} ${String(Math.floor(p.minutes / 60)).padStart(2, '0')}:${String(p.minutes % 60).padStart(2, '0')}`;
    };
    return {
      title: 'Citas',
      columns: [
        { key: 'fecha', label: 'Fecha y hora' }, { key: 'expediente', label: 'Expediente' }, { key: 'paciente', label: 'Paciente' },
        { key: 'medico', label: 'Médico' }, { key: 'especialidad', label: 'Especialidad' }, { key: 'estado', label: 'Estado' }, { key: 'modalidad', label: 'Modalidad' },
      ],
      rows: rows.map((a) => ({
        fecha: fmt(a.startsAt), expediente: a.patient.recordNumber, paciente: `${a.patient.lastName}, ${a.patient.firstName}`,
        medico: `${a.professional.title} ${a.professional.firstName} ${a.professional.lastName}`, especialidad: a.specialty?.name ?? '',
        estado: APPOINTMENT_STATUS_LABEL[a.status], modalidad: a.modality === 'VIRTUAL' ? 'Virtual' : 'Presencial',
      })),
      totals: { total: String(rows.length) },
    };
  }

  async invoices(user: AuthUser, f: ReportFilters): Promise<TabularReport> {
    const { start, end } = await this.range(user, f);
    const rows = await this.prisma.invoice.findMany({
      where: {
        organizationId: user.organizationId, ...this.branch(user, f.branchId), issuedAt: { gte: start, lt: end }, status: { not: 'BORRADOR' },
        ...(f.patientId ? { patientId: f.patientId } : {}),
        ...(f.serviceId ? { items: { some: { serviceId: f.serviceId } } } : {}),
        ...(f.professionalId ? { items: { some: { charge: { professionalId: f.professionalId } } } } : {}),
      },
      include: { patient: { select: { recordNumber: true, firstName: true, lastName: true } } },
      orderBy: { issuedAt: 'asc' },
      take: 10000,
    });
    const active = rows.filter((r) => r.status !== 'ANULADA');
    const sum = (k: 'total' | 'insuranceAmount' | 'patientAmount' | 'paidAmount' | 'balance') => fromCents(sumCents(active.map((r) => c(r[k]))));
    return {
      title: 'Facturación',
      columns: [
        { key: 'numero', label: 'Factura' }, { key: 'fecha', label: 'Fecha' }, { key: 'paciente', label: 'Paciente' }, { key: 'estado', label: 'Estado' },
        { key: 'total', label: 'Total', money: true }, { key: 'seguro', label: 'Seguro', money: true }, { key: 'pacienteMonto', label: 'Paciente', money: true },
        { key: 'pagado', label: 'Pagado', money: true }, { key: 'saldo', label: 'Saldo', money: true },
      ],
      rows: rows.map((r) => ({
        numero: r.number, fecha: r.issuedAt!.toISOString().slice(0, 10).split('-').reverse().join('/'), paciente: `${r.patient.lastName}, ${r.patient.firstName}`,
        estado: r.status, total: r.total.toString(), seguro: r.insuranceAmount.toString(), pacienteMonto: r.patientAmount.toString(), pagado: r.paidAmount.toString(), saldo: r.balance.toString(),
      })),
      totals: { total: sum('total'), seguro: sum('insuranceAmount'), pacienteMonto: sum('patientAmount'), pagado: sum('paidAmount'), saldo: sum('balance') },
    };
  }

  async payments(user: AuthUser, f: ReportFilters): Promise<TabularReport> {
    const { start, end } = await this.range(user, f);
    const tenders = await this.prisma.paymentTender.findMany({
      where: {
        payment: { organizationId: user.organizationId, ...this.branch(user, f.branchId), receivedAt: { gte: start, lt: end }, ...(f.cashierId ? { createdById: f.cashierId } : {}), ...(f.patientId ? { patientId: f.patientId } : {}) },
        ...(f.methodKind ? { method: { kind: f.methodKind as never } } : {}),
      },
      include: { method: true, transaction: { select: { testMode: true, authCode: true } }, payment: { include: { patient: { select: { firstName: true, lastName: true } } } } },
      orderBy: { payment: { receivedAt: 'asc' } },
      take: 10000,
    });
    const cashierIds = [...new Set(tenders.map((t) => t.payment.createdById))];
    const cashiers = await this.prisma.user.findMany({ where: { id: { in: cashierIds } }, select: { id: true, fullName: true } });
    const completed = tenders.filter((t) => t.payment.status === 'COMPLETADO');
    return {
      title: 'Cobros',
      columns: [
        { key: 'recibo', label: 'Recibo' }, { key: 'fecha', label: 'Fecha' }, { key: 'paciente', label: 'Paciente' }, { key: 'metodo', label: 'Método' },
        { key: 'referencia', label: 'Referencia' }, { key: 'cajero', label: 'Cajero' }, { key: 'estado', label: 'Estado' }, { key: 'monto', label: 'Monto', money: true },
      ],
      rows: tenders.map((t) => ({
        recibo: t.payment.number, fecha: t.payment.receivedAt.toISOString().slice(0, 10).split('-').reverse().join('/'),
        paciente: `${t.payment.patient.lastName}, ${t.payment.patient.firstName}`, metodo: t.method.name + (t.transaction?.testMode ? ' (PRUEBA)' : ''),
        referencia: t.reference ?? t.transaction?.authCode ?? (t.cardLast4 ? `****${t.cardLast4}` : ''), cajero: cashiers.find((x) => x.id === t.payment.createdById)?.fullName ?? '',
        estado: t.payment.status, monto: t.amount.toString(),
      })),
      totals: { monto: fromCents(sumCents(completed.map((t) => c(t.amount)))) },
    };
  }

  async claimsReport(user: AuthUser, f: ReportFilters): Promise<TabularReport> {
    const { start, end } = await this.range(user, f);
    const rows = await this.prisma.claim.findMany({
      where: {
        organizationId: user.organizationId, ...this.branch(user, f.branchId), createdAt: { gte: start, lt: end },
        ...(f.insurerId ? { insurerId: f.insurerId } : {}), ...(f.claimStatus ? { status: f.claimStatus as never } : {}),
      },
      include: { insurer: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
      take: 10000,
    });
    const data = rows.map((r) => {
      const expected = claimExpected(r);
      return { r, expected, balance: Math.max(expected - c(r.paidAmount), 0) };
    });
    return {
      title: 'Reclamaciones a aseguradoras',
      columns: [
        { key: 'numero', label: 'Reclamación' }, { key: 'aseguradora', label: 'Aseguradora' }, { key: 'estado', label: 'Estado' }, { key: 'referencia', label: 'Ref. ARS' },
        { key: 'reclamado', label: 'Reclamado', money: true }, { key: 'aprobado', label: 'Reconocido', money: true }, { key: 'glosa', label: 'Glosas', money: true },
        { key: 'pagado', label: 'Pagado', money: true }, { key: 'saldo', label: 'Saldo', money: true },
      ],
      rows: data.map(({ r, expected, balance }) => ({
        numero: r.number, aseguradora: r.insurer.name, estado: CLAIM_STATUS_LABEL[r.status], referencia: r.externalReference ?? '',
        reclamado: r.claimedAmount.toString(), aprobado: fromCents(expected), glosa: r.glosaAmount.toString(), pagado: r.paidAmount.toString(), saldo: fromCents(balance),
      })),
      totals: {
        reclamado: fromCents(sumCents(rows.map((r) => c(r.claimedAmount)))), aprobado: fromCents(sumCents(data.map((d) => d.expected))),
        glosa: fromCents(sumCents(rows.map((r) => c(r.glosaAmount)))), pagado: fromCents(sumCents(rows.map((r) => c(r.paidAmount)))), saldo: fromCents(sumCents(data.map((d) => d.balance))),
      },
    };
  }

  async cashSessions(user: AuthUser, f: ReportFilters): Promise<TabularReport> {
    const { start, end } = await this.range(user, f);
    const rows = await this.prisma.cashSession.findMany({
      where: { organizationId: user.organizationId, ...this.branch(user, f.branchId), openedAt: { gte: start, lt: end }, ...(f.cashierId ? { openedById: f.cashierId } : {}) },
      include: { register: { select: { name: true } } },
      orderBy: { openedAt: 'asc' },
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.openedById) } }, select: { id: true, fullName: true } });
    return {
      title: 'Cierres de caja',
      columns: [
        { key: 'caja', label: 'Caja' }, { key: 'cajero', label: 'Cajero' }, { key: 'apertura', label: 'Apertura' }, { key: 'estado', label: 'Estado' },
        { key: 'fondo', label: 'Fondo', money: true }, { key: 'esperado', label: 'Efectivo esperado', money: true }, { key: 'contado', label: 'Contado', money: true }, { key: 'diferencia', label: 'Diferencia', money: true },
      ],
      rows: rows.map((r) => ({
        caja: r.register.name, cajero: users.find((u) => u.id === r.openedById)?.fullName ?? '', apertura: r.openedAt.toISOString().slice(0, 16).replace('T', ' '),
        estado: r.status, fondo: r.openingFloat.toString(), esperado: r.expectedCash?.toString() ?? '', contado: r.countedCash?.toString() ?? '', diferencia: r.difference?.toString() ?? '',
      })),
      totals: { diferencia: fromCents(sumCents(rows.map((r) => c(r.difference)))) },
    };
  }
}

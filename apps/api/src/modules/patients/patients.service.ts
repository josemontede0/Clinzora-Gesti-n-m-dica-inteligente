import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { normalizeDocument, normalizePhone, patientCreateSchema, patientMergeSchema, patientUpdateSchema } from '@medigest/shared';
import { z } from 'zod/v4';
import { AuditService, changedFields } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { BusinessError } from '../../common/errors';
import { found } from '../../common/scope';
import { nextNumber } from '../../common/sequence';
import { ListQuery, page, paginate } from '../../common/zod.pipe';
import { PrismaService } from '../../prisma/prisma.service';

type CreateInput = z.infer<typeof patientCreateSchema>;
type UpdateInput = z.infer<typeof patientUpdateSchema>;

export interface DuplicateCandidate {
  id: string;
  recordNumber: string;
  firstName: string;
  lastName: string;
  documentNumber: string | null;
  birthDate: Date | null;
  phone: string | null;
  reason: string;
}

const listSelect = {
  id: true, recordNumber: true, firstName: true, lastName: true, documentType: true, documentNumber: true, birthDate: true,
  sex: true, phone: true, email: true, status: true, lastVisitAt: true, createdAt: true,
} satisfies Prisma.PatientSelect;

@Injectable()
export class PatientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Búsqueda por nombre, expediente, documento o teléfono. */
  searchWhere(user: AuthUser, q?: string, status?: string): Prisma.PatientWhereInput {
    const where: Prisma.PatientWhereInput = { organizationId: user.organizationId };
    if (status) where.status = status as never;
    else where.status = { not: 'MERGED' };
    if (q) {
      const doc = normalizeDocument(q);
      const phone = normalizePhone(q);
      const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 4);
      where.OR = [
        { recordNumber: { equals: q.trim().toUpperCase() } },
        ...(doc ? [{ documentNumber: doc }] : []),
        ...(phone && phone.length >= 4 ? [{ phoneNormalized: { contains: phone } }] : []),
        {
          AND: words.map((w) => ({
            OR: [{ firstName: { contains: w, mode: 'insensitive' as const } }, { lastName: { contains: w, mode: 'insensitive' as const } }],
          })),
        },
      ];
    }
    return where;
  }

  async list(user: AuthUser, q: ListQuery & { status?: string }) {
    const where = this.searchWhere(user, q.q, q.status);
    const [items, total] = await Promise.all([
      this.prisma.patient.findMany({ where, select: listSelect, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], ...paginate(q) }),
      this.prisma.patient.count({ where }),
    ]);
    return page(items, total, q);
  }

  async quickSearch(user: AuthUser, q: string) {
    if (!q || q.trim().length < 2) return [];
    return this.prisma.patient.findMany({
      where: this.searchWhere(user, q, 'ACTIVE'),
      select: {
        ...listSelect,
        insurances: { where: { active: true }, select: { id: true, affiliateNumber: true, isPrimary: true, plan: { select: { name: true, insurer: { select: { name: true } } } } } },
      },
      take: 10,
      orderBy: [{ lastName: 'asc' }],
    });
  }

  /** Duplicados posibles: documento igual (bloqueante) o nombre + fecha de nacimiento / teléfono (advertencia). */
  async findDuplicates(user: AuthUser, input: Partial<CreateInput>, excludeId?: string): Promise<{ blocking: DuplicateCandidate[]; warnings: DuplicateCandidate[] }> {
    const doc = normalizeDocument(input.documentNumber);
    const phone = normalizePhone(input.phone);
    const base: Prisma.PatientWhereInput = { organizationId: user.organizationId, status: { not: 'MERGED' }, ...(excludeId ? { id: { not: excludeId } } : {}) };
    const select = { id: true, recordNumber: true, firstName: true, lastName: true, documentNumber: true, birthDate: true, phone: true };

    const blocking = doc && input.documentType && input.documentType !== 'NINGUNO'
      ? (await this.prisma.patient.findMany({ where: { ...base, documentType: input.documentType, documentNumber: doc }, select })).map((p) => ({ ...p, reason: 'Mismo documento de identidad' }))
      : [];

    const or: Prisma.PatientWhereInput[] = [];
    if (input.firstName && input.lastName) {
      const nameMatch = { firstName: { equals: input.firstName.trim(), mode: 'insensitive' as const }, lastName: { equals: input.lastName.trim(), mode: 'insensitive' as const } };
      if (input.birthDate) or.push({ ...nameMatch, birthDate: new Date(input.birthDate) });
      if (phone) or.push({ ...nameMatch, phoneNormalized: phone });
      if (!input.birthDate && !phone) or.push(nameMatch);
    }
    if (phone && input.lastName) or.push({ phoneNormalized: phone, lastName: { equals: input.lastName.trim(), mode: 'insensitive' } });
    const warnings = or.length
      ? (await this.prisma.patient.findMany({ where: { ...base, OR: or }, select, take: 10 }))
          .filter((p) => !blocking.some((b) => b.id === p.id))
          .map((p) => ({ ...p, reason: 'Nombre y fecha de nacimiento o teléfono coinciden' }))
      : [];
    return { blocking, warnings };
  }

  private toData(input: UpdateInput) {
    return {
      firstName: input.firstName,
      lastName: input.lastName,
      documentType: input.documentType,
      documentNumber: input.documentType === 'NINGUNO' ? null : normalizeDocument(input.documentNumber),
      birthDate: input.birthDate ? new Date(input.birthDate) : null,
      sex: input.sex,
      phone: input.phone,
      phoneNormalized: normalizePhone(input.phone),
      email: input.email?.toLowerCase() ?? null,
      address: input.address,
      city: input.city,
      province: input.province,
      adminNotes: input.adminNotes,
    };
  }

  async create(user: AuthUser, input: CreateInput) {
    const dup = await this.findDuplicates(user, input);
    if (dup.blocking.length) {
      throw new ConflictException({ message: 'Ya existe un paciente con ese documento de identidad', code: 'DOCUMENTO_DUPLICADO', candidates: dup.blocking });
    }
    if (dup.warnings.length && !input.confirmDuplicate) {
      throw new ConflictException({ message: 'Hay pacientes con datos similares. Revise antes de continuar.', code: 'POSIBLE_DUPLICADO', candidates: dup.warnings });
    }
    return this.prisma.$transaction(async (tx) => {
      const recordNumber = await nextNumber(tx, user.organizationId, 'patient');
      const patient = await tx.patient.create({
        data: { ...this.toData(input), organizationId: user.organizationId, recordNumber, createdById: user.id },
      });
      const contacts = [
        input.emergencyContact ? { ...input.emergencyContact, kind: 'EMERGENCY' as const } : null,
        input.guardian ? { ...input.guardian, kind: 'GUARDIAN' as const } : null,
      ].filter((c): c is NonNullable<typeof c> => !!c);
      if (contacts.length) await tx.patientContact.createMany({ data: contacts.map((c) => ({ ...c, patientId: patient.id })) });
      if (input.consents?.length) {
        await tx.patientConsent.createMany({
          data: input.consents.map((c) => ({ patientId: patient.id, type: c.type, granted: c.granted, notes: c.notes, recordedById: user.id })),
        });
      }
      await this.audit.log(
        { action: 'PACIENTE_CREADO', entity: 'Patient', entityId: patient.id, details: { recordNumber, advertenciaDuplicado: dup.warnings.length > 0 } },
        tx,
      );
      return patient;
    });
  }

  async get(user: AuthUser, id: string) {
    const patient = found(
      await this.prisma.patient.findFirst({
        where: { id, organizationId: user.organizationId },
        include: {
          contacts: true,
          consents: { orderBy: { recordedAt: 'desc' } },
          insurances: { include: { plan: { include: { insurer: true } } }, orderBy: [{ active: 'desc' }, { isPrimary: 'desc' }] },
          mergedInto: { select: { id: true, recordNumber: true } },
        },
      }),
      'Paciente',
    );
    const now = new Date();
    const [upcoming, past, counts] = await Promise.all([
      this.prisma.appointment.findMany({
        where: { patientId: id, startsAt: { gte: now }, status: { notIn: ['CANCELADA', 'NO_ASISTIO'] } },
        include: { professional: { select: { title: true, firstName: true, lastName: true } } },
        orderBy: { startsAt: 'asc' },
        take: 5,
      }),
      this.prisma.appointment.count({ where: { patientId: id, startsAt: { lt: now } } }),
      this.prisma.appointment.groupBy({ by: ['status'], where: { patientId: id }, _count: true }),
    ]);
    // Último consentimiento por tipo = estado vigente.
    const currentConsents = Object.values(
      patient.consents.reduce<Record<string, (typeof patient.consents)[number]>>((acc, c) => {
        if (!acc[c.type]) acc[c.type] = c;
        return acc;
      }, {}),
    );
    let billing: { balance: string; openInvoices: number; credit: string } | undefined;
    if (user.permissions.has('billing.read')) billing = await this.balanceSummary(user.organizationId, id);
    return { ...patient, currentConsents, upcomingAppointments: upcoming, pastAppointmentsCount: past, appointmentStats: counts, billing };
  }

  async balanceSummary(organizationId: string, patientId: string) {
    const [agg, open, payments] = await Promise.all([
      this.prisma.invoice.aggregate({ where: { organizationId, patientId, status: { in: ['PENDIENTE', 'PARCIAL'] } }, _sum: { balance: true } }),
      this.prisma.invoice.count({ where: { organizationId, patientId, status: { in: ['PENDIENTE', 'PARCIAL'] } } }),
      this.prisma.$queryRaw<{ credit: string | null }[]>`
        SELECT COALESCE(SUM(p.amount), 0)
             - COALESCE((SELECT SUM(a.amount) FROM "PaymentAllocation" a JOIN "Payment" p2 ON p2.id = a."paymentId"
                         WHERE p2."patientId" = ${patientId}::uuid AND p2.status = 'COMPLETADO' AND a."reversedAt" IS NULL), 0)
             - COALESCE((SELECT SUM(r.amount) FROM "Refund" r JOIN "Payment" p3 ON p3.id = r."paymentId"
                         WHERE p3."patientId" = ${patientId}::uuid AND p3.status = 'COMPLETADO' AND r.status = 'COMPLETADO'), 0) AS credit
        FROM "Payment" p WHERE p."patientId" = ${patientId}::uuid AND p.status = 'COMPLETADO'`,
    ]);
    return { balance: (agg._sum.balance ?? new Prisma.Decimal(0)).toFixed(2), openInvoices: open, credit: Number(payments[0]?.credit ?? 0).toFixed(2) };
  }

  async update(user: AuthUser, id: string, input: UpdateInput) {
    const current = found(await this.prisma.patient.findFirst({ where: { id, organizationId: user.organizationId } }), 'Paciente');
    if (current.status === 'MERGED') throw new BusinessError('El expediente fue fusionado; edite el expediente destino');
    const dup = await this.findDuplicates(user, input, id);
    if (dup.blocking.length) {
      throw new ConflictException({ message: 'Ya existe otro paciente con ese documento de identidad', code: 'DOCUMENTO_DUPLICADO', candidates: dup.blocking });
    }
    const data = this.toData(input);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.patient.update({ where: { id }, data });
      for (const [kind, contact] of [['EMERGENCY', input.emergencyContact], ['GUARDIAN', input.guardian]] as const) {
        if (contact === undefined) continue;
        await tx.patientContact.deleteMany({ where: { patientId: id, kind } });
        if (contact) await tx.patientContact.create({ data: { ...contact, kind, patientId: id } });
      }
      await this.audit.log({ action: 'PACIENTE_ACTUALIZADO', entity: 'Patient', entityId: id, details: { campos: changedFields(current, data) } }, tx);
      return updated;
    });
  }

  async setStatus(user: AuthUser, id: string, status: 'ACTIVE' | 'INACTIVE', reason?: string | null) {
    const p = found(await this.prisma.patient.findFirst({ where: { id, organizationId: user.organizationId } }), 'Paciente');
    if (p.status === 'MERGED') throw new BusinessError('No se puede cambiar el estado de un expediente fusionado');
    await this.prisma.patient.update({ where: { id }, data: { status } });
    await this.audit.log({ action: status === 'INACTIVE' ? 'PACIENTE_INACTIVADO' : 'PACIENTE_REACTIVADO', entity: 'Patient', entityId: id, details: { motivo: reason } });
    return { ok: true };
  }

  /**
   * Fusión controlada: mueve todas las relaciones del expediente origen al destino dentro de una transacción,
   * marca el origen como MERGED (no se borra) y registra conteos en auditoría.
   */
  async merge(user: AuthUser, input: z.infer<typeof patientMergeSchema>) {
    const [source, target] = await Promise.all([
      this.prisma.patient.findFirst({ where: { id: input.sourceId, organizationId: user.organizationId } }),
      this.prisma.patient.findFirst({ where: { id: input.targetId, organizationId: user.organizationId } }),
    ]);
    found(source, 'Expediente origen');
    found(target, 'Expediente destino');
    if (source!.status === 'MERGED' || target!.status === 'MERGED') throw new BusinessError('Uno de los expedientes ya fue fusionado');
    if (source!.documentNumber && target!.documentNumber && source!.documentNumber !== target!.documentNumber) {
      throw new BusinessError('Los expedientes tienen documentos de identidad distintos; verifique que sean la misma persona');
    }

    return this.prisma.$transaction(async (tx) => {
      const move = { where: { patientId: source!.id }, data: { patientId: target!.id } };
      const counts = {
        citas: (await tx.appointment.updateMany(move)).count,
        encuentros: (await tx.medicalEncounter.updateMany(move)).count,
        cargos: (await tx.charge.updateMany(move)).count,
        facturas: (await tx.invoice.updateMany(move)).count,
        pagos: (await tx.payment.updateMany(move)).count,
        seguros: (await tx.patientInsurance.updateMany(move)).count,
        contactos: (await tx.patientContact.updateMany(move)).count,
        consentimientos: (await tx.patientConsent.updateMany(move)).count,
        documentos: (await tx.patientDocument.updateMany(move)).count,
        alergias: (await tx.allergy.updateMany(move)).count,
        medicamentos: (await tx.medication.updateMany(move)).count,
        antecedentes: (await tx.medicalHistoryEntry.updateMany(move)).count,
        notificaciones: (await tx.notification.updateMany(move)).count,
        listaEspera: (await tx.waitlistEntry.updateMany(move)).count,
      };
      await tx.patient.update({
        where: { id: source!.id },
        data: { status: 'MERGED', mergedIntoId: target!.id, mergedDocumentNumber: source!.documentNumber, documentNumber: null },
      });
      if (!target!.documentNumber && source!.documentNumber) {
        await tx.patient.update({ where: { id: target!.id }, data: { documentType: source!.documentType, documentNumber: source!.documentNumber } });
      }
      const lastVisit = [source!.lastVisitAt, target!.lastVisitAt].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0];
      if (lastVisit) await tx.patient.update({ where: { id: target!.id }, data: { lastVisitAt: lastVisit } });
      await this.audit.log(
        { action: 'PACIENTES_FUSIONADOS', entity: 'Patient', entityId: target!.id, details: { origen: source!.recordNumber, destino: target!.recordNumber, motivo: input.reason, movidos: counts } },
        tx,
      );
      return { targetId: target!.id, moved: counts };
    });
  }

  async addConsent(user: AuthUser, patientId: string, input: { type: string; granted: boolean; notes: string | null }) {
    found(await this.prisma.patient.findFirst({ where: { id: patientId, organizationId: user.organizationId } }), 'Paciente');
    const consent = await this.prisma.patientConsent.create({
      data: { patientId, type: input.type as never, granted: input.granted, notes: input.notes, recordedById: user.id },
    });
    await this.audit.log({ action: input.granted ? 'CONSENTIMIENTO_OTORGADO' : 'CONSENTIMIENTO_DENEGADO', entity: 'Patient', entityId: patientId, details: { tipo: input.type } });
    return consent;
  }

  async appointments(user: AuthUser, patientId: string, q: ListQuery) {
    found(await this.prisma.patient.findFirst({ where: { id: patientId, organizationId: user.organizationId } }), 'Paciente');
    const where = { patientId, organizationId: user.organizationId };
    const [items, total] = await Promise.all([
      this.prisma.appointment.findMany({
        where,
        include: { professional: { select: { title: true, firstName: true, lastName: true } }, specialty: { select: { name: true } } },
        orderBy: { startsAt: 'desc' },
        ...paginate(q),
      }),
      this.prisma.appointment.count({ where }),
    ]);
    return page(items, total, q);
  }
}

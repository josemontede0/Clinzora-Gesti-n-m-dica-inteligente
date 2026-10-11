import { ForbiddenException, Injectable } from '@nestjs/common';
import { MedicalEncounter, Prisma } from '@prisma/client';
import {
  allergySchema, diagnosisSchema, historySchema, medicalOrderSchema, medicationSchema, noteCorrectionSchema, noteSaveSchema, orderResultSchema,
  prescriptionSchema, vitalsSchema,
} from '@medigest/shared';
import { z } from 'zod/v4';
import { AuditService } from '../../common/audit.service';
import { ClinicalAccessService } from '../../common/clinical-access';
import { AuthUser } from '../../common/context';
import { BusinessError } from '../../common/errors';
import { assertBranch, found } from '../../common/scope';
import { PrismaService } from '../../prisma/prisma.service';
import { ChargesService } from '../billing/charges.service';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class ClinicalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ClinicalAccessService,
    private readonly audit: AuditService,
    private readonly charges: ChargesService,
    private readonly queue: QueueService,
  ) {}

  private async encounterFor(user: AuthUser, id: string) {
    return found(await this.prisma.medicalEncounter.findFirst({ where: { id, organizationId: user.organizationId } }), 'Encuentro');
  }

  /** Para editar contenido clínico: encuentro abierto + profesional responsable. */
  private async editable(user: AuthUser, id: string) {
    const enc = await this.encounterFor(user, id);
    await this.access.assertWriteEncounter(user, enc);
    if (enc.status !== 'EN_CURSO') throw new BusinessError('El encuentro está firmado. Use la opción de corrección para modificar notas.', 'ENCUENTRO_FIRMADO');
    return enc;
  }

  async patientSummary(user: AuthUser, patientId: string) {
    await this.access.assertRead(user, patientId, 'resumen clínico');
    const [patient, allergies, medications, history, encounters] = await Promise.all([
      this.prisma.patient.findUniqueOrThrow({
        where: { id: patientId },
        select: { id: true, recordNumber: true, firstName: true, lastName: true, birthDate: true, sex: true, documentNumber: true },
      }),
      this.prisma.allergy.findMany({ where: { patientId }, orderBy: [{ active: 'desc' }, { createdAt: 'desc' }] }),
      this.prisma.medication.findMany({ where: { patientId }, orderBy: [{ active: 'desc' }, { createdAt: 'desc' }] }),
      this.prisma.medicalHistoryEntry.findMany({ where: { patientId, active: true }, orderBy: { createdAt: 'desc' } }),
      this.prisma.medicalEncounter.findMany({
        where: { patientId },
        include: {
          professional: { select: { title: true, firstName: true, lastName: true } },
          diagnoses: { where: { voidedAt: null }, select: { code: true, description: true, type: true } },
          notes: { where: { isCurrent: true, section: 'MOTIVO_CONSULTA' }, select: { content: true } },
          vitals: { orderBy: { recordedAt: 'desc' }, take: 1 },
        },
        orderBy: { startedAt: 'desc' },
      }),
    ]);
    return { patient, allergies, medications, history, encounters };
  }

  async startEncounter(user: AuthUser, input: { appointmentId: string | null; patientId: string; branchId: string | null }) {
    if (!user.professionalId) throw new ForbiddenException('Solo un profesional de la salud puede iniciar un encuentro');
    found(await this.prisma.patient.findFirst({ where: { id: input.patientId, organizationId: user.organizationId, status: 'ACTIVE' } }), 'Paciente');

    if (input.appointmentId) {
      const appt = found(
        await this.prisma.appointment.findFirst({ where: { id: input.appointmentId, organizationId: user.organizationId, patientId: input.patientId }, include: { encounter: true } }),
        'Cita',
      );
      if (appt.encounter) return appt.encounter; // Idempotente.
      if (appt.professionalId !== user.professionalId) throw new ForbiddenException('La cita está asignada a otro profesional');
      if (!['EN_ESPERA', 'EN_CONSULTA'].includes(appt.status)) {
        throw new BusinessError('Registre primero la llegada del paciente (estado "En espera")', 'SIN_LLEGADA');
      }
      const created = await this.prisma.$transaction(async (tx) => {
        const enc = await tx.medicalEncounter.create({
          data: {
            organizationId: user.organizationId, branchId: appt.branchId, patientId: appt.patientId, professionalId: user.professionalId!,
            appointmentId: appt.id, createdById: user.id,
          },
        });
        if (appt.status === 'EN_ESPERA') {
          await tx.appointment.update({ where: { id: appt.id }, data: { status: 'EN_CONSULTA' } });
          await tx.appointmentStatusHistory.create({ data: { appointmentId: appt.id, fromStatus: 'EN_ESPERA', toStatus: 'EN_CONSULTA', changedById: user.id, reason: 'Inicio de encuentro clínico' } });
        }
        await tx.patient.update({ where: { id: appt.patientId }, data: { lastVisitAt: new Date() } });
        await this.audit.log({ action: 'ENCUENTRO_INICIADO', entity: 'MedicalEncounter', entityId: enc.id, branchId: appt.branchId, details: { cita: appt.id } }, tx);
        return enc;
      });
      await this.queue.onAppointmentStatus(appt.id, 'EN_CONSULTA', user.id).catch(() => undefined);
      return created;
    }

    if (!input.branchId) throw new BusinessError('Indique la sucursal del encuentro');
    assertBranch(user, input.branchId);
    const enc = await this.prisma.medicalEncounter.create({
      data: { organizationId: user.organizationId, branchId: input.branchId, patientId: input.patientId, professionalId: user.professionalId, createdById: user.id },
    });
    await this.audit.log({ action: 'ENCUENTRO_INICIADO', entity: 'MedicalEncounter', entityId: enc.id, branchId: input.branchId, details: { sinCita: true } });
    return enc;
  }

  async getEncounter(user: AuthUser, id: string) {
    const enc = await this.encounterFor(user, id);
    await this.access.assertRead(user, enc.patientId, 'encuentro');
    const full = await this.prisma.medicalEncounter.findUniqueOrThrow({
      where: { id },
      include: {
        patient: { select: { id: true, recordNumber: true, firstName: true, lastName: true, birthDate: true, sex: true } },
        professional: { select: { id: true, title: true, firstName: true, lastName: true, exequatur: true } },
        appointment: { select: { id: true, startsAt: true, reason: true, serviceId: true, status: true } },
        notes: { orderBy: [{ section: 'asc' }, { version: 'desc' }] },
        vitals: { orderBy: { recordedAt: 'desc' } },
        diagnoses: { orderBy: { createdAt: 'asc' } },
        prescriptions: { include: { items: true }, orderBy: { createdAt: 'asc' } },
        orders: { orderBy: { createdAt: 'asc' } },
        documents: { where: { deletedAt: null }, include: { file: { select: { originalName: true, mimeType: true, sizeBytes: true } } } },
      },
    });
    const userIds = [...new Set([...full.notes.map((n) => n.authorId), full.signedById].filter((x): x is string => !!x))];
    const authors = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } });
    return { ...full, authors, canEdit: full.status === 'EN_CURSO' && (user.professionalId === full.professionalId) };
  }

  async saveNote(user: AuthUser, encounterId: string, input: z.infer<typeof noteSaveSchema>) {
    await this.editable(user, encounterId);
    const current = await this.prisma.clinicalNote.findFirst({ where: { encounterId, section: input.section, isCurrent: true } });
    const note = current
      ? await this.prisma.clinicalNote.update({ where: { id: current.id }, data: { content: input.content, authorId: user.id } })
      : await this.prisma.clinicalNote.create({ data: { encounterId, section: input.section, content: input.content, authorId: user.id } });
    // La auditoría registra la sección, nunca el contenido clínico.
    await this.audit.log({ action: current ? 'NOTA_EDITADA_BORRADOR' : 'NOTA_CREADA', entity: 'ClinicalNote', entityId: note.id, details: { encuentro: encounterId, seccion: input.section } });
    return note;
  }

  /** Corrección de una nota de un encuentro firmado: conserva el original y crea una versión nueva con motivo. */
  async correctNote(user: AuthUser, noteId: string, input: z.infer<typeof noteCorrectionSchema>) {
    const note = found(await this.prisma.clinicalNote.findFirst({ where: { id: noteId, encounter: { organizationId: user.organizationId } }, include: { encounter: true } }), 'Nota');
    await this.access.assertWriteEncounter(user, note.encounter);
    if (!user.permissions.has('clinical.sign')) throw new ForbiddenException('No tiene permiso para corregir notas firmadas');
    if (note.encounter.status !== 'FIRMADO') throw new BusinessError('El encuentro aún no está firmado; edite la nota directamente');
    if (!note.isCurrent) throw new BusinessError('Solo se puede corregir la versión vigente de la nota');
    if (note.content === input.content) throw new BusinessError('La corrección no cambia el contenido');
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.clinicalNote.update({ where: { id: note.id }, data: { isCurrent: false } });
      const v = await tx.clinicalNote.create({
        data: {
          encounterId: note.encounterId, section: note.section, content: input.content, version: note.version + 1, isCurrent: true,
          supersedesId: note.id, correctionReason: input.reason, authorId: user.id,
        },
      });
      await this.audit.log({ action: 'NOTA_CORREGIDA', entity: 'ClinicalNote', entityId: v.id, details: { original: note.id, version: v.version, motivo: input.reason } }, tx);
      return v;
    });
    return created;
  }

  async noteVersions(user: AuthUser, noteId: string) {
    const note = found(await this.prisma.clinicalNote.findFirst({ where: { id: noteId, encounter: { organizationId: user.organizationId } }, include: { encounter: true } }), 'Nota');
    await this.access.assertRead(user, note.encounter.patientId, 'versiones de nota');
    return this.prisma.clinicalNote.findMany({ where: { encounterId: note.encounterId, section: note.section }, orderBy: { version: 'desc' } });
  }

  async addVitals(user: AuthUser, encounterId: string, input: z.infer<typeof vitalsSchema>) {
    const enc = await this.encounterFor(user, encounterId);
    if (!(await this.access.canRead(user, enc.patientId))) throw new ForbiddenException('Sin relación asistencial con el paciente');
    if (enc.status !== 'EN_CURSO') throw new BusinessError('El encuentro ya fue firmado');
    const bmi = input.weightKg && input.heightCm ? Math.round((input.weightKg / (input.heightCm / 100) ** 2) * 100) / 100 : null;
    const v = await this.prisma.vitalSigns.create({
      data: {
        encounterId,
        recordedById: user.id,
        systolic: input.systolic,
        diastolic: input.diastolic,
        heartRate: input.heartRate,
        respiratoryRate: input.respiratoryRate,
        temperatureC: input.temperatureC != null ? new Prisma.Decimal(input.temperatureC) : null,
        spo2: input.spo2,
        weightKg: input.weightKg != null ? new Prisma.Decimal(input.weightKg) : null,
        heightCm: input.heightCm != null ? new Prisma.Decimal(input.heightCm) : null,
        bmi: bmi != null ? new Prisma.Decimal(bmi) : null,
        notes: input.notes,
      },
    });
    await this.audit.log({ action: 'SIGNOS_VITALES_REGISTRADOS', entity: 'VitalSigns', entityId: v.id, details: { encuentro: encounterId } });
    return v;
  }

  async addDiagnosis(user: AuthUser, encounterId: string, input: z.infer<typeof diagnosisSchema>) {
    await this.editable(user, encounterId);
    const d = await this.prisma.diagnosis.create({ data: { ...input, encounterId, createdById: user.id } });
    await this.audit.log({ action: 'DIAGNOSTICO_REGISTRADO', entity: 'Diagnosis', entityId: d.id, details: { encuentro: encounterId } });
    return d;
  }

  async voidDiagnosis(user: AuthUser, id: string, reason: string) {
    const d = found(await this.prisma.diagnosis.findFirst({ where: { id, encounter: { organizationId: user.organizationId } } }), 'Diagnóstico');
    await this.editable(user, d.encounterId);
    await this.prisma.diagnosis.update({ where: { id }, data: { voidedAt: new Date(), voidReason: reason } });
    await this.audit.log({ action: 'DIAGNOSTICO_ANULADO', entity: 'Diagnosis', entityId: id, details: { motivo: reason } });
    return { ok: true };
  }

  async addPrescription(user: AuthUser, encounterId: string, input: z.infer<typeof prescriptionSchema>) {
    await this.editable(user, encounterId);
    const p = await this.prisma.prescription.create({
      data: { encounterId, notes: input.notes, createdById: user.id, items: { create: input.items } },
      include: { items: true },
    });
    await this.audit.log({ action: 'RECETA_EMITIDA', entity: 'Prescription', entityId: p.id, details: { encuentro: encounterId, items: input.items.length } });
    return p;
  }

  async voidPrescription(user: AuthUser, id: string, reason: string) {
    const p = found(await this.prisma.prescription.findFirst({ where: { id, encounter: { organizationId: user.organizationId } }, include: { encounter: true } }), 'Receta');
    await this.access.assertWriteEncounter(user, p.encounter);
    if (p.voidedAt) throw new BusinessError('La receta ya está anulada');
    await this.prisma.prescription.update({ where: { id }, data: { voidedAt: new Date(), voidReason: reason } });
    await this.audit.log({ action: 'RECETA_ANULADA', entity: 'Prescription', entityId: id, details: { motivo: reason } });
    return { ok: true };
  }

  async addOrder(user: AuthUser, encounterId: string, input: z.infer<typeof medicalOrderSchema>) {
    await this.editable(user, encounterId);
    const o = await this.prisma.medicalOrder.create({ data: { ...input, encounterId, createdById: user.id } });
    await this.audit.log({ action: 'ORDEN_MEDICA_CREADA', entity: 'MedicalOrder', entityId: o.id, details: { tipo: input.type } });
    return o;
  }

  /** Los resultados pueden registrarse después de firmado el encuentro (llegan más tarde). */
  async orderResult(user: AuthUser, id: string, input: z.infer<typeof orderResultSchema>) {
    const o = found(await this.prisma.medicalOrder.findFirst({ where: { id, encounter: { organizationId: user.organizationId } }, include: { encounter: true } }), 'Orden');
    await this.access.assertWriteEncounter(user, o.encounter);
    if (o.status !== 'ORDENADA') throw new BusinessError('La orden ya fue cerrada');
    const updated = await this.prisma.medicalOrder.update({
      where: { id },
      data: { status: input.status, resultSummary: input.resultSummary, resultAt: new Date() },
    });
    await this.audit.log({ action: 'ORDEN_MEDICA_RESULTADO', entity: 'MedicalOrder', entityId: id, details: { estado: input.status } });
    return updated;
  }

  /**
   * Firma: cierra el encuentro (las notas quedan inmutables), completa la cita y genera el cargo del
   * servicio de la cita de forma idempotente.
   */
  async sign(user: AuthUser, encounterId: string) {
    const enc = await this.editable(user, encounterId);
    if (!user.permissions.has('clinical.sign')) throw new ForbiddenException('No tiene permiso para firmar encuentros');
    const notes = await this.prisma.clinicalNote.count({ where: { encounterId, isCurrent: true } });
    if (!notes) throw new BusinessError('Registre al menos una nota clínica antes de firmar');
    const appt = enc.appointmentId ? await this.prisma.appointment.findUnique({ where: { id: enc.appointmentId } }) : null;

    await this.prisma.$transaction(async (tx) => {
      const r = await tx.medicalEncounter.updateMany({
        where: { id: encounterId, status: 'EN_CURSO' },
        data: { status: 'FIRMADO', signedAt: new Date(), signedById: user.id },
      });
      if (!r.count) throw new BusinessError('El encuentro ya fue firmado');
      if (appt && appt.status === 'EN_CONSULTA') {
        await tx.appointment.update({ where: { id: appt.id }, data: { status: 'COMPLETADA' } });
        await tx.appointmentStatusHistory.create({ data: { appointmentId: appt.id, fromStatus: 'EN_CONSULTA', toStatus: 'COMPLETADA', changedById: user.id, reason: 'Encuentro firmado' } });
      }
      await this.audit.log({ action: 'ENCUENTRO_FIRMADO', entity: 'MedicalEncounter', entityId: encounterId, branchId: enc.branchId }, tx);
    });
    if (appt) await this.queue.onAppointmentStatus(appt.id, 'COMPLETADA', user.id).catch(() => undefined);
    let charge = null;
    if (appt?.serviceId) charge = await this.charges.createFromEncounter(user, enc as MedicalEncounter, appt.serviceId, appt.patientInsuranceId);
    return { ok: true, chargeId: charge?.id ?? null };
  }

  // ── Datos clínicos del paciente (alergias, medicamentos, antecedentes) ──

  private async patientWritable(user: AuthUser, patientId: string) {
    if (!user.permissions.has('clinical.write')) throw new ForbiddenException('No tiene permiso para modificar el expediente');
    if (!(await this.access.canRead(user, patientId))) throw new ForbiddenException('Sin relación asistencial con el paciente');
  }

  async addAllergy(user: AuthUser, patientId: string, input: z.infer<typeof allergySchema>) {
    await this.patientWritable(user, patientId);
    const a = await this.prisma.allergy.create({ data: { ...input, patientId, recordedById: user.id } });
    await this.audit.log({ action: 'ALERGIA_REGISTRADA', entity: 'Allergy', entityId: a.id, details: { paciente: patientId } });
    return a;
  }

  async setAllergyActive(user: AuthUser, id: string, active: boolean) {
    const a = found(await this.prisma.allergy.findFirst({ where: { id, patient: { organizationId: user.organizationId } } }), 'Alergia');
    await this.patientWritable(user, a.patientId);
    await this.prisma.allergy.update({ where: { id }, data: { active } });
    await this.audit.log({ action: active ? 'ALERGIA_REACTIVADA' : 'ALERGIA_INACTIVADA', entity: 'Allergy', entityId: id });
    return { ok: true };
  }

  async addMedication(user: AuthUser, patientId: string, input: z.infer<typeof medicationSchema>) {
    await this.patientWritable(user, patientId);
    const m = await this.prisma.medication.create({
      data: { ...input, startDate: input.startDate ? new Date(input.startDate) : null, patientId, recordedById: user.id },
    });
    await this.audit.log({ action: 'MEDICAMENTO_REGISTRADO', entity: 'Medication', entityId: m.id, details: { paciente: patientId } });
    return m;
  }

  async stopMedication(user: AuthUser, id: string) {
    const m = found(await this.prisma.medication.findFirst({ where: { id, patient: { organizationId: user.organizationId } } }), 'Medicamento');
    await this.patientWritable(user, m.patientId);
    await this.prisma.medication.update({ where: { id }, data: { active: false, endDate: new Date() } });
    await this.audit.log({ action: 'MEDICAMENTO_SUSPENDIDO', entity: 'Medication', entityId: id });
    return { ok: true };
  }

  async addHistory(user: AuthUser, patientId: string, input: z.infer<typeof historySchema>) {
    await this.patientWritable(user, patientId);
    const h = await this.prisma.medicalHistoryEntry.create({ data: { ...input, patientId, recordedById: user.id } });
    await this.audit.log({ action: 'ANTECEDENTE_REGISTRADO', entity: 'MedicalHistoryEntry', entityId: h.id, details: { paciente: patientId, tipo: input.kind } });
    return h;
  }
}

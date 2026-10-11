import { BadRequestException, Injectable } from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import {
  appointmentCreateSchema, appointmentRescheduleSchema, canTransition, minutesToHHMM, RESCHEDULABLE_STATUSES, utcToZonedParts,
  waitlistSchema, zonedToUtc,
} from '@medigest/shared';
import { z } from 'zod/v4';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { BusinessError } from '../../common/errors';
import { assertBranch, found } from '../../common/scope';
import { logger } from '../../common/logger';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { QueueService } from '../queue/queue.service';
import { SettingsService } from '../settings/settings.service';

const ACTIVE: AppointmentStatus[] = ['SOLICITADA', 'PENDIENTE_CONFIRMACION', 'CONFIRMADA', 'EN_ESPERA', 'EN_CONSULTA', 'COMPLETADA'];

export const appointmentInclude = {
  patient: { select: { id: true, recordNumber: true, firstName: true, lastName: true, phone: true, documentNumber: true } },
  professional: { select: { id: true, title: true, firstName: true, lastName: true } },
  specialty: { select: { id: true, name: true } },
  room: { select: { id: true, name: true } },
  patientInsurance: { select: { id: true, affiliateNumber: true, plan: { select: { name: true, insurer: { select: { name: true } } } } } },
  encounter: { select: { id: true, status: true } },
} satisfies Prisma.AppointmentInclude;

export interface Slot {
  start: string;
  end: string;
  label: string;
  roomId: string | null;
}

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly queue: QueueService,
  ) {}

  private async branchTz(organizationId: string, branchId: string) {
    const branch = found(await this.prisma.branch.findFirst({ where: { id: branchId, organizationId } }), 'Sucursal');
    return branch.timezone ?? (await this.settings.timezone(organizationId));
  }

  /**
   * Verifica que [start, end) caiga dentro del horario del profesional en la sucursal y no choque con bloqueos.
   * Devuelve el consultorio del bloque de horario si tiene uno asignado.
   */
  private async assertWithinSchedule(db: Tx | PrismaService, organizationId: string, professionalId: string, branchId: string, start: Date, end: Date) {
    const tz = await this.branchTz(organizationId, branchId);
    const s = utcToZonedParts(start, tz);
    const e = utcToZonedParts(end, tz);
    if (s.ymd !== e.ymd && e.minutes !== 0) throw new BusinessError('La cita no puede cruzar la medianoche');
    const endMinute = s.ymd === e.ymd ? e.minutes : 1440;
    const day = new Date(`${s.ymd}T00:00:00Z`);
    const schedules = await db.schedule.findMany({
      where: {
        professionalId, branchId, weekday: s.weekday, active: true,
        AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: day } }] }, { OR: [{ validTo: null }, { validTo: { gte: day } }] }],
      },
    });
    const block = schedules.find((sc) => sc.startMinute <= s.minutes && sc.endMinute >= endMinute);
    if (!block) {
      throw new BusinessError(`El médico no atiende en esa sucursal el ${s.ymd.split('-').reverse().join('/')} a las ${minutesToHHMM(s.minutes)}`, 'FUERA_DE_HORARIO');
    }
    const blocked = await db.scheduleBlock.findFirst({
      where: {
        organizationId,
        startsAt: { lt: end },
        endsAt: { gt: start },
        AND: [{ OR: [{ professionalId }, { professionalId: null }] }, { OR: [{ branchId }, { branchId: null }] }],
      },
    });
    if (blocked) throw new BusinessError(`La agenda está bloqueada en ese horario (${blocked.reason ?? blocked.type.toLowerCase()})`, 'AGENDA_BLOQUEADA');
    return block.roomId;
  }

  /** Espacios libres de un profesional en un día (fecha local de la sucursal). */
  async availability(user: AuthUser, professionalId: string, branchId: string, date: string, durationMin?: number): Promise<Slot[]> {
    assertBranch(user, branchId);
    const professional = found(
      await this.prisma.medicalProfessional.findFirst({ where: { id: professionalId, organizationId: user.organizationId, active: true } }),
      'Profesional',
    );
    const tz = await this.branchTz(user.organizationId, branchId);
    const duration = durationMin ?? professional.defaultDurationMin;
    const dayStart = zonedToUtc(date, 0, tz);
    const dayEnd = zonedToUtc(date, 1440, tz);
    const weekday = utcToZonedParts(new Date(dayStart.getTime() + 12 * 3600_000), tz).weekday;
    const day = new Date(`${date}T00:00:00Z`);
    const [schedules, blocks, appts] = await Promise.all([
      this.prisma.schedule.findMany({
        where: {
          professionalId, branchId, weekday, active: true,
          AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: day } }] }, { OR: [{ validTo: null }, { validTo: { gte: day } }] }],
        },
        orderBy: { startMinute: 'asc' },
      }),
      this.prisma.scheduleBlock.findMany({
        where: {
          organizationId: user.organizationId, startsAt: { lt: dayEnd }, endsAt: { gt: dayStart },
          AND: [{ OR: [{ professionalId }, { professionalId: null }] }, { OR: [{ branchId }, { branchId: null }] }],
        },
      }),
      this.prisma.appointment.findMany({
        where: { professionalId, startsAt: { lt: dayEnd }, endsAt: { gt: dayStart }, status: { in: ACTIVE } },
        select: { startsAt: true, endsAt: true },
      }),
    ]);
    const busy = [...blocks.map((b) => [b.startsAt.getTime(), b.endsAt.getTime()]), ...(professional.allowOverlap ? [] : appts.map((a) => [a.startsAt.getTime(), a.endsAt.getTime()]))];
    const now = Date.now();
    const slots: Slot[] = [];
    for (const sc of schedules) {
      for (let m = sc.startMinute; m + duration <= sc.endMinute; m += duration) {
        const start = zonedToUtc(date, m, tz);
        const end = new Date(start.getTime() + duration * 60000);
        if (start.getTime() < now) continue;
        if (busy.some(([bs, be]) => bs < end.getTime() && be > start.getTime())) continue;
        slots.push({ start: start.toISOString(), end: end.toISOString(), label: minutesToHHMM(m), roomId: sc.roomId });
      }
    }
    return slots;
  }

  async list(user: AuthUser, q: { from: string; to: string; professionalId?: string; branchId?: string; specialtyId?: string; status?: string; patientId?: string }) {
    if (q.branchId) assertBranch(user, q.branchId);
    const where: Prisma.AppointmentWhereInput = {
      organizationId: user.organizationId,
      startsAt: { lt: new Date(q.to) },
      endsAt: { gt: new Date(q.from) },
      ...(q.branchId ? { branchId: q.branchId } : user.allBranches ? {} : { branchId: { in: user.branchIds } }),
      ...(q.professionalId ? { professionalId: q.professionalId } : {}),
      ...(q.specialtyId ? { specialtyId: q.specialtyId } : {}),
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.status ? { status: { in: q.status.split(',') as AppointmentStatus[] } } : {}),
    };
    return this.prisma.appointment.findMany({ where, include: appointmentInclude, orderBy: { startsAt: 'asc' }, take: 2000 });
  }

  async get(user: AuthUser, id: string) {
    return found(
      await this.prisma.appointment.findFirst({
        where: { id, organizationId: user.organizationId },
        include: { ...appointmentInclude, history: { orderBy: { createdAt: 'desc' } }, notifications: { orderBy: { scheduledFor: 'asc' }, select: { id: true, type: true, channel: true, status: true, scheduledFor: true, testMode: true, lastError: true } } },
      }),
      'Cita',
    );
  }

  async create(user: AuthUser, input: z.infer<typeof appointmentCreateSchema>) {
    assertBranch(user, input.branchId);
    const settings = await this.settings.operational(user.organizationId);
    if (input.modality === 'VIRTUAL' && !settings.allowVirtualAppointments) throw new BusinessError('Las citas virtuales no están habilitadas');
    const [patient, professional, service] = await Promise.all([
      this.prisma.patient.findFirst({ where: { id: input.patientId, organizationId: user.organizationId } }),
      this.prisma.medicalProfessional.findFirst({
        where: { id: input.professionalId, organizationId: user.organizationId },
        include: { branches: true, specialties: true },
      }),
      input.serviceId ? this.prisma.service.findFirst({ where: { id: input.serviceId, organizationId: user.organizationId, active: true } }) : null,
    ]);
    found(patient, 'Paciente');
    found(professional, 'Profesional');
    if (patient!.status !== 'ACTIVE') throw new BusinessError('El paciente no está activo');
    if (!professional!.active) throw new BusinessError('El profesional no está activo');
    if (!professional!.branches.some((b) => b.branchId === input.branchId)) throw new BusinessError('El profesional no atiende en esa sucursal');
    if (input.serviceId && !service) throw new BadRequestException('Servicio inválido');
    if (input.specialtyId && !professional!.specialties.some((s) => s.specialtyId === input.specialtyId)) {
      throw new BusinessError('El profesional no tiene esa especialidad');
    }
    if (input.patientInsuranceId) {
      const ins = await this.prisma.patientInsurance.findFirst({ where: { id: input.patientInsuranceId, patientId: input.patientId, active: true } });
      if (!ins) throw new BadRequestException('La afiliación no pertenece al paciente o no está activa');
    }
    if (input.roomId) found(await this.prisma.consultationRoom.findFirst({ where: { id: input.roomId, branchId: input.branchId, active: true } }), 'Consultorio');

    const start = new Date(input.startsAt);
    if (start.getTime() < Date.now() - 5 * 60000) throw new BusinessError('No se pueden crear citas en el pasado');
    const duration = input.durationMin ?? service?.durationMin ?? professional!.defaultDurationMin;
    const end = new Date(start.getTime() + duration * 60000);

    const appt = await this.prisma.$transaction(async (tx) => {
      const scheduleRoom = await this.assertWithinSchedule(tx, user.organizationId, professional!.id, input.branchId, start, end);
      const status: AppointmentStatus = input.confirmed ? 'CONFIRMADA' : 'PENDIENTE_CONFIRMACION';
      // La restricción EXCLUDE de PostgreSQL rechaza el insert si otro usuario tomó el espacio en paralelo (→ 409).
      const created = await tx.appointment.create({
        data: {
          organizationId: user.organizationId,
          branchId: input.branchId,
          patientId: input.patientId,
          professionalId: input.professionalId,
          specialtyId: input.specialtyId ?? service?.specialtyId ?? professional!.specialties[0]?.specialtyId ?? null,
          serviceId: input.serviceId,
          roomId: input.roomId ?? scheduleRoom ?? null,
          patientInsuranceId: input.patientInsuranceId,
          startsAt: start,
          endsAt: end,
          status,
          modality: input.modality,
          reason: input.reason,
          notes: input.notes,
          overlapGuard: !professional!.allowOverlap,
          createdById: user.id,
        },
      });
      await tx.appointmentStatusHistory.create({ data: { appointmentId: created.id, toStatus: status, changedById: user.id, reason: 'Cita creada' } });
      if (input.waitlistEntryId) {
        await tx.waitlistEntry.updateMany({
          where: { id: input.waitlistEntryId, organizationId: user.organizationId, status: 'EN_ESPERA' },
          data: { status: 'AGENDADA', appointmentId: created.id },
        });
      }
      await this.audit.log({ action: 'CITA_CREADA', entity: 'Appointment', entityId: created.id, branchId: input.branchId, details: { inicio: start.toISOString(), profesional: input.professionalId } }, tx);
      return created;
    });
    await this.notify(appt.id, 'creada');
    return this.get(user, appt.id);
  }

  async reschedule(user: AuthUser, id: string, input: z.infer<typeof appointmentRescheduleSchema>) {
    const appt = found(await this.prisma.appointment.findFirst({ where: { id, organizationId: user.organizationId } }), 'Cita');
    assertBranch(user, appt.branchId);
    if (!RESCHEDULABLE_STATUSES.includes(appt.status)) throw new BusinessError('Solo se pueden reprogramar citas pendientes o confirmadas');
    const professionalId = input.professionalId ?? appt.professionalId;
    const professional = found(
      await this.prisma.medicalProfessional.findFirst({ where: { id: professionalId, organizationId: user.organizationId, active: true }, include: { branches: true } }),
      'Profesional',
    );
    if (!professional.branches.some((b) => b.branchId === appt.branchId)) throw new BusinessError('El profesional no atiende en esa sucursal');
    const start = new Date(input.startsAt);
    if (start.getTime() < Date.now()) throw new BusinessError('La nueva fecha debe ser futura');
    const duration = input.durationMin ?? Math.round((appt.endsAt.getTime() - appt.startsAt.getTime()) / 60000);
    const end = new Date(start.getTime() + duration * 60000);

    await this.prisma.$transaction(async (tx) => {
      const scheduleRoom = await this.assertWithinSchedule(tx, user.organizationId, professionalId, appt.branchId, start, end);
      await tx.appointment.update({
        where: { id },
        data: {
          startsAt: start, endsAt: end, professionalId, roomId: input.roomId ?? (input.professionalId ? scheduleRoom : appt.roomId),
          overlapGuard: !professional.allowOverlap, status: appt.status === 'CONFIRMADA' ? 'CONFIRMADA' : 'PENDIENTE_CONFIRMACION',
        },
      });
      await tx.appointmentStatusHistory.create({
        data: {
          appointmentId: id, fromStatus: appt.status, toStatus: appt.status === 'CONFIRMADA' ? 'CONFIRMADA' : 'PENDIENTE_CONFIRMACION',
          changedById: user.id, reason: input.reason,
          details: { reprogramada: { de: appt.startsAt.toISOString(), a: start.toISOString(), profesionalAnterior: appt.professionalId, profesionalNuevo: professionalId } },
        },
      });
      await this.audit.log({ action: 'CITA_REPROGRAMADA', entity: 'Appointment', entityId: id, branchId: appt.branchId, details: { de: appt.startsAt.toISOString(), a: start.toISOString(), motivo: input.reason } }, tx);
    });
    await this.notify(id, 'reprogramada');
    return this.get(user, id);
  }

  async changeStatus(user: AuthUser, id: string, to: AppointmentStatus, reason?: string | null) {
    const appt = found(await this.prisma.appointment.findFirst({ where: { id, organizationId: user.organizationId } }), 'Cita');
    assertBranch(user, appt.branchId);
    if (appt.status === to) return this.get(user, id);
    if (!canTransition(appt.status, to)) {
      throw new BusinessError(`No se puede pasar una cita de "${appt.status}" a "${to}"`, 'TRANSICION_INVALIDA');
    }
    if (to === 'CANCELADA' && !reason) throw new BusinessError('Indique el motivo de la cancelación');
    if (to === 'CANCELADA' && !user.permissions.has('appointments.write')) throw new BusinessError('No tiene permiso para cancelar citas');
    if (to === 'NO_ASISTIO' && appt.startsAt.getTime() > Date.now()) throw new BusinessError('No se puede marcar inasistencia antes de la hora de la cita');
    if (to === 'EN_CONSULTA' || to === 'COMPLETADA') {
      if (!user.professionalId && !user.permissions.has('clinical.write')) throw new BusinessError('Solo el personal clínico puede iniciar o completar la consulta');
    }

    const data: Prisma.AppointmentUpdateInput = { status: to };
    if (to === 'EN_ESPERA' && !appt.checkedInAt) data.checkedInAt = new Date();
    if (to === 'CANCELADA') Object.assign(data, { cancelledAt: new Date(), cancelReason: reason });
    await this.prisma.$transaction(async (tx) => {
      await tx.appointment.update({ where: { id }, data });
      await tx.appointmentStatusHistory.create({ data: { appointmentId: id, fromStatus: appt.status, toStatus: to, changedById: user.id, reason } });
      if (to === 'COMPLETADA' || to === 'EN_CONSULTA') await tx.patient.update({ where: { id: appt.patientId }, data: { lastVisitAt: new Date() } });
      await this.audit.log({ action: 'CITA_ESTADO', entity: 'Appointment', entityId: id, branchId: appt.branchId, details: { de: appt.status, a: to, motivo: reason } }, tx);
    });
    // El turno de la sala de espera acompaña el estado de la cita (no debe impedir la operación si falla).
    await this.queue.onAppointmentStatus(id, to, user.id).catch((e) => logger.error(`Turno no sincronizado: ${(e as Error).message}`, undefined, 'Appointments'));
    if (to === 'CANCELADA') await this.notify(id, 'cancelada');
    if (to === 'CONFIRMADA' && appt.status !== 'EN_ESPERA') await this.notify(id, 'confirmada');
    return this.get(user, id);
  }

  /** Las notificaciones no deben impedir la operación de agenda si fallan al programarse. */
  private async notify(id: string, event: 'creada' | 'reprogramada' | 'cancelada' | 'confirmada') {
    try {
      await this.notifications.onAppointmentEvent(id, event);
    } catch (e) {
      logger.error(`No se pudieron programar notificaciones de la cita: ${(e as Error).message}`, undefined, 'Appointments');
    }
  }

  // ── Lista de espera ──

  async waitlist(user: AuthUser, branchId?: string) {
    return this.prisma.waitlistEntry.findMany({
      where: {
        organizationId: user.organizationId, status: 'EN_ESPERA',
        ...(branchId ? { branchId } : user.allBranches ? {} : { branchId: { in: user.branchIds } }),
      },
      orderBy: { createdAt: 'asc' },
    }).then(async (entries) => {
      const patients = await this.prisma.patient.findMany({ where: { id: { in: entries.map((e) => e.patientId) } }, select: { id: true, firstName: true, lastName: true, recordNumber: true, phone: true } });
      const pros = await this.prisma.medicalProfessional.findMany({ where: { id: { in: entries.map((e) => e.professionalId).filter((x): x is string => !!x) } }, select: { id: true, title: true, firstName: true, lastName: true } });
      return entries.map((e) => ({ ...e, patient: patients.find((p) => p.id === e.patientId), professional: pros.find((p) => p.id === e.professionalId) ?? null }));
    });
  }

  async addToWaitlist(user: AuthUser, input: z.infer<typeof waitlistSchema>) {
    assertBranch(user, input.branchId);
    found(await this.prisma.patient.findFirst({ where: { id: input.patientId, organizationId: user.organizationId } }), 'Paciente');
    const entry = await this.prisma.waitlistEntry.create({
      data: {
        ...input,
        preferredFrom: input.preferredFrom ? new Date(input.preferredFrom) : null,
        preferredTo: input.preferredTo ? new Date(input.preferredTo) : null,
        organizationId: user.organizationId,
        createdById: user.id,
      },
    });
    await this.audit.log({ action: 'LISTA_ESPERA_AGREGADO', entity: 'WaitlistEntry', entityId: entry.id });
    return entry;
  }

  async cancelWaitlist(user: AuthUser, id: string) {
    const r = await this.prisma.waitlistEntry.updateMany({ where: { id, organizationId: user.organizationId, status: 'EN_ESPERA' }, data: { status: 'CANCELADA' } });
    if (!r.count) throw new BusinessError('La entrada no existe o ya fue atendida');
    await this.audit.log({ action: 'LISTA_ESPERA_CANCELADO', entity: 'WaitlistEntry', entityId: id });
    return { ok: true };
  }
}

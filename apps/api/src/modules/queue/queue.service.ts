import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AppointmentStatus, Prisma, QueueTicketStatus } from '@prisma/client';
import { displayScreenSchema, queueAreaSchema, queueTicketCreateSchema, utcToZonedParts } from '@medigest/shared';
import { z } from 'zod/v4';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { randomToken, sha256 } from '../../common/crypto';
import { BusinessError } from '../../common/errors';
import { assertBranch, found } from '../../common/scope';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

const ACTIVE: QueueTicketStatus[] = ['ESPERANDO', 'LLAMADO', 'ATENDIENDO'];

const ticketInclude = { area: { select: { id: true, code: true, name: true } } } satisfies Prisma.QueueTicketInclude;

@Injectable()
export class QueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  /** Fecha local de la sucursal (la numeración de turnos se reinicia cada día). */
  async today(branchId: string, db: Tx | PrismaService = this.prisma): Promise<string> {
    const branch = await db.branch.findUniqueOrThrow({ where: { id: branchId }, select: { timezone: true, organizationId: true } });
    const tz = branch.timezone ?? (await this.settings.timezone(branch.organizationId));
    return utcToZonedParts(new Date(), tz).ymd;
  }

  // ── Áreas ──

  areas(user: AuthUser, branchId?: string) {
    if (branchId) assertBranch(user, branchId);
    return this.prisma.queueArea.findMany({
      where: { organizationId: user.organizationId, ...(branchId ? { branchId } : user.allBranches ? {} : { branchId: { in: user.branchIds } }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async saveArea(user: AuthUser, id: string | null, input: z.infer<typeof queueAreaSchema>) {
    found(await this.prisma.branch.findFirst({ where: { id: input.branchId, organizationId: user.organizationId } }), 'Sucursal');
    if (id) found(await this.prisma.queueArea.findFirst({ where: { id, organizationId: user.organizationId } }), 'Área');
    const area = id
      ? await this.prisma.queueArea.update({ where: { id }, data: input })
      : await this.prisma.queueArea.create({ data: { ...input, organizationId: user.organizationId } });
    await this.audit.log({ action: id ? 'AREA_TURNOS_ACTUALIZADA' : 'AREA_TURNOS_CREADA', entity: 'QueueArea', entityId: area.id, details: { codigo: area.code } });
    return area;
  }

  // ── Emisión ──

  /** Crea un turno con el siguiente número del día para el área (seguro ante emisiones simultáneas). */
  private async create(tx: Tx, data: { organizationId: string; branchId: string; areaId: string; patientId?: string | null; appointmentId?: string | null; visitorName?: string | null; priority?: boolean; priorityReason?: string | null; transferredFromId?: string | null; createdById: string }) {
    const area = await tx.queueArea.findUniqueOrThrow({ where: { id: data.areaId } });
    const day = await this.today(data.branchId, tx);
    await tx.$executeRaw`INSERT INTO "QueueCounter" ("areaId", day, last) VALUES (${area.id}::uuid, ${day}, 0) ON CONFLICT DO NOTHING`;
    const [{ last }] = await tx.$queryRaw<{ last: number }[]>`
      UPDATE "QueueCounter" SET last = last + 1 WHERE "areaId" = ${area.id}::uuid AND day = ${day} RETURNING last`;
    return tx.queueTicket.create({
      data: {
        organizationId: data.organizationId,
        branchId: data.branchId,
        areaId: area.id,
        day,
        number: last,
        code: `${area.code}-${String(last).padStart(3, '0')}`,
        patientId: data.patientId ?? null,
        appointmentId: data.appointmentId ?? null,
        visitorName: data.visitorName ?? null,
        priority: data.priority ?? false,
        priorityReason: data.priorityReason ?? null,
        transferredFromId: data.transferredFromId ?? null,
        createdById: data.createdById,
      },
      include: ticketInclude,
    });
  }

  async issue(user: AuthUser, input: z.infer<typeof queueTicketCreateSchema>) {
    assertBranch(user, input.branchId);
    const area = found(await this.prisma.queueArea.findFirst({ where: { id: input.areaId, branchId: input.branchId, organizationId: user.organizationId, active: true } }), 'Área');
    if (input.patientId) found(await this.prisma.patient.findFirst({ where: { id: input.patientId, organizationId: user.organizationId } }), 'Paciente');
    if (input.priority && !input.priorityReason) throw new BusinessError('Indique el motivo de la prioridad (p. ej. embarazada, adulto mayor)');
    const ticket = await this.prisma.$transaction((tx) =>
      this.create(tx, { ...input, organizationId: user.organizationId, areaId: area.id, createdById: user.id }),
    );
    await this.audit.log({ action: 'TURNO_EMITIDO', entity: 'QueueTicket', entityId: ticket.id, branchId: input.branchId, details: { codigo: ticket.code, prioridad: ticket.priority } });
    return ticket;
  }

  /**
   * Sincroniza el turno con el estado de la cita: al registrar la llegada se emite en el área de check-in
   * (idempotente); en consulta pasa a atendiendo; al completar, cancelar o no asistir se cierra.
   */
  async onAppointmentStatus(appointmentId: string, status: AppointmentStatus, userId: string) {
    const appt = await this.prisma.appointment.findUnique({ where: { id: appointmentId } });
    if (!appt) return null;
    const active = await this.prisma.queueTicket.findFirst({ where: { appointmentId, status: { in: ACTIVE } }, orderBy: { createdAt: 'desc' } });
    if (status === 'EN_ESPERA') {
      if (active) return active;
      const area = await this.prisma.queueArea.findFirst({ where: { branchId: appt.branchId, autoCheckin: true, active: true }, orderBy: { sortOrder: 'asc' } });
      if (!area) return null;
      return this.prisma.$transaction((tx) =>
        this.create(tx, { organizationId: appt.organizationId, branchId: appt.branchId, areaId: area.id, patientId: appt.patientId, appointmentId, createdById: userId }),
      );
    }
    if (!active) return null;
    const data: Prisma.QueueTicketUpdateInput =
      status === 'EN_CONSULTA'
        ? { status: 'ATENDIENDO', servedAt: active.servedAt ?? new Date() }
        : status === 'COMPLETADA'
          ? { status: 'ATENDIDO', finishedAt: new Date() }
          : status === 'NO_ASISTIO'
            ? { status: 'NO_SE_PRESENTO', finishedAt: new Date() }
            : status === 'CANCELADA'
              ? { status: 'CANCELADO', finishedAt: new Date() }
              : {};
    if (!Object.keys(data).length) return active;
    return this.prisma.queueTicket.update({ where: { id: active.id }, data });
  }

  // ── Llamado ──

  /** Llama el siguiente turno: prioritarios primero y luego por orden de llegada. Dos puestos nunca toman el mismo. */
  async callNext(user: AuthUser, branchId: string, areaIds: string[], station: string) {
    assertBranch(user, branchId);
    const day = await this.today(branchId);
    const areaFilter = areaIds.length ? Prisma.sql`AND "areaId" = ANY(${areaIds}::uuid[])` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "QueueTicket" SET status = 'LLAMADO', station = ${station}, "calledAt" = now(), "calledCount" = "calledCount" + 1,
             "calledById" = ${user.id}::uuid, "updatedAt" = now()
      WHERE id = (
        SELECT id FROM "QueueTicket"
        WHERE "organizationId" = ${user.organizationId}::uuid AND "branchId" = ${branchId}::uuid AND day = ${day} AND status = 'ESPERANDO' ${areaFilter}
        ORDER BY priority DESC, "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`;
    if (!rows.length) return null;
    const ticket = await this.prisma.queueTicket.findUniqueOrThrow({ where: { id: rows[0].id }, include: ticketInclude });
    await this.audit.log({ action: 'TURNO_LLAMADO', entity: 'QueueTicket', entityId: ticket.id, branchId, details: { codigo: ticket.code, puesto: station } });
    return ticket;
  }

  async action(user: AuthUser, id: string, action: 'volver_a_llamar' | 'atender' | 'finalizar' | 'no_se_presento' | 'cancelar' | 'devolver_a_espera', station: string | null) {
    const t = found(await this.prisma.queueTicket.findFirst({ where: { id, organizationId: user.organizationId } }), 'Turno');
    assertBranch(user, t.branchId);
    if (!ACTIVE.includes(t.status)) throw new BusinessError('El turno ya fue cerrado');
    const now = new Date();
    const data: Prisma.QueueTicketUpdateInput = {
      volver_a_llamar: { status: 'LLAMADO' as const, calledAt: now, calledCount: { increment: 1 }, calledById: user.id, ...(station ? { station } : {}) },
      atender: { status: 'ATENDIENDO' as const, servedAt: t.servedAt ?? now, ...(station ? { station } : {}) },
      finalizar: { status: 'ATENDIDO' as const, finishedAt: now },
      no_se_presento: { status: 'NO_SE_PRESENTO' as const, finishedAt: now },
      cancelar: { status: 'CANCELADO' as const, finishedAt: now },
      devolver_a_espera: { status: 'ESPERANDO' as const, station: null, calledAt: null },
    }[action];
    if (action === 'volver_a_llamar' && !station && !t.station) throw new BadRequestException('Indique el puesto');
    const updated = await this.prisma.queueTicket.update({ where: { id }, data, include: ticketInclude });
    await this.audit.log({ action: `TURNO_${action.toUpperCase()}`, entity: 'QueueTicket', entityId: id, branchId: t.branchId, details: { codigo: t.code } });
    return updated;
  }

  /** Deriva a otra área (p. ej. de Consulta a Caja): cierra el turno actual y emite uno nuevo con los mismos datos. */
  async transfer(user: AuthUser, id: string, areaId: string) {
    const t = found(await this.prisma.queueTicket.findFirst({ where: { id, organizationId: user.organizationId } }), 'Turno');
    assertBranch(user, t.branchId);
    const area = found(await this.prisma.queueArea.findFirst({ where: { id: areaId, branchId: t.branchId, active: true } }), 'Área');
    if (area.id === t.areaId) throw new BusinessError('El turno ya está en esa área');
    const created = await this.prisma.$transaction(async (tx) => {
      if (ACTIVE.includes(t.status)) await tx.queueTicket.update({ where: { id }, data: { status: 'ATENDIDO', finishedAt: new Date() } });
      return this.create(tx, {
        organizationId: t.organizationId, branchId: t.branchId, areaId: area.id, patientId: t.patientId, appointmentId: null,
        visitorName: t.visitorName, priority: t.priority, priorityReason: t.priorityReason, transferredFromId: t.id, createdById: user.id,
      });
    });
    await this.audit.log({ action: 'TURNO_DERIVADO', entity: 'QueueTicket', entityId: created.id, branchId: t.branchId, details: { de: t.code, a: created.code } });
    return created;
  }

  /** Llama al paciente de una cita (desde la sala de espera o el médico). Si no tenía turno, se le emite. */
  async callAppointment(user: AuthUser, appointmentId: string, station: string) {
    const appt = found(await this.prisma.appointment.findFirst({ where: { id: appointmentId, organizationId: user.organizationId } }), 'Cita');
    assertBranch(user, appt.branchId);
    let ticket = await this.prisma.queueTicket.findFirst({ where: { appointmentId, status: { in: ACTIVE } }, orderBy: { createdAt: 'desc' } });
    if (!ticket) {
      if (appt.status !== 'EN_ESPERA') throw new BusinessError('Registre primero la llegada del paciente');
      ticket = (await this.onAppointmentStatus(appointmentId, 'EN_ESPERA', user.id)) ?? null;
      if (!ticket) throw new BusinessError('No hay un área de turnos configurada para recibir pacientes con cita');
    }
    return this.action(user, ticket.id, 'volver_a_llamar', station);
  }

  // ── Tablero del personal ──

  async board(user: AuthUser, branchId: string) {
    assertBranch(user, branchId);
    const day = await this.today(branchId);
    const tickets = await this.prisma.queueTicket.findMany({
      where: { organizationId: user.organizationId, branchId, day },
      include: ticketInclude,
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    const patientIds = [...new Set(tickets.map((t) => t.patientId).filter((x): x is string => !!x))];
    const patients = await this.prisma.patient.findMany({ where: { id: { in: patientIds } }, select: { id: true, firstName: true, lastName: true, recordNumber: true } });
    const withNames = tickets.map((t) => ({ ...t, patient: patients.find((p) => p.id === t.patientId) ?? null }));
    const served = tickets.filter((t) => t.calledAt);
    const avgWaitMin = served.length ? Math.round(served.reduce((a, t) => a + (t.calledAt!.getTime() - t.createdAt.getTime()), 0) / served.length / 60000) : null;
    return {
      day,
      waiting: withNames.filter((t) => t.status === 'ESPERANDO'),
      inProgress: withNames.filter((t) => t.status === 'LLAMADO' || t.status === 'ATENDIENDO').sort((a, b) => (b.calledAt?.getTime() ?? 0) - (a.calledAt?.getTime() ?? 0)),
      closed: withNames.filter((t) => !ACTIVE.includes(t.status)).slice(-30).reverse(),
      stats: { issued: tickets.length, waiting: tickets.filter((t) => t.status === 'ESPERANDO').length, served: tickets.filter((t) => t.status === 'ATENDIDO').length, avgWaitMin },
    };
  }

  // ── Pantallas de recepción ──

  screens(user: AuthUser) {
    return this.prisma.displayScreen.findMany({
      where: { organizationId: user.organizationId, active: true, ...(user.allBranches ? {} : { branchId: { in: user.branchIds } }) },
      select: { id: true, branchId: true, name: true, showNames: true, lastSeenAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Crea la pantalla y devuelve el enlace UNA sola vez (en la base solo queda el hash del token). */
  async createScreen(user: AuthUser, input: z.infer<typeof displayScreenSchema>) {
    found(await this.prisma.branch.findFirst({ where: { id: input.branchId, organizationId: user.organizationId } }), 'Sucursal');
    const token = randomToken(32);
    const screen = await this.prisma.displayScreen.create({ data: { ...input, organizationId: user.organizationId, tokenHash: sha256(token), createdById: user.id } });
    await this.audit.log({ action: 'PANTALLA_TURNOS_CREADA', entity: 'DisplayScreen', entityId: screen.id, details: { nombre: input.name } });
    return { id: screen.id, token };
  }

  async regenerateScreen(user: AuthUser, id: string) {
    found(await this.prisma.displayScreen.findFirst({ where: { id, organizationId: user.organizationId, active: true } }), 'Pantalla');
    const token = randomToken(32);
    await this.prisma.displayScreen.update({ where: { id }, data: { tokenHash: sha256(token) } });
    await this.audit.log({ action: 'PANTALLA_TURNOS_ENLACE_REGENERADO', entity: 'DisplayScreen', entityId: id });
    return { id, token };
  }

  async updateScreen(user: AuthUser, id: string, data: { name?: string; showNames?: boolean; active?: boolean }) {
    found(await this.prisma.displayScreen.findFirst({ where: { id, organizationId: user.organizationId } }), 'Pantalla');
    const s = await this.prisma.displayScreen.update({ where: { id }, data });
    await this.audit.log({ action: data.active === false ? 'PANTALLA_TURNOS_REVOCADA' : 'PANTALLA_TURNOS_ACTUALIZADA', entity: 'DisplayScreen', entityId: id });
    return { id: s.id };
  }

  /**
   * Datos públicos de la pantalla (sin sesión, con el token). Solo códigos de turno y puestos;
   * el nombre del paciente únicamente si la pantalla lo permite, y abreviado (Ana P.).
   */
  async publicDisplay(token: string) {
    if (!token || token.length > 100) throw new NotFoundException('Pantalla no encontrada');
    const screen = await this.prisma.displayScreen.findUnique({ where: { tokenHash: sha256(token) } });
    if (!screen || !screen.active) throw new NotFoundException('Pantalla no encontrada o revocada');
    if (!screen.lastSeenAt || Date.now() - screen.lastSeenAt.getTime() > 60_000) {
      await this.prisma.displayScreen.update({ where: { id: screen.id }, data: { lastSeenAt: new Date() } });
    }
    const [branch, org] = await Promise.all([
      this.prisma.branch.findUniqueOrThrow({ where: { id: screen.branchId }, select: { name: true, timezone: true } }),
      this.prisma.organization.findUniqueOrThrow({ where: { id: screen.organizationId }, select: { name: true, timezone: true } }),
    ]);
    const day = await this.today(screen.branchId);
    const tickets = await this.prisma.queueTicket.findMany({ where: { branchId: screen.branchId, day }, include: ticketInclude });
    let names = new Map<string, string>();
    if (screen.showNames) {
      const ids = [...new Set(tickets.map((t) => t.patientId).filter((x): x is string => !!x))];
      const patients = await this.prisma.patient.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } });
      names = new Map(patients.map((p) => [p.id, `${p.firstName.split(' ')[0]} ${p.lastName.charAt(0)}.`]));
    }
    const pub = (t: (typeof tickets)[number]) => ({
      id: t.id,
      code: t.code,
      area: t.area.name,
      station: t.station,
      status: t.status,
      calledAt: t.calledAt,
      calledCount: t.calledCount,
      priority: t.priority,
      name: screen.showNames ? (t.patientId ? names.get(t.patientId) ?? null : t.visitorName ? `${t.visitorName.split(' ')[0]}` : null) : null,
    });
    const called = tickets.filter((t) => t.calledAt && (t.status === 'LLAMADO' || t.status === 'ATENDIENDO')).sort((a, b) => b.calledAt!.getTime() - a.calledAt!.getTime());
    const areas = await this.prisma.queueArea.findMany({ where: { branchId: screen.branchId, active: true }, orderBy: { sortOrder: 'asc' } });
    return {
      organization: org.name,
      branch: branch.name,
      timezone: branch.timezone ?? org.timezone,
      showNames: screen.showNames,
      serverTime: new Date().toISOString(),
      current: called[0] ? pub(called[0]) : null,
      recent: called.slice(1, 7).map(pub),
      waitingByArea: areas.map((a) => ({ area: a.name, code: a.code, waiting: tickets.filter((t) => t.areaId === a.id && t.status === 'ESPERANDO').length })),
    };
  }
}

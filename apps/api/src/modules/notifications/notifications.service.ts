import { Injectable } from '@nestjs/common';
import { ConsentType, NotificationChannel, NotificationStatus, NotificationType, Prisma } from '@prisma/client';
import { formatDate, formatMoney, formatTime, renderTemplate } from '@medigest/shared';
import { logger } from '../../common/logger';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { ChannelNotConfigured, ChannelSender } from './channels';

export type AppointmentEvent = 'creada' | 'reprogramada' | 'cancelada' | 'confirmada';

const CHANNEL_CONSENT: Record<NotificationChannel, ConsentType> = {
  WHATSAPP: 'COMUNICACION_WHATSAPP',
  SMS: 'COMUNICACION_SMS',
  EMAIL: 'COMUNICACION_EMAIL',
};

const REMINDER_TYPES: NotificationType[] = ['CITA_RECORDATORIO', 'CITA_PENDIENTE_CONFIRMAR'];

/** Plantillas iniciales. No incluyen información clínica. */
export const DEFAULT_TEMPLATES: { type: NotificationType; subject: string; body: string }[] = [
  { type: 'CITA_CONFIRMACION', subject: 'Cita confirmada', body: 'Hola {{nombre}}, su cita con {{medico}} quedó confirmada para el {{fecha}} a las {{hora}} en {{ubicacion}}. {{centro}}' },
  { type: 'CITA_PENDIENTE_CONFIRMAR', subject: 'Confirme su cita', body: 'Hola {{nombre}}, tiene una cita con {{medico}} el {{fecha}} a las {{hora}} en {{ubicacion}}. Por favor confirme su asistencia. {{centro}}' },
  { type: 'CITA_RECORDATORIO', subject: 'Recordatorio de cita', body: 'Hola {{nombre}}, le recordamos su cita con {{medico}} el {{fecha}} a las {{hora}} en {{ubicacion}}. {{centro}}' },
  { type: 'CITA_CAMBIO', subject: 'Cambio en su cita', body: 'Hola {{nombre}}, su cita con {{medico}} fue reprogramada para el {{fecha}} a las {{hora}} en {{ubicacion}}. {{centro}}' },
  { type: 'CITA_CANCELACION', subject: 'Cita cancelada', body: 'Hola {{nombre}}, su cita con {{medico}} del {{fecha}} a las {{hora}} fue cancelada. Para reprogramar comuníquese con {{centro}}.' },
  { type: 'SALDO_PENDIENTE', subject: 'Saldo pendiente', body: 'Hola {{nombre}}, le informamos que tiene un saldo pendiente de {{monto}} en {{centro}}. Puede pasar por caja o comunicarse con nosotros.' },
];

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly sender: ChannelSender,
  ) {}

  /** Programa los mensajes de una cita según el evento. Idempotente: reintentar no duplica envíos. */
  async onAppointmentEvent(appointmentId: string, event: AppointmentEvent) {
    const appt = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { patient: true, professional: true },
    });
    if (!appt) return;
    const [org, branch, settings, templates] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: appt.organizationId } }),
      this.prisma.branch.findUniqueOrThrow({ where: { id: appt.branchId } }),
      this.settings.operational(appt.organizationId),
      this.prisma.notificationTemplate.findMany({ where: { organizationId: appt.organizationId, active: true } }),
    ]);

    // Cualquier cambio invalida los recordatorios pendientes de la versión anterior de la cita.
    if (event === 'reprogramada' || event === 'cancelada') {
      await this.prisma.notification.updateMany({
        where: { appointmentId, status: 'PENDIENTE', type: { in: REMINDER_TYPES } },
        data: { status: 'CANCELADO', lastError: `Cita ${event}` },
      });
    }

    const tz = branch.timezone ?? org.timezone;
    const vars = {
      nombre: appt.patient.firstName,
      medico: `${appt.professional.title} ${appt.professional.firstName} ${appt.professional.lastName}`,
      fecha: formatDate(appt.startsAt, tz),
      hora: formatTime(appt.startsAt, tz, !settings.timeFormat24h),
      ubicacion: [branch.name, branch.address].filter(Boolean).join(', '),
      centro: settings.productName === 'MediGest' ? org.name : settings.productName,
    };
    const startIso = appt.startsAt.toISOString();
    const now = Date.now();
    const rows: Prisma.NotificationCreateManyInput[] = [];

    for (const channel of settings.notificationChannels as NotificationChannel[]) {
      const recipient = channel === 'EMAIL' ? appt.patient.email : appt.patient.phoneNormalized;
      if (!recipient) continue;
      const push = (type: NotificationType, scheduledFor: Date, key: string) => {
        const tpl = templates.find((t) => t.type === type && t.channel === channel);
        if (!tpl) return;
        rows.push({
          organizationId: appt.organizationId,
          patientId: appt.patientId,
          appointmentId,
          type,
          channel,
          recipient,
          subject: tpl.subject ? renderTemplate(tpl.subject, vars) : null,
          body: renderTemplate(tpl.body, vars),
          scheduledFor,
          idempotencyKey: key,
        });
      };
      const immediate = new Date();
      if (event === 'creada') {
        const type = appt.status === 'CONFIRMADA' ? 'CITA_CONFIRMACION' : 'CITA_PENDIENTE_CONFIRMAR';
        push(type, immediate, `${type}:${appointmentId}:${channel}:${startIso}`);
      } else if (event === 'confirmada') {
        push('CITA_CONFIRMACION', immediate, `CITA_CONFIRMACION:${appointmentId}:${channel}:${startIso}`);
      } else if (event === 'reprogramada') {
        push('CITA_CAMBIO', immediate, `CITA_CAMBIO:${appointmentId}:${channel}:${startIso}`);
      } else if (event === 'cancelada') {
        push('CITA_CANCELACION', immediate, `CITA_CANCELACION:${appointmentId}:${channel}`);
      }
      if (event !== 'cancelada') {
        for (const offset of settings.reminderOffsetsMinutes) {
          const at = new Date(appt.startsAt.getTime() - offset * 60000);
          if (at.getTime() > now) push('CITA_RECORDATORIO', at, `CITA_RECORDATORIO:${appointmentId}:${channel}:${offset}:${startIso}`);
        }
      }
    }
    if (rows.length) await this.prisma.notification.createMany({ data: rows, skipDuplicates: true });
  }

  /** Aviso administrativo de saldo pendiente (sin detalle de servicios). Una vez por día como máximo. */
  async queueBalanceReminder(organizationId: string, patientId: string, balance: string) {
    const [patient, org, settings, templates] = await Promise.all([
      this.prisma.patient.findFirstOrThrow({ where: { id: patientId, organizationId } }),
      this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
      this.settings.operational(organizationId),
      this.prisma.notificationTemplate.findMany({ where: { organizationId, type: 'SALDO_PENDIENTE', active: true } }),
    ]);
    const day = new Date().toISOString().slice(0, 10);
    const vars = { nombre: patient.firstName, monto: formatMoney(balance, org.currency), centro: org.name };
    const rows: Prisma.NotificationCreateManyInput[] = [];
    for (const channel of settings.notificationChannels as NotificationChannel[]) {
      const recipient = channel === 'EMAIL' ? patient.email : patient.phoneNormalized;
      const tpl = templates.find((t) => t.channel === channel);
      if (!recipient || !tpl) continue;
      rows.push({
        organizationId, patientId, type: 'SALDO_PENDIENTE', channel, recipient,
        subject: tpl.subject, body: renderTemplate(tpl.body, vars), scheduledFor: new Date(),
        idempotencyKey: `SALDO_PENDIENTE:${patientId}:${channel}:${day}`,
      });
    }
    const r = await this.prisma.notification.createMany({ data: rows, skipDuplicates: true });
    return { queued: r.count };
  }

  /**
   * Procesa la cola: reclama lotes con FOR UPDATE SKIP LOCKED (seguro con varias instancias),
   * valida consentimiento y vigencia, envía y registra el resultado con reintentos limitados.
   */
  async processDue(limit = 20): Promise<number> {
    const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "Notification" SET "lockedAt" = now()
      WHERE id IN (
        SELECT id FROM "Notification"
        WHERE status = 'PENDIENTE' AND "scheduledFor" <= now()
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
          AND ("lockedAt" IS NULL OR "lockedAt" < now() - interval '5 minutes')
        ORDER BY "scheduledFor" LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ) RETURNING id`;
    for (const { id } of claimed) await this.processOne(id);
    return claimed.length;
  }

  private async processOne(id: string) {
    const n = await this.prisma.notification.findUnique({ where: { id }, include: { appointment: true } });
    if (!n || n.status !== 'PENDIENTE') return;
    const finish = (status: NotificationStatus, data: Prisma.NotificationUpdateInput = {}) =>
      this.prisma.notification.update({ where: { id }, data: { status, lockedAt: null, ...data } });

    if (REMINDER_TYPES.includes(n.type) && n.appointment) {
      if (['CANCELADA', 'NO_ASISTIO', 'COMPLETADA', 'EN_CONSULTA'].includes(n.appointment.status)) {
        return finish('CANCELADO', { lastError: 'La cita ya no está vigente' });
      }
      if (n.appointment.startsAt.getTime() < Date.now()) return finish('OMITIDO', { lastError: 'La cita ya pasó' });
    }
    if (n.patientId) {
      const consent = await this.prisma.patientConsent.findFirst({
        where: { patientId: n.patientId, type: CHANNEL_CONSENT[n.channel] },
        orderBy: { recordedAt: 'desc' },
      });
      if (!consent || !consent.granted || consent.revokedAt) {
        return finish('OMITIDO', { lastError: 'Sin consentimiento vigente para este canal' });
      }
    }
    try {
      const result = await this.sender.send({ channel: n.channel, recipient: n.recipient, subject: n.subject, body: n.body });
      await finish('ENVIADO', {
        attempts: { increment: 1 },
        sentAt: new Date(),
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        testMode: result.testMode,
        lastError: null,
      });
    } catch (e) {
      const attempts = n.attempts + 1;
      const message = String((e as Error).message).slice(0, 300);
      const terminal = e instanceof ChannelNotConfigured || attempts >= n.maxAttempts;
      logger.warn(`Fallo de envío ${n.channel} (intento ${attempts}): ${message}`, 'Notifications');
      await finish(terminal ? 'FALLIDO' : 'PENDIENTE', {
        attempts,
        lastError: message,
        nextAttemptAt: terminal ? null : new Date(Date.now() + 2 ** attempts * 60000),
      });
    }
  }

  /** Estado informado por el proveedor (webhook). ENTREGADO solo si el proveedor lo confirma. */
  async applyProviderStatus(provider: string, providerMessageId: string, status: 'delivered' | 'read' | 'failed', error?: string) {
    const n = await this.prisma.notification.findFirst({ where: { provider, providerMessageId } });
    if (!n || n.testMode) return;
    if (status === 'failed') {
      await this.prisma.notification.update({ where: { id: n.id }, data: { status: 'FALLIDO', lastError: error?.slice(0, 300) ?? 'Fallo informado por el proveedor' } });
    } else if (n.status === 'ENVIADO') {
      await this.prisma.notification.update({ where: { id: n.id }, data: { status: 'ENTREGADO', deliveredAt: new Date() } });
    }
  }

  async retry(organizationId: string, id: string) {
    const r = await this.prisma.notification.updateMany({
      where: { id, organizationId, status: 'FALLIDO' },
      data: { status: 'PENDIENTE', attempts: 0, nextAttemptAt: null, lockedAt: null, scheduledFor: new Date() },
    });
    return { retried: r.count === 1 };
  }

  async ensureDefaultTemplates(organizationId: string) {
    const data = DEFAULT_TEMPLATES.flatMap((t) =>
      (['EMAIL', 'WHATSAPP', 'SMS'] as NotificationChannel[]).map((channel) => ({
        organizationId, type: t.type, channel, subject: channel === 'EMAIL' ? t.subject : null, body: t.body,
      })),
    );
    await this.prisma.notificationTemplate.createMany({ data, skipDuplicates: true });
  }
}

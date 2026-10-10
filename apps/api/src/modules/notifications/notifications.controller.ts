import { Controller, ForbiddenException, Get, HttpCode, Injectable, OnModuleDestroy, OnModuleInit, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { maskRecipient, templateSchema } from '@medigest/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod/v4';
import { config } from '../../config';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/context';
import { CurrentUser, Public, RequirePermissions } from '../../common/decorators';
import { logger } from '../../common/logger';
import { listQuery, page, paginate, ZBody, ZQuery } from '../../common/zod.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

const notifQuery = listQuery.extend({
  status: z.string().optional(),
  channel: z.string().optional(),
  appointmentId: z.uuid().optional(),
  patientId: z.uuid().optional(),
});

@ApiTags('notificaciones')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly service: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('notifications.read')
  async list(@CurrentUser() user: AuthUser, @ZQuery(notifQuery) q: z.infer<typeof notifQuery>) {
    const where = {
      organizationId: user.organizationId,
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.channel ? { channel: q.channel as never } : {}),
      ...(q.appointmentId ? { appointmentId: q.appointmentId } : {}),
      ...(q.patientId ? { patientId: q.patientId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { scheduledFor: 'desc' }, ...paginate(q) }),
      this.prisma.notification.count({ where }),
    ]);
    // El destinatario se enmascara en el listado.
    return page(items.map((n) => ({ ...n, recipient: maskRecipient(n.recipient) })), total, q);
  }

  @Post(':id/retry')
  @HttpCode(200)
  @RequirePermissions('notifications.manage')
  async retry(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.service.retry(user.organizationId, id);
    await this.audit.log({ action: 'NOTIFICACION_REINTENTO', entity: 'Notification', entityId: id });
    return r;
  }

  @Post('process')
  @HttpCode(200)
  @RequirePermissions('notifications.manage')
  async processNow() {
    return { processed: await this.service.processDue(50) };
  }

  @Get('templates')
  @RequirePermissions('notifications.read')
  templates(@CurrentUser() user: AuthUser) {
    return this.prisma.notificationTemplate.findMany({ where: { organizationId: user.organizationId }, orderBy: [{ type: 'asc' }, { channel: 'asc' }] });
  }

  @Put('templates/:id')
  @RequirePermissions('notifications.manage')
  async updateTemplate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(templateSchema) body: z.infer<typeof templateSchema>) {
    const tpl = await this.prisma.notificationTemplate.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!tpl) throw new ForbiddenException('Plantilla no encontrada');
    const updated = await this.prisma.notificationTemplate.update({ where: { id }, data: { ...body, updatedById: user.id } });
    await this.audit.log({ action: 'PLANTILLA_ACTUALIZADA', entity: 'NotificationTemplate', entityId: id, details: { type: tpl.type, channel: tpl.channel } });
    return updated;
  }
}

/** Webhooks de proveedores: validados por firma, sin sesión. */
@ApiTags('webhooks')
@SkipThrottle()
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly service: NotificationsService) {}

  /** Verificación de suscripción de Meta. */
  @Public()
  @Get('whatsapp')
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string, @Res() res: Response) {
    if (mode === 'subscribe' && config.WHATSAPP_WEBHOOK_VERIFY_TOKEN && token === config.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  @Public()
  @Post('whatsapp')
  @HttpCode(200)
  async whatsapp(@Req() req: Request & { rawBody?: Buffer }) {
    const secret = config.WHATSAPP_APP_SECRET;
    const signature = req.get('x-hub-signature-256') ?? '';
    if (!secret || !req.rawBody) throw new ForbiddenException('Webhook no configurado');
    const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(req.rawBody).digest('hex')}`);
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new ForbiddenException('Firma inválida');
    const body = req.body as { entry?: { changes?: { value?: { statuses?: { id: string; status: string; errors?: { title?: string }[] }[] } }[] }[] };
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const s of change.value?.statuses ?? []) {
          if (s.status === 'delivered' || s.status === 'read' || s.status === 'failed') {
            await this.service.applyProviderStatus('whatsapp-cloud', s.id, s.status, s.errors?.[0]?.title);
          }
        }
      }
    }
    return { ok: true };
  }

  /** Callback de estado de Twilio. Valida X-Twilio-Signature (HMAC-SHA1 de URL + parámetros ordenados). */
  @Public()
  @Post('sms/status')
  @HttpCode(200)
  async smsStatus(@Req() req: Request) {
    const token = config.TWILIO_AUTH_TOKEN;
    if (!token) throw new ForbiddenException('Webhook no configurado');
    const params = req.body as Record<string, string>;
    const url = `${config.PUBLIC_API_URL ?? ''}${req.originalUrl}`;
    const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
    const expected = Buffer.from(createHmac('sha1', token).update(data).digest('base64'));
    const given = Buffer.from(req.get('x-twilio-signature') ?? '');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new ForbiddenException('Firma inválida');
    const map: Record<string, 'delivered' | 'failed'> = { delivered: 'delivered', failed: 'failed', undelivered: 'failed' };
    const status = map[params.MessageStatus];
    if (status) await this.service.applyProviderStatus('twilio', params.MessageSid, status, params.ErrorCode);
    return { ok: true };
  }
}

/** Ejecuta la cola periódicamente. Con varias instancias es seguro gracias a SKIP LOCKED. */
@Injectable()
export class NotificationsWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly service: NotificationsService) {}

  onModuleInit() {
    if (!config.JOBS_ENABLED || config.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), 20_000);
    logger.log(`Cola de notificaciones activa (modo ${config.NOTIFICATIONS_MODE}${config.REDIS_URL ? ', REDIS_URL definido' : ', cola en PostgreSQL'})`, 'NotificationsWorker');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.service.processDue();
    } catch (e) {
      logger.error(`Error procesando notificaciones: ${(e as Error).message}`, undefined, 'NotificationsWorker');
    } finally {
      this.running = false;
    }
  }
}

import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { formatDate, formatTime, displayScreenSchema, queueActionSchema, queueAreaSchema, queueCallSchema, queueTicketCreateSchema, queueTransferSchema } from '@medigest/shared';
import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import { z } from 'zod/v4';
import { AuthUser } from '../../common/context';
import { CurrentUser, Public, RequirePermissions } from '../../common/decorators';
import { found } from '../../common/scope';
import { ApiZBody, ZBody, ZQuery } from '../../common/zod.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueService } from './queue.service';

@ApiTags('turnos')
@Controller('queue')
export class QueueController {
  constructor(
    private readonly queue: QueueService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('areas')
  areas(@CurrentUser() user: AuthUser, @ZQuery(z.object({ branchId: z.uuid().optional() })) q: { branchId?: string }) {
    return this.queue.areas(user, q.branchId);
  }

  @Post('areas')
  @RequirePermissions('queue.configure')
  createArea(@CurrentUser() user: AuthUser, @ZBody(queueAreaSchema) body: z.infer<typeof queueAreaSchema>) {
    return this.queue.saveArea(user, null, body);
  }

  @Put('areas/:id')
  @RequirePermissions('queue.configure')
  updateArea(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(queueAreaSchema) body: z.infer<typeof queueAreaSchema>) {
    return this.queue.saveArea(user, id, body);
  }

  @Get('board')
  @RequirePermissions('queue.manage')
  board(@CurrentUser() user: AuthUser, @ZQuery(z.object({ branchId: z.uuid() })) q: { branchId: string }) {
    return this.queue.board(user, q.branchId);
  }

  @Post('tickets')
  @RequirePermissions('queue.manage')
  @ApiZBody(queueTicketCreateSchema)
  issue(@CurrentUser() user: AuthUser, @ZBody(queueTicketCreateSchema) body: z.infer<typeof queueTicketCreateSchema>) {
    return this.queue.issue(user, body);
  }

  @Post('call-next')
  @HttpCode(200)
  @RequirePermissions('queue.manage')
  async callNext(@CurrentUser() user: AuthUser, @ZBody(queueCallSchema) body: z.infer<typeof queueCallSchema>) {
    return { ticket: await this.queue.callNext(user, body.branchId, body.areaIds, body.station) };
  }

  @Post('tickets/:id/action')
  @HttpCode(200)
  @RequirePermissions('queue.manage')
  action(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(queueActionSchema) body: z.infer<typeof queueActionSchema>) {
    return this.queue.action(user, id, body.action, body.station);
  }

  @Post('tickets/:id/transfer')
  @RequirePermissions('queue.manage')
  transfer(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(queueTransferSchema) body: z.infer<typeof queueTransferSchema>) {
    return this.queue.transfer(user, id, body.areaId);
  }

  @Post('appointments/:appointmentId/call')
  @HttpCode(200)
  @RequirePermissions('queue.manage')
  callAppointment(@CurrentUser() user: AuthUser, @Param('appointmentId', ParseUUIDPipe) appointmentId: string, @ZBody(z.object({ station: z.string().trim().min(1).max(40) })) body: { station: string }) {
    return this.queue.callAppointment(user, appointmentId, body.station);
  }

  /** Ticket impreso (80 mm) para entregar a quien llega sin cita. */
  @Get('tickets/:id/print')
  @RequirePermissions('queue.manage')
  async print(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const t = found(await this.prisma.queueTicket.findFirst({ where: { id, organizationId: user.organizationId }, include: { area: true } }), 'Turno');
    const [org, branch, ahead] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: t.organizationId } }),
      this.prisma.branch.findUniqueOrThrow({ where: { id: t.branchId } }),
      this.prisma.queueTicket.count({ where: { areaId: t.areaId, day: t.day, status: 'ESPERANDO', createdAt: { lt: t.createdAt } } }),
    ]);
    const tz = branch.timezone ?? org.timezone;
    const doc = new PDFDocument({ size: [226.77, 300], margin: 14, info: { Title: `Turno ${t.code}`, Creator: 'Clinzora' } });
    const chunks: Buffer[] = [];
    doc.on('data', (d: Buffer) => chunks.push(d));
    const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
    const w = 226.77 - 28;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0B2E4F').text(org.name, { width: w, align: 'center' });
    doc.font('Helvetica').fontSize(8.5).fillColor('#334155').text(branch.name, { width: w, align: 'center' });
    doc.moveDown(0.8);
    doc.font('Helvetica').fontSize(10).fillColor('#0f172a').text(`Turno · ${t.area.name}`, { width: w, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(46).text(t.code, { width: w, align: 'center' });
    if (t.priority) doc.font('Helvetica-Bold').fontSize(9).fillColor('#b45309').text(`PRIORITARIO${t.priorityReason ? ` · ${t.priorityReason}` : ''}`, { width: w, align: 'center' });
    doc.moveDown(0.6);
    doc.font('Helvetica').fontSize(9).fillColor('#334155').text(`${formatDate(t.createdAt, tz)} ${formatTime(t.createdAt, tz)}`, { width: w, align: 'center' });
    doc.text(ahead === 0 ? 'Usted es el siguiente en la fila' : `Personas antes que usted: ${ahead}`, { width: w, align: 'center' });
    doc.moveDown(0.6);
    doc.fontSize(8).text('Espere a ver su turno en la pantalla.', { width: w, align: 'center' });
    doc.fontSize(7).fillColor('#64748b').text('Clinzora · un producto de KonviaRD', { width: w, align: 'center' });
    doc.end();
    const buffer = await done;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="turno-${t.code}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  }

  // ── Pantallas ──

  @Get('screens')
  @RequirePermissions('queue.configure')
  screens(@CurrentUser() user: AuthUser) {
    return this.queue.screens(user);
  }

  @Post('screens')
  @RequirePermissions('queue.configure')
  createScreen(@CurrentUser() user: AuthUser, @ZBody(displayScreenSchema) body: z.infer<typeof displayScreenSchema>) {
    return this.queue.createScreen(user, body);
  }

  @Post('screens/:id/regenerate')
  @HttpCode(200)
  @RequirePermissions('queue.configure')
  regenerate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.queue.regenerateScreen(user, id);
  }

  @Put('screens/:id')
  @RequirePermissions('queue.configure')
  updateScreen(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(z.object({ name: z.string().trim().min(2).max(60).optional(), showNames: z.boolean().optional(), active: z.boolean().optional() })) body: { name?: string; showNames?: boolean; active?: boolean }) {
    return this.queue.updateScreen(user, id, body);
  }
}

/** Pantalla de recepción: pública con el token secreto del enlace (sin sesión). */
@ApiTags('turnos')
@Controller('public/display')
export class PublicDisplayController {
  constructor(private readonly queue: QueueService) {}

  @Public()
  @Get(':token')
  display(@Param('token') token: string) {
    return this.queue.publicDisplay(token);
  }
}

import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { appointmentCreateSchema, appointmentRescheduleSchema, appointmentStatusSchema, waitlistSchema } from '@medigest/shared';
import { z } from 'zod/v4';
import { AuthUser } from '../../common/context';
import { CurrentUser, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { ApiZBody, ZBody, ZQuery } from '../../common/zod.pipe';
import { AppointmentsService } from './appointments.service';

const listSchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  professionalId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  specialtyId: z.uuid().optional(),
  patientId: z.uuid().optional(),
  status: z.string().max(200).optional(),
});
const availabilitySchema = z.object({
  professionalId: z.uuid(),
  branchId: z.uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMin: z.coerce.number().int().min(5).max(480).optional(),
});

@ApiTags('citas')
@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly service: AppointmentsService) {}

  @Get()
  @RequirePermissions('appointments.read')
  list(@CurrentUser() user: AuthUser, @ZQuery(listSchema) q: z.infer<typeof listSchema>) {
    return this.service.list(user, q);
  }

  @Get('availability')
  @RequirePermissions('appointments.read')
  availability(@CurrentUser() user: AuthUser, @ZQuery(availabilitySchema) q: z.infer<typeof availabilitySchema>) {
    return this.service.availability(user, q.professionalId, q.branchId, q.date, q.durationMin);
  }

  @Get('waitlist')
  @RequirePermissions('appointments.read')
  waitlist(@CurrentUser() user: AuthUser, @ZQuery(z.object({ branchId: z.uuid().optional() })) q: { branchId?: string }) {
    return this.service.waitlist(user, q.branchId);
  }

  @Post('waitlist')
  @RequirePermissions('appointments.write')
  addWaitlist(@CurrentUser() user: AuthUser, @ZBody(waitlistSchema) body: z.infer<typeof waitlistSchema>) {
    return this.service.addToWaitlist(user, body);
  }

  @Post('waitlist/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('appointments.write')
  cancelWaitlist(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancelWaitlist(user, id);
  }

  @Get(':id')
  @RequirePermissions('appointments.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user, id);
  }

  @Post()
  @RequirePermissions('appointments.write')
  @ApiZBody(appointmentCreateSchema)
  create(@CurrentUser() user: AuthUser, @ZBody(appointmentCreateSchema) body: z.infer<typeof appointmentCreateSchema>) {
    return this.service.create(user, body);
  }

  @Post(':id/reschedule')
  @HttpCode(200)
  @RequirePermissions('appointments.write')
  @ApiZBody(appointmentRescheduleSchema)
  reschedule(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(appointmentRescheduleSchema) body: z.infer<typeof appointmentRescheduleSchema>) {
    return this.service.reschedule(user, id, body);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequireAnyPermission('appointments.write', 'appointments.checkin')
  @ApiZBody(appointmentStatusSchema)
  status(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(appointmentStatusSchema) body: z.infer<typeof appointmentStatusSchema>) {
    return this.service.changeStatus(user, id, body.status, body.reason);
  }
}

import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { consentSchema, patientBaseSchema, patientCreateSchema, patientMergeSchema, patientUpdateSchema } from '@medigest/shared';
import { z } from 'zod/v4';
import { AuthUser } from '../../common/context';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ApiZBody, listQuery, ZBody, ZQuery } from '../../common/zod.pipe';
import { PatientsService } from './patients.service';

const patientListQuery = listQuery.extend({ status: z.enum(['ACTIVE', 'INACTIVE', 'MERGED']).optional() });
const statusSchema = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']), reason: z.string().trim().max(300).optional().nullable() });

@ApiTags('pacientes')
@Controller('patients')
export class PatientsController {
  constructor(private readonly service: PatientsService) {}

  @Get()
  @RequirePermissions('patients.read')
  list(@CurrentUser() user: AuthUser, @ZQuery(patientListQuery) q: z.infer<typeof patientListQuery>) {
    return this.service.list(user, q);
  }

  @Get('search')
  @RequirePermissions('patients.read')
  search(@CurrentUser() user: AuthUser, @ZQuery(z.object({ q: z.string().max(100).default('') })) q: { q: string }) {
    return this.service.quickSearch(user, q.q);
  }

  @Post('duplicates')
  @HttpCode(200)
  @RequirePermissions('patients.read')
  duplicates(@CurrentUser() user: AuthUser, @ZBody(patientBaseSchema.partial().extend({ excludeId: z.uuid().optional() })) body: z.infer<typeof patientBaseSchema> & { excludeId?: string }) {
    return this.service.findDuplicates(user, body, body.excludeId);
  }

  @Post()
  @RequirePermissions('patients.write')
  @ApiZBody(patientCreateSchema)
  create(@CurrentUser() user: AuthUser, @ZBody(patientCreateSchema) body: z.infer<typeof patientCreateSchema>) {
    return this.service.create(user, body);
  }

  @Post('merge')
  @HttpCode(200)
  @RequirePermissions('patients.merge')
  @ApiZBody(patientMergeSchema)
  merge(@CurrentUser() user: AuthUser, @ZBody(patientMergeSchema) body: z.infer<typeof patientMergeSchema>) {
    return this.service.merge(user, body);
  }

  @Get(':id')
  @RequirePermissions('patients.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user, id);
  }

  @Put(':id')
  @RequirePermissions('patients.write')
  @ApiZBody(patientUpdateSchema)
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(patientUpdateSchema) body: z.infer<typeof patientUpdateSchema>) {
    return this.service.update(user, id, body);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermissions('patients.write')
  status(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(statusSchema) body: z.infer<typeof statusSchema>) {
    return this.service.setStatus(user, id, body.status, body.reason);
  }

  @Post(':id/consents')
  @RequirePermissions('patients.write')
  consent(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(consentSchema) body: z.infer<typeof consentSchema>) {
    return this.service.addConsent(user, id, body);
  }

  @Get(':id/appointments')
  @RequirePermissions('appointments.read')
  appointments(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZQuery(listQuery) q: z.infer<typeof listQuery>) {
    return this.service.appointments(user, id, q);
  }
}

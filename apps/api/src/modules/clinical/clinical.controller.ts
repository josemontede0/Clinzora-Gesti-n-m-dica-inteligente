import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  allergySchema, diagnosisSchema, encounterCreateSchema, historySchema, medicalOrderSchema, medicationSchema, noteCorrectionSchema, noteSaveSchema,
  orderResultSchema, prescriptionSchema, vitalsSchema,
} from '@medigest/shared';
import { z } from 'zod/v4';
import { AuthUser } from '../../common/context';
import { CurrentUser, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { ApiZBody, ZBody } from '../../common/zod.pipe';
import { ClinicalService } from './clinical.service';

const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Indique el motivo').max(300) });

@ApiTags('expediente clínico')
@Controller('clinical')
export class ClinicalController {
  constructor(private readonly service: ClinicalService) {}

  @Get('patients/:patientId')
  @RequireAnyPermission('clinical.read', 'clinical.read_all')
  summary(@CurrentUser() user: AuthUser, @Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.service.patientSummary(user, patientId);
  }

  @Post('encounters')
  @RequirePermissions('clinical.write')
  @ApiZBody(encounterCreateSchema)
  start(@CurrentUser() user: AuthUser, @ZBody(encounterCreateSchema) body: z.infer<typeof encounterCreateSchema>) {
    return this.service.startEncounter(user, body);
  }

  @Get('encounters/:id')
  @RequireAnyPermission('clinical.read', 'clinical.read_all')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getEncounter(user, id);
  }

  @Put('encounters/:id/notes')
  @RequirePermissions('clinical.write')
  saveNote(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(noteSaveSchema) body: z.infer<typeof noteSaveSchema>) {
    return this.service.saveNote(user, id, body);
  }

  @Post('notes/:id/correct')
  @RequirePermissions('clinical.sign')
  correct(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(noteCorrectionSchema) body: z.infer<typeof noteCorrectionSchema>) {
    return this.service.correctNote(user, id, body);
  }

  @Get('notes/:id/versions')
  @RequireAnyPermission('clinical.read', 'clinical.read_all')
  versions(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.noteVersions(user, id);
  }

  @Post('encounters/:id/vitals')
  @RequirePermissions('clinical.vitals')
  vitals(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(vitalsSchema) body: z.infer<typeof vitalsSchema>) {
    return this.service.addVitals(user, id, body);
  }

  @Post('encounters/:id/diagnoses')
  @RequirePermissions('clinical.write')
  diagnosis(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(diagnosisSchema) body: z.infer<typeof diagnosisSchema>) {
    return this.service.addDiagnosis(user, id, body);
  }

  @Post('diagnoses/:id/void')
  @HttpCode(200)
  @RequirePermissions('clinical.write')
  voidDiagnosis(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(reasonSchema) body: z.infer<typeof reasonSchema>) {
    return this.service.voidDiagnosis(user, id, body.reason);
  }

  @Post('encounters/:id/prescriptions')
  @RequirePermissions('clinical.write')
  prescription(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(prescriptionSchema) body: z.infer<typeof prescriptionSchema>) {
    return this.service.addPrescription(user, id, body);
  }

  @Post('prescriptions/:id/void')
  @HttpCode(200)
  @RequirePermissions('clinical.write')
  voidPrescription(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(reasonSchema) body: z.infer<typeof reasonSchema>) {
    return this.service.voidPrescription(user, id, body.reason);
  }

  @Post('encounters/:id/orders')
  @RequirePermissions('clinical.write')
  order(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(medicalOrderSchema) body: z.infer<typeof medicalOrderSchema>) {
    return this.service.addOrder(user, id, body);
  }

  @Post('orders/:id/result')
  @HttpCode(200)
  @RequirePermissions('clinical.write')
  orderResult(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(orderResultSchema) body: z.infer<typeof orderResultSchema>) {
    return this.service.orderResult(user, id, body);
  }

  @Post('encounters/:id/sign')
  @HttpCode(200)
  @RequirePermissions('clinical.sign')
  sign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.sign(user, id);
  }

  @Post('patients/:patientId/allergies')
  @RequirePermissions('clinical.write')
  allergy(@CurrentUser() user: AuthUser, @Param('patientId', ParseUUIDPipe) patientId: string, @ZBody(allergySchema) body: z.infer<typeof allergySchema>) {
    return this.service.addAllergy(user, patientId, body);
  }

  @Post('allergies/:id/active')
  @HttpCode(200)
  @RequirePermissions('clinical.write')
  allergyActive(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(z.object({ active: z.boolean() })) body: { active: boolean }) {
    return this.service.setAllergyActive(user, id, body.active);
  }

  @Post('patients/:patientId/medications')
  @RequirePermissions('clinical.write')
  medication(@CurrentUser() user: AuthUser, @Param('patientId', ParseUUIDPipe) patientId: string, @ZBody(medicationSchema) body: z.infer<typeof medicationSchema>) {
    return this.service.addMedication(user, patientId, body);
  }

  @Post('medications/:id/stop')
  @HttpCode(200)
  @RequirePermissions('clinical.write')
  stopMedication(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.stopMedication(user, id);
  }

  @Post('patients/:patientId/history')
  @RequirePermissions('clinical.write')
  history(@CurrentUser() user: AuthUser, @Param('patientId', ParseUUIDPipe) patientId: string, @ZBody(historySchema) body: z.infer<typeof historySchema>) {
    return this.service.addHistory(user, patientId, body);
  }
}

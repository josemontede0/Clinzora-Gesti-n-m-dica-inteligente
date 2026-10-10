import { BadRequestException, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { FileCategory } from '@prisma/client';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Response } from 'express';
import { z } from 'zod/v4';
import { config } from '../../config';
import { AuditService } from '../../common/audit.service';
import { ClinicalAccessService } from '../../common/clinical-access';
import { AuthUser } from '../../common/context';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { randomToken, sha256, signFileUrl, verifyFileUrl } from '../../common/crypto';
import { found } from '../../common/scope';
import { ZBody } from '../../common/zod.pipe';
import { PrismaService } from '../../prisma/prisma.service';

const ALLOWED: Record<string, string[]> = {
  'application/pdf': ['%PDF'],
  'image/png': ['\x89PNG'],
  'image/jpeg': ['\xFF\xD8\xFF'],
  'image/webp': ['RIFF'],
};
const LINK_TTL_MS = 5 * 60_000;

/** Verifica el tipo real por la firma de los primeros bytes, no solo por el mimetype declarado. */
function sniff(buf: Buffer, mime: string): boolean {
  const head = buf.subarray(0, 4).toString('latin1');
  return (ALLOWED[mime] ?? []).some((sig) => head.startsWith(sig));
}

const uploadMeta = z.object({
  patientId: z.uuid(),
  title: z.string().trim().min(2).max(150),
  isClinical: z.enum(['true', 'false']).transform((v) => v === 'true'),
  encounterId: z.uuid().optional(),
});

@ApiTags('archivos')
@Controller('files')
export class FilesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ClinicalAccessService,
    private readonly audit: AuditService,
  ) {}

  private store(buf: Buffer) {
    mkdirSync(config.storageDir, { recursive: true });
    const key = `${new Date().toISOString().slice(0, 7)}/${randomToken(24)}`;
    mkdirSync(join(config.storageDir, key.split('/')[0]), { recursive: true });
    writeFileSync(join(config.storageDir, key), buf);
    return key;
  }

  @Post('patient-documents')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } }))
  async upload(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File | undefined, @ZBody(uploadMeta) meta: z.infer<typeof uploadMeta>) {
    if (!file) throw new BadRequestException('Adjunte un archivo');
    if (!ALLOWED[file.mimetype] || !sniff(file.buffer, file.mimetype)) throw new BadRequestException('Tipo de archivo no permitido (PDF, PNG, JPG o WEBP)');
    found(await this.prisma.patient.findFirst({ where: { id: meta.patientId, organizationId: user.organizationId } }), 'Paciente');
    if (meta.isClinical) {
      if (!user.permissions.has('clinical.write')) throw new ForbiddenException('No tiene permiso para adjuntar documentos clínicos');
      if (!(await this.access.canRead(user, meta.patientId))) throw new ForbiddenException('Sin relación asistencial con el paciente');
      if (meta.encounterId) found(await this.prisma.medicalEncounter.findFirst({ where: { id: meta.encounterId, patientId: meta.patientId } }), 'Encuentro');
    } else if (!user.permissions.has('patients.documents')) {
      throw new ForbiddenException('No tiene permiso para adjuntar documentos');
    }
    const key = this.store(file.buffer);
    const doc = await this.prisma.$transaction(async (tx) => {
      const meta2 = await tx.fileMetadata.create({
        data: {
          organizationId: user.organizationId, storageKey: key, originalName: file.originalname.slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size,
          sha256: sha256(file.buffer), category: (meta.isClinical ? 'CLINICAL' : 'ADMINISTRATIVE') as FileCategory, uploadedById: user.id,
        },
      });
      return tx.patientDocument.create({
        data: { patientId: meta.patientId, fileId: meta2.id, encounterId: meta.encounterId, title: meta.title, isClinical: meta.isClinical, createdById: user.id },
      });
    });
    await this.audit.log({ action: 'DOCUMENTO_SUBIDO', entity: 'PatientDocument', entityId: doc.id, details: { paciente: meta.patientId, clinico: meta.isClinical, tipo: file.mimetype } });
    return doc;
  }

  @Get('patients/:patientId/documents')
  async list(@CurrentUser() user: AuthUser, @Param('patientId', ParseUUIDPipe) patientId: string) {
    found(await this.prisma.patient.findFirst({ where: { id: patientId, organizationId: user.organizationId } }), 'Paciente');
    const canClinical = await this.access.canRead(user, patientId);
    const canAdmin = user.permissions.has('patients.documents') || user.permissions.has('patients.read');
    return this.prisma.patientDocument.findMany({
      where: { patientId, deletedAt: null, OR: [...(canAdmin ? [{ isClinical: false }] : []), ...(canClinical ? [{ isClinical: true }] : [])] },
      include: { file: { select: { originalName: true, mimeType: true, sizeBytes: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async assertDocAccess(user: AuthUser, documentId: string) {
    const doc = found(await this.prisma.patientDocument.findFirst({ where: { id: documentId, deletedAt: null, patient: { organizationId: user.organizationId } }, include: { file: true } }), 'Documento');
    if (doc.isClinical) await this.access.assertRead(user, doc.patientId, 'documento clínico');
    else if (!user.permissions.has('patients.documents') && !user.permissions.has('patients.read')) throw new ForbiddenException('Sin acceso al documento');
    return doc;
  }

  /** Enlace temporal (5 min) firmado y ligado al usuario. No existen enlaces públicos permanentes. */
  @Get('documents/:id/link')
  async link(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.assertDocAccess(user, id);
    const exp = Date.now() + LINK_TTL_MS;
    return { url: `/files/documents/${id}/download?exp=${exp}&sig=${signFileUrl(id, user.id, exp)}`, expiresAt: new Date(exp).toISOString() };
  }

  @Get('documents/:id/download')
  async download(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    if (!verifyFileUrl(id, user.id, Number(exp), String(sig ?? ''))) throw new ForbiddenException('Enlace inválido o vencido');
    const doc = await this.assertDocAccess(user, id);
    const path = join(config.storageDir, doc.file.storageKey);
    if (!existsSync(path)) throw new BadRequestException('El archivo no está disponible en el almacenamiento');
    await this.audit.log({ action: 'DOCUMENTO_DESCARGADO', entity: 'PatientDocument', entityId: id, details: { paciente: doc.patientId } });
    res.setHeader('Content-Type', doc.file.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.file.originalName)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    createReadStream(path).pipe(res);
  }

  @Post('documents/:id/delete')
  @RequirePermissions('patients.write')
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(z.object({ reason: z.string().trim().min(5).max(300) })) body: { reason: string }) {
    const doc = await this.assertDocAccess(user, id);
    if (doc.isClinical) throw new ForbiddenException('Los documentos clínicos no se eliminan; quedan en el expediente');
    await this.prisma.patientDocument.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log({ action: 'DOCUMENTO_RETIRADO', entity: 'PatientDocument', entityId: id, details: { motivo: body.reason } });
    return { ok: true };
  }
}

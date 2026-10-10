import { ForbiddenException, Global, Injectable, Module, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { AuthUser } from './context';

/**
 * Acceso al expediente clínico por relación asistencial:
 *  - clinical.read_all: cualquier paciente de la organización.
 *  - Profesional (cuenta vinculada a un médico): pacientes con los que tiene o tuvo citas o encuentros.
 *  - Otros con clinical.read (enfermería): pacientes con citas en sus sucursales.
 * Cada consulta autorizada queda registrada en la auditoría.
 */
@Injectable()
export class ClinicalAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async canRead(user: AuthUser, patientId: string): Promise<boolean> {
    if (!user.permissions.has('clinical.read') && !user.permissions.has('clinical.read_all')) return false;
    const patient = await this.prisma.patient.findFirst({ where: { id: patientId, organizationId: user.organizationId }, select: { id: true } });
    if (!patient) return false;
    if (user.permissions.has('clinical.read_all')) return true;
    if (user.professionalId) {
      const [appt, enc] = await Promise.all([
        this.prisma.appointment.findFirst({ where: { patientId, professionalId: user.professionalId }, select: { id: true } }),
        this.prisma.medicalEncounter.findFirst({ where: { patientId, professionalId: user.professionalId }, select: { id: true } }),
      ]);
      return !!(appt || enc);
    }
    const appt = await this.prisma.appointment.findFirst({
      where: { patientId, organizationId: user.organizationId, ...(user.allBranches ? {} : { branchId: { in: user.branchIds } }) },
      select: { id: true },
    });
    return !!appt;
  }

  /** Lanza 403/404 si no hay acceso y registra la consulta en auditoría. */
  async assertRead(user: AuthUser, patientId: string, what = 'expediente') {
    const exists = await this.prisma.patient.findFirst({ where: { id: patientId, organizationId: user.organizationId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Paciente no encontrado');
    if (!(await this.canRead(user, patientId))) {
      await this.audit.log({ action: 'ACCESO_CLINICO_DENEGADO', entity: 'Patient', entityId: patientId, details: { recurso: what } });
      throw new ForbiddenException('No tiene relación asistencial con este paciente para ver su información clínica');
    }
    await this.audit.log({ action: 'ACCESO_CLINICO', entity: 'Patient', entityId: patientId, details: { recurso: what } });
  }

  /** Para escribir: además del permiso, el profesional debe ser el responsable del encuentro (o tener read_all). */
  async assertWriteEncounter(user: AuthUser, encounter: { professionalId: string; organizationId: string }) {
    if (encounter.organizationId !== user.organizationId) throw new NotFoundException('Encuentro no encontrado');
    if (user.permissions.has('clinical.read_all')) return;
    if (user.professionalId !== encounter.professionalId) {
      throw new ForbiddenException('Solo el profesional responsable puede modificar este encuentro');
    }
  }
}

@Global()
@Module({ providers: [ClinicalAccessService], exports: [ClinicalAccessService] })
export class ClinicalAccessModule {}

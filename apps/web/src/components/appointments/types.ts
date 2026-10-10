import type { AppointmentStatus } from '@medigest/shared';

export interface Appointment {
  id: string;
  branchId: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  modality: 'PRESENCIAL' | 'VIRTUAL';
  reason: string | null;
  notes: string | null;
  checkedInAt: string | null;
  cancelReason: string | null;
  patient: { id: string; recordNumber: string; firstName: string; lastName: string; phone: string | null };
  professional: { id: string; title: string; firstName: string; lastName: string };
  specialty: { id: string; name: string } | null;
  room: { id: string; name: string } | null;
  patientInsurance: { id: string; affiliateNumber: string; plan: { name: string; insurer: { name: string } } } | null;
  encounter: { id: string; status: string } | null;
  history?: { id: string; fromStatus: AppointmentStatus | null; toStatus: AppointmentStatus; reason: string | null; createdAt: string; details: { reprogramada?: { de: string; a: string } } | null }[];
  notifications?: { id: string; type: string; channel: string; status: string; scheduledFor: string; testMode: boolean; lastError: string | null }[];
}

export interface Professional {
  id: string;
  title: string;
  firstName: string;
  lastName: string;
  defaultDurationMin: number;
  active: boolean;
  specialties: { specialty: { id: string; name: string } }[];
  branches: { branch: { id: string; name: string } }[];
}

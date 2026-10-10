import { APPOINTMENT_STATUS_LABEL, CLAIM_STATUS_LABEL, INVOICE_STATUS_LABEL, type AppointmentStatus, type ClaimStatus } from '@medigest/shared';
import { Badge } from './ui/layout';

const apptTone: Record<AppointmentStatus, 'slate' | 'navy' | 'teal' | 'amber' | 'red' | 'violet' | 'sky'> = {
  SOLICITADA: 'slate',
  PENDIENTE_CONFIRMACION: 'amber',
  CONFIRMADA: 'navy',
  EN_ESPERA: 'sky',
  EN_CONSULTA: 'violet',
  COMPLETADA: 'teal',
  CANCELADA: 'red',
  NO_ASISTIO: 'red',
};
export const APPT_COLORS: Record<AppointmentStatus, string> = {
  SOLICITADA: '#94a3b8',
  PENDIENTE_CONFIRMACION: '#d97706',
  CONFIRMADA: '#1f4672',
  EN_ESPERA: '#0284c7',
  EN_CONSULTA: '#7c3aed',
  COMPLETADA: '#0e8577',
  CANCELADA: '#dc2626',
  NO_ASISTIO: '#b91c1c',
};

export function AppointmentStatusBadge({ status }: { status: AppointmentStatus }) {
  return <Badge tone={apptTone[status]}>{APPOINTMENT_STATUS_LABEL[status]}</Badge>;
}

export function InvoiceStatusBadge({ status, overdue }: { status: string; overdue?: boolean }) {
  if (overdue) return <Badge tone="red">Vencida</Badge>;
  const tone = ({ BORRADOR: 'slate', PENDIENTE: 'amber', PARCIAL: 'sky', PAGADA: 'teal', ANULADA: 'red' } as const)[status as 'BORRADOR'] ?? 'slate';
  return <Badge tone={tone}>{INVOICE_STATUS_LABEL[status] ?? status}</Badge>;
}

export function ClaimStatusBadge({ status }: { status: ClaimStatus }) {
  const tone = ({ BORRADOR: 'slate', SOMETIDA: 'navy', EN_REVISION: 'sky', APROBADA: 'teal', APROBADA_PARCIAL: 'teal', RECHAZADA: 'red', PAGADA_PARCIAL: 'amber', PAGADA: 'teal', CERRADA: 'slate' } as const)[status];
  return <Badge tone={tone}>{CLAIM_STATUS_LABEL[status]}</Badge>;
}

export function TestModeBadge() {
  return <Badge tone="amber">Modo prueba</Badge>;
}

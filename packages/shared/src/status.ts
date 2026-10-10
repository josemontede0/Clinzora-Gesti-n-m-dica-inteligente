export const APPOINTMENT_STATUSES = [
  'SOLICITADA',
  'PENDIENTE_CONFIRMACION',
  'CONFIRMADA',
  'EN_ESPERA',
  'EN_CONSULTA',
  'COMPLETADA',
  'CANCELADA',
  'NO_ASISTIO',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  SOLICITADA: 'Solicitada',
  PENDIENTE_CONFIRMACION: 'Pendiente de confirmación',
  CONFIRMADA: 'Confirmada',
  EN_ESPERA: 'En espera',
  EN_CONSULTA: 'En consulta',
  COMPLETADA: 'Completada',
  CANCELADA: 'Cancelada',
  NO_ASISTIO: 'No asistió',
};

/** Transiciones válidas. COMPLETADA, CANCELADA y NO_ASISTIO son finales. */
export const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  SOLICITADA: ['PENDIENTE_CONFIRMACION', 'CONFIRMADA', 'CANCELADA'],
  PENDIENTE_CONFIRMACION: ['CONFIRMADA', 'EN_ESPERA', 'CANCELADA', 'NO_ASISTIO'],
  CONFIRMADA: ['EN_ESPERA', 'CANCELADA', 'NO_ASISTIO', 'PENDIENTE_CONFIRMACION'],
  EN_ESPERA: ['EN_CONSULTA', 'CANCELADA', 'CONFIRMADA'],
  EN_CONSULTA: ['COMPLETADA', 'EN_ESPERA'],
  COMPLETADA: [],
  CANCELADA: [],
  NO_ASISTIO: [],
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return APPOINTMENT_TRANSITIONS[from].includes(to);
}

/** Estados desde los que se permite reprogramar. */
export const RESCHEDULABLE_STATUSES: AppointmentStatus[] = ['SOLICITADA', 'PENDIENTE_CONFIRMACION', 'CONFIRMADA'];

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  BORRADOR: 'Borrador',
  PENDIENTE: 'Pendiente',
  PARCIAL: 'Parcialmente pagada',
  PAGADA: 'Pagada',
  ANULADA: 'Anulada',
  VENCIDA: 'Vencida',
};

export const CLAIM_STATUSES = [
  'BORRADOR',
  'SOMETIDA',
  'EN_REVISION',
  'APROBADA',
  'APROBADA_PARCIAL',
  'RECHAZADA',
  'PAGADA_PARCIAL',
  'PAGADA',
  'CERRADA',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  BORRADOR: 'Borrador',
  SOMETIDA: 'Sometida',
  EN_REVISION: 'En revisión',
  APROBADA: 'Aprobada',
  APROBADA_PARCIAL: 'Aprobada parcial',
  RECHAZADA: 'Rechazada',
  PAGADA_PARCIAL: 'Pagada parcial',
  PAGADA: 'Pagada',
  CERRADA: 'Cerrada',
};

/** Transiciones manuales de reclamación. PAGADA y PAGADA_PARCIAL las asigna el sistema al conciliar pagos. */
export const CLAIM_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  BORRADOR: ['SOMETIDA'],
  SOMETIDA: ['EN_REVISION', 'APROBADA', 'APROBADA_PARCIAL', 'RECHAZADA'],
  EN_REVISION: ['APROBADA', 'APROBADA_PARCIAL', 'RECHAZADA'],
  APROBADA: ['CERRADA'],
  APROBADA_PARCIAL: ['CERRADA'],
  RECHAZADA: ['SOMETIDA', 'CERRADA'],
  PAGADA_PARCIAL: ['CERRADA'],
  PAGADA: ['CERRADA'],
  CERRADA: [],
};

export const PAYMENT_METHOD_KIND_LABEL: Record<string, string> = {
  EFECTIVO: 'Efectivo',
  TARJETA_DEBITO: 'Tarjeta de débito',
  TARJETA_CREDITO: 'Tarjeta de crédito',
  TRANSFERENCIA: 'Transferencia',
  CHEQUE: 'Cheque',
  OTRO: 'Otro',
};

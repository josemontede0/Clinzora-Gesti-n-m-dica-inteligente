'use client';

import { APPOINTMENT_TRANSITIONS } from '@medigest/shared';
import { CalendarClock, CheckCircle2, DoorOpen, Stethoscope, UserX, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Appointment } from './types';

/** Acciones de estado según transiciones válidas y permisos. El servidor vuelve a validarlas. */
export function AppointmentActions({ appt, onChanged, compact, onReschedule }: { appt: Appointment; onChanged: () => void; compact?: boolean; onReschedule?: () => void }) {
  const { can, me } = useSession();
  const router = useRouter();
  const [confirm, setConfirm] = useState<null | 'CANCELADA' | 'NO_ASISTIO'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const allowed = APPOINTMENT_TRANSITIONS[appt.status];
  const size = compact ? 'sm' : 'default';
  const isMine = !!me?.professionalId && me.professionalId === appt.professional.id;

  const change = async (status: string, reason?: string) => {
    setBusy(status);
    try {
      await api.post(`/appointments/${appt.id}/status`, { status, reason: reason || null });
      toast.success('Cita actualizada');
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const startConsultation = async () => {
    setBusy('consulta');
    try {
      const enc = await api.post<{ id: string }>('/clinical/encounters', { appointmentId: appt.id, patientId: appt.patient.id });
      router.push(`/clinico/encuentro/${enc.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      {allowed.includes('CONFIRMADA') && appt.status !== 'EN_ESPERA' && can('appointments.write') && (
        <Button size={size} variant="outline" loading={busy === 'CONFIRMADA'} onClick={() => change('CONFIRMADA')}><CheckCircle2 /> Confirmar</Button>
      )}
      {allowed.includes('EN_ESPERA') && can('appointments.checkin') && (
        <Button size={size} variant="success" loading={busy === 'EN_ESPERA'} onClick={() => change('EN_ESPERA')}><DoorOpen /> Registrar llegada</Button>
      )}
      {(appt.status === 'EN_ESPERA' || appt.status === 'EN_CONSULTA') && isMine && can('clinical.write') && !appt.encounter && (
        <Button size={size} loading={busy === 'consulta'} onClick={startConsultation}><Stethoscope /> Iniciar consulta</Button>
      )}
      {appt.encounter && (can('clinical.read') || can('clinical.read_all')) && (
        <Button size={size} variant="outline" asChild><Link href={`/clinico/encuentro/${appt.encounter.id}`}><Stethoscope /> Ver encuentro</Link></Button>
      )}
      {onReschedule && ['SOLICITADA', 'PENDIENTE_CONFIRMACION', 'CONFIRMADA'].includes(appt.status) && can('appointments.write') && (
        <Button size={size} variant="outline" onClick={onReschedule}><CalendarClock /> Reprogramar</Button>
      )}
      {allowed.includes('NO_ASISTIO') && can('appointments.checkin') && new Date(appt.startsAt) < new Date() && (
        <Button size={size} variant="ghost" onClick={() => setConfirm('NO_ASISTIO')}><UserX /> No asistió</Button>
      )}
      {allowed.includes('CANCELADA') && can('appointments.write') && (
        <Button size={size} variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => setConfirm('CANCELADA')}><XCircle /> Cancelar</Button>
      )}
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={confirm === 'CANCELADA' ? 'Cancelar cita' : 'Marcar inasistencia'}
        description={confirm === 'CANCELADA' ? 'La cita se conserva en el historial y se avisará al paciente por los canales autorizados.' : undefined}
        requireReason={confirm === 'CANCELADA'}
        tone="destructive"
        confirmLabel={confirm === 'CANCELADA' ? 'Cancelar cita' : 'Marcar'}
        onConfirm={(reason) => change(confirm!, reason)}
      />
    </div>
  );
}

'use client';

import { APPOINTMENT_STATUS_LABEL, formatDate, formatDateTime, formatTime } from '@medigest/shared';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { AppointmentStatusBadge, TestModeBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/form';
import { Badge, DefinitionList, LoadingBlock } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { fullName } from '@/lib/utils';
import { AppointmentActions } from './appointment-actions';
import { SlotPicker, type Slot } from './slot-picker';
import type { Appointment } from './types';

const NOTIF_LABEL: Record<string, string> = {
  CITA_CONFIRMACION: 'Confirmación', CITA_RECORDATORIO: 'Recordatorio', CITA_CAMBIO: 'Cambio', CITA_CANCELACION: 'Cancelación', CITA_PENDIENTE_CONFIRMAR: 'Pendiente de confirmar',
};

export function AppointmentDialog({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const { data: a, loading, reload } = useApi<Appointment>(id ? `/appointments/${id}` : null);
  const [rescheduling, setRescheduling] = useState(false);
  const [date, setDate] = useState('');
  const [slot, setSlot] = useState<Slot | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    reload();
    onChanged();
  };

  const reschedule = async () => {
    if (!a || !slot) return;
    setBusy(true);
    try {
      await api.post(`/appointments/${a.id}/reschedule`, { startsAt: slot.start, reason });
      toast.success('Cita reprogramada. Se avisará al paciente.');
      setRescheduling(false);
      setSlot(null);
      setReason('');
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!id} onOpenChange={(v) => !v && (setRescheduling(false), onClose())} title="Detalle de la cita" size="lg">
      {loading || !a ? <LoadingBlock /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <Link href={`/pacientes/${a.patient.id}`} className="text-lg font-semibold text-navy-800 hover:underline">{a.patient.firstName} {a.patient.lastName}</Link>
              <p className="text-sm text-muted">{a.patient.recordNumber} · {a.patient.phone ?? 'sin teléfono'}</p>
            </div>
            <AppointmentStatusBadge status={a.status} />
          </div>
          <DefinitionList items={[
            { label: 'Fecha', value: `${formatDate(a.startsAt)} · ${formatTime(a.startsAt)} – ${formatTime(a.endsAt)}` },
            { label: 'Médico', value: fullName(a.professional) },
            { label: 'Especialidad', value: a.specialty?.name },
            { label: 'Consultorio', value: a.room?.name },
            { label: 'Modalidad', value: a.modality === 'VIRTUAL' ? 'Virtual' : 'Presencial' },
            { label: 'Seguro', value: a.patientInsurance ? `${a.patientInsurance.plan.insurer.name} · ${a.patientInsurance.plan.name} (${a.patientInsurance.affiliateNumber})` : 'Particular' },
            { label: 'Motivo administrativo', value: a.reason },
            { label: 'Llegada', value: a.checkedInAt ? formatTime(a.checkedInAt) : null },
          ]} />
          {a.cancelReason && <p className="text-sm text-red-700">Motivo de cancelación: {a.cancelReason}</p>}

          <AppointmentActions appt={a} onChanged={refresh} onReschedule={() => setRescheduling(true)} />

          {rescheduling && (
            <div className="space-y-3 rounded-xl border border-border bg-slate-50/60 p-4">
              <p className="text-sm font-medium">Reprogramar con {fullName(a.professional)}</p>
              <Field label="Nueva fecha"><Input type="date" value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => { setDate(e.target.value); setSlot(null); }} /></Field>
              {date && <SlotPicker professionalId={a.professional.id} branchId={a.branchId} date={date} durationMin={Math.round((new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime()) / 60000)} value={slot?.start ?? null} onChange={setSlot} />}
              <Field label="Motivo" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-[60px]" /></Field>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setRescheduling(false)}>Cancelar</Button>
                <Button variant="success" loading={busy} disabled={!slot || reason.trim().length < 3} onClick={reschedule}>Confirmar nueva fecha</Button>
              </div>
            </div>
          )}

          {!!a.notifications?.length && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Mensajes al paciente</p>
              <ul className="space-y-1 text-sm">
                {a.notifications.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-center gap-2">
                    <span className="w-44 text-muted">{formatDateTime(n.scheduledFor)}</span>
                    <span>{NOTIF_LABEL[n.type] ?? n.type} · {n.channel}</span>
                    <Badge tone={n.status === 'ENVIADO' || n.status === 'ENTREGADO' ? 'teal' : n.status === 'FALLIDO' ? 'red' : n.status === 'PENDIENTE' ? 'amber' : 'slate'}>{n.status.toLowerCase()}</Badge>
                    {n.testMode && <TestModeBadge />}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!!a.history?.length && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Historial</p>
              <ol className="space-y-1.5 border-l-2 border-border pl-4 text-sm">
                {a.history.map((h) => (
                  <li key={h.id}>
                    <span className="text-muted">{formatDateTime(h.createdAt)}</span> · {h.fromStatus ? `${APPOINTMENT_STATUS_LABEL[h.fromStatus]} → ` : ''}{APPOINTMENT_STATUS_LABEL[h.toStatus]}
                    {h.details?.reprogramada && <> · reprogramada de {formatDateTime(h.details.reprogramada.de)} a {formatDateTime(h.details.reprogramada.a)}</>}
                    {h.reason && <span className="text-muted"> · {h.reason}</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

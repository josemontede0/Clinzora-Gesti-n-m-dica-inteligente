'use client';

import { formatDate, formatTime } from '@medigest/shared';
import { CalendarPlus, Clock, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AppointmentActions } from '@/components/appointments/appointment-actions';
import { AppointmentDialog } from '@/components/appointments/appointment-dialog';
import type { Appointment } from '@/components/appointments/types';
import { PatientSearch, type PatientHit } from '@/components/patient-search';
import { AppointmentStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/form';
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/ui/layout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { addDaysYmd, fullName, todayYmd } from '@/lib/utils';

interface WaitEntry { id: string; createdAt: string; notes: string | null; preferredFrom: string | null; preferredTo: string | null; patient?: { id: string; firstName: string; lastName: string; recordNumber: string; phone: string | null }; professional: { title: string; firstName: string; lastName: string } | null }

const GROUPS: { key: string; title: string; statuses: string[] }[] = [
  { key: 'espera', title: 'En sala de espera', statuses: ['EN_ESPERA'] },
  { key: 'consulta', title: 'En consulta', statuses: ['EN_CONSULTA'] },
  { key: 'pendientes', title: 'Por llegar', statuses: ['SOLICITADA', 'PENDIENTE_CONFIRMACION', 'CONFIRMADA'] },
  { key: 'cerradas', title: 'Finalizadas', statuses: ['COMPLETADA', 'CANCELADA', 'NO_ASISTIO'] },
];

function Reception() {
  const params = useSearchParams();
  const { me, branchId, can } = useSession();
  const tz = me?.organization.timezone;
  const [day, setDay] = useState(todayYmd(tz));
  const [mine, setMine] = useState(!!me?.professionalId);
  const [selected, setSelected] = useState<string | null>(params.get('cita'));
  const [tab, setTab] = useState(params.get('tab') ?? 'hoy');
  const from = new Date(`${day}T00:00:00-04:00`).toISOString();
  const to = new Date(`${addDaysYmd(day, 1)}T00:00:00-04:00`).toISOString();
  const { data, loading, error, reload } = useApi<Appointment[]>('/appointments', { from, to, branchId: branchId || undefined, professionalId: mine && me?.professionalId ? me.professionalId : undefined });
  const wait = useApi<WaitEntry[]>(tab === 'espera' ? '/appointments/waitlist' : null, { branchId: branchId || undefined });
  const [addOpen, setAddOpen] = useState(false);
  const [wPatient, setWPatient] = useState<PatientHit | null>(null);
  const [wNotes, setWNotes] = useState('');
  const [wFrom, setWFrom] = useState('');
  const [wTo, setWTo] = useState('');

  const grouped = useMemo(() => GROUPS.map((g) => ({ ...g, items: (data ?? []).filter((a) => g.statuses.includes(a.status)) })), [data]);

  return (
    <>
      <PageHeader
        title="Sala de espera"
        description="Llegadas, consultas en curso y pacientes por atender."
        actions={can('appointments.write') && <Button variant="success" asChild><Link href="/agenda/nueva"><CalendarPlus /> Nueva cita</Link></Button>}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="hoy">Citas del día</TabsTrigger>
          <TabsTrigger value="espera">Lista de espera</TabsTrigger>
        </TabsList>
        <TabsContent value="hoy">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="w-44" aria-label="Fecha" />
            {me?.professionalId && <Checkbox label="Solo mis pacientes" checked={mine} onChange={(e) => setMine(e.target.checked)} />}
            <span className="text-sm text-muted">{formatDate(day)} · {data?.length ?? 0} cita(s)</span>
          </div>
          {error && <ErrorState message={error} onRetry={reload} />}
          {loading && !data ? <LoadingBlock /> : (
            <div className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
              {grouped.map((g) => (
                <Card key={g.key}>
                  <CardHeader title={<span className="flex items-center gap-2">{g.title} <Badge>{g.items.length}</Badge></span>} />
                  {g.items.length ? (
                    <ul className="divide-y divide-border">
                      {g.items.map((a) => (
                        <li key={a.id} className="space-y-2 px-5 py-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <button className="text-left" onClick={() => setSelected(a.id)}>
                              <p className="font-medium text-slate-800 hover:underline">{a.patient.lastName}, {a.patient.firstName}</p>
                              <p className="flex flex-wrap items-center gap-1 text-xs text-muted">
                                <Clock className="h-3 w-3" /> {formatTime(a.startsAt, tz, !me?.timeFormat24h)} · {fullName(a.professional)}{a.room ? ` · ${a.room.name}` : ''}
                                {a.patientInsurance ? ` · ${a.patientInsurance.plan.insurer.name}` : ' · Particular'}
                                {a.checkedInAt && ` · llegó ${formatTime(a.checkedInAt, tz, !me?.timeFormat24h)}`}
                              </p>
                            </button>
                            <AppointmentStatusBadge status={a.status} />
                          </div>
                          {g.key !== 'cerradas' && <AppointmentActions appt={a} onChanged={reload} compact />}
                        </li>
                      ))}
                    </ul>
                  ) : <EmptyState title="Sin pacientes" />}
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="espera">
          <Card>
            <CardHeader title="Lista de espera" description="Pacientes que esperan un espacio. Al agendarlos se retiran de la lista." actions={can('appointments.write') && <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>Agregar paciente</Button>} />
            {wait.loading ? <LoadingBlock /> : wait.data?.length ? (
              <ul className="divide-y divide-border">
                {wait.data.map((w) => (
                  <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                    <div>
                      <p className="font-medium">{w.patient?.lastName}, {w.patient?.firstName} <span className="text-xs text-muted">{w.patient?.recordNumber} · {w.patient?.phone}</span></p>
                      <p className="text-xs text-muted">Desde {formatDate(w.createdAt)}{w.professional ? ` · ${fullName(w.professional)}` : ''}{w.preferredFrom ? ` · prefiere ${formatDate(w.preferredFrom)}–${formatDate(w.preferredTo)}` : ''}{w.notes ? ` · ${w.notes}` : ''}</p>
                    </div>
                    {can('appointments.write') && (
                      <span className="flex gap-2">
                        <Button size="sm" variant="success" asChild><Link href={`/agenda/nueva?paciente=${w.patient?.id}`}>Agendar</Link></Button>
                        <Button size="sm" variant="ghost" aria-label="Retirar de la lista" onClick={async () => { try { await api.post(`/appointments/waitlist/${w.id}/cancel`); wait.reload(); } catch (e) { toast.error(errorMessage(e)); } }}><Trash2 /></Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="La lista de espera está vacía" />}
          </Card>
        </TabsContent>
      </Tabs>
      <AppointmentDialog id={selected} onClose={() => setSelected(null)} onChanged={reload} />
      <Dialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Agregar a lista de espera"
        footer={<><Button variant="outline" onClick={() => setAddOpen(false)}>Cancelar</Button><Button variant="success" disabled={!wPatient} onClick={async () => {
          try {
            await api.post('/appointments/waitlist', { branchId, patientId: wPatient!.id, notes: wNotes || null, preferredFrom: wFrom || null, preferredTo: wTo || null });
            toast.success('Paciente agregado a la lista de espera');
            setAddOpen(false); setWPatient(null); setWNotes(''); wait.reload();
          } catch (e) { toast.error(errorMessage(e)); }
        }}>Agregar</Button></>}
      >
        <div className="space-y-4">
          <Field label="Paciente">{wPatient ? <p className="text-sm">{wPatient.lastName}, {wPatient.firstName} <button className="ml-2 text-navy-600 underline" onClick={() => setWPatient(null)}>cambiar</button></p> : <PatientSearch onSelect={setWPatient} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Disponible desde"><Input type="date" value={wFrom} onChange={(e) => setWFrom(e.target.value)} /></Field>
            <Field label="Hasta"><Input type="date" value={wTo} onChange={(e) => setWTo(e.target.value)} /></Field>
          </div>
          <Field label="Notas (preferencias de horario, médico…)"><Textarea value={wNotes} onChange={(e) => setWNotes(e.target.value)} /></Field>
        </div>
      </Dialog>
    </>
  );
}

export default function ReceptionPage() {
  return (
    <Suspense>
      <Reception />
    </Suspense>
  );
}

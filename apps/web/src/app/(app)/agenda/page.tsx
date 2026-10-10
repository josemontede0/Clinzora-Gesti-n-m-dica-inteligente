'use client';

import 'react-big-calendar/lib/css/react-big-calendar.css';
import { APPOINTMENT_STATUSES, APPOINTMENT_STATUS_LABEL } from '@medigest/shared';
import { addDays, addMonths, endOfMonth, endOfWeek, format, getDay, parse, startOfMonth, startOfWeek } from 'date-fns';
import { es } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, ListPlus, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Calendar, dateFnsLocalizer, type View } from 'react-big-calendar';
import { AppointmentDialog } from '@/components/appointments/appointment-dialog';
import type { Appointment, Professional } from '@/components/appointments/types';
import { APPT_COLORS } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form';
import { Card, ErrorState, PageHeader } from '@/components/ui/layout';
import { useSession } from '@/lib/session';
import { useApi, usePersistentState } from '@/lib/use-api';
import { cn, fullName } from '@/lib/utils';

const localizer = dateFnsLocalizer({ format, parse, startOfWeek: (d: Date) => startOfWeek(d, { weekStartsOn: 1 }), getDay, locales: { es } });
const messages = { today: 'Hoy', previous: 'Anterior', next: 'Siguiente', month: 'Mes', week: 'Semana', day: 'Día', agenda: 'Agenda', date: 'Fecha', time: 'Hora', event: 'Cita', noEventsInRange: 'No hay citas en este rango.', showMore: (n: number) => `+${n} más` };

function range(date: Date, view: View) {
  if (view === 'day') return { from: new Date(date.getFullYear(), date.getMonth(), date.getDate()), to: addDays(new Date(date.getFullYear(), date.getMonth(), date.getDate()), 1) };
  if (view === 'week') return { from: startOfWeek(date, { weekStartsOn: 1 }), to: addDays(endOfWeek(date, { weekStartsOn: 1 }), 1) };
  if (view === 'agenda') return { from: new Date(date.getFullYear(), date.getMonth(), date.getDate()), to: addDays(date, 30) };
  return { from: startOfWeek(startOfMonth(date), { weekStartsOn: 1 }), to: addDays(endOfWeek(endOfMonth(date), { weekStartsOn: 1 }), 1) };
}

export default function AgendaPage() {
  const router = useRouter();
  const { branchId, me, can } = useSession();
  const [filters, setFilters] = usePersistentState('mg_agenda', { view: 'week' as View, professionalId: me?.professionalId ?? '', specialtyId: '', status: '' });
  const [date, setDate] = useState(new Date());
  const [selected, setSelected] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const set = () => setIsMobile(mq.matches);
    set();
    mq.addEventListener('change', set);
    return () => mq.removeEventListener('change', set);
  }, []);
  // En móvil la vista semanal/mensual es ilegible: se usa día o agenda.
  const view: View = isMobile && (filters.view === 'week' || filters.view === 'month') ? 'agenda' : filters.view;

  const { from, to } = range(date, view);
  const pros = useApi<Professional[]>('/professionals', { branchId: branchId || undefined });
  const specialties = useApi<{ id: string; name: string }[]>('/specialties');
  const { data, error, reload } = useApi<Appointment[]>('/appointments', {
    from: from.toISOString(), to: to.toISOString(), branchId: branchId || undefined,
    professionalId: filters.professionalId || undefined, specialtyId: filters.specialtyId || undefined, status: filters.status || undefined,
  });

  const events = useMemo(() => (data ?? []).map((a) => ({
    id: a.id,
    title: `${a.patient.lastName}, ${a.patient.firstName}${filters.professionalId ? '' : ` · ${a.professional.lastName}`}`,
    start: new Date(a.startsAt),
    end: new Date(a.endsAt),
    status: a.status,
  })), [data, filters.professionalId]);

  const move = (dir: 1 | -1) => setDate((d) => (view === 'month' ? addMonths(d, dir) : view === 'week' ? addDays(d, 7 * dir) : view === 'agenda' ? addDays(d, 30 * dir) : addDays(d, dir)));
  const label = view === 'month' ? format(date, "MMMM 'de' yyyy", { locale: es }) : view === 'week' ? `${format(from, 'd MMM', { locale: es })} – ${format(addDays(to, -1), "d MMM yyyy", { locale: es })}` : format(date, "EEEE d 'de' MMMM yyyy", { locale: es });

  return (
    <>
      <PageHeader
        title="Agenda"
        actions={
          <>
            {can('appointments.write') && <Button variant="outline" asChild><Link href="/recepcion?tab=espera"><ListPlus /> Lista de espera</Link></Button>}
            {can('appointments.write') && <Button variant="success" asChild><Link href="/agenda/nueva"><Plus /> Nueva cita</Link></Button>}
          </>
        }
      />
      <Card className="mb-4 p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" onClick={() => move(-1)} aria-label="Anterior"><ChevronLeft /></Button>
            <Button variant="outline" size="sm" onClick={() => setDate(new Date())}>Hoy</Button>
            <Button variant="outline" size="icon" onClick={() => move(1)} aria-label="Siguiente"><ChevronRight /></Button>
            <span className="ml-2 text-sm font-semibold capitalize text-navy-800">{label}</span>
          </div>
          <div className="flex flex-wrap gap-2 lg:ml-auto">
            <div className="flex rounded-lg border border-border p-0.5">
              {(['day', 'week', 'month', 'agenda'] as View[]).filter((v) => !isMobile || v === 'day' || v === 'agenda').map((v) => (
                <button key={v} onClick={() => setFilters({ ...filters, view: v })} className={cn('rounded-md px-3 py-1.5 text-xs font-medium', view === v ? 'bg-navy-800 text-white' : 'text-slate-600 hover:bg-slate-100')}>
                  {messages[v as 'day']}
                </button>
              ))}
            </div>
            <Select className="h-9 w-full sm:w-52" value={filters.professionalId} onChange={(e) => setFilters({ ...filters, professionalId: e.target.value })} aria-label="Médico">
              <option value="">Todos los médicos</option>
              {pros.data?.map((p) => <option key={p.id} value={p.id}>{fullName(p)}</option>)}
            </Select>
            <Select className="h-9 w-full sm:w-44" value={filters.specialtyId} onChange={(e) => setFilters({ ...filters, specialtyId: e.target.value })} aria-label="Especialidad">
              <option value="">Todas las especialidades</option>
              {specialties.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Select className="h-9 w-full sm:w-44" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label="Estado">
              <option value="">Todos los estados</option>
              {APPOINTMENT_STATUSES.map((s) => <option key={s} value={s}>{APPOINTMENT_STATUS_LABEL[s]}</option>)}
            </Select>
          </div>
        </div>
      </Card>
      {error && <ErrorState message={error} onRetry={reload} />}
      <div className="h-[calc(100dvh-260px)] min-h-[520px]">
        <Calendar
          localizer={localizer}
          culture="es"
          messages={messages}
          events={events}
          date={date}
          view={view}
          onNavigate={setDate}
          onView={(v) => setFilters({ ...filters, view: v })}
          min={new Date(1970, 0, 1, 7, 0)}
          max={new Date(1970, 0, 1, 20, 0)}
          step={15}
          timeslots={2}
          selectable={can('appointments.write')}
          onSelectSlot={(s) => {
            if (s.start < new Date()) return;
            const params = new URLSearchParams({ fecha: format(s.start, 'yyyy-MM-dd'), hora: format(s.start, 'HH:mm') });
            if (filters.professionalId) params.set('medico', filters.professionalId);
            router.push(`/agenda/nueva?${params}`);
          }}
          onSelectEvent={(e) => setSelected(e.id)}
          eventPropGetter={(e) => ({ style: { backgroundColor: APPT_COLORS[e.status], opacity: e.status === 'CANCELADA' ? 0.55 : 1, textDecoration: e.status === 'CANCELADA' ? 'line-through' : undefined } })}
          formats={{ timeGutterFormat: (d: Date) => format(d, me?.timeFormat24h ? 'HH:mm' : 'h:mm a', { locale: es }) }}
          popup
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted">
        {APPOINTMENT_STATUSES.map((s) => <span key={s} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: APPT_COLORS[s] }} />{APPOINTMENT_STATUS_LABEL[s]}</span>)}
      </div>
      <AppointmentDialog id={selected} onClose={() => setSelected(null)} onChanged={reload} />
    </>
  );
}

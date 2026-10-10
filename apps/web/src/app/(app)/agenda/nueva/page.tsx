'use client';

import { ageFrom, formatCedula, formatDate, formatMoney, formatTime } from '@medigest/shared';
import { UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { SlotPicker, type Slot } from '@/components/appointments/slot-picker';
import type { Professional } from '@/components/appointments/types';
import { PatientSearch, type PatientHit } from '@/components/patient-search';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form';
import { Card, CardBody, CardHeader, Notice, PageHeader } from '@/components/ui/layout';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { fullName, todayYmd } from '@/lib/utils';

interface Service { id: string; code: string; name: string; durationMin: number; specialtyId: string | null; prices: { insurancePlanId: string | null; price: string }[] }

function Step({ n, title, children, done }: { n: number; title: string; children: React.ReactNode; done?: boolean }) {
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-semibold ${done ? 'bg-teal-600 text-white' : 'bg-navy-100 text-navy-700'}`}>{n}</span>{title}</span>} />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

function NewAppointment() {
  const router = useRouter();
  const params = useSearchParams();
  const { me, branchId } = useSession();
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [specialtyId, setSpecialtyId] = useState('');
  const [professionalId, setProfessionalId] = useState(params.get('medico') ?? me?.professionalId ?? '');
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState(params.get('fecha') ?? todayYmd(me?.organization.timezone));
  const [slot, setSlot] = useState<Slot | null>(null);
  const [modality, setModality] = useState<'PRESENCIAL' | 'VIRTUAL'>('PRESENCIAL');
  const [insuranceId, setInsuranceId] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pros = useApi<Professional[]>('/professionals', { branchId: branchId || undefined });
  const specialties = useApi<{ id: string; name: string }[]>('/specialties');
  const services = useApi<Service[]>('/services', { specialtyId: specialtyId || undefined });
  const quote = useApi<{ price: string; estimatedCoverage: string; estimatedPatient: string; negotiated: boolean }>(serviceId ? `/services/${serviceId}/quote` : null);

  // Paciente preseleccionado (desde la ficha o tras registrarlo).
  useEffect(() => {
    const id = params.get('paciente');
    if (id) api.get<PatientHit & { insurances: PatientHit['insurances'] }>(`/patients/${id}`).then((p) => setPatient({ ...p, insurances: p.insurances?.filter((i) => (i as unknown as { active: boolean }).active !== false) })).catch(() => undefined);
  }, [params]);

  const filteredPros = useMemo(() => (pros.data ?? []).filter((p) => !specialtyId || p.specialties.some((s) => s.specialty.id === specialtyId)), [pros.data, specialtyId]);
  const service = services.data?.find((s) => s.id === serviceId);
  const professional = pros.data?.find((p) => p.id === professionalId);
  const duration = service?.durationMin ?? professional?.defaultDurationMin;

  // Hora sugerida al venir desde el calendario.
  const hint = params.get('hora');

  useEffect(() => setSlot(null), [professionalId, date, serviceId]);
  useEffect(() => {
    const primary = patient?.insurances?.find((i) => i.isPrimary) ?? patient?.insurances?.[0];
    setInsuranceId(primary?.id ?? '');
  }, [patient]);

  const submit = async () => {
    if (!patient || !professionalId || !slot || !branchId) return;
    setBusy(true);
    setError(null);
    try {
      const appt = await api.post<{ id: string }>('/appointments', {
        branchId, patientId: patient.id, professionalId, specialtyId: specialtyId || null, serviceId: serviceId || null,
        patientInsuranceId: insuranceId || null, startsAt: slot.start, durationMin: duration, modality, reason: reason || null, confirmed,
      });
      toast.success('Cita creada. Se programaron los recordatorios.');
      router.push(`/recepcion?cita=${appt.id}`);
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === 'SOLAPAMIENTO') setSlot(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Nueva cita" breadcrumbs={[{ label: 'Agenda', href: '/agenda' }, { label: 'Nueva cita' }]} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Step n={1} title="Paciente" done={!!patient}>
            {patient ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-4 py-3">
                <div>
                  <p className="font-medium">{patient.lastName}, {patient.firstName}</p>
                  <p className="text-xs text-muted">{patient.recordNumber} · {formatCedula(patient.documentNumber)}{patient.birthDate ? ` · ${ageFrom(patient.birthDate)} años` : ''} · {patient.phone ?? 'sin teléfono'}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setPatient(null)}>Cambiar</Button>
              </div>
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row">
                <PatientSearch className="flex-1" autoFocus onSelect={setPatient} placeholder="Buscar por nombre, expediente, cédula o teléfono" />
                <Button variant="outline" asChild><Link href="/pacientes/nuevo?volver=cita"><UserPlus /> Registrar nuevo</Link></Button>
              </div>
            )}
          </Step>

          <Step n={2} title="Médico y servicio" done={!!professionalId}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Especialidad">
                <Select value={specialtyId} onChange={(e) => { setSpecialtyId(e.target.value); setServiceId(''); }}>
                  <option value="">Todas</option>
                  {specialties.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
              <Field label="Médico" required>
                <Select value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
                  <option value="">Seleccione…</option>
                  {filteredPros.map((p) => <option key={p.id} value={p.id}>{fullName(p)} · {p.specialties.map((s) => s.specialty.name).join(', ')}</option>)}
                </Select>
              </Field>
              <Field label="Servicio">
                <Select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
                  <option value="">Sin especificar</option>
                  {services.data?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.durationMin} min)</option>)}
                </Select>
              </Field>
            </div>
          </Step>

          <Step n={3} title="Fecha y hora" done={!!slot}>
            <div className="space-y-4">
              <Field label="Fecha" className="max-w-xs"><Input type="date" value={date} min={todayYmd(me?.organization.timezone)} onChange={(e) => setDate(e.target.value)} /></Field>
              {hint && !slot && <p className="text-xs text-muted">Hora seleccionada en el calendario: {hint}. Elija el espacio disponible correspondiente.</p>}
              <SlotPicker professionalId={professionalId} branchId={branchId} date={date} durationMin={duration} value={slot?.start ?? null} onChange={setSlot} />
            </div>
          </Step>

          <Step n={4} title="Detalles">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {me?.allowVirtualAppointments && (
                <Field label="Modalidad">
                  <Select value={modality} onChange={(e) => setModality(e.target.value as 'PRESENCIAL')}><option value="PRESENCIAL">Presencial</option><option value="VIRTUAL">Virtual</option></Select>
                </Field>
              )}
              <Field label="Seguro" hint={patient && !patient.insurances?.length ? 'El paciente no tiene seguros registrados.' : undefined}>
                <Select value={insuranceId} onChange={(e) => setInsuranceId(e.target.value)} disabled={!patient}>
                  <option value="">Particular</option>
                  {patient?.insurances?.map((i) => <option key={i.id} value={i.id}>{i.plan.insurer.name} · {i.plan.name} ({i.affiliateNumber})</option>)}
                </Select>
              </Field>
              <Field label="Motivo administrativo" className="sm:col-span-2" hint="Ej.: control, primera vez, resultados. No registre datos clínicos aquí.">
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-[60px]" maxLength={300} />
              </Field>
              <Checkbox className="sm:col-span-2" label="La cita queda confirmada con el paciente" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            </div>
          </Step>
        </div>

        <div>
          <Card className="sticky top-20">
            <CardHeader title="Resumen" />
            <CardBody className="space-y-3 text-sm">
              <p><span className="text-muted">Paciente:</span> {patient ? `${patient.firstName} ${patient.lastName}` : '—'}</p>
              <p><span className="text-muted">Médico:</span> {professional ? fullName(professional) : '—'}</p>
              <p><span className="text-muted">Servicio:</span> {service?.name ?? '—'}</p>
              <p><span className="text-muted">Fecha:</span> {slot ? `${formatDate(slot.start)} · ${formatTime(slot.start)} (${duration} min)` : '—'}</p>
              {quote.data && <p><span className="text-muted">Tarifa particular vigente:</span> {formatMoney(quote.data.price, me?.organization.currency)}</p>}
              {insuranceId && <Notice tone="sky">La cobertura y el copago se calculan al facturar con la tarifa vigente del plan.</Notice>}
              {error && <Notice tone="red">{error}</Notice>}
              <Button className="w-full" variant="success" loading={busy} disabled={!patient || !professionalId || !slot} onClick={submit}>Guardar cita</Button>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

export default function NewAppointmentPage() {
  return (
    <Suspense>
      <NewAppointment />
    </Suspense>
  );
}

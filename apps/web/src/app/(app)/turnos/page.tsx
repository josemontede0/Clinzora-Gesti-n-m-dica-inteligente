'use client';

import { QUEUE_STATUS_LABEL } from '@medigest/shared';
import { BellRing, CheckCircle2, Megaphone, MonitorPlay, Plus, Printer, RotateCcw, Shuffle, Stethoscope, UserX, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PatientSearch, type PatientHit } from '@/components/patient-search';
import { minutesSince, type QueueArea, type QueueTicket, useStation } from '@/components/queue/use-station';
import { printPdf } from '@/components/receipts/receipt-actions';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/form';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader, Stat } from '@/components/ui/layout';
import { api, backendUrl, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

interface Board {
  day: string;
  waiting: QueueTicket[];
  inProgress: QueueTicket[];
  closed: QueueTicket[];
  stats: { issued: number; waiting: number; served: number; avgWaitMin: number | null };
}

const who = (t: QueueTicket) => (t.patient ? `${t.patient.firstName} ${t.patient.lastName}` : t.visitorName ?? 'Sin nombre');

export default function QueuePage() {
  const { branchId, can } = useSession();
  const [cfg, setCfg] = useStation();
  const areas = useApi<QueueArea[]>(branchId ? '/queue/areas' : null, { branchId });
  const { data, loading, error, reload } = useApi<Board>(branchId ? '/queue/board' : null, { branchId });
  const [busy, setBusy] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [transfer, setTransfer] = useState<QueueTicket | null>(null);
  const [, tick] = useState(0);

  // Actualización automática del tablero (y del contador de minutos de espera).
  useEffect(() => {
    const t = setInterval(() => {
      void reload();
      tick((n) => n + 1);
    }, 5000);
    return () => clearInterval(t);
  }, [reload]);

  const activeAreas = useMemo(() => (areas.data ?? []).filter((a) => a.active), [areas.data]);
  const mine = (data?.inProgress ?? []).filter((t) => cfg.station && t.station === cfg.station);
  const others = (data?.inProgress ?? []).filter((t) => !cfg.station || t.station !== cfg.station);
  const waiting = (data?.waiting ?? []).filter((t) => !cfg.areaIds.length || cfg.areaIds.includes(t.area.id));

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      await reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const callNext = () =>
    run('next', async () => {
      if (!cfg.station.trim()) throw new Error('Indique su puesto (p. ej. Consultorio 1 o Caja 1)');
      const r = await api.post<{ ticket: QueueTicket | null }>('/queue/call-next', { branchId, areaIds: cfg.areaIds, station: cfg.station.trim() });
      if (r.ticket) toast.success(`Llamando ${r.ticket.code} a ${cfg.station}`);
      else toast.message('No hay turnos en espera');
    });

  const act = (t: QueueTicket, action: string, ok?: string) =>
    run(`${t.id}-${action}`, () => api.post(`/queue/tickets/${t.id}/action`, { action, station: cfg.station.trim() || null }), ok);

  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <>
      <PageHeader
        title="Turnos"
        description="Emita, llame y atienda los turnos de la sala de espera. La pantalla de recepción se actualiza sola."
        actions={
          <>
            {can('queue.configure') && <Button variant="outline" asChild><Link href="/configuracion"><MonitorPlay /> Pantallas</Link></Button>}
            <Button variant="success" onClick={() => setNewOpen(true)}><Plus /> Nuevo turno</Button>
          </>
        }
      />

      <Card className="mb-6">
        <CardBody className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <Field label="Mi puesto" className="lg:w-64" hint="Se mostrará en la pantalla: “pase a …”">
            <Input value={cfg.station} placeholder="Consultorio 1, Caja 1…" onChange={(e) => setCfg({ ...cfg, station: e.target.value })} list="mg-stations" />
          </Field>
          <datalist id="mg-stations">
            {['Recepción', 'Caja 1', 'Caja 2', 'Consultorio 1', 'Consultorio 2', 'Consultorio 3', 'Enfermería'].map((s) => <option key={s} value={s} />)}
          </datalist>
          <div className="flex-1">
            <p className="mb-1.5 text-[13px] font-medium text-slate-700">Áreas que atiendo</p>
            <div className="flex flex-wrap gap-2">
              {activeAreas.map((a) => {
                const on = cfg.areaIds.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setCfg({ ...cfg, areaIds: on ? cfg.areaIds.filter((x) => x !== a.id) : [...cfg.areaIds, a.id] })}
                    className={cn('rounded-full border px-3 py-1.5 text-sm font-medium', on ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-border bg-white text-slate-600 hover:bg-slate-50')}
                  >
                    {a.code} · {a.name}
                  </button>
                );
              })}
              {!cfg.areaIds.length && <span className="self-center text-xs text-muted">Todas las áreas</span>}
            </div>
          </div>
          <Button size="lg" className="h-14 px-8 text-base" loading={busy === 'next'} onClick={callNext}><Megaphone /> Llamar siguiente</Button>
        </CardBody>
      </Card>

      {loading && !data ? <LoadingBlock rows={6} /> : data && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Turnos emitidos hoy" value={data.stats.issued} />
            <Stat label="En espera" value={data.stats.waiting} tone="amber" />
            <Stat label="Atendidos" value={data.stats.served} tone="teal" />
            <Stat label="Espera promedio" value={data.stats.avgWaitMin == null ? '—' : `${data.stats.avgWaitMin} min`} />
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <Card className="xl:col-span-1">
              <CardHeader title={cfg.station ? `Atendiendo en ${cfg.station}` : 'Mis turnos'} description={!cfg.station ? 'Indique su puesto para ver sus turnos.' : undefined} />
              {mine.length ? (
                <ul className="divide-y divide-border">
                  {mine.map((t) => (
                    <li key={t.id} className="space-y-3 px-5 py-4">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-3xl font-bold tracking-tight text-navy-900">{t.code}</p>
                          <p className="text-sm text-slate-700">{who(t)}</p>
                          <p className="text-xs text-muted">{t.area.name} · llamado {t.calledCount} {t.calledCount === 1 ? 'vez' : 'veces'}</p>
                        </div>
                        <Badge tone={t.status === 'ATENDIENDO' ? 'violet' : 'sky'}>{QUEUE_STATUS_LABEL[t.status]}</Badge>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" loading={busy === `${t.id}-volver_a_llamar`} onClick={() => act(t, 'volver_a_llamar', `Volviendo a llamar ${t.code}`)}><BellRing /> Volver a llamar</Button>
                        {t.status === 'LLAMADO' && <Button size="sm" onClick={() => act(t, 'atender')}><Stethoscope /> Atender</Button>}
                        <Button size="sm" variant="success" onClick={() => act(t, 'finalizar', `${t.code} finalizado`)}><CheckCircle2 /> Finalizar</Button>
                        <Button size="sm" variant="ghost" onClick={() => setTransfer(t)}><Shuffle /> Derivar</Button>
                        <Button size="sm" variant="ghost" onClick={() => act(t, 'devolver_a_espera')}><RotateCcw /> A la fila</Button>
                        <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => act(t, 'no_se_presento', `${t.code}: no se presentó`)}><UserX /> No se presentó</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState title="Sin turnos llamados" description="Pulse “Llamar siguiente” para llamar al próximo en la fila." />}
            </Card>

            <Card className="xl:col-span-2">
              <CardHeader title={<span className="flex items-center gap-2">En espera <Badge>{waiting.length}</Badge></span>} description="Primero los prioritarios, luego por orden de llegada." />
              {waiting.length ? (
                <ul className="divide-y divide-border">
                  {waiting.map((t, i) => (
                    <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                      <div className="flex min-w-0 items-center gap-4">
                        <span className="w-6 text-right text-xs text-muted">{i + 1}</span>
                        <span className="text-xl font-bold tabular-nums text-navy-900">{t.code}</span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{who(t)}</p>
                          <p className="text-xs text-muted">{t.area.name} · espera {minutesSince(t.createdAt)} min{t.appointmentId ? ' · con cita' : ''}</p>
                        </div>
                        {t.priority && <Badge tone="amber">Prioritario{t.priorityReason ? `: ${t.priorityReason}` : ''}</Badge>}
                      </div>
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" disabled={!cfg.station.trim()} title={!cfg.station.trim() ? 'Indique su puesto' : undefined} onClick={() => act(t, 'volver_a_llamar', `Llamando ${t.code}`)}><Megaphone /> Llamar</Button>
                        {!t.appointmentId && <Button size="icon" variant="ghost" aria-label={`Imprimir ticket ${t.code}`} onClick={() => printPdf(backendUrl(`/queue/tickets/${t.id}/print`))}><Printer /></Button>}
                        <Button size="icon" variant="ghost" aria-label={`Cancelar ${t.code}`} onClick={() => act(t, 'cancelar', `${t.code} cancelado`)}><XCircle /></Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState title="No hay nadie en espera" />}
            </Card>
          </div>

          {others.length > 0 && (
            <Card>
              <CardHeader title="Llamados en otros puestos" />
              <ul className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
                {others.map((t) => (
                  <li key={t.id} className="bg-white px-5 py-3">
                    <p className="text-lg font-bold text-navy-900">{t.code}</p>
                    <p className="text-xs text-muted">{t.station} · {QUEUE_STATUS_LABEL[t.status]}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      <NewTicketDialog open={newOpen} onOpenChange={setNewOpen} areas={activeAreas} branchId={branchId} onCreated={reload} />

      <Dialog open={!!transfer} onOpenChange={(o) => !o && setTransfer(null)} title={`Derivar ${transfer?.code ?? ''}`} description="Se cierra el turno actual y se emite uno nuevo en el área elegida (conserva la prioridad)." size="sm">
        <div className="grid grid-cols-1 gap-2">
          {activeAreas.filter((a) => a.id !== transfer?.area.id).map((a) => (
            <Button key={a.id} variant="outline" className="justify-start" onClick={async () => {
              const t = transfer!;
              setTransfer(null);
              await run(`${t.id}-transfer`, async () => {
                const nt = await api.post<QueueTicket>(`/queue/tickets/${t.id}/transfer`, { areaId: a.id });
                toast.success(`${t.code} derivado a ${a.name} como ${nt.code}`);
              });
            }}>
              {a.code} · {a.name}
            </Button>
          ))}
        </div>
      </Dialog>
    </>
  );
}

function NewTicketDialog({ open, onOpenChange, areas, branchId, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; areas: QueueArea[]; branchId: string; onCreated: () => void }) {
  const [areaId, setAreaId] = useState('');
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [visitorName, setVisitorName] = useState('');
  const [priority, setPriority] = useState(false);
  const [reason, setReason] = useState('');
  const [created, setCreated] = useState<QueueTicket | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setAreaId(areas.find((a) => !a.autoCheckin)?.id ?? areas[0]?.id ?? '');
      setPatient(null);
      setVisitorName('');
      setPriority(false);
      setReason('');
      setCreated(null);
    }
  }, [open, areas]);

  const submit = async () => {
    setBusy(true);
    try {
      const t = await api.post<QueueTicket>('/queue/tickets', { branchId, areaId, patientId: patient?.id ?? null, visitorName: patient ? null : visitorName || null, priority, priorityReason: priority ? reason : null });
      setCreated(t);
      onCreated();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={created ? `Turno ${created.code}` : 'Nuevo turno'}
      size="sm"
      footer={created ? (
        <>
          <Button variant="outline" onClick={() => setCreated(null)}>Otro turno</Button>
          <Button onClick={() => printPdf(backendUrl(`/queue/tickets/${created.id}/print`))}><Printer /> Imprimir ticket</Button>
        </>
      ) : (
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant="success" loading={busy} disabled={!areaId || (priority && reason.trim().length < 3)} onClick={submit}>Emitir turno</Button>
        </>
      )}
    >
      {created ? (
        <div className="py-4 text-center">
          <p className="text-sm text-muted">{created.area.name}</p>
          <p className="text-6xl font-bold tracking-tight text-navy-900">{created.code}</p>
          {created.priority && <Badge tone="amber" className="mt-2">Prioritario</Badge>}
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Área">
            <Select value={areaId} onChange={(e) => setAreaId(e.target.value)}>{areas.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>
          </Field>
          <Field label="Paciente (opcional)">
            {patient ? (
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                <span>{patient.lastName}, {patient.firstName}</span>
                <button className="text-blue-600 hover:underline" onClick={() => setPatient(null)}>Quitar</button>
              </div>
            ) : <PatientSearch onSelect={setPatient} placeholder="Buscar si tiene expediente…" />}
          </Field>
          {!patient && <Field label="Nombre (opcional)"><Input value={visitorName} onChange={(e) => setVisitorName(e.target.value)} placeholder="Para quien no tiene expediente" /></Field>}
          <Checkbox label="Turno prioritario (embarazada, adulto mayor, discapacidad…)" checked={priority} onChange={(e) => setPriority(e.target.checked)} />
          {priority && <Field label="Motivo de la prioridad" required><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        </div>
      )}
    </Dialog>
  );
}

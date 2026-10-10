'use client';

import { ageFrom, CONSENT_LABEL, CONSENT_TYPES, formatCedula, formatDate, formatDateTime, formatMoney } from '@medigest/shared';
import { CalendarPlus, FileHeart, GitMerge, Pencil, Receipt, UserX, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { DocumentsPanel } from '@/components/patients/documents-panel';
import { InsurancePanel } from '@/components/patients/insurance-panel';
import { MergeDialog } from '@/components/patients/merge-dialog';
import { AppointmentStatusBadge, InvoiceStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader } from '@/components/ui/layout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage, type Paged } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { fullName } from '@/lib/utils';
import type { AppointmentStatus } from '@medigest/shared';

interface PatientDetail {
  id: string; recordNumber: string; firstName: string; lastName: string; documentType: string; documentNumber: string | null; birthDate: string | null; sex: string;
  phone: string | null; email: string | null; address: string | null; city: string | null; province: string | null; adminNotes: string | null; status: string;
  lastVisitAt: string | null; createdAt: string; mergedInto: { id: string; recordNumber: string } | null;
  contacts: { id: string; kind: string; name: string; relationship: string | null; phone: string | null }[];
  currentConsents: { id: string; type: string; granted: boolean; recordedAt: string }[];
  upcomingAppointments: { id: string; startsAt: string; status: AppointmentStatus; professional: { title: string; firstName: string; lastName: string } }[];
  pastAppointmentsCount: number;
  billing?: { balance: string; openInvoices: number; credit: string };
}

interface Account {
  balance: string; credit: string;
  openInvoices: { id: string; number: string; issuedAt: string | null; total: string; balance: string; status: string; overdue: boolean }[];
  pendingCharges: { id: string; description: string; total: string; patientAmount: string; serviceDate: string }[];
}

export default function PatientPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can, canAny, me } = useSession();
  const { data: p, loading, error, reload } = useApi<PatientDetail>(`/patients/${id}`);
  const [tab, setTab] = useState('resumen');
  const appts = useApi<Paged<{ id: string; startsAt: string; status: AppointmentStatus; reason: string | null; professional: { title: string; firstName: string; lastName: string }; specialty: { name: string } | null }>>(tab === 'citas' ? `/patients/${id}/appointments` : null, { pageSize: 50 });
  const account = useApi<Account>(tab === 'cuenta' && canAny('billing.read', 'payments.write') ? `/patients/${id}/account` : null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const cur = me?.organization.currency ?? 'DOP';

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !p) return <LoadingBlock rows={8} />;

  const active = p.status === 'ACTIVE';
  const toggleConsent = async (type: string, granted: boolean) => {
    try {
      await api.post(`/patients/${id}/consents`, { type, granted });
      toast.success('Consentimiento actualizado');
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Pacientes', href: '/pacientes' }, { label: p.recordNumber }]}
        title={`${p.firstName} ${p.lastName}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{p.recordNumber}</span>·<span>{formatCedula(p.documentNumber)}</span>
            {p.birthDate && <>·<span>{ageFrom(p.birthDate)} años</span></>}
            {p.status === 'ACTIVE' ? <Badge tone="teal">Activo</Badge> : p.status === 'MERGED' ? <Badge tone="violet">Fusionado</Badge> : <Badge>Inactivo</Badge>}
          </span>
        }
        actions={
          <>
            {can('appointments.write') && active && <Button asChild variant="success"><Link href={`/agenda/nueva?paciente=${p.id}`}><CalendarPlus /> Nueva cita</Link></Button>}
            {canAny('clinical.read', 'clinical.read_all') && <Button asChild variant="outline"><Link href={`/clinico/paciente/${p.id}`}><FileHeart /> Expediente clínico</Link></Button>}
            {can('payments.write') && <Button asChild variant="outline"><Link href={`/caja/cobrar?paciente=${p.id}`}><Receipt /> Cobrar</Link></Button>}
            {can('patients.write') && p.status !== 'MERGED' && <Button asChild variant="ghost"><Link href={`/pacientes/${p.id}/editar`}><Pencil /> Editar</Link></Button>}
          </>
        }
      />
      {p.mergedInto && <Notice tone="sky" className="mb-4">Este expediente fue fusionado en <Link className="font-medium underline" href={`/pacientes/${p.mergedInto.id}`}>{p.mergedInto.recordNumber}</Link>.</Notice>}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="resumen">Resumen</TabsTrigger>
          {can('appointments.read') && <TabsTrigger value="citas">Citas</TabsTrigger>}
          {canAny('billing.read', 'payments.write') && <TabsTrigger value="cuenta">Cuenta</TabsTrigger>}
          {can('insurance.read') && <TabsTrigger value="seguros">Seguros</TabsTrigger>}
          <TabsTrigger value="documentos">Documentos</TabsTrigger>
        </TabsList>

        <TabsContent value="resumen" className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div className="space-y-6 xl:col-span-2">
            <Card>
              <CardHeader title="Datos del paciente" />
              <CardBody>
                <DefinitionList items={[
                  { label: 'Fecha de nacimiento', value: formatDate(p.birthDate) },
                  { label: 'Sexo', value: p.sex.replace('_', ' ').toLowerCase() },
                  { label: 'Teléfono', value: p.phone },
                  { label: 'Correo', value: p.email },
                  { label: 'Dirección', value: [p.address, p.city, p.province].filter(Boolean).join(', ') || null },
                  { label: 'Última visita', value: formatDate(p.lastVisitAt) },
                  { label: 'Registrado', value: formatDateTime(p.createdAt) },
                  { label: 'Consultas anteriores', value: p.pastAppointmentsCount },
                ]} />
                {p.adminNotes && <Notice tone="sky" className="mt-4"><span className="font-medium">Observaciones:</span> {p.adminNotes}</Notice>}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Próximas citas" />
              {p.upcomingAppointments.length ? (
                <ul className="divide-y divide-border">
                  {p.upcomingAppointments.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                      <span><span className="font-medium">{formatDateTime(a.startsAt)}</span> · {fullName(a.professional)}</span>
                      <AppointmentStatusBadge status={a.status} />
                    </li>
                  ))}
                </ul>
              ) : <EmptyState title="Sin citas próximas" />}
            </Card>
          </div>
          <div className="space-y-6">
            {p.billing && (
              <Card>
                <CardHeader title="Estado de cuenta" />
                <CardBody className="space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-muted">Saldo pendiente</span><span className="font-semibold tabular-nums">{formatMoney(p.billing.balance, cur)}</span></div>
                  <div className="flex justify-between"><span className="text-muted">Facturas abiertas</span><span>{p.billing.openInvoices}</span></div>
                  <div className="flex justify-between"><span className="text-muted">Anticipos disponibles</span><span className="tabular-nums">{formatMoney(p.billing.credit, cur)}</span></div>
                </CardBody>
              </Card>
            )}
            <Card>
              <CardHeader title="Contactos" />
              <CardBody className="space-y-3 text-sm">
                {p.contacts.length ? p.contacts.map((c) => (
                  <div key={c.id}>
                    <p className="text-xs font-medium uppercase text-muted">{c.kind === 'GUARDIAN' ? 'Responsable / tutor' : 'Emergencia'}</p>
                    <p>{c.name}{c.relationship ? ` (${c.relationship})` : ''} · {c.phone ?? 'sin teléfono'}</p>
                  </div>
                )) : <p className="text-muted">Sin contactos registrados</p>}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Consentimientos" description="El último registro de cada tipo es el vigente." />
              <ul className="divide-y divide-border">
                {CONSENT_TYPES.filter((t) => t !== 'OTRO').map((type) => {
                  const c = p.currentConsents.find((x) => x.type === type);
                  return (
                    <li key={type} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm">
                      <span>{CONSENT_LABEL[type]}</span>
                      {can('patients.write') ? (
                        <button onClick={() => toggleConsent(type, !c?.granted)} className="shrink-0">
                          {c?.granted ? <Badge tone="teal">Otorgado</Badge> : c ? <Badge tone="red">Denegado</Badge> : <Badge>Sin registrar</Badge>}
                        </button>
                      ) : c?.granted ? <Badge tone="teal">Otorgado</Badge> : <Badge>{c ? 'Denegado' : 'Sin registrar'}</Badge>}
                    </li>
                  );
                })}
              </ul>
            </Card>
            {can('patients.write') && p.status !== 'MERGED' && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setStatusOpen(true)}>{active ? <><UserX /> Marcar inactivo</> : <><UserCheck /> Reactivar</>}</Button>
                {can('patients.merge') && <Button variant="outline" size="sm" onClick={() => setMergeOpen(true)}><GitMerge /> Fusionar duplicado</Button>}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="citas">
          <Card>
            {appts.loading ? <LoadingBlock /> : appts.data?.items.length ? (
              <ul className="divide-y divide-border">
                {appts.data.items.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                    <div>
                      <p className="font-medium">{formatDateTime(a.startsAt)}</p>
                      <p className="text-xs text-muted">{fullName(a.professional)}{a.specialty ? ` · ${a.specialty.name}` : ''}{a.reason ? ` · ${a.reason}` : ''}</p>
                    </div>
                    <AppointmentStatusBadge status={a.status} />
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="Sin citas registradas" />}
          </Card>
        </TabsContent>

        <TabsContent value="cuenta" className="space-y-6">
          {account.loading ? <LoadingBlock /> : account.data && (
            <>
              <div className="flex flex-wrap gap-2">
                {can('billing.write') && <Button asChild variant="outline"><Link href={`/facturacion/nueva?paciente=${id}`}>Facturar cargos pendientes</Link></Button>}
                {can('payments.write') && <Button asChild variant="success"><Link href={`/caja/cobrar?paciente=${id}`}>Registrar cobro</Link></Button>}
                {can('billing.read') && Number(account.data.balance) > 0 && (
                  <Button variant="ghost" onClick={async () => { try { const r = await api.post<{ queued: number }>(`/patients/${id}/balance-reminder`); toast.success(r.queued ? 'Recordatorio de saldo programado' : 'Sin canales autorizados para enviar'); } catch (e) { toast.error(errorMessage(e)); } }}>
                    Enviar recordatorio de saldo
                  </Button>
                )}
              </div>
              <Card>
                <CardHeader title="Facturas con saldo" description={`Saldo total: ${formatMoney(account.data.balance, cur)} · Anticipos: ${formatMoney(account.data.credit, cur)}`} />
                {account.data.openInvoices.length ? (
                  <ul className="divide-y divide-border">
                    {account.data.openInvoices.map((i) => (
                      <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                        <Link href={`/facturacion/${i.id}`} className="font-medium text-navy-700 hover:underline">{i.number}</Link>
                        <span className="text-muted">{formatDate(i.issuedAt)}</span>
                        <span className="tabular-nums">Total {formatMoney(i.total, cur)} · Saldo <b>{formatMoney(i.balance, cur)}</b></span>
                        <InvoiceStatusBadge status={i.status} overdue={i.overdue} />
                      </li>
                    ))}
                  </ul>
                ) : <EmptyState title="Sin facturas pendientes" />}
              </Card>
              <Card>
                <CardHeader title="Cargos pendientes de facturar" />
                {account.data.pendingCharges.length ? (
                  <ul className="divide-y divide-border">
                    {account.data.pendingCharges.map((c) => (
                      <li key={c.id} className="flex flex-wrap justify-between gap-2 px-5 py-3 text-sm">
                        <span>{c.description}</span><span className="text-muted">{formatDate(c.serviceDate)}</span>
                        <span className="tabular-nums">Paciente {formatMoney(c.patientAmount, cur)} de {formatMoney(c.total, cur)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <EmptyState title="Sin cargos pendientes" />}
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="seguros"><InsurancePanel patientId={id} /></TabsContent>
        <TabsContent value="documentos"><DocumentsPanel patientId={id} /></TabsContent>
      </Tabs>

      <ConfirmDialog
        open={statusOpen}
        onOpenChange={setStatusOpen}
        title={active ? 'Marcar paciente como inactivo' : 'Reactivar paciente'}
        description={active ? 'El historial se conserva. No podrá agendar nuevas citas mientras esté inactivo.' : undefined}
        requireReason={active}
        tone={active ? 'destructive' : 'success'}
        confirmLabel={active ? 'Marcar inactivo' : 'Reactivar'}
        onConfirm={async (reason) => {
          try {
            await api.post(`/patients/${id}/status`, { status: active ? 'INACTIVE' : 'ACTIVE', reason });
            toast.success('Estado actualizado');
            reload();
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      />
      <MergeDialog open={mergeOpen} onOpenChange={setMergeOpen} target={p} onMerged={(targetId) => router.push(`/pacientes/${targetId}`)} />
    </>
  );
}

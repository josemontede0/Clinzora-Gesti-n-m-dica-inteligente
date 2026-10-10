'use client';

import { formatDate } from '@medigest/shared';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/form';
import { Card, CardBody, CardHeader, LoadingBlock, Notice } from '@/components/ui/layout';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { useMutation } from './shared';

interface Org { name: string; legalName: string | null; rnc: string | null; phone: string | null; email: string | null; address: string | null; currency: string; timezone: string }
interface Ops { productName: string; reminderOffsetsMinutes: number[]; notificationChannels: string[]; cancellationMinHours: number; invoiceDueDays: number; allowVirtualAppointments: boolean; maxLoginAttempts: number; lockoutMinutes: number; timeFormat24h: boolean; dataRetentionYears: number }

interface Retention { retentionYears: number; cutoff: string; total: number; patients: { id: string; recordNumber: string; firstName: string; lastName: string; lastVisitAt: string | null; createdAt: string }[] }

/** Revisión de expedientes fuera del plazo de retención. No elimina nada. */
function RetentionCard() {
  const [data, setData] = useState<Retention | null>(null);
  const { busy, run } = useMutation();
  return (
    <Card className="xl:col-span-2">
      <CardHeader
        title="Revisión de retención de expedientes"
        description="Lista los pacientes sin actividad por más años que el plazo configurado. El sistema no elimina expedientes: la depuración debe seguir un procedimiento aprobado por asesoría legal."
        actions={<Button size="sm" variant="outline" loading={busy} onClick={() => run(async () => setData(await api.get<Retention>('/settings/retention')), 'Revisión generada')}>Revisar ahora</Button>}
      />
      {data && (
        <CardBody className="text-sm">
          <p className="mb-3">Plazo: {data.retentionYears} años (sin actividad antes del {formatDate(data.cutoff)}). Expedientes encontrados: <b>{data.total}</b>.</p>
          {data.patients.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {data.patients.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 px-3 py-2">
                  <span>{p.recordNumber} · {p.lastName}, {p.firstName}</span>
                  <span className="text-muted">Última visita {formatDate(p.lastVisitAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      )}
    </Card>
  );
}

export function OrganizationTab() {
  const { can, refresh } = useSession();
  const org = useApi<Org>('/settings/organization');
  const ops = useApi<Ops>('/settings/operational');
  const [o, setO] = useState<Org | null>(null);
  const [p, setP] = useState<Ops | null>(null);
  const { busy, run } = useMutation();
  const edit = can('settings.manage');
  useEffect(() => setO(org.data), [org.data]);
  useEffect(() => setP(ops.data), [ops.data]);
  if (!o || !p) return <LoadingBlock />;
  const so = (k: keyof Org) => (e: React.ChangeEvent<HTMLInputElement>) => setO({ ...o, [k]: e.target.value });

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader title="Datos de la organización" description="Se usan en facturas, reportes y mensajes." />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Nombre comercial" className="sm:col-span-2"><Input value={o.name} onChange={so('name')} disabled={!edit} /></Field>
          <Field label="Razón social"><Input value={o.legalName ?? ''} onChange={so('legalName')} disabled={!edit} /></Field>
          <Field label="RNC"><Input value={o.rnc ?? ''} onChange={so('rnc')} disabled={!edit} /></Field>
          <Field label="Teléfono"><Input value={o.phone ?? ''} onChange={so('phone')} disabled={!edit} /></Field>
          <Field label="Correo"><Input value={o.email ?? ''} onChange={so('email')} disabled={!edit} /></Field>
          <Field label="Dirección" className="sm:col-span-2"><Input value={o.address ?? ''} onChange={so('address')} disabled={!edit} /></Field>
          <Field label="Moneda (ISO)" hint="DOP por defecto"><Input value={o.currency} onChange={so('currency')} disabled={!edit} maxLength={3} /></Field>
          <Field label="Zona horaria"><Input value={o.timezone} onChange={so('timezone')} disabled={!edit} /></Field>
          {edit && <Button className="sm:col-span-2 sm:w-fit" loading={busy} onClick={async () => { if (await run(() => api.put('/settings/organization', o), 'Datos guardados')) refresh(); }}>Guardar</Button>}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Parámetros operativos" />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Nombre del producto" className="sm:col-span-2"><Input value={p.productName} onChange={(e) => setP({ ...p, productName: e.target.value })} disabled={!edit} /></Field>
          <Field label="Recordatorios antes de la cita (horas)" hint="Separados por coma. Ej.: 24, 2"><Input value={p.reminderOffsetsMinutes.map((m) => m / 60).join(', ')} onChange={(e) => setP({ ...p, reminderOffsetsMinutes: e.target.value.split(',').map((x) => Math.round(Number(x.trim()) * 60)).filter((n) => n > 0) })} disabled={!edit} /></Field>
          <Field label="Canales de notificación">
            <div className="flex flex-wrap gap-4 pt-2">
              {['EMAIL', 'WHATSAPP', 'SMS'].map((c) => <Checkbox key={c} label={c === 'EMAIL' ? 'Correo' : c === 'WHATSAPP' ? 'WhatsApp' : 'SMS'} checked={p.notificationChannels.includes(c)} disabled={!edit} onChange={(e) => setP({ ...p, notificationChannels: e.target.checked ? [...p.notificationChannels, c] : p.notificationChannels.filter((x) => x !== c) })} />)}
            </div>
          </Field>
          <Field label="Cancelación con anticipación mínima (horas)"><Input type="number" value={p.cancellationMinHours} onChange={(e) => setP({ ...p, cancellationMinHours: Number(e.target.value) })} disabled={!edit} /></Field>
          <Field label="Días de vencimiento de facturas"><Input type="number" value={p.invoiceDueDays} onChange={(e) => setP({ ...p, invoiceDueDays: Number(e.target.value) })} disabled={!edit} /></Field>
          <Field label="Intentos de acceso antes de bloquear"><Input type="number" value={p.maxLoginAttempts} onChange={(e) => setP({ ...p, maxLoginAttempts: Number(e.target.value) })} disabled={!edit} /></Field>
          <Field label="Minutos de bloqueo"><Input type="number" value={p.lockoutMinutes} onChange={(e) => setP({ ...p, lockoutMinutes: Number(e.target.value) })} disabled={!edit} /></Field>
          <Field label="Retención de expedientes (años)" hint="Validar con asesoría legal"><Input type="number" value={p.dataRetentionYears} onChange={(e) => setP({ ...p, dataRetentionYears: Number(e.target.value) })} disabled={!edit} /></Field>
          <div className="space-y-2 sm:col-span-2">
            <Checkbox label="Permitir citas virtuales" checked={p.allowVirtualAppointments} disabled={!edit} onChange={(e) => setP({ ...p, allowVirtualAppointments: e.target.checked })} />
            <Checkbox label="Mostrar horas en formato 24 h" checked={p.timeFormat24h} disabled={!edit} onChange={(e) => setP({ ...p, timeFormat24h: e.target.checked })} />
          </div>
          {edit && <Button className="sm:col-span-2 sm:w-fit" loading={busy} onClick={async () => { if (await run(() => api.put('/settings/operational', p), 'Parámetros guardados')) refresh(); }}>Guardar parámetros</Button>}
          <Notice tone="sky" className="sm:col-span-2">Los cambios de recordatorios aplican a las citas que se creen o reprogramen desde ahora.</Notice>
        </CardBody>
      </Card>
      {edit && <RetentionCard />}
    </div>
  );
}

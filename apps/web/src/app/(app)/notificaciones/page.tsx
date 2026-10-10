'use client';

import { formatDateTime } from '@medigest/shared';
import type { ColumnDef } from '@tanstack/react-table';
import { RefreshCw } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { TestModeBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form';
import { Badge, Card, CardHeader, LoadingBlock, Notice, PageHeader } from '@/components/ui/layout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage, type Paged } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Notif { id: string; type: string; channel: string; recipient: string; status: string; scheduledFor: string; sentAt: string | null; attempts: number; testMode: boolean; lastError: string | null; provider: string | null }
interface Template { id: string; type: string; channel: string; subject: string | null; body: string; active: boolean }

const TYPE_LABEL: Record<string, string> = {
  CITA_CONFIRMACION: 'Confirmación de cita', CITA_RECORDATORIO: 'Recordatorio de cita', CITA_CAMBIO: 'Cambio de cita', CITA_CANCELACION: 'Cancelación',
  CITA_PENDIENTE_CONFIRMAR: 'Cita pendiente de confirmar', SALDO_PENDIENTE: 'Saldo pendiente', RECUPERAR_CONTRASENA: 'Recuperar contraseña',
};
const STATUS_TONE: Record<string, 'teal' | 'amber' | 'red' | 'slate' | 'sky'> = { ENVIADO: 'sky', ENTREGADO: 'teal', CONFIRMADO: 'teal', PENDIENTE: 'amber', FALLIDO: 'red', CANCELADO: 'slate', OMITIDO: 'slate' };

function Notifications() {
  const params = useSearchParams();
  const { can } = useSession();
  const [f, setF] = useState({ status: params.get('estado') ?? '', channel: '', page: 1 });
  const list = useApi<Paged<Notif>>('/notifications', { status: f.status || undefined, channel: f.channel || undefined, page: f.page });
  const templates = useApi<Template[]>('/notifications/templates');
  const [edit, setEdit] = useState<Template | null>(null);

  const columns: ColumnDef<Notif, unknown>[] = [
    { header: 'Programado', cell: ({ row }) => formatDateTime(row.original.scheduledFor) },
    { header: 'Tipo', cell: ({ row }) => TYPE_LABEL[row.original.type] ?? row.original.type },
    { header: 'Canal', cell: ({ row }) => row.original.channel },
    { header: 'Destinatario', cell: ({ row }) => <span className="font-mono text-xs">{row.original.recipient}</span> },
    { header: 'Estado', cell: ({ row }) => <span className="flex flex-wrap gap-1"><Badge tone={STATUS_TONE[row.original.status]}>{row.original.status.toLowerCase()}</Badge>{row.original.testMode && <TestModeBadge />}</span> },
    { header: 'Detalle', cell: ({ row }) => <span className="text-xs text-muted">{row.original.lastError ?? (row.original.attempts ? `${row.original.attempts} intento(s)` : '')}</span> },
    { header: '', id: 'acc', cell: ({ row }) => row.original.status === 'FALLIDO' && can('notifications.manage') ? <Button size="sm" variant="ghost" onClick={async () => { await api.post(`/notifications/${row.original.id}/retry`); toast.success('Reprogramado'); list.reload(); }}>Reintentar</Button> : null },
  ];

  return (
    <>
      <PageHeader
        title="Notificaciones"
        description="Registro de confirmaciones y recordatorios. Solo se envían por canales con consentimiento del paciente y sin información clínica."
        actions={can('notifications.manage') && <Button variant="outline" onClick={async () => { const r = await api.post<{ processed: number }>('/notifications/process'); toast.success(`${r.processed} mensaje(s) procesado(s)`); list.reload(); }}><RefreshCw /> Procesar cola ahora</Button>}
      />
      <Notice tone="amber" className="mb-4">Los mensajes marcados “Modo prueba” no salieron a la red: falta configurar los proveedores reales (SMTP, WhatsApp Business, SMS). Un mensaje solo se marca “entregado” cuando el proveedor lo confirma.</Notice>
      <Tabs defaultValue="registro">
        <TabsList><TabsTrigger value="registro">Registro de envíos</TabsTrigger><TabsTrigger value="plantillas">Plantillas</TabsTrigger></TabsList>
        <TabsContent value="registro">
          <Card>
            <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row">
              <Select className="sm:w-48" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} aria-label="Estado"><option value="">Todos los estados</option>{Object.keys(STATUS_TONE).map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</Select>
              <Select className="sm:w-40" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value, page: 1 })} aria-label="Canal"><option value="">Todos los canales</option><option>EMAIL</option><option>WHATSAPP</option><option>SMS</option></Select>
            </div>
            <DataTable columns={columns} data={list.data?.items ?? []} loading={list.loading} error={list.error} onRetry={list.reload} page={list.data?.page} pages={list.data?.pages} total={list.data?.total} onPageChange={(page) => setF({ ...f, page })} />
          </Card>
        </TabsContent>
        <TabsContent value="plantillas">
          <Card>
            <CardHeader title="Plantillas" description="Variables disponibles: {{nombre}}, {{fecha}}, {{hora}}, {{medico}}, {{ubicacion}}, {{centro}}, {{monto}}." />
            {templates.loading ? <LoadingBlock /> : (
              <ul className="divide-y divide-border">
                {templates.data?.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-start justify-between gap-2 px-5 py-3 text-sm">
                    <div className="min-w-0 flex-1"><p className="font-medium">{TYPE_LABEL[t.type]} · {t.channel} {!t.active && <Badge>Inactiva</Badge>}</p><p className="mt-0.5 text-muted">{t.body}</p></div>
                    {can('notifications.manage') && <Button size="sm" variant="ghost" onClick={() => setEdit(t)}>Editar</Button>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>
      </Tabs>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title="Editar plantilla" size="lg" footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancelar</Button><Button variant="success" onClick={async () => { try { await api.put(`/notifications/templates/${edit!.id}`, { subject: edit!.subject, body: edit!.body, active: edit!.active }); toast.success('Plantilla guardada'); setEdit(null); templates.reload(); } catch (e) { toast.error(errorMessage(e)); } }}>Guardar</Button></>}>
        {edit && (
          <div className="space-y-4">
            {edit.channel === 'EMAIL' && <Field label="Asunto"><Input value={edit.subject ?? ''} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></Field>}
            <Field label="Mensaje" hint="No incluya diagnósticos ni información clínica."><Textarea value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} className="min-h-[140px]" /></Field>
            <Checkbox label="Plantilla activa" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />
          </div>
        )}
      </Dialog>
    </>
  );
}

export default function NotificationsPage() {
  return (
    <Suspense>
      <Notifications />
    </Suspense>
  );
}

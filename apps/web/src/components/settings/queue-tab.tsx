'use client';

import { formatDateTime } from '@medigest/shared';
import { Copy, ExternalLink, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { QueueArea } from '@/components/queue/use-station';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/form';
import { Badge, Card, CardHeader, LoadingBlock, Notice } from '@/components/ui/layout';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { save, useMutation } from './shared';

interface Screen { id: string; branchId: string; name: string; showNames: boolean; lastSeenAt: string | null; createdAt: string }
interface Branch { id: string; name: string }

export function QueueTab() {
  const branches = useApi<Branch[]>('/settings/branches');
  const areas = useApi<QueueArea[]>('/queue/areas');
  const screens = useApi<Screen[]>('/queue/screens');
  const [area, setArea] = useState<Partial<QueueArea> | null>(null);
  const [screen, setScreen] = useState<{ branchId: string; name: string; showNames: boolean } | null>(null);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const [revoke, setRevoke] = useState<Screen | null>(null);
  const { busy, run } = useMutation();
  const branchName = (id: string) => branches.data?.find((b) => b.id === id)?.name ?? '';
  const urlFor = (token: string) => `${window.location.origin}/pantalla/${token}`;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Áreas de turnos"
          description="Cada área tiene su propia fila y prefijo (C-012). El área marcada como “recibe pacientes con cita” emite el turno automáticamente al registrar la llegada."
          actions={<Button size="sm" variant="outline" onClick={() => setArea({ branchId: branches.data?.[0]?.id, code: '', name: '', autoCheckin: false, sortOrder: (areas.data?.length ?? 0) + 1, active: true })}><Plus /> Área</Button>}
        />
        {areas.loading ? <LoadingBlock /> : (
          <ul className="divide-y divide-border text-sm">
            {areas.data?.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                <span className="flex items-center gap-2">
                  <span className="grid h-8 w-10 place-items-center rounded-lg bg-navy-50 font-bold text-navy-700">{a.code}</span>
                  <span className="font-medium">{a.name}</span>
                  <span className="text-xs text-muted">· {branchName(a.branchId)}</span>
                  {a.autoCheckin && <Badge tone="teal">Recibe pacientes con cita</Badge>}
                  {!a.active && <Badge>Inactiva</Badge>}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setArea(a)}>Editar</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Pantallas de recepción"
          description="Abra el enlace en el navegador del TV o monitor de la sala de espera (pantalla completa). No requiere iniciar sesión: trate el enlace como una contraseña."
          actions={<Button size="sm" variant="outline" onClick={() => setScreen({ branchId: branches.data?.[0]?.id ?? '', name: 'TV sala de espera', showNames: false })}><Plus /> Pantalla</Button>}
        />
        {screens.loading ? <LoadingBlock /> : screens.data?.length ? (
          <ul className="divide-y divide-border text-sm">
            {screens.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                <div>
                  <p className="font-medium">{s.name} <span className="text-xs text-muted">· {branchName(s.branchId)}</span></p>
                  <p className="text-xs text-muted">{s.lastSeenAt ? `Última conexión ${formatDateTime(s.lastSeenAt)}` : 'Aún no se ha abierto'} · {s.showNames ? 'muestra nombre abreviado' : 'solo código de turno'}</p>
                </div>
                <span className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => run(async () => { await api.put(`/queue/screens/${s.id}`, { showNames: !s.showNames }); await screens.reload(); }, s.showNames ? 'Ahora solo muestra el código' : 'Ahora muestra el nombre abreviado')}>
                    {s.showNames ? 'Ocultar nombres' : 'Mostrar nombres'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => run(async () => { const r = await api.post<{ token: string }>(`/queue/screens/${s.id}/regenerate`); setLink({ name: s.name, url: urlFor(r.token) }); }, 'Enlace nuevo generado; el anterior dejó de funcionar')}>
                    Generar enlace nuevo
                  </Button>
                  <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => setRevoke(s)}>Revocar</Button>
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="px-5 py-4 text-sm text-muted">No hay pantallas. Cree una para mostrar los turnos en la recepción.</p>}
      </Card>

      <Dialog open={!!area} onOpenChange={(o) => !o && setArea(null)} title={area?.id ? 'Editar área' : 'Nueva área'} footer={<><Button variant="outline" onClick={() => setArea(null)}>Cancelar</Button><Button loading={busy} onClick={async () => {
        const a = area!;
        if (await run(() => save('/queue/areas', a.id, { branchId: a.branchId, code: a.code, name: a.name, autoCheckin: !!a.autoCheckin, sortOrder: a.sortOrder ?? 0, active: a.active ?? true }), 'Área guardada')) { setArea(null); areas.reload(); }
      }}>Guardar</Button></>}>
        {area && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Sucursal" className="col-span-2"><Select value={area.branchId} disabled={!!area.id} onChange={(e) => setArea({ ...area, branchId: e.target.value })}>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            <Field label="Prefijo" hint="1 a 3 letras"><Input value={area.code ?? ''} maxLength={3} onChange={(e) => setArea({ ...area, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Nombre"><Input value={area.name ?? ''} onChange={(e) => setArea({ ...area, name: e.target.value })} /></Field>
            <Field label="Orden"><Input type="number" value={area.sortOrder ?? 0} onChange={(e) => setArea({ ...area, sortOrder: Number(e.target.value) })} /></Field>
            <div className="col-span-2 space-y-2">
              <Checkbox label="Recibe pacientes con cita (turno automático al registrar la llegada)" checked={!!area.autoCheckin} onChange={(e) => setArea({ ...area, autoCheckin: e.target.checked })} />
              <Checkbox label="Activa" checked={area.active ?? true} onChange={(e) => setArea({ ...area, active: e.target.checked })} />
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={!!screen} onOpenChange={(o) => !o && setScreen(null)} title="Nueva pantalla de recepción" footer={<><Button variant="outline" onClick={() => setScreen(null)}>Cancelar</Button><Button loading={busy} onClick={async () => {
        const sc = screen!;
        await run(async () => { const r = await api.post<{ token: string }>('/queue/screens', sc); setScreen(null); setLink({ name: sc.name, url: urlFor(r.token) }); await screens.reload(); }, 'Pantalla creada');
      }}>Crear</Button></>}>
        {screen && (
          <div className="space-y-4">
            <Field label="Sucursal"><Select value={screen.branchId} onChange={(e) => setScreen({ ...screen, branchId: e.target.value })}>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            <Field label="Nombre"><Input value={screen.name} onChange={(e) => setScreen({ ...screen, name: e.target.value })} /></Field>
            <Checkbox label="Mostrar el nombre del paciente abreviado (Ana P.)" checked={screen.showNames} onChange={(e) => setScreen({ ...screen, showNames: e.target.checked })} />
            <Notice tone="sky">Por privacidad se recomienda mostrar solo el código del turno.</Notice>
          </div>
        )}
      </Dialog>

      <Dialog open={!!link} onOpenChange={(o) => !o && setLink(null)} title={`Enlace de “${link?.name ?? ''}”`} description="Cópielo ahora: por seguridad no se vuelve a mostrar. Si se pierde, genere uno nuevo.">
        {link && (
          <div className="space-y-4">
            <Input readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Enlace de la pantalla" />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => { void navigator.clipboard.writeText(link.url); toast.success('Enlace copiado'); }}><Copy /> Copiar</Button>
              <Button variant="outline" asChild><a href={link.url} target="_blank" rel="noopener noreferrer"><ExternalLink /> Abrir pantalla</a></Button>
            </div>
            <p className="text-xs text-muted">En el TV: abra el enlace, pulse “pantalla completa” y toque una vez para activar el sonido.</p>
          </div>
        )}
      </Dialog>

      <ConfirmDialog open={!!revoke} onOpenChange={(o) => !o && setRevoke(null)} title={`Revocar “${revoke?.name ?? ''}”`} description="La pantalla dejará de mostrar turnos de inmediato." tone="destructive" confirmLabel="Revocar" onConfirm={async () => { await run(() => api.put(`/queue/screens/${revoke!.id}`, { active: false }), 'Pantalla revocada'); await screens.reload(); }} />
    </div>
  );
}

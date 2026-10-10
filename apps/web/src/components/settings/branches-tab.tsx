'use client';

import { PAYMENT_METHOD_KIND_LABEL } from '@medigest/shared';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/form';
import { Badge, Card, CardHeader, LoadingBlock } from '@/components/ui/layout';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { save, useMutation } from './shared';

interface Branch { id: string; code: string; name: string; address: string | null; phone: string | null; timezone: string | null; active: boolean; rooms: { id: string; name: string; active: boolean }[] }
interface Method { id: string; code: string; name: string; kind: string; requiresReference: boolean; active: boolean }
interface Register { id: string; name: string; branchId: string; active: boolean; branch: { name: string } }

export function BranchesTab() {
  const { can } = useSession();
  const branches = useApi<Branch[]>('/settings/branches');
  const methods = useApi<Method[]>('/settings/payment-methods');
  const registers = useApi<Register[]>('/settings/cash-registers');
  const [b, setB] = useState<Partial<Branch> | null>(null);
  const [room, setRoom] = useState<{ id?: string; branchId: string; name: string; active: boolean } | null>(null);
  const [m, setM] = useState<Partial<Method> | null>(null);
  const [reg, setReg] = useState<{ branchId: string; name: string } | null>(null);
  const { busy, run } = useMutation();
  const cat = can('catalogs.manage');
  const set = can('settings.manage');

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Card className="xl:col-span-2">
        <CardHeader title="Sucursales y consultorios" actions={cat && <Button size="sm" variant="outline" onClick={() => setB({ active: true })}><Plus /> Sucursal</Button>} />
        {branches.loading ? <LoadingBlock /> : (
          <ul className="divide-y divide-border">
            {branches.data?.map((br) => (
              <li key={br.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{br.name} <span className="font-mono text-xs text-muted">{br.code}</span> {!br.active && <Badge>Inactiva</Badge>}</p>
                  {cat && <span className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setRoom({ branchId: br.id, name: '', active: true })}><Plus /> Consultorio</Button><Button size="sm" variant="ghost" onClick={() => setB(br)}>Editar</Button></span>}
                </div>
                <p className="text-xs text-muted">{br.address ?? 'Sin dirección'}{br.phone ? ` · ${br.phone}` : ''}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">{br.rooms.map((r) => <button key={r.id} disabled={!cat} onClick={() => setRoom({ id: r.id, branchId: br.id, name: r.name, active: r.active })}><Badge tone={r.active ? 'navy' : 'slate'}>{r.name}</Badge></button>)}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Medios de pago" actions={set && <Button size="sm" variant="outline" onClick={() => setM({ kind: 'OTRO', active: true, requiresReference: false })}><Plus /> Medio</Button>} />
        <ul className="divide-y divide-border text-sm">
          {methods.data?.map((x) => (
            <li key={x.id} className="flex items-center justify-between px-5 py-2.5">
              <span>{x.name} <span className="text-xs text-muted">{PAYMENT_METHOD_KIND_LABEL[x.kind]}</span> {!x.active && <Badge>Inactivo</Badge>}</span>
              {set && <Button size="sm" variant="ghost" onClick={() => setM(x)}>Editar</Button>}
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <CardHeader title="Cajas" actions={set && <Button size="sm" variant="outline" onClick={() => setReg({ branchId: branches.data?.[0]?.id ?? '', name: '' })}><Plus /> Caja</Button>} />
        <ul className="divide-y divide-border text-sm">{registers.data?.map((r) => <li key={r.id} className="px-5 py-2.5">{r.name} <span className="text-xs text-muted">· {r.branch.name}</span></li>)}</ul>
      </Card>

      <Dialog open={!!b} onOpenChange={(o) => !o && setB(null)} title={b?.id ? 'Editar sucursal' : 'Nueva sucursal'} footer={<><Button variant="outline" onClick={() => setB(null)}>Cancelar</Button><Button loading={busy} onClick={async () => { if (await run(() => save('/settings/branches', b!.id, { code: b!.code, name: b!.name, address: b!.address || null, phone: b!.phone || null, timezone: b!.timezone || null, active: b!.active ?? true }), 'Sucursal guardada')) { setB(null); branches.reload(); } }}>Guardar</Button></>}>
        {b && <div className="grid grid-cols-2 gap-4">
          <Field label="Código"><Input value={b.code ?? ''} onChange={(e) => setB({ ...b, code: e.target.value })} /></Field>
          <Field label="Nombre"><Input value={b.name ?? ''} onChange={(e) => setB({ ...b, name: e.target.value })} /></Field>
          <Field label="Dirección" className="col-span-2"><Input value={b.address ?? ''} onChange={(e) => setB({ ...b, address: e.target.value })} /></Field>
          <Field label="Teléfono"><Input value={b.phone ?? ''} onChange={(e) => setB({ ...b, phone: e.target.value })} /></Field>
          <Field label="Zona horaria (opcional)"><Input value={b.timezone ?? ''} onChange={(e) => setB({ ...b, timezone: e.target.value })} placeholder="America/Santo_Domingo" /></Field>
          <Checkbox label="Activa" checked={b.active ?? true} onChange={(e) => setB({ ...b, active: e.target.checked })} />
        </div>}
      </Dialog>
      <Dialog open={!!room} onOpenChange={(o) => !o && setRoom(null)} title="Consultorio" footer={<><Button variant="outline" onClick={() => setRoom(null)}>Cancelar</Button><Button loading={busy} onClick={async () => { if (await run(() => save('/settings/rooms', room!.id, { branchId: room!.branchId, name: room!.name, active: room!.active }), 'Consultorio guardado')) { setRoom(null); branches.reload(); } }}>Guardar</Button></>}>
        {room && <div className="space-y-4"><Field label="Nombre"><Input value={room.name} onChange={(e) => setRoom({ ...room, name: e.target.value })} /></Field><Checkbox label="Activo" checked={room.active} onChange={(e) => setRoom({ ...room, active: e.target.checked })} /></div>}
      </Dialog>
      <Dialog open={!!m} onOpenChange={(o) => !o && setM(null)} title="Medio de pago" footer={<><Button variant="outline" onClick={() => setM(null)}>Cancelar</Button><Button loading={busy} onClick={async () => { if (await run(() => save('/settings/payment-methods', m!.id, { code: m!.code, name: m!.name, kind: m!.kind, requiresReference: !!m!.requiresReference, active: m!.active ?? true }), 'Medio guardado')) { setM(null); methods.reload(); } }}>Guardar</Button></>}>
        {m && <div className="grid grid-cols-2 gap-4">
          <Field label="Código"><Input value={m.code ?? ''} onChange={(e) => setM({ ...m, code: e.target.value })} /></Field>
          <Field label="Nombre"><Input value={m.name ?? ''} onChange={(e) => setM({ ...m, name: e.target.value })} /></Field>
          <Field label="Tipo" className="col-span-2"><Select value={m.kind} onChange={(e) => setM({ ...m, kind: e.target.value })}>{Object.entries(PAYMENT_METHOD_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Checkbox label="Requiere referencia" checked={!!m.requiresReference} onChange={(e) => setM({ ...m, requiresReference: e.target.checked })} />
          <Checkbox label="Activo" checked={m.active ?? true} onChange={(e) => setM({ ...m, active: e.target.checked })} />
        </div>}
      </Dialog>
      <Dialog open={!!reg} onOpenChange={(o) => !o && setReg(null)} title="Nueva caja" footer={<><Button variant="outline" onClick={() => setReg(null)}>Cancelar</Button><Button loading={busy} onClick={async () => { if (await run(() => api.post('/settings/cash-registers', { ...reg, active: true }), 'Caja creada')) { setReg(null); registers.reload(); } }}>Guardar</Button></>}>
        {reg && <div className="space-y-4"><Field label="Sucursal"><Select value={reg.branchId} onChange={(e) => setReg({ ...reg, branchId: e.target.value })}>{branches.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field><Field label="Nombre"><Input value={reg.name} onChange={(e) => setReg({ ...reg, name: e.target.value })} /></Field></div>}
      </Dialog>
    </div>
  );
}

'use client';

import { formatDateTime, hhmmToMinutes, minutesToHHMM } from '@medigest/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/form';
import { Badge, Card, CardHeader, LoadingBlock } from '@/components/ui/layout';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { fullName } from '@/lib/utils';
import { save, useMutation, WEEKDAYS } from './shared';

interface Pro {
  id: string; title: string; firstName: string; lastName: string; exequatur: string | null; phone: string | null; email: string | null; defaultDurationMin: number; allowOverlap: boolean; active: boolean;
  user: { id: string; email: string } | null; specialties: { specialty: { id: string; name: string } }[]; branches: { branch: { id: string; name: string } }[];
}
interface ProDetail extends Pro { schedules: { id: string; weekday: number; startMinute: number; endMinute: number; branchId: string; room: { name: string } | null }[]; blocks: { id: string; type: string; startsAt: string; endsAt: string; reason: string | null }[] }

export function ProfessionalsTab() {
  const { can } = useSession();
  const pros = useApi<Pro[]>('/professionals', { active: 'all' });
  const specialties = useApi<{ id: string; name: string; code: string; active: boolean }[]>('/specialties', { active: 'all' });
  const branches = useApi<{ id: string; name: string; rooms: { id: string; name: string }[] }[]>('/settings/branches');
  const users = useApi<{ items: { id: string; fullName: string; email: string; professional: { id: string } | null }[] }>(can('users.read') ? '/users' : null, { pageSize: 200 });
  const [edit, setEdit] = useState<(Partial<Pro> & { specialtyIds: string[]; branchIds: string[]; userId: string }) | null>(null);
  const [sched, setSched] = useState<string | null>(null);
  const detail = useApi<ProDetail>(sched ? `/professionals/${sched}` : null);
  const [ns, setNs] = useState({ weekday: '1', start: '08:00', end: '12:00', branchId: '', roomId: '' });
  const [blk, setBlk] = useState({ type: 'VACACIONES', start: '', end: '', reason: '' });
  const [spec, setSpec] = useState<{ id?: string; code: string; name: string; active: boolean } | null>(null);
  const { busy, run } = useMutation();
  const manage = can('catalogs.manage');

  const openEdit = (p?: Pro) => setEdit(p
    ? { ...p, specialtyIds: p.specialties.map((s) => s.specialty.id), branchIds: p.branches.map((b) => b.branch.id), userId: p.user?.id ?? '' }
    : { title: 'Dr.', defaultDurationMin: 30, active: true, allowOverlap: false, specialtyIds: [], branchIds: branches.data?.[0] ? [branches.data[0].id] : [], userId: '' });

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Médicos y profesionales" actions={manage && <Button size="sm" variant="outline" onClick={() => openEdit()}><Plus /> Profesional</Button>} />
        {pros.loading ? <LoadingBlock /> : (
          <ul className="divide-y divide-border text-sm">
            {pros.data?.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                <div>
                  <p className="font-medium">{fullName(p)} {!p.active && <Badge>Inactivo</Badge>}</p>
                  <p className="text-xs text-muted">{p.specialties.map((s) => s.specialty.name).join(', ') || 'Sin especialidad'} · {p.branches.map((b) => b.branch.name).join(', ')}{p.exequatur ? ` · Exequátur ${p.exequatur}` : ''}{p.user ? ` · usuario ${p.user.email}` : ' · sin usuario vinculado'}</p>
                </div>
                <span className="flex gap-2">
                  {can('schedules.manage') && <Button size="sm" variant="ghost" onClick={() => { setSched(p.id); setNs({ ...ns, branchId: p.branches[0]?.branch.id ?? '' }); }}>Horarios</Button>}
                  {manage && <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>Editar</Button>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Especialidades" actions={manage && <Button size="sm" variant="outline" onClick={() => setSpec({ code: '', name: '', active: true })}><Plus /> Especialidad</Button>} />
        <ul className="divide-y divide-border text-sm">
          {specialties.data?.map((s) => <li key={s.id} className="flex items-center justify-between px-5 py-2.5"><span>{s.name} <span className="font-mono text-xs text-muted">{s.code}</span> {!s.active && <Badge>Inactiva</Badge>}</span>{manage && <Button size="sm" variant="ghost" onClick={() => setSpec(s)}>Editar</Button>}</li>)}
        </ul>
      </Card>

      <Dialog open={!!spec} onOpenChange={(o) => !o && setSpec(null)} title="Especialidad" footer={<><Button variant="outline" onClick={() => setSpec(null)}>Cancelar</Button><Button loading={busy} onClick={async () => { if (await run(() => save('/specialties', spec!.id, { code: spec!.code, name: spec!.name, active: spec!.active }), 'Especialidad guardada')) { setSpec(null); specialties.reload(); } }}>Guardar</Button></>}>
        {spec && <div className="grid grid-cols-2 gap-4"><Field label="Código"><Input value={spec.code} onChange={(e) => setSpec({ ...spec, code: e.target.value })} /></Field><Field label="Nombre"><Input value={spec.name} onChange={(e) => setSpec({ ...spec, name: e.target.value })} /></Field><Checkbox label="Activa" checked={spec.active} onChange={(e) => setSpec({ ...spec, active: e.target.checked })} /></div>}
      </Dialog>

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit?.id ? 'Editar profesional' : 'Nuevo profesional'} size="lg" footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancelar</Button><Button loading={busy} onClick={async () => {
        const e = edit!;
        if (await run(() => save('/professionals', e.id, { firstName: e.firstName, lastName: e.lastName, title: e.title, exequatur: e.exequatur || null, phone: e.phone || null, email: e.email || null, defaultDurationMin: e.defaultDurationMin, allowOverlap: !!e.allowOverlap, active: e.active ?? true, userId: e.userId || null, specialtyIds: e.specialtyIds, branchIds: e.branchIds }), 'Profesional guardado')) { setEdit(null); pros.reload(); }
      }}>Guardar</Button></>}>
        {edit && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Título"><Select value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })}><option>Dr.</option><option>Dra.</option><option>Lic.</option><option>Licda.</option></Select></Field>
            <Field label="Nombres"><Input value={edit.firstName ?? ''} onChange={(e) => setEdit({ ...edit, firstName: e.target.value })} /></Field>
            <Field label="Apellidos"><Input value={edit.lastName ?? ''} onChange={(e) => setEdit({ ...edit, lastName: e.target.value })} /></Field>
            <Field label="Exequátur"><Input value={edit.exequatur ?? ''} onChange={(e) => setEdit({ ...edit, exequatur: e.target.value })} /></Field>
            <Field label="Teléfono"><Input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
            <Field label="Correo"><Input value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="Duración de consulta (min)"><Input type="number" value={edit.defaultDurationMin} onChange={(e) => setEdit({ ...edit, defaultDurationMin: Number(e.target.value) })} /></Field>
            <Field label="Usuario del sistema" className="sm:col-span-2" hint="Vincule la cuenta para que el médico vea su agenda y su expediente.">
              <Select value={edit.userId} onChange={(e) => setEdit({ ...edit, userId: e.target.value })}><option value="">Sin vincular</option>{users.data?.items.filter((u) => !u.professional || u.professional.id === edit.id).map((u) => <option key={u.id} value={u.id}>{u.fullName} · {u.email}</option>)}</Select>
            </Field>
            <Field label="Especialidades" className="sm:col-span-3"><div className="flex flex-wrap gap-4">{specialties.data?.filter((s) => s.active).map((s) => <Checkbox key={s.id} label={s.name} checked={edit.specialtyIds.includes(s.id)} onChange={(e) => setEdit({ ...edit, specialtyIds: e.target.checked ? [...edit.specialtyIds, s.id] : edit.specialtyIds.filter((x) => x !== s.id) })} />)}</div></Field>
            <Field label="Sucursales" className="sm:col-span-3"><div className="flex flex-wrap gap-4">{branches.data?.map((b) => <Checkbox key={b.id} label={b.name} checked={edit.branchIds.includes(b.id)} onChange={(e) => setEdit({ ...edit, branchIds: e.target.checked ? [...edit.branchIds, b.id] : edit.branchIds.filter((x) => x !== b.id) })} />)}</div></Field>
            <Checkbox label="Activo" checked={edit.active ?? true} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />
            <Checkbox className="sm:col-span-2" label="Permitir citas solapadas (atención simultánea)" checked={!!edit.allowOverlap} onChange={(e) => setEdit({ ...edit, allowOverlap: e.target.checked })} />
          </div>
        )}
      </Dialog>

      <Dialog open={!!sched} onOpenChange={(o) => !o && setSched(null)} title={detail.data ? `Horarios de ${fullName(detail.data)}` : 'Horarios'} size="lg">
        {!detail.data ? <LoadingBlock /> : (
          <div className="space-y-6">
            <div>
              <p className="mb-2 text-sm font-medium">Horario semanal</p>
              <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                {detail.data.schedules.map((s) => (
                  <li key={s.id} className="flex items-center justify-between px-3 py-2">
                    <span>{WEEKDAYS[s.weekday]} · {minutesToHHMM(s.startMinute)}–{minutesToHHMM(s.endMinute)} · {branches.data?.find((b) => b.id === s.branchId)?.name}{s.room ? ` · ${s.room.name}` : ''}</span>
                    <button aria-label="Quitar horario" className="text-slate-400 hover:text-red-600" onClick={async () => { if (await run(() => api.del(`/schedules/${s.id}`), 'Horario retirado')) detail.reload(); }}><Trash2 className="h-4 w-4" /></button>
                  </li>
                ))}
                {!detail.data.schedules.length && <li className="px-3 py-2 text-muted">Sin horarios: no se podrán agendar citas.</li>}
              </ul>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-[130px_100px_100px_1fr_1fr_auto]">
                <Select value={ns.weekday} onChange={(e) => setNs({ ...ns, weekday: e.target.value })} aria-label="Día">{WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}</Select>
                <Input type="time" value={ns.start} onChange={(e) => setNs({ ...ns, start: e.target.value })} aria-label="Desde" />
                <Input type="time" value={ns.end} onChange={(e) => setNs({ ...ns, end: e.target.value })} aria-label="Hasta" />
                <Select value={ns.branchId} onChange={(e) => setNs({ ...ns, branchId: e.target.value, roomId: '' })} aria-label="Sucursal">{detail.data.branches.map((b) => <option key={b.branch.id} value={b.branch.id}>{b.branch.name}</option>)}</Select>
                <Select value={ns.roomId} onChange={(e) => setNs({ ...ns, roomId: e.target.value })} aria-label="Consultorio"><option value="">Sin consultorio</option>{branches.data?.find((b) => b.id === ns.branchId)?.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
                <Button variant="outline" onClick={async () => { if (await run(() => api.post(`/professionals/${sched}/schedules`, { weekday: Number(ns.weekday), startMinute: hhmmToMinutes(ns.start), endMinute: hhmmToMinutes(ns.end), branchId: ns.branchId, roomId: ns.roomId || null }), 'Horario agregado')) detail.reload(); }}><Plus /> Agregar</Button>
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Bloqueos, vacaciones y feriados</p>
              <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                {detail.data.blocks.map((b) => (
                  <li key={b.id} className="flex items-center justify-between px-3 py-2">
                    <span>{b.type.toLowerCase()} · {formatDateTime(b.startsAt)} → {formatDateTime(b.endsAt)}{b.reason ? ` · ${b.reason}` : ''}</span>
                    <button aria-label="Quitar bloqueo" className="text-slate-400 hover:text-red-600" onClick={async () => { if (await run(() => api.del(`/schedule-blocks/${b.id}`), 'Bloqueo eliminado')) detail.reload(); }}><Trash2 className="h-4 w-4" /></button>
                  </li>
                ))}
                {!detail.data.blocks.length && <li className="px-3 py-2 text-muted">Sin bloqueos próximos</li>}
              </ul>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[140px_1fr_1fr_1fr_auto]">
                <Select value={blk.type} onChange={(e) => setBlk({ ...blk, type: e.target.value })} aria-label="Tipo"><option value="VACACIONES">Vacaciones</option><option value="BLOQUEO">Bloqueo</option><option value="FERIADO">Feriado</option></Select>
                <Input type="datetime-local" value={blk.start} onChange={(e) => setBlk({ ...blk, start: e.target.value })} aria-label="Desde" />
                <Input type="datetime-local" value={blk.end} onChange={(e) => setBlk({ ...blk, end: e.target.value })} aria-label="Hasta" />
                <Input placeholder="Motivo" value={blk.reason} onChange={(e) => setBlk({ ...blk, reason: e.target.value })} />
                <Button variant="outline" disabled={!blk.start || !blk.end} onClick={async () => { if (await run(() => api.post('/schedule-blocks', { professionalId: sched, type: blk.type, startsAt: new Date(blk.start).toISOString(), endsAt: new Date(blk.end).toISOString(), reason: blk.reason || null }), 'Bloqueo registrado')) { setBlk({ ...blk, start: '', end: '', reason: '' }); detail.reload(); } }}><Plus /> Bloquear</Button>
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

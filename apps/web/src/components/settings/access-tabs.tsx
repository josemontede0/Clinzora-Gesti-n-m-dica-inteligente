'use client';

import { formatDate, formatDateTime } from '@medigest/shared';
import { Plus } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input } from '@/components/ui/form';
import { Badge, Card, CardHeader, LoadingBlock, Notice } from '@/components/ui/layout';
import { api, type Paged } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi, useDebounced } from '@/lib/use-api';
import { useMutation } from './shared';

interface User { id: string; email: string; fullName: string; active: boolean; mfaEnabled: boolean; lockedUntil: string | null; lastLoginAt: string | null; mustChangePassword: boolean; roles: { role: { id: string; name: string } }[]; branches: { branch: { id: string; name: string } }[] }
interface Role { id: string; code: string; name: string; description: string | null; requiresMfa: boolean; isSystem: boolean; permissions: string[]; _count: { users: number } }
interface Perm { code: string; module: string; description: string }

export function UsersTab() {
  const { can, me } = useSession();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const users = useApi<Paged<User>>('/users', { q: dq, pageSize: 100 });
  const roles = useApi<Role[]>('/roles');
  const branches = useApi<{ id: string; name: string }[]>('/settings/branches');
  const [edit, setEdit] = useState<{ id?: string; email: string; fullName: string; password: string; roleIds: string[]; branchIds: string[]; active: boolean } | null>(null);
  const [reset, setReset] = useState<{ id: string; password: string } | null>(null);
  const { busy, run } = useMutation();
  const manage = can('users.manage');

  const action = (u: User, path: string, ok: string) => run(() => api.post(`/users/${u.id}/${path}`), ok).then((r) => { if (r) void users.reload(); });

  return (
    <Card>
      <CardHeader title="Usuarios" description="Cada cuenta pertenece a esta organización y a las sucursales asignadas." actions={
        <>
          <Input className="h-9 w-56" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar usuarios" />
          {manage && <Button size="sm" variant="outline" onClick={() => setEdit({ email: '', fullName: '', password: '', roleIds: [], branchIds: me?.branches[0] ? [me.branches[0].id] : [], active: true })}><Plus /> Usuario</Button>}
        </>
      } />
      {users.loading ? <LoadingBlock /> : (
        <ul className="divide-y divide-border text-sm">
          {users.data?.items.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <div>
                <p className="font-medium">{u.fullName} <span className="text-xs text-muted">{u.email}</span></p>
                <p className="mt-0.5 flex flex-wrap gap-1">
                  {u.roles.map((r) => <Badge key={r.role.id} tone="navy">{r.role.name}</Badge>)}
                  {!u.active && <Badge tone="red">Inactivo</Badge>}
                  {u.lockedUntil && new Date(u.lockedUntil) > new Date() && <Badge tone="red">Bloqueado</Badge>}
                  {u.mfaEnabled ? <Badge tone="teal">MFA</Badge> : <Badge>Sin MFA</Badge>}
                  {u.mustChangePassword && <Badge tone="amber">Contraseña temporal</Badge>}
                </p>
                <p className="text-xs text-muted">{u.branches.map((b) => b.branch.name).join(', ')} · último acceso {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'nunca'}</p>
              </div>
              {manage && (
                <span className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEdit({ id: u.id, email: u.email, fullName: u.fullName, password: '', roleIds: u.roles.map((r) => r.role.id), branchIds: u.branches.map((b) => b.branch.id), active: u.active })}>Editar</Button>
                  {u.lockedUntil && <Button size="sm" variant="ghost" onClick={() => action(u, 'unlock', 'Cuenta desbloqueada')}>Desbloquear</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setReset({ id: u.id, password: '' })}>Contraseña</Button>
                  {u.mfaEnabled && <Button size="sm" variant="ghost" onClick={() => action(u, 'reset-mfa', 'MFA restablecido')}>Restablecer MFA</Button>}
                  <Button size="sm" variant="ghost" onClick={() => action(u, 'revoke-sessions', 'Sesiones cerradas')}>Cerrar sesiones</Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit?.id ? 'Editar usuario' : 'Nuevo usuario'} size="lg" footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancelar</Button><Button loading={busy} onClick={async () => {
        const e = edit!;
        const ok = await run(() => (e.id ? api.put(`/users/${e.id}`, { fullName: e.fullName, roleIds: e.roleIds, branchIds: e.branchIds, active: e.active }) : api.post('/users', { email: e.email, fullName: e.fullName, password: e.password, roleIds: e.roleIds, branchIds: e.branchIds })), 'Usuario guardado');
        if (ok) { setEdit(null); users.reload(); }
      }}>Guardar</Button></>}>
        {edit && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Nombre completo"><Input value={edit.fullName} onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} /></Field>
            <Field label="Correo"><Input type="email" value={edit.email} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            {!edit.id && <Field label="Contraseña temporal" hint="Deberá cambiarla al primer acceso." className="sm:col-span-2"><Input type="password" autoComplete="new-password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>}
            <Field label="Roles" className="sm:col-span-2"><div className="flex flex-wrap gap-4">{roles.data?.map((r) => <Checkbox key={r.id} label={r.name} checked={edit.roleIds.includes(r.id)} onChange={(e) => setEdit({ ...edit, roleIds: e.target.checked ? [...edit.roleIds, r.id] : edit.roleIds.filter((x) => x !== r.id) })} />)}</div></Field>
            <Field label="Sucursales" className="sm:col-span-2"><div className="flex flex-wrap gap-4">{branches.data?.map((b) => <Checkbox key={b.id} label={b.name} checked={edit.branchIds.includes(b.id)} onChange={(e) => setEdit({ ...edit, branchIds: e.target.checked ? [...edit.branchIds, b.id] : edit.branchIds.filter((x) => x !== b.id) })} />)}</div></Field>
            {edit.id && <Checkbox label="Cuenta activa" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />}
          </div>
        )}
      </Dialog>
      <Dialog open={!!reset} onOpenChange={(o) => !o && setReset(null)} title="Asignar contraseña temporal" footer={<><Button variant="outline" onClick={() => setReset(null)}>Cancelar</Button><Button loading={busy} onClick={async () => { if (await run(() => api.post(`/users/${reset!.id}/reset-password`, { password: reset!.password }), 'Contraseña asignada; se cerraron sus sesiones')) setReset(null); }}>Asignar</Button></>}>
        <Field label="Nueva contraseña temporal" hint="El usuario deberá cambiarla al ingresar."><Input type="password" autoComplete="new-password" value={reset?.password ?? ''} onChange={(e) => setReset((r) => r && { ...r, password: e.target.value })} /></Field>
      </Dialog>
    </Card>
  );
}

export function RolesTab() {
  const { can } = useSession();
  const roles = useApi<Role[]>('/roles');
  const perms = useApi<Perm[]>('/permissions');
  const [edit, setEdit] = useState<{ id?: string; code: string; name: string; description: string; requiresMfa: boolean; permissions: string[] } | null>(null);
  const { busy, run } = useMutation();
  const manage = can('roles.manage');
  const modules = [...new Set(perms.data?.map((p) => p.module) ?? [])];

  return (
    <Card>
      <CardHeader title="Roles y matriz de permisos" description="Los roles iniciales son editables. Los permisos se aplican en el servidor." actions={manage && <Button size="sm" variant="outline" onClick={() => setEdit({ code: '', name: '', description: '', requiresMfa: false, permissions: [] })}><Plus /> Rol</Button>} />
      {roles.loading || perms.loading ? <LoadingBlock /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-slate-50/70">
                <th className="sticky left-0 bg-slate-50 px-3 py-2 text-left font-semibold text-muted">Permiso</th>
                {roles.data?.map((r) => <th key={r.id} className="px-2 py-2 font-semibold text-navy-700"><button disabled={!manage} className="hover:underline" onClick={() => setEdit({ id: r.id, code: r.code, name: r.name, description: r.description ?? '', requiresMfa: r.requiresMfa, permissions: r.permissions })}>{r.name}</button><p className="font-normal text-muted">{r._count.users} usuario(s)</p></th>)}
              </tr>
            </thead>
            <tbody>
              {modules.map((m) => (
                <Fragment key={m}>
                  <tr><td colSpan={(roles.data?.length ?? 0) + 1} className="bg-slate-50/40 px-3 py-1.5 font-semibold uppercase tracking-wide text-muted">{m}</td></tr>
                  {perms.data?.filter((p) => p.module === m).map((p) => (
                    <tr key={p.code} className="border-b border-border/60">
                      <td className="sticky left-0 bg-white px-3 py-1.5">{p.description}</td>
                      {roles.data?.map((r) => <td key={r.id} className="px-2 py-1.5 text-center">{r.permissions.includes(p.code) ? <span className="text-teal-600" aria-label="Sí">●</span> : <span className="text-slate-300" aria-label="No">○</span>}</td>)}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit?.id ? `Rol: ${edit.name}` : 'Nuevo rol'} size="xl" footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancelar</Button><Button loading={busy} onClick={async () => { const e = edit!; if (await run(() => (e.id ? api.put(`/roles/${e.id}`, e) : api.post('/roles', e)), 'Rol guardado')) { setEdit(null); roles.reload(); } }}>Guardar</Button></>}>
        {edit && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Código"><Input value={edit.code} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>
              <Field label="Nombre"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="Descripción"><Input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            </div>
            <Checkbox label="Exigir verificación en dos pasos a las cuentas con este rol" checked={edit.requiresMfa} onChange={(e) => setEdit({ ...edit, requiresMfa: e.target.checked })} />
            <Notice tone="amber">Revise con cuidado los permisos clínicos: el acceso a expedientes debe limitarse al personal asistencial.</Notice>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {modules.map((m) => (
                <div key={m}>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{m}</p>
                  {perms.data?.filter((p) => p.module === m).map((p) => <Checkbox key={p.code} label={p.description} checked={edit.permissions.includes(p.code)} onChange={(e) => setEdit({ ...edit, permissions: e.target.checked ? [...edit.permissions, p.code] : edit.permissions.filter((x) => x !== p.code) })} />)}
                </div>
              ))}
            </div>
          </div>
        )}
      </Dialog>
    </Card>
  );
}

interface AuditRow { id: string; createdAt: string; userEmail: string | null; action: string; entity: string; entityId: string | null; ip: string | null; details: Record<string, unknown> | null }

export function AuditTab() {
  const [f, setF] = useState({ q: '', entity: '', from: '', to: '', page: 1 });
  const dq = useDebounced(f.q);
  const { data, loading, error, reload } = useApi<Paged<AuditRow>>('/audit', { q: dq, entity: f.entity || undefined, from: f.from || undefined, to: f.to ? `${f.to}T23:59:59-04:00` : undefined, page: f.page, pageSize: 50 });
  return (
    <Card>
      <CardHeader title="Auditoría" description="Registro inalterable de accesos y operaciones sensibles. No contiene contenido clínico ni contraseñas." />
      <div className="grid grid-cols-1 gap-3 border-b border-border p-4 sm:grid-cols-4">
        <Input placeholder="Usuario o acción" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} aria-label="Buscar" />
        <Input placeholder="Entidad (Patient, Invoice…)" value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value, page: 1 })} aria-label="Entidad" />
        <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, page: 1 })} aria-label="Desde" />
        <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value, page: 1 })} aria-label="Hasta" />
      </div>
      <DataTable
        columns={[
          { header: 'Fecha', cell: ({ row }) => <span className="whitespace-nowrap">{formatDateTime(row.original.createdAt)}</span> },
          { header: 'Usuario', cell: ({ row }) => row.original.userEmail ?? '—' },
          { header: 'Acción', cell: ({ row }) => <span className="font-mono text-xs">{row.original.action}</span> },
          { header: 'Entidad', cell: ({ row }) => <span className="text-xs">{row.original.entity}{row.original.entityId ? ` · ${row.original.entityId.slice(0, 8)}` : ''}</span> },
          { header: 'Detalle', cell: ({ row }) => <span className="block max-w-md truncate text-xs text-muted" title={JSON.stringify(row.original.details)}>{row.original.details ? JSON.stringify(row.original.details) : ''}</span> },
          { header: 'IP', cell: ({ row }) => <span className="text-xs text-muted">{row.original.ip}</span> },
        ]}
        data={data?.items ?? []}
        loading={loading}
        error={error}
        onRetry={reload}
        page={data?.page}
        pages={data?.pages}
        total={data?.total}
        onPageChange={(page) => setF({ ...f, page })}
      />
    </Card>
  );
}

interface Seq { id: string; type: string; description: string; prefix: string; rangeFrom: number; rangeTo: number; nextNumber: number; validUntil: string | null; active: boolean }

export function FiscalTab() {
  const seqs = useApi<Seq[]>('/fiscal/sequences');
  const [nf, setNf] = useState({ type: 'B02', description: '', rangeFrom: '', rangeTo: '', validUntil: '' });
  const { busy, run } = useMutation();
  return (
    <div className="space-y-6">
      <Notice tone="amber">
        El sistema solo usa rangos de comprobantes autorizados por la DGII que usted registre aquí; no genera números propios. Para e-CF se requiere un proveedor
        certificado o la certificación propia ante la DGII: hasta configurarlo, los e-CF quedan como pendientes de envío. Valide los tipos y formatos vigentes con su contador.
      </Notice>
      <Card>
        <CardHeader title="Rangos de comprobantes (NCF / e-CF)" />
        <ul className="divide-y divide-border text-sm">
          {seqs.data?.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <span><span className="font-mono font-medium">{s.type}</span> · {s.description}</span>
              <span className="text-muted">{s.rangeFrom}–{s.rangeTo} · próximo {s.nextNumber} · {s.rangeTo - s.nextNumber + 1} disponibles{s.validUntil ? ` · vence ${formatDate(s.validUntil)}` : ''}</span>
              <span className="flex items-center gap-2">{s.active ? <Badge tone="teal">Activo</Badge> : <Badge>Inactivo</Badge>}{s.active && <Button size="sm" variant="ghost" onClick={async () => { if (await run(() => api.post(`/fiscal/sequences/${s.id}/deactivate`), 'Rango desactivado')) seqs.reload(); }}>Desactivar</Button>}</span>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-1 gap-2 border-t border-border p-5 sm:grid-cols-[100px_1fr_120px_120px_150px_auto]">
          <Input value={nf.type} onChange={(e) => setNf({ ...nf, type: e.target.value.toUpperCase() })} aria-label="Tipo" placeholder="B02" />
          <Input value={nf.description} onChange={(e) => setNf({ ...nf, description: e.target.value })} placeholder="Descripción" aria-label="Descripción" />
          <Input type="number" value={nf.rangeFrom} onChange={(e) => setNf({ ...nf, rangeFrom: e.target.value })} placeholder="Desde" aria-label="Desde" />
          <Input type="number" value={nf.rangeTo} onChange={(e) => setNf({ ...nf, rangeTo: e.target.value })} placeholder="Hasta" aria-label="Hasta" />
          <Input type="date" value={nf.validUntil} onChange={(e) => setNf({ ...nf, validUntil: e.target.value })} aria-label="Vence" />
          <Button variant="outline" loading={busy} onClick={async () => { if (await run(() => api.post('/fiscal/sequences', { type: nf.type, prefix: nf.type, description: nf.description, rangeFrom: nf.rangeFrom, rangeTo: nf.rangeTo, validUntil: nf.validUntil || null }), 'Rango registrado')) seqs.reload(); }}><Plus /> Registrar</Button>
        </div>
      </Card>
    </div>
  );
}

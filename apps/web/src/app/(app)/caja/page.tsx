'use client';

import { formatDateTime, formatMoney, PAYMENT_METHOD_KIND_LABEL } from '@medigest/shared';
import { ArrowDownToLine, ArrowUpFromLine, Lock, Receipt, Unlock } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Badge, Card, CardBody, CardHeader, EmptyState, LoadingBlock, Notice, PageHeader, Stat } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Summary { expectedCash: string; byMethod: Record<string, string>; byType: Record<string, string> }
interface Session {
  id: string; status: string; openedAt: string; openingFloat: string; closedAt: string | null; expectedCash: string | null; countedCash: string | null; difference: string | null; closingNotes: string | null;
  register: { name: string; branch: { name: string } };
  summary: Summary;
  movements?: { id: string; type: string; methodKind: string; amount: string; description: string | null; createdAt: string }[];
}
interface SessionRow { id: string; status: string; openedAt: string; closedAt: string | null; difference: string | null; openedBy?: string; register: { name: string; branch: { name: string } } }

const TYPE_LABEL: Record<string, string> = { FONDO_INICIAL: 'Fondo inicial', COBRO: 'Cobro', REEMBOLSO: 'Reembolso', REVERSO: 'Reverso', RETIRO: 'Retiro', INGRESO: 'Ingreso' };

export default function CashPage() {
  const { can, me, branchId } = useSession();
  const cur = me?.organization.currency ?? 'DOP';
  const current = useApi<{ session: Session | null }>(can('cash.operate') ? '/cash/current' : null);
  const session = current.data?.session ?? null;
  const detail = useApi<Session>(session ? `/cash/sessions/${session.id}` : null);
  const history = useApi<SessionRow[]>('/cash/sessions', { branchId: branchId || undefined });
  const registers = useApi<{ id: string; name: string; branchId: string; active: boolean; branch: { name: string } }[]>('/settings/cash-registers');
  const [openForm, setOpenForm] = useState({ registerId: '', openingFloat: '' });
  const [closeOpen, setCloseOpen] = useState(false);
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [mov, setMov] = useState<{ type: 'RETIRO' | 'INGRESO'; amount: string; description: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    current.reload();
    detail.reload();
    history.reload();
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      refresh();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const diff = counted && session ? Number(counted) - Number(session.summary.expectedCash) : null;

  return (
    <>
      <PageHeader title="Caja" description="Apertura, cobros, movimientos y cierre con arqueo." actions={session && can('payments.write') && <Button variant="success" asChild><Link href="/caja/cobrar"><Receipt /> Registrar cobro</Link></Button>} />
      {can('cash.operate') && (current.loading ? <LoadingBlock /> : !session ? (
        <Card className="mb-6 max-w-xl">
          <CardHeader title="Abrir caja" description="Para registrar cobros debe tener una caja abierta en la sucursal." />
          <CardBody className="space-y-4">
            <Field label="Caja" required>
              <Select value={openForm.registerId} onChange={(e) => setOpenForm({ ...openForm, registerId: e.target.value })}>
                <option value="">Seleccione…</option>
                {registers.data?.filter((r) => r.active && (!branchId || r.branchId === branchId)).map((r) => <option key={r.id} value={r.id}>{r.name} · {r.branch.name}</option>)}
              </Select>
            </Field>
            <Field label="Fondo inicial en efectivo" required><Input inputMode="decimal" value={openForm.openingFloat} onChange={(e) => setOpenForm({ ...openForm, openingFloat: e.target.value })} placeholder="0.00" /></Field>
            <Button variant="success" loading={busy} disabled={!openForm.registerId || openForm.openingFloat === ''} onClick={() => run(() => api.post('/cash/sessions', openForm), 'Caja abierta')}><Unlock /> Abrir caja</Button>
          </CardBody>
        </Card>
      ) : (
        <div className="mb-6 space-y-6">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="teal">Abierta</Badge> <span className="font-medium">{session.register.name}</span> · {session.register.branch.name} · desde {formatDateTime(session.openedAt)}
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Efectivo esperado en caja" value={formatMoney(session.summary.expectedCash, cur)} tone="teal" hint={`Incluye fondo inicial de ${formatMoney(session.openingFloat, cur)}`} />
            {Object.entries(session.summary.byMethod).filter(([k]) => k !== 'EFECTIVO').map(([k, v]) => <Stat key={k} label={PAYMENT_METHOD_KIND_LABEL[k] ?? k} value={formatMoney(v, cur)} />)}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setMov({ type: 'RETIRO', amount: '', description: '' })}><ArrowUpFromLine /> Retiro de efectivo</Button>
            <Button variant="outline" onClick={() => setMov({ type: 'INGRESO', amount: '', description: '' })}><ArrowDownToLine /> Ingreso de efectivo</Button>
            <Button variant="default" onClick={() => { setCounted(''); setNotes(''); setCloseOpen(true); }}><Lock /> Cerrar caja</Button>
          </div>
          <Card>
            <CardHeader title="Movimientos de la sesión" />
            {detail.data?.movements?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border bg-slate-50/70 text-left text-xs uppercase text-muted"><th className="px-5 py-2">Hora</th><th className="px-5 py-2">Tipo</th><th className="px-5 py-2">Método</th><th className="px-5 py-2">Detalle</th><th className="px-5 py-2 text-right">Monto</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {detail.data.movements.map((m) => (
                      <tr key={m.id}>
                        <td className="px-5 py-2 text-muted">{formatDateTime(m.createdAt)}</td>
                        <td className="px-5 py-2">{TYPE_LABEL[m.type]}</td>
                        <td className="px-5 py-2">{PAYMENT_METHOD_KIND_LABEL[m.methodKind]}</td>
                        <td className="px-5 py-2 text-muted">{m.description}</td>
                        <td className={`px-5 py-2 text-right tabular-nums ${Number(m.amount) < 0 ? 'text-red-600' : ''}`}>{formatMoney(m.amount, cur)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState title="Sin movimientos" />}
          </Card>
        </div>
      ))}

      <Card>
        <CardHeader title={can('cash.supervise') ? 'Sesiones de caja' : 'Mis cierres anteriores'} />
        {history.data?.length ? (
          <ul className="divide-y divide-border text-sm">
            {history.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                <span><span className="font-medium">{s.register.name}</span> · {s.register.branch.name}{s.openedBy ? ` · ${s.openedBy}` : ''}</span>
                <span className="text-muted">{formatDateTime(s.openedAt)} → {s.closedAt ? formatDateTime(s.closedAt) : 'abierta'}</span>
                <span className="flex items-center gap-2">
                  {s.difference != null && Number(s.difference) !== 0 && <Badge tone="red">Diferencia {formatMoney(s.difference, cur)}</Badge>}
                  <Badge tone={s.status === 'ABIERTA' ? 'teal' : 'slate'}>{s.status.toLowerCase()}</Badge>
                </span>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="Sin sesiones registradas" />}
      </Card>

      <Dialog open={closeOpen} onOpenChange={setCloseOpen} title="Cierre y arqueo de caja" footer={<><Button variant="outline" onClick={() => setCloseOpen(false)}>Cancelar</Button><Button loading={busy} disabled={counted === '' || (diff !== null && diff !== 0 && notes.trim().length < 3)} onClick={async () => { if (await run(() => api.post(`/cash/sessions/${session!.id}/close`, { countedCash: counted, notes: notes || null }), 'Caja cerrada')) setCloseOpen(false); }}>Cerrar caja</Button></>}>
        {session && (
          <div className="space-y-4">
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <div className="flex justify-between"><span className="text-muted">Efectivo esperado</span><b className="tabular-nums">{formatMoney(session.summary.expectedCash, cur)}</b></div>
              {Object.entries(session.summary.byMethod).filter(([k]) => k !== 'EFECTIVO').map(([k, v]) => <div key={k} className="flex justify-between"><span className="text-muted">{PAYMENT_METHOD_KIND_LABEL[k]} (verificar con vouchers/estado)</span><span className="tabular-nums">{formatMoney(v, cur)}</span></div>)}
            </div>
            <Field label="Efectivo contado" required><Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus /></Field>
            {diff !== null && !Number.isNaN(diff) && diff !== 0 && <Notice tone="amber">Diferencia de {formatMoney(diff.toFixed(2), cur)} ({diff > 0 ? 'sobrante' : 'faltante'}). Explique el motivo.</Notice>}
            <Field label="Notas del cierre"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          </div>
        )}
      </Dialog>

      <Dialog open={!!mov} onOpenChange={(o) => !o && setMov(null)} title={mov?.type === 'RETIRO' ? 'Retiro de efectivo' : 'Ingreso de efectivo'} footer={<><Button variant="outline" onClick={() => setMov(null)}>Cancelar</Button><Button loading={busy} onClick={async () => { if (await run(() => api.post(`/cash/sessions/${session!.id}/movements`, mov), 'Movimiento registrado')) setMov(null); }}>Registrar</Button></>}>
        <div className="space-y-4">
          <Field label="Monto" required><Input inputMode="decimal" value={mov?.amount ?? ''} onChange={(e) => setMov((m) => m && { ...m, amount: e.target.value })} /></Field>
          <Field label="Descripción" required><Input value={mov?.description ?? ''} onChange={(e) => setMov((m) => m && { ...m, description: e.target.value })} placeholder="Ej.: depósito bancario, cambio" /></Field>
        </div>
      </Dialog>
    </>
  );
}

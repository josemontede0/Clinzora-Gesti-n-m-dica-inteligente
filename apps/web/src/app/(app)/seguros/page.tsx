'use client';

import { CLAIM_STATUSES, CLAIM_STATUS_LABEL, formatDate, formatMoney, type ClaimStatus } from '@medigest/shared';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ClaimStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Badge, Card, CardHeader, EmptyState, LoadingBlock, Notice, PageHeader } from '@/components/ui/layout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage, type Paged } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi, usePersistentState } from '@/lib/use-api';

interface ClaimRow { id: string; number: string; status: ClaimStatus; createdAt: string; submittedAt: string | null; externalReference: string | null; claimedAmount: string; expectedAmount: string; glosaAmount: string; paidAmount: string; balance: string; submissionOverdue: boolean; paymentOverdue: boolean; insurer: { name: string }; _count: { items: number } }
interface Receivable { insurer: { id: string; name: string }; openClaims: number; claimsBalance: string; notYetClaimed: string; glosas: string; unallocatedPayments: string }
interface InsurerPayment { id: string; receivedAt: string; amount: string; reference: string | null; allocated: string; unallocated: string; insurer: { name: string } }
interface Insurer { id: string; name: string }
interface Authorization { id: string; authorizationNumber: string | null; status: string; authorizedAmount: string | null; createdAt: string; patientInsurance: { affiliateNumber: string; plan: { name: string; insurer: { name: string } }; patient: { id: string; firstName: string; lastName: string } } }

export default function InsurancePage() {
  const router = useRouter();
  const { can, me, branchId } = useSession();
  const cur = me?.organization.currency ?? 'DOP';
  const [tab, setTab] = usePersistentState('mg_ins_tab', { tab: 'reclamaciones' });
  const [f, setF] = usePersistentState('mg_claims', { insurerId: '', status: '', page: 1 });
  const insurers = useApi<Insurer[]>('/insurance/insurers');
  const claims = useApi<Paged<ClaimRow>>(tab.tab === 'reclamaciones' ? '/insurance/claims' : null, { insurerId: f.insurerId || undefined, status: f.status || undefined, branchId: branchId || undefined, page: f.page });
  const receivables = useApi<Receivable[]>(tab.tab === 'cxc' ? '/insurance/receivables' : null);
  const payments = useApi<InsurerPayment[]>(tab.tab === 'pagos' ? '/insurance/payments' : null);
  const auths = useApi<Authorization[]>(tab.tab === 'autorizaciones' ? '/insurance/authorizations' : null);
  const [payOpen, setPayOpen] = useState(false);
  const [pay, setPay] = useState({ insurerId: '', receivedAt: new Date().toISOString().slice(0, 10), amount: '', reference: '', notes: '' });
  const [payAllocs, setPayAllocs] = useState<Record<string, string>>({});
  const openClaims = useApi<Paged<ClaimRow>>(payOpen && pay.insurerId ? '/insurance/claims' : null, { insurerId: pay.insurerId, status: 'SOMETIDA,EN_REVISION,APROBADA,APROBADA_PARCIAL,PAGADA_PARCIAL', pageSize: 100 });

  const columns: ColumnDef<ClaimRow, unknown>[] = [
    { header: 'Reclamación', cell: ({ row }) => <span className="font-mono text-xs font-medium">{row.original.number}</span> },
    { header: 'Aseguradora', cell: ({ row }) => row.original.insurer.name },
    { header: 'Fecha', cell: ({ row }) => formatDate(row.original.submittedAt ?? row.original.createdAt) },
    { header: 'Reclamado', cell: ({ row }) => <span className="tabular-nums">{formatMoney(row.original.claimedAmount, cur)}</span> },
    { header: 'Reconocido', cell: ({ row }) => <span className="tabular-nums">{formatMoney(row.original.expectedAmount, cur)}</span> },
    { header: 'Pagado', cell: ({ row }) => <span className="tabular-nums">{formatMoney(row.original.paidAmount, cur)}</span> },
    { header: 'Saldo', cell: ({ row }) => <span className="font-medium tabular-nums">{formatMoney(row.original.balance, cur)}</span> },
    { header: 'Estado', cell: ({ row }) => <span className="flex flex-wrap gap-1"><ClaimStatusBadge status={row.original.status} />{row.original.submissionOverdue && <Badge tone="red">Plazo vencido</Badge>}{row.original.paymentOverdue && <Badge tone="amber">Pago atrasado</Badge>}</span> },
  ];

  const registerPayment = async () => {
    try {
      await api.post('/insurance/payments', {
        insurerId: pay.insurerId, receivedAt: new Date(`${pay.receivedAt}T12:00:00-04:00`).toISOString(), amount: pay.amount, reference: pay.reference || null, notes: pay.notes || null,
        allocations: Object.entries(payAllocs).filter(([, v]) => Number(v) > 0).map(([claimId, amount]) => ({ claimId, amount })),
      });
      toast.success('Pago de aseguradora registrado');
      setPayOpen(false);
      setPayAllocs({});
      payments.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        title="Seguros y ARS"
        description="Reclamaciones, glosas, pagos recibidos y conciliación. Una autorización no es un pago."
        actions={can('insurance.claims') && (
          <>
            <Button variant="outline" onClick={() => setPayOpen(true)}>Registrar pago de ARS</Button>
            <Button variant="success" asChild><Link href="/seguros/reclamaciones/nueva"><Plus /> Nueva reclamación</Link></Button>
          </>
        )}
      />
      <Tabs value={tab.tab} onValueChange={(v) => setTab({ tab: v })}>
        <TabsList>
          <TabsTrigger value="reclamaciones">Reclamaciones</TabsTrigger>
          <TabsTrigger value="cxc">Cuentas por cobrar</TabsTrigger>
          <TabsTrigger value="pagos">Pagos recibidos</TabsTrigger>
          <TabsTrigger value="autorizaciones">Autorizaciones</TabsTrigger>
        </TabsList>
        <TabsContent value="reclamaciones">
          <Card>
            <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row">
              <Select className="sm:w-60" value={f.insurerId} onChange={(e) => setF({ ...f, insurerId: e.target.value, page: 1 })} aria-label="Aseguradora"><option value="">Todas las aseguradoras</option>{insurers.data?.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select>
              <Select className="sm:w-52" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} aria-label="Estado"><option value="">Todos los estados</option>{CLAIM_STATUSES.map((s) => <option key={s} value={s}>{CLAIM_STATUS_LABEL[s]}</option>)}</Select>
            </div>
            <DataTable columns={columns} data={claims.data?.items ?? []} loading={claims.loading} error={claims.error} onRetry={claims.reload} page={claims.data?.page} pages={claims.data?.pages} total={claims.data?.total} onPageChange={(page) => setF({ ...f, page })} onRowClick={(r) => router.push(`/seguros/reclamaciones/${r.id}`)}
              mobileCard={(r) => <div className="flex justify-between gap-2"><div><p className="font-medium">{r.number}</p><p className="text-xs text-muted">{r.insurer.name} · saldo {formatMoney(r.balance, cur)}</p></div><ClaimStatusBadge status={r.status} /></div>} />
          </Card>
        </TabsContent>
        <TabsContent value="cxc">
          <Card>
            <CardHeader title="Cuentas por cobrar por aseguradora" description="Saldo de reclamaciones abiertas (reconocido − pagado) y montos de seguro facturados aún sin reclamar." />
            {receivables.loading ? <LoadingBlock /> : receivables.data?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead><tr className="border-b border-border bg-slate-50/70 text-left text-xs uppercase text-muted"><th className="px-5 py-2">Aseguradora</th><th className="px-5 py-2 text-right">Reclamaciones abiertas</th><th className="px-5 py-2 text-right">Saldo reclamado</th><th className="px-5 py-2 text-right">Sin reclamar</th><th className="px-5 py-2 text-right">Glosas</th><th className="px-5 py-2 text-right">Pagos sin conciliar</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {receivables.data.map((r) => (
                      <tr key={r.insurer.id}>
                        <td className="px-5 py-2.5 font-medium">{r.insurer.name}</td>
                        <td className="px-5 py-2.5 text-right">{r.openClaims}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums">{formatMoney(r.claimsBalance, cur)}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums">{formatMoney(r.notYetClaimed, cur)}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-red-700">{formatMoney(r.glosas, cur)}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums">{formatMoney(r.unallocatedPayments, cur)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState title="Sin aseguradoras" />}
          </Card>
        </TabsContent>
        <TabsContent value="pagos">
          <Card>
            {payments.loading ? <LoadingBlock /> : payments.data?.length ? (
              <ul className="divide-y divide-border text-sm">
                {payments.data.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                    <span><span className="font-medium">{p.insurer.name}</span> · {formatDate(p.receivedAt)}{p.reference ? ` · ${p.reference}` : ''}</span>
                    <span className="tabular-nums">{formatMoney(p.amount, cur)} · conciliado {formatMoney(p.allocated, cur)}</span>
                    {Number(p.unallocated) > 0 ? <Badge tone="amber">Sin conciliar {formatMoney(p.unallocated, cur)}</Badge> : <Badge tone="teal">Conciliado</Badge>}
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="Sin pagos registrados" />}
          </Card>
        </TabsContent>
        <TabsContent value="autorizaciones">
          <Card>
            {auths.loading ? <LoadingBlock /> : auths.data?.length ? (
              <ul className="divide-y divide-border text-sm">
                {auths.data.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                    <span><Link href={`/pacientes/${a.patientInsurance.patient.id}`} className="font-medium hover:underline">{a.patientInsurance.patient.lastName}, {a.patientInsurance.patient.firstName}</Link> · {a.patientInsurance.plan.insurer.name} · {a.patientInsurance.affiliateNumber}</span>
                    <span>{a.authorizationNumber ?? 'Sin número'} {a.authorizedAmount ? `· ${formatMoney(a.authorizedAmount, cur)}` : ''} · {formatDate(a.createdAt)}</span>
                    <Badge tone={a.status === 'APROBADA' || a.status === 'UTILIZADA' ? 'teal' : a.status === 'DENEGADA' ? 'red' : 'amber'}>{a.status.toLowerCase()}</Badge>
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="Sin autorizaciones" description="Se registran desde la ficha del paciente, pestaña Seguros." />}
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={payOpen} onOpenChange={setPayOpen} title="Registrar pago de aseguradora" size="lg" footer={<><Button variant="outline" onClick={() => setPayOpen(false)}>Cancelar</Button><Button variant="success" disabled={!pay.insurerId || !pay.amount} onClick={registerPayment}>Registrar</Button></>}>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Aseguradora" required><Select value={pay.insurerId} onChange={(e) => { setPay({ ...pay, insurerId: e.target.value }); setPayAllocs({}); }}><option value="">Seleccione…</option>{insurers.data?.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select></Field>
            <Field label="Fecha de recepción" required><Input type="date" value={pay.receivedAt} onChange={(e) => setPay({ ...pay, receivedAt: e.target.value })} /></Field>
            <Field label="Monto recibido" required><Input inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
            <Field label="Referencia (transferencia, cheque)"><Input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>
          </div>
          {pay.insurerId && (
            <div>
              <p className="mb-2 text-sm font-medium">Conciliar con reclamaciones</p>
              {openClaims.data?.items.length ? (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {openClaims.data.items.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span>{c.number} · saldo {formatMoney(c.balance, cur)}</span>
                      <Input className="w-32 text-right" inputMode="decimal" placeholder="0.00" value={payAllocs[c.id] ?? ''} onChange={(e) => setPayAllocs({ ...payAllocs, [c.id]: e.target.value })} aria-label={`Conciliar ${c.number}`} />
                    </li>
                  ))}
                </ul>
              ) : <Notice tone="sky">No hay reclamaciones abiertas de esta aseguradora. El pago quedará pendiente de conciliar.</Notice>}
            </div>
          )}
          <Field label="Notas"><Textarea value={pay.notes} onChange={(e) => setPay({ ...pay, notes: e.target.value })} className="min-h-[60px]" /></Field>
        </div>
      </Dialog>
    </>
  );
}

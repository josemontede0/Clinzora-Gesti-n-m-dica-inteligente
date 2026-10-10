'use client';

import { CLAIM_STATUS_LABEL, CLAIM_TRANSITIONS, formatDate, formatDateTime, formatMoney, type ClaimStatus } from '@medigest/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ClaimStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Badge, Card, CardBody, CardHeader, DefinitionList, ErrorState, LoadingBlock, Notice, PageHeader, Stat } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Claim {
  id: string; number: string; status: ClaimStatus; externalReference: string | null; submittedAt: string | null; submissionDeadline: string | null; expectedPaymentDate: string | null; notes: string | null;
  claimedAmount: string; approvedAmount: string | null; glosaAmount: string; paidAmount: string; expectedAmount: string; balance: string; difference: string;
  insurer: { name: string };
  items: { id: string; description: string; claimedAmount: string; approvedAmount: string | null; serviceDate: string; authorization: { authorizationNumber: string | null } | null; patientInsurance?: { affiliateNumber: string }; invoiceItem: { invoice: { id: string; number: string; patient: { id: string; firstName: string; lastName: string } } } }[];
  glosas: { id: string; code: string | null; reason: string; amount: string; status: string; resolution: string | null; createdAt: string; claimItemId: string | null }[];
  history: { id: string; fromStatus: ClaimStatus | null; toStatus: ClaimStatus; note: string | null; createdAt: string }[];
  allocations: { id: string; amount: string; insurerPayment: { receivedAt: string; reference: string | null } }[];
}

export default function ClaimPage() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useSession();
  const cur = me?.organization.currency ?? 'DOP';
  const { data: c, loading, error, reload } = useApi<Claim>(`/insurance/claims/${id}`);
  const [statusDlg, setStatusDlg] = useState<ClaimStatus | null>(null);
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [approved, setApproved] = useState<Record<string, string>>({});
  const [glosa, setGlosa] = useState<{ claimItemId: string; code: string; reason: string; amount: string } | null>(null);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !c) return <LoadingBlock rows={8} />;
  const manage = can('insurance.claims');
  const next = CLAIM_TRANSITIONS[c.status];

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      reload();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    }
  };

  const openStatus = (s: ClaimStatus) => {
    setStatusDlg(s);
    setRef(c.externalReference ?? '');
    setNote('');
    setApproved(Object.fromEntries(c.items.map((i) => [i.id, i.approvedAmount ?? i.claimedAmount])));
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Seguros', href: '/seguros' }, { label: c.number }]}
        title={`Reclamación ${c.number}`}
        description={<span className="flex flex-wrap items-center gap-2">{c.insurer.name} <ClaimStatusBadge status={c.status} /> {c.externalReference && <span>Ref. ARS {c.externalReference}</span>}</span>}
        actions={manage && (
          <>
            {next.map((s) => <Button key={s} variant={s === 'RECHAZADA' ? 'outline' : s === 'CERRADA' ? 'ghost' : 'success'} onClick={() => openStatus(s)}>{{ SOMETIDA: 'Someter a la ARS', EN_REVISION: 'En revisión', APROBADA: 'Registrar aprobación', APROBADA_PARCIAL: 'Aprobación parcial', RECHAZADA: 'Registrar rechazo', CERRADA: 'Cerrar' }[s as 'SOMETIDA'] ?? CLAIM_STATUS_LABEL[s]}</Button>)}
            {c.status !== 'BORRADOR' && c.status !== 'CERRADA' && <Button variant="outline" onClick={() => setGlosa({ claimItemId: '', code: '', reason: '', amount: '' })}>Registrar glosa</Button>}
          </>
        )}
      />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Reclamado" value={formatMoney(c.claimedAmount, cur)} />
        <Stat label="Reconocido" value={formatMoney(c.expectedAmount, cur)} hint={c.approvedAmount ? 'Según respuesta de la ARS' : 'Reclamado − glosas vigentes'} tone="teal" />
        <Stat label="Glosas" value={formatMoney(c.glosaAmount, cur)} tone="red" />
        <Stat label="Pagado por la ARS" value={formatMoney(c.paidAmount, cur)} tone="teal" />
        <Stat label="Saldo por cobrar" value={formatMoney(c.balance, cur)} tone="amber" />
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader title="Servicios reclamados" />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead><tr className="border-b border-border bg-slate-50/70 text-left text-xs uppercase text-muted"><th className="px-5 py-2">Paciente / servicio</th><th className="px-5 py-2">Autorización</th><th className="px-5 py-2 text-right">Reclamado</th><th className="px-5 py-2 text-right">Aprobado</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {c.items.map((i) => (
                    <tr key={i.id}>
                      <td className="px-5 py-2.5"><Link className="font-medium hover:underline" href={`/pacientes/${i.invoiceItem.invoice.patient.id}`}>{i.invoiceItem.invoice.patient.lastName}, {i.invoiceItem.invoice.patient.firstName}</Link><p className="text-xs text-muted">{i.description} · {formatDate(i.serviceDate)} · afiliado {i.patientInsurance?.affiliateNumber}</p></td>
                      <td className="px-5 py-2.5">{i.authorization?.authorizationNumber ?? '—'}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums">{formatMoney(i.claimedAmount, cur)}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums">{i.approvedAmount != null ? formatMoney(i.approvedAmount, cur) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card>
            <CardHeader title="Glosas" description="Objeciones de la ARS. Las recuperadas dejan de restar del monto reconocido." />
            {c.glosas.length ? (
              <ul className="divide-y divide-border text-sm">
                {c.glosas.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                    <div><p>{g.code && <span className="mr-1 font-mono text-xs">{g.code}</span>}{g.reason}</p><p className="text-xs text-muted">{formatDateTime(g.createdAt)}{g.resolution ? ` · ${g.resolution}` : ''}</p></div>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums">{formatMoney(g.amount, cur)}</span>
                      <Badge tone={g.status === 'RECUPERADA' ? 'teal' : g.status === 'ACEPTADA' ? 'slate' : 'amber'}>{g.status.toLowerCase().replace('_', ' ')}</Badge>
                      {manage && g.status !== 'RECUPERADA' && (
                        <Select className="h-8 w-36 text-xs" value="" onChange={(e) => e.target.value && run(() => api.post(`/insurance/glosas/${g.id}/resolve`, { status: e.target.value, resolution: null }), 'Glosa actualizada')} aria-label="Resolver glosa">
                          <option value="">Resolver…</option><option value="EN_DISPUTA">En disputa</option><option value="ACEPTADA">Aceptada</option><option value="RECUPERADA">Recuperada</option>
                        </Select>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="px-5 py-4 text-sm text-muted">Sin glosas</p>}
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Seguimiento" />
            <CardBody>
              <DefinitionList className="sm:grid-cols-1" items={[
                { label: 'Plazo para someter', value: formatDate(c.submissionDeadline) },
                { label: 'Sometida', value: formatDateTime(c.submittedAt) },
                { label: 'Pago esperado', value: formatDate(c.expectedPaymentDate) },
                { label: 'Diferencia reclamado − reconocido', value: formatMoney(c.difference, cur) },
              ]} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Pagos conciliados" />
            {c.allocations.length ? <ul className="divide-y divide-border text-sm">{c.allocations.map((a) => <li key={a.id} className="flex justify-between px-5 py-2.5"><span>{formatDate(a.insurerPayment.receivedAt)}{a.insurerPayment.reference ? ` · ${a.insurerPayment.reference}` : ''}</span><span className="tabular-nums">{formatMoney(a.amount, cur)}</span></li>)}</ul> : <p className="px-5 py-4 text-sm text-muted">Sin pagos conciliados</p>}
          </Card>
          <Card>
            <CardHeader title="Historial" />
            <ol className="space-y-2 p-5 text-sm">
              {c.history.map((h) => <li key={h.id}><span className="text-muted">{formatDateTime(h.createdAt)}</span> · {h.fromStatus ? `${CLAIM_STATUS_LABEL[h.fromStatus]} → ` : ''}{CLAIM_STATUS_LABEL[h.toStatus]}{h.note ? <span className="text-muted"> · {h.note}</span> : null}</li>)}
            </ol>
          </Card>
        </div>
      </div>

      <Dialog open={!!statusDlg} onOpenChange={(o) => !o && setStatusDlg(null)} title={statusDlg ? CLAIM_STATUS_LABEL[statusDlg] : ''} size="lg" footer={<><Button variant="outline" onClick={() => setStatusDlg(null)}>Cancelar</Button><Button variant="success" onClick={async () => {
        const body: Record<string, unknown> = { status: statusDlg, externalReference: ref || null, note: note || null };
        if (statusDlg === 'APROBADA_PARCIAL' || statusDlg === 'APROBADA') body.items = Object.entries(approved).map(([itemId, amount]) => ({ id: itemId, approvedAmount: amount || '0' }));
        if (await run(() => api.post(`/insurance/claims/${id}/status`, body), 'Reclamación actualizada')) setStatusDlg(null);
      }}>Guardar</Button></>}>
        <div className="space-y-4">
          {statusDlg === 'RECHAZADA' && <Notice tone="amber">El monto reconocido quedará en cero. Podrá volver a someterla corregida.</Notice>}
          <Field label="Referencia de la ARS"><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
          {(statusDlg === 'APROBADA' || statusDlg === 'APROBADA_PARCIAL') && (
            <div>
              <p className="mb-2 text-sm font-medium">Monto aprobado por línea</p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {c.items.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate">{i.description} <span className="text-muted">(reclamado {formatMoney(i.claimedAmount, cur)})</span></span>
                    <Input className="w-32 text-right" inputMode="decimal" value={approved[i.id] ?? ''} onChange={(e) => setApproved({ ...approved, [i.id]: e.target.value })} aria-label={`Aprobado ${i.description}`} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Field label="Nota"><Textarea value={note} onChange={(e) => setNote(e.target.value)} className="min-h-[60px]" /></Field>
        </div>
      </Dialog>

      <Dialog open={!!glosa} onOpenChange={(o) => !o && setGlosa(null)} title="Registrar glosa" footer={<><Button variant="outline" onClick={() => setGlosa(null)}>Cancelar</Button><Button variant="success" onClick={async () => { if (await run(() => api.post(`/insurance/claims/${id}/glosas`, { claimItemId: glosa!.claimItemId || null, code: glosa!.code || null, reason: glosa!.reason, amount: glosa!.amount }), 'Glosa registrada')) setGlosa(null); }}>Registrar</Button></>}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Línea afectada" className="sm:col-span-2"><Select value={glosa?.claimItemId} onChange={(e) => setGlosa((g) => g && { ...g, claimItemId: e.target.value })}><option value="">Toda la reclamación</option>{c.items.map((i) => <option key={i.id} value={i.id}>{i.description}</option>)}</Select></Field>
          <Field label="Código de glosa"><Input value={glosa?.code ?? ''} onChange={(e) => setGlosa((g) => g && { ...g, code: e.target.value })} /></Field>
          <Field label="Monto" required><Input inputMode="decimal" value={glosa?.amount ?? ''} onChange={(e) => setGlosa((g) => g && { ...g, amount: e.target.value })} /></Field>
          <Field label="Motivo" required className="sm:col-span-2"><Textarea value={glosa?.reason ?? ''} onChange={(e) => setGlosa((g) => g && { ...g, reason: e.target.value })} /></Field>
        </div>
      </Dialog>
    </>
  );
}

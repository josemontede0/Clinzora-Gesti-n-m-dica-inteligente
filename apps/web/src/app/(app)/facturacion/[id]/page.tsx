'use client';

import { formatCedula, formatDate, formatDateTime, formatMoney } from '@medigest/shared';
import { Ban, FileBadge, Printer, Receipt, RotateCcw, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { InvoiceStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Badge, Card, CardBody, CardHeader, ErrorState, LoadingBlock, Notice, PageHeader } from '@/components/ui/layout';
import { api, errorMessage, newKey } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Invoice {
  id: string; number: string; status: string; overdue: boolean; issuedAt: string | null; dueDate: string | null; currency: string; notes: string | null; voidReason: string | null;
  subtotal: string; discountTotal: string; taxTotal: string; total: string; insuranceAmount: string; patientAmount: string; paidAmount: string; creditedAmount: string; balance: string;
  patient: { id: string; recordNumber: string; firstName: string; lastName: string; documentNumber: string | null; address: string | null; phone: string | null };
  items: { id: string; description: string; quantity: number; unitPrice: string; discount: string; taxAmount: string; total: string; insuranceAmount: string; patientAmount: string; claimItem: { claimId: string } | null }[];
  allocations: { id: string; amount: string; reversedAt: string | null; createdAt: string; payment: { id: string; number: string; receivedAt: string; status: string } }[];
  creditNotes: { id: string; number: string; amount: string; reason: string; createdAt: string; status: string }[];
  fiscalDocuments: { id: string; type: string; ncf: string | null; status: string; providerMessage: string | null; issuedAt: string | null }[];
  organization: { name: string; legalName: string | null; rnc: string | null; address: string | null; phone: string | null };
  branch: { name: string; address: string | null };
  patientInsurance: { affiliateNumber: string; plan: { name: string; insurer: { name: string } } } | null;
}

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data: inv, loading, error, reload } = useApi<Invoice>(`/invoices/${id}`);
  const methods = useApi<{ id: string; name: string; kind: string; active: boolean }[]>('/settings/payment-methods');
  const [voidOpen, setVoidOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [cn, setCn] = useState<{ amount: string; reason: string } | null>(null);
  const [fiscal, setFiscal] = useState<{ type: string; buyerRnc: string; buyerName: string } | null>(null);
  const [refund, setRefund] = useState<{ paymentId: string; amount: string; methodId: string; reason: string; key: string } | null>(null);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !inv) return <LoadingBlock rows={8} />;
  const cur = inv.currency;
  const open = inv.status === 'PENDIENTE' || inv.status === 'PARCIAL';
  const activeAllocs = inv.allocations.filter((a) => !a.reversedAt && a.payment.status === 'COMPLETADO');

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

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Facturación', href: '/facturacion' }, { label: inv.number }]}
        title={`Factura ${inv.number}`}
        description={<span className="flex flex-wrap items-center gap-2"><InvoiceStatusBadge status={inv.status} overdue={inv.overdue} /> Emitida {formatDate(inv.issuedAt)} · Vence {formatDate(inv.dueDate)}</span>}
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            {inv.status === 'BORRADOR' && can('billing.write') && <Button variant="success" onClick={() => setIssueOpen(true)}>Emitir</Button>}
            {open && can('payments.write') && <Button variant="success" asChild><Link href={`/caja/cobrar?paciente=${inv.patient.id}&factura=${inv.id}`}><Receipt /> Cobrar</Link></Button>}
            {can('fiscal.manage') && !['BORRADOR', 'ANULADA'].includes(inv.status) && !inv.fiscalDocuments.some((f) => !['ANULADO', 'RECHAZADO'].includes(f.status)) && (
              <Button variant="outline" onClick={() => setFiscal({ type: 'B02', buyerRnc: '', buyerName: '' })}><FileBadge /> Comprobante fiscal</Button>
            )}
            {open && can('billing.void') && <Button variant="outline" onClick={() => setCn({ amount: '', reason: '' })}><Undo2 /> Nota de crédito</Button>}
            {activeAllocs.length > 0 && can('payments.refund') && (
              <Button variant="outline" onClick={() => setRefund({ paymentId: activeAllocs[0].payment.id, amount: '', methodId: methods.data?.find((m) => m.kind === 'EFECTIVO')?.id ?? '', reason: '', key: newKey() })}><RotateCcw /> Devolución</Button>
            )}
            {inv.status !== 'ANULADA' && can('billing.void') && <Button variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => setVoidOpen(true)}><Ban /> Anular</Button>}
            <Button variant="ghost" onClick={() => window.print()}><Printer /> Imprimir</Button>
          </div>
        }
      />
      {inv.voidReason && <Notice tone="red" className="mb-4">Anulada: {inv.voidReason}</Notice>}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardBody className="space-y-6">
            <div className="flex flex-wrap justify-between gap-4 text-sm">
              <div>
                <p className="font-semibold text-navy-900">{inv.organization.legalName ?? inv.organization.name}</p>
                {inv.organization.rnc && <p className="text-muted">RNC {inv.organization.rnc}</p>}
                <p className="text-muted">{inv.branch.name}{inv.branch.address ? ` · ${inv.branch.address}` : ''}</p>
              </div>
              <div className="sm:text-right">
                <p className="text-xs uppercase text-muted">Paciente</p>
                <Link href={`/pacientes/${inv.patient.id}`} className="font-medium hover:underline">{inv.patient.firstName} {inv.patient.lastName}</Link>
                <p className="text-muted">{inv.patient.recordNumber} · {formatCedula(inv.patient.documentNumber)}</p>
                {inv.patientInsurance && <p className="text-muted">{inv.patientInsurance.plan.insurer.name} · {inv.patientInsurance.plan.name} · {inv.patientInsurance.affiliateNumber}</p>}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead><tr className="border-b border-border text-left text-xs uppercase text-muted"><th className="py-2">Servicio</th><th className="py-2 text-right">Cant.</th><th className="py-2 text-right">Precio</th><th className="py-2 text-right">Desc.</th><th className="py-2 text-right">Total</th><th className="py-2 text-right">Seguro</th><th className="py-2 text-right">Paciente</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {inv.items.map((i) => (
                    <tr key={i.id}>
                      <td className="py-2">{i.description}{i.claimItem && <Badge tone="navy" className="ml-2">En reclamación</Badge>}</td>
                      <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">{i.quantity}</td>
                      <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">{formatMoney(i.unitPrice, cur)}</td>
                      <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">{formatMoney(i.discount, cur)}</td>
                      <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">{formatMoney(i.total, cur)}</td>
                      <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">{formatMoney(i.insuranceAmount, cur)}</td>
                      <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">{formatMoney(i.patientAmount, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="ml-auto max-w-xs space-y-1.5 text-sm">
              {[
                ['Subtotal', inv.subtotal], ['Descuentos', inv.discountTotal], ['Impuestos', inv.taxTotal], ['Total facturado', inv.total], ['A cargo del seguro', inv.insuranceAmount],
              ].map(([k, val]) => <div key={k} className="flex justify-between"><dt className="text-muted">{k}</dt><dd className="tabular-nums">{formatMoney(val, cur)}</dd></div>)}
              <div className="flex justify-between border-t border-border pt-1.5 font-medium"><dt>A cargo del paciente</dt><dd className="tabular-nums">{formatMoney(inv.patientAmount, cur)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Pagos aplicados</dt><dd className="tabular-nums">− {formatMoney(inv.paidAmount, cur)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Notas de crédito</dt><dd className="tabular-nums">− {formatMoney(inv.creditedAmount, cur)}</dd></div>
              <div className="flex justify-between border-t border-border pt-1.5 text-base font-semibold text-navy-900"><dt>Saldo pendiente</dt><dd className="tabular-nums">{formatMoney(inv.balance, cur)}</dd></div>
            </dl>
            {inv.notes && <p className="text-sm text-muted">Notas: {inv.notes}</p>}
          </CardBody>
        </Card>

        <div className="space-y-6 print:hidden">
          <Card>
            <CardHeader title="Pagos aplicados" />
            {inv.allocations.length ? (
              <ul className="divide-y divide-border text-sm">
                {inv.allocations.map((a) => (
                  <li key={a.id} className={`flex justify-between gap-2 px-5 py-2.5 ${a.reversedAt || a.payment.status !== 'COMPLETADO' ? 'text-muted line-through' : ''}`}>
                    <span>{a.payment.number} · {formatDateTime(a.payment.receivedAt)}</span><span className="tabular-nums">{formatMoney(a.amount, cur)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="px-5 py-4 text-sm text-muted">Sin pagos</p>}
          </Card>
          <Card>
            <CardHeader title="Notas de crédito" />
            {inv.creditNotes.length ? (
              <ul className="divide-y divide-border text-sm">{inv.creditNotes.map((c) => <li key={c.id} className="px-5 py-2.5"><div className="flex justify-between"><span>{c.number}</span><span className="tabular-nums">{formatMoney(c.amount, cur)}</span></div><p className="text-xs text-muted">{c.reason}</p></li>)}</ul>
            ) : <p className="px-5 py-4 text-sm text-muted">Sin notas de crédito</p>}
          </Card>
          <Card>
            <CardHeader title="Comprobante fiscal" />
            {inv.fiscalDocuments.length ? (
              <ul className="divide-y divide-border text-sm">
                {inv.fiscalDocuments.map((f) => (
                  <li key={f.id} className="px-5 py-2.5">
                    <div className="flex justify-between"><span className="font-mono">{f.ncf ?? 'Sin NCF'}</span><Badge tone={f.status === 'EMITIDO' || f.status === 'ACEPTADO' ? 'teal' : 'amber'}>{f.status.toLowerCase()}</Badge></div>
                    <p className="text-xs text-muted">{f.type} · {formatDateTime(f.issuedAt)}</p>
                    {f.providerMessage && <p className="text-xs text-amber-700">{f.providerMessage}</p>}
                  </li>
                ))}
              </ul>
            ) : <p className="px-5 py-4 text-sm text-muted">Sin comprobante fiscal asignado</p>}
          </Card>
        </div>
      </div>

      <ConfirmDialog open={issueOpen} onOpenChange={setIssueOpen} title="Emitir factura" description="Una factura emitida no se puede editar; solo anular o acreditar." tone="success" confirmLabel="Emitir" onConfirm={async () => { await run(() => api.post(`/invoices/${id}/issue`), 'Factura emitida'); }} />
      <ConfirmDialog open={voidOpen} onOpenChange={setVoidOpen} title="Anular factura" description="La factura se conserva como anulada y sus cargos quedan anulados. Si tiene pagos o comprobante fiscal, el sistema lo impedirá." requireReason tone="destructive" confirmLabel="Anular factura" onConfirm={async (reason) => { await run(() => api.post(`/invoices/${id}/void`, { reason }), 'Factura anulada'); }} />

      <Dialog open={!!cn} onOpenChange={(o) => !o && setCn(null)} title="Nota de crédito" description={`Reduce el saldo pendiente (${formatMoney(inv.balance, cur)}).`} footer={<><Button variant="outline" onClick={() => setCn(null)}>Cancelar</Button><Button variant="success" onClick={async () => { if (await run(() => api.post(`/invoices/${id}/credit-notes`, cn), 'Nota de crédito emitida')) setCn(null); }}>Emitir</Button></>}>
        <div className="space-y-4">
          <Field label="Monto" required><Input inputMode="decimal" value={cn?.amount ?? ''} onChange={(e) => setCn((s) => s && { ...s, amount: e.target.value })} /></Field>
          <Field label="Motivo" required><Textarea value={cn?.reason ?? ''} onChange={(e) => setCn((s) => s && { ...s, reason: e.target.value })} /></Field>
        </div>
      </Dialog>

      <Dialog open={!!fiscal} onOpenChange={(o) => !o && setFiscal(null)} title="Asignar comprobante fiscal" footer={<><Button variant="outline" onClick={() => setFiscal(null)}>Cancelar</Button><Button variant="success" onClick={async () => { if (await run(() => api.post(`/invoices/${id}/fiscal`, { type: fiscal!.type, buyerRnc: fiscal!.buyerRnc || null, buyerName: fiscal!.buyerName || null }), 'Comprobante asignado')) setFiscal(null); }}>Asignar</Button></>}>
        <Notice tone="sky" className="mb-4">El NCF se toma del rango autorizado por la DGII registrado en Configuración &gt; Fiscal. Los e-CF quedan pendientes de envío hasta configurar un proveedor certificado.</Notice>
        <div className="space-y-4">
          <Field label="Tipo de comprobante">
            <Select value={fiscal?.type} onChange={(e) => setFiscal((s) => s && { ...s, type: e.target.value })}>
              <option value="B02">B02 · Consumidor final</option><option value="B01">B01 · Crédito fiscal</option><option value="B14">B14 · Régimen especial</option><option value="B15">B15 · Gubernamental</option>
              <option value="E32">E32 · e-CF consumo</option><option value="E31">E31 · e-CF crédito fiscal</option>
            </Select>
          </Field>
          <Field label="RNC / cédula del comprador" hint="Obligatorio para crédito fiscal y gubernamental."><Input value={fiscal?.buyerRnc ?? ''} onChange={(e) => setFiscal((s) => s && { ...s, buyerRnc: e.target.value })} /></Field>
          <Field label="Nombre o razón social"><Input value={fiscal?.buyerName ?? ''} onChange={(e) => setFiscal((s) => s && { ...s, buyerName: e.target.value })} /></Field>
        </div>
      </Dialog>

      <Dialog open={!!refund} onOpenChange={(o) => !o && setRefund(null)} title="Devolución" description="Reduce lo cobrado, emite una nota de crédito por el mismo monto y registra la salida en su caja." footer={<><Button variant="outline" onClick={() => setRefund(null)}>Cancelar</Button><Button variant="destructive" onClick={async () => { if (await run(() => api.post(`/invoices/${id}/refund`, { paymentId: refund!.paymentId, amount: refund!.amount, methodId: refund!.methodId, reason: refund!.reason, idempotencyKey: refund!.key }), 'Devolución registrada')) setRefund(null); }}>Registrar devolución</Button></>}>
        <div className="space-y-4">
          <Field label="Pago a devolver">
            <Select value={refund?.paymentId} onChange={(e) => setRefund((s) => s && { ...s, paymentId: e.target.value })}>{activeAllocs.map((a) => <option key={a.id} value={a.payment.id}>{a.payment.number} · {formatMoney(a.amount, cur)}</option>)}</Select>
          </Field>
          <Field label="Monto" required><Input inputMode="decimal" value={refund?.amount ?? ''} onChange={(e) => setRefund((s) => s && { ...s, amount: e.target.value })} /></Field>
          <Field label="Medio de devolución"><Select value={refund?.methodId} onChange={(e) => setRefund((s) => s && { ...s, methodId: e.target.value })}>{methods.data?.filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
          <Field label="Motivo" required><Textarea value={refund?.reason ?? ''} onChange={(e) => setRefund((s) => s && { ...s, reason: e.target.value })} /></Field>
        </div>
      </Dialog>
    </>
  );
}

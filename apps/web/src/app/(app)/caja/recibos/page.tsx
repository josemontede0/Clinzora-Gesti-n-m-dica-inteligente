'use client';

import { formatDateTime, formatMoney, PAYMENT_METHOD_KIND_LABEL } from '@medigest/shared';
import type { ColumnDef } from '@tanstack/react-table';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { ReceiptActions } from '@/components/receipts/receipt-actions';
import { Dialog } from '@/components/ui/dialog';
import { DataTable } from '@/components/ui/data-table';
import { Checkbox, Input, Select } from '@/components/ui/form';
import { Badge, Card, DefinitionList, LoadingBlock, PageHeader } from '@/components/ui/layout';
import type { Paged } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi, useDebounced, usePersistentState } from '@/lib/use-api';

interface Receipt {
  id: string; number: string; receivedAt: string; amount: string; status: string; notes: string | null;
  patient: { id: string; recordNumber: string; firstName: string; lastName: string };
  tenders: { id: string; amount: string; cardLast4: string | null; reference: string | null; method: { name: string; kind: string } }[];
  allocations: { id: string; amount: string; reversedAt: string | null; invoice: { number: string } }[];
  unapplied?: string;
}
interface PrintLog { createdAt: string; userEmail: string | null; details: { formato?: string; uso?: string; copia?: number } | null }

export default function ReceiptsPage() {
  const { me, branchId, can } = useSession();
  const cur = me?.organization.currency ?? 'DOP';
  const [f, setF] = usePersistentState('mg_receipts', { q: '', from: '', to: '', status: '', mine: !can('cash.supervise'), page: 1 });
  const q = useDebounced(f.q);
  const { data, loading, error, reload } = useApi<Paged<Receipt>>('/payments', {
    q, status: f.status || undefined, mine: f.mine || undefined, branchId: branchId || undefined,
    from: f.from ? `${f.from}T00:00:00-04:00` : undefined, to: f.to ? `${f.to}T23:59:59-04:00` : undefined, page: f.page, pageSize: 25,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useApi<Receipt>(selected ? `/payments/${selected}` : null);
  const prints = useApi<PrintLog[]>(selected ? `/payments/${selected}/receipt/prints` : null);

  const columns: ColumnDef<Receipt, unknown>[] = [
    { header: 'Recibo', cell: ({ row }) => <span className="font-mono text-xs font-medium">{row.original.number}</span> },
    { header: 'Fecha', cell: ({ row }) => <span className="whitespace-nowrap">{formatDateTime(row.original.receivedAt)}</span> },
    { header: 'Paciente', cell: ({ row }) => `${row.original.patient.lastName}, ${row.original.patient.firstName}` },
    { header: 'Medios', cell: ({ row }) => <span className="text-xs text-muted">{row.original.tenders.map((t) => t.method.name).join(' + ')}</span> },
    { header: 'Monto', cell: ({ row }) => <span className="font-medium tabular-nums">{formatMoney(row.original.amount, cur)}</span> },
    { header: 'Estado', cell: ({ row }) => (row.original.status === 'COMPLETADO' ? <Badge tone="teal">Vigente</Badge> : <Badge tone="red">{row.original.status === 'REVERTIDO' ? 'Revertido' : row.original.status.toLowerCase()}</Badge>) },
  ];

  return (
    <>
      <PageHeader title="Historial de recibos" description="Busque un cobro para ver el recibo, imprimirlo, descargarlo o reimprimirlo. Cada impresión queda registrada." breadcrumbs={[{ label: 'Caja', href: '/caja' }, { label: 'Recibos' }]} />
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-border p-4 sm:grid-cols-2 lg:grid-cols-[1fr_150px_150px_160px_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input className="pl-9" placeholder="Número de recibo, paciente o expediente" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} aria-label="Buscar recibos" />
          </div>
          <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, page: 1 })} aria-label="Desde" />
          <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value, page: 1 })} aria-label="Hasta" />
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} aria-label="Estado">
            <option value="">Todos</option>
            <option value="COMPLETADO">Vigentes</option>
            <option value="REVERTIDO">Revertidos</option>
          </Select>
          <Checkbox className="self-center" label="Solo míos" checked={f.mine} onChange={(e) => setF({ ...f, mine: e.target.checked, page: 1 })} />
        </div>
        <DataTable
          columns={columns}
          data={data?.items ?? []}
          loading={loading}
          error={error}
          onRetry={reload}
          page={data?.page}
          pages={data?.pages}
          total={data?.total}
          onPageChange={(page) => setF({ ...f, page })}
          onRowClick={(r) => setSelected(r.id)}
          mobileCard={(r) => (
            <div className="flex items-start justify-between gap-2">
              <div><p className="font-medium">{r.number}</p><p className="text-xs text-muted">{r.patient.lastName}, {r.patient.firstName} · {formatDateTime(r.receivedAt)}</p></div>
              <span className="text-sm font-medium tabular-nums">{formatMoney(r.amount, cur)}</span>
            </div>
          )}
        />
      </Card>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)} title={detail.data ? `Recibo ${detail.data.number}` : 'Recibo'} size="lg">
        {detail.loading || !detail.data ? <LoadingBlock /> : (
          <div className="space-y-5">
            {detail.data.status === 'REVERTIDO' && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">Este pago fue revertido: el recibo saldrá marcado como REVERTIDO.</p>}
            <DefinitionList items={[
              { label: 'Fecha', value: formatDateTime(detail.data.receivedAt) },
              { label: 'Paciente', value: `${detail.data.patient.firstName} ${detail.data.patient.lastName} (${detail.data.patient.recordNumber})` },
              { label: 'Total', value: formatMoney(detail.data.amount, cur) },
              { label: 'Anticipo disponible', value: formatMoney(detail.data.unapplied ?? '0', cur) },
            ]} />
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Medios de pago</p>
              <ul className="space-y-1 text-sm">
                {detail.data.tenders.map((t) => (
                  <li key={t.id} className="flex justify-between"><span>{t.method.name || PAYMENT_METHOD_KIND_LABEL[t.method.kind]}{t.cardLast4 ? ` ****${t.cardLast4}` : ''}{t.reference ? ` · Ref. ${t.reference}` : ''}</span><span className="tabular-nums">{formatMoney(t.amount, cur)}</span></li>
                ))}
              </ul>
            </div>
            {detail.data.allocations.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Aplicado a facturas</p>
                <ul className="space-y-1 text-sm">{detail.data.allocations.map((a) => <li key={a.id} className={`flex justify-between ${a.reversedAt ? 'text-muted line-through' : ''}`}><span>{a.invoice.number}</span><span className="tabular-nums">{formatMoney(a.amount, cur)}</span></li>)}</ul>
              </div>
            )}
            <ReceiptActions paymentId={detail.data.id} printedBefore={(prints.data?.length ?? 0) > 0} onPrinted={() => setTimeout(() => prints.reload(), 1500)} />
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Impresiones</p>
              {prints.data?.length ? (
                <ul className="space-y-0.5 text-xs text-muted">
                  {prints.data.map((p, i) => <li key={i}>Copia {p.details?.copia ?? i + 1} · {formatDateTime(p.createdAt)} · {p.userEmail} · {p.details?.formato === 'carta' ? 'carta' : 'ticket'} ({p.details?.uso})</li>)}
                </ul>
              ) : <p className="text-xs text-muted">Aún no se ha impreso.</p>}
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}

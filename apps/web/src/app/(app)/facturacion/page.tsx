'use client';

import { formatDate, formatMoney, INVOICE_STATUS_LABEL } from '@medigest/shared';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { InvoiceStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Checkbox, Input, Select } from '@/components/ui/form';
import { Card, PageHeader } from '@/components/ui/layout';
import type { Paged } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi, useDebounced, usePersistentState } from '@/lib/use-api';

interface Row { id: string; number: string; issuedAt: string | null; status: string; overdue: boolean; total: string; insuranceAmount: string; patientAmount: string; balance: string; patient: { firstName: string; lastName: string; recordNumber: string } }

export default function InvoicesPage() {
  const router = useRouter();
  const { can, me, branchId } = useSession();
  const cur = me?.organization.currency ?? 'DOP';
  const [f, setF] = usePersistentState('mg_invoices', { q: '', status: '', overdue: false, from: '', to: '', page: 1 });
  const q = useDebounced(f.q);
  const { data, loading, error, reload } = useApi<Paged<Row>>('/invoices', { q, status: f.status || undefined, overdue: f.overdue || undefined, from: f.from || undefined, to: f.to ? `${f.to}T23:59:59-04:00` : undefined, branchId: branchId || undefined, page: f.page });

  const columns: ColumnDef<Row, unknown>[] = [
    { header: 'Factura', cell: ({ row }) => <span className="font-mono text-xs font-medium">{row.original.number}</span> },
    { header: 'Fecha', cell: ({ row }) => formatDate(row.original.issuedAt) },
    { header: 'Paciente', cell: ({ row }) => `${row.original.patient.lastName}, ${row.original.patient.firstName}` },
    { header: 'Total', cell: ({ row }) => <span className="tabular-nums">{formatMoney(row.original.total, cur)}</span> },
    { header: 'Seguro', cell: ({ row }) => <span className="tabular-nums text-muted">{formatMoney(row.original.insuranceAmount, cur)}</span> },
    { header: 'Saldo paciente', cell: ({ row }) => <span className="font-medium tabular-nums">{formatMoney(row.original.balance, cur)}</span> },
    { header: 'Estado', cell: ({ row }) => <InvoiceStatusBadge status={row.original.status} overdue={row.original.overdue} /> },
  ];

  return (
    <>
      <PageHeader title="Facturación" description="Facturas emitidas, saldos de pacientes y partes atribuidas a aseguradoras." actions={<><Button variant="outline" asChild><Link href="/caja/recibos">Recibos de caja</Link></Button>{can('billing.write') && <Button variant="success" asChild><Link href="/facturacion/nueva"><Plus /> Facturar</Link></Button>}</>} />
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-border p-4 sm:grid-cols-2 lg:grid-cols-[1fr_180px_150px_150px_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input className="pl-9" placeholder="Número, paciente o expediente" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} aria-label="Buscar facturas" />
          </div>
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} aria-label="Estado">
            <option value="">Todos los estados</option>
            {['BORRADOR', 'PENDIENTE', 'PARCIAL', 'PAGADA', 'ANULADA'].map((s) => <option key={s} value={s}>{INVOICE_STATUS_LABEL[s]}</option>)}
          </Select>
          <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, page: 1 })} aria-label="Desde" />
          <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value, page: 1 })} aria-label="Hasta" />
          <Checkbox className="self-center" label="Solo vencidas" checked={f.overdue} onChange={(e) => setF({ ...f, overdue: e.target.checked, page: 1 })} />
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
          onRowClick={(r) => router.push(`/facturacion/${r.id}`)}
          mobileCard={(r) => (
            <div className="flex items-start justify-between gap-2">
              <div><p className="font-medium">{r.number}</p><p className="text-xs text-muted">{r.patient.lastName}, {r.patient.firstName} · {formatDate(r.issuedAt)}</p></div>
              <div className="text-right"><p className="text-sm font-medium tabular-nums">{formatMoney(r.balance, cur)}</p><InvoiceStatusBadge status={r.status} overdue={r.overdue} /></div>
            </div>
          )}
        />
      </Card>
    </>
  );
}

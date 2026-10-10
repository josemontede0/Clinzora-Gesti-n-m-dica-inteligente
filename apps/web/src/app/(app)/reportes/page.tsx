'use client';

import { CLAIM_STATUSES, CLAIM_STATUS_LABEL, formatMoney, PAYMENT_METHOD_KIND_LABEL } from '@medigest/shared';
import { FileSpreadsheet, FileText } from 'lucide-react';
import { useState } from 'react';
import type { Professional } from '@/components/appointments/types';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form';
import { Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/ui/layout';
import { backendUrl } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi, usePersistentState } from '@/lib/use-api';
import { addDaysYmd, fullName, todayYmd } from '@/lib/utils';

interface Report { title: string; columns: { key: string; label: string; money?: boolean }[]; rows: Record<string, string | number | null>[]; totals?: Record<string, string> }

const TYPES = [
  { key: 'citas', label: 'Citas', perm: 'reports.operational' },
  { key: 'facturacion', label: 'Facturación', perm: 'reports.financial' },
  { key: 'cobros', label: 'Cobros por método y cajero', perm: 'reports.financial' },
  { key: 'reclamaciones', label: 'Reclamaciones a aseguradoras', perm: 'reports.financial' },
  { key: 'caja', label: 'Cierres de caja', perm: 'reports.financial' },
] as const;

export default function ReportsPage() {
  const { can, me, branchId } = useSession();
  const cur = me?.organization.currency ?? 'DOP';
  const today = todayYmd(me?.organization.timezone);
  const available = TYPES.filter((t) => can(t.perm));
  const [f, setF] = usePersistentState('mg_reports', { type: available[0]?.key ?? 'citas', from: addDaysYmd(today, -30), to: today, professionalId: '', serviceId: '', methodKind: '', insurerId: '', claimStatus: '', cashierId: '' });
  const [run, setRun] = useState(0);
  const query = {
    from: f.from, to: f.to, branchId: branchId || undefined, professionalId: f.professionalId || undefined, serviceId: f.serviceId || undefined,
    methodKind: f.methodKind || undefined, insurerId: f.insurerId || undefined, claimStatus: f.claimStatus || undefined, cashierId: f.cashierId || undefined,
  };
  const { data, loading, error, reload } = useApi<Report>(`/reports/run/${f.type}`, { ...query, _: run });
  const pros = useApi<Professional[]>('/professionals', { active: 'all' });
  const services = useApi<{ id: string; name: string }[]>('/services', { active: 'all' });
  const insurers = useApi<{ id: string; name: string }[]>('/insurance/insurers');

  return (
    <>
      <PageHeader title="Reportes" description="Los reportes respetan sus permisos. Las exportaciones quedan registradas en la auditoría." />
      <Card className="mb-6 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <Field label="Reporte" className="sm:col-span-2">
            <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as typeof f.type })}>{available.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</Select>
          </Field>
          <Field label="Desde"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="Hasta"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          {(f.type === 'citas' || f.type === 'facturacion') && (
            <Field label="Médico"><Select value={f.professionalId} onChange={(e) => setF({ ...f, professionalId: e.target.value })}><option value="">Todos</option>{pros.data?.map((p) => <option key={p.id} value={p.id}>{fullName(p)}</option>)}</Select></Field>
          )}
          {(f.type === 'citas' || f.type === 'facturacion') && (
            <Field label="Servicio"><Select value={f.serviceId} onChange={(e) => setF({ ...f, serviceId: e.target.value })}><option value="">Todos</option>{services.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          )}
          {f.type === 'cobros' && (
            <Field label="Método"><Select value={f.methodKind} onChange={(e) => setF({ ...f, methodKind: e.target.value })}><option value="">Todos</option>{Object.entries(PAYMENT_METHOD_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          )}
          {f.type === 'reclamaciones' && (
            <>
              <Field label="Aseguradora"><Select value={f.insurerId} onChange={(e) => setF({ ...f, insurerId: e.target.value })}><option value="">Todas</option>{insurers.data?.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select></Field>
              <Field label="Estado"><Select value={f.claimStatus} onChange={(e) => setF({ ...f, claimStatus: e.target.value })}><option value="">Todos</option>{CLAIM_STATUSES.map((s) => <option key={s} value={s}>{CLAIM_STATUS_LABEL[s]}</option>)}</Select></Field>
            </>
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => setRun((r) => r + 1)}>Actualizar</Button>
          {can('reports.export') && (
            <>
              <Button variant="outline" asChild><a href={backendUrl(`/reports/export/${f.type}`, { ...query, format: 'xlsx' })}><FileSpreadsheet /> Excel</a></Button>
              <Button variant="outline" asChild><a href={backendUrl(`/reports/export/${f.type}`, { ...query, format: 'pdf' })}><FileText /> PDF</a></Button>
            </>
          )}
        </div>
      </Card>
      <Card>
        {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <LoadingBlock /> : data && (
          <>
            <CardHeader title={data.title} description={`${data.rows.length} registro(s)`} />
            {data.rows.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border bg-slate-50/70 text-left text-xs uppercase text-muted">{data.columns.map((c) => <th key={c.key} className={`whitespace-nowrap px-4 py-2 ${c.money ? 'text-right' : ''}`}>{c.label}</th>)}</tr></thead>
                  <tbody className="divide-y divide-border">
                    {data.rows.slice(0, 500).map((r, i) => (
                      <tr key={i}>{data.columns.map((c) => <td key={c.key} className={`whitespace-nowrap px-4 py-2 ${c.money ? 'text-right tabular-nums' : ''}`}>{c.money && r[c.key] !== '' && r[c.key] != null ? formatMoney(String(r[c.key]), cur) : (r[c.key] ?? '')}</td>)}</tr>
                    ))}
                  </tbody>
                  {data.totals && (
                    <tfoot><tr className="border-t-2 border-border font-semibold">{data.columns.map((c, i) => <td key={c.key} className={`px-4 py-2 ${c.money ? 'text-right tabular-nums' : ''}`}>{data.totals![c.key] != null ? (c.money ? formatMoney(data.totals![c.key], cur) : data.totals![c.key]) : i === 0 ? 'Totales' : ''}</td>)}</tr></tfoot>
                  )}
                </table>
                {data.rows.length > 500 && <p className="px-4 py-3 text-xs text-muted">Se muestran 500 filas. Exporte para ver todas.</p>}
              </div>
            ) : <EmptyState title="Sin datos para los filtros seleccionados" />}
          </>
        )}
      </Card>
    </>
  );
}

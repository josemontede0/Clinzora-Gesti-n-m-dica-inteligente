'use client';

import { formatDate, formatMoney } from '@medigest/shared';
import { AlertTriangle, CalendarCheck, CircleDollarSign, Clock, FileWarning, Hourglass, Landmark, Stethoscope, UserX, Wallet, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardBody, CardHeader, ErrorState, LoadingBlock, PageHeader, Stat } from '@/components/ui/layout';
import { Select } from '@/components/ui/form';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';
import { addDaysYmd, todayYmd } from '@/lib/utils';

interface Dashboard {
  operational: {
    today: { total: number; confirmed: number; waiting: number; inConsultation: number; completed: number; pendingConfirmation: number };
    period: { total: number; completed: number; cancelled: number; noShow: number; byStatus: { status: string; label: string; count: number }[] };
  };
  availability: { id: string; name: string; scheduledMinutes: number; appointmentsToday: number }[];
  financial: null | {
    billed: { total: string; patient: string; insurance: string; invoices: number };
    collected: { gross: string; refunds: string; reversals: string; net: string; byMethod: { kind: string; label: string; amount: string }[] };
    patientReceivable: { amount: string; invoices: number };
    insurerReceivable: { claims: string; notYetClaimed: string };
    claims: { pending: number; rejectedInPeriod: number };
    unreconciledInsurerPayments: string;
    cashDifferences: { amount: string; sessions: number };
    daily: { day: string; billed: string; collected: string }[];
  };
}

const PERIODS = { hoy: 0, '7': 6, '30': 29, '90': 89 } as const;
const PIE = ['#112a47', '#13a08e', '#2c5a8c', '#d97706', '#7c3aed', '#64748b'];

export default function DashboardPage() {
  const { me, branchId } = useSession();
  const [period, setPeriod] = useState<keyof typeof PERIODS>('30');
  const to = todayYmd(me?.organization.timezone);
  const from = addDaysYmd(to, -PERIODS[period]);
  const { data, loading, error, reload } = useApi<Dashboard>('/reports/dashboard', { from, to, branchId: branchId || undefined });
  const cur = me?.organization.currency ?? 'DOP';

  return (
    <>
      <PageHeader
        title={`Hola, ${me?.fullName.split(' ')[0] ?? ''}`}
        description={`Resumen de ${me?.branches.find((b) => b.id === branchId)?.name ?? 'todas las sucursales'} · ${formatDate(from)} – ${formatDate(to)}`}
        actions={
          <Select value={period} onChange={(e) => setPeriod(e.target.value as keyof typeof PERIODS)} aria-label="Período" className="w-44">
            <option value="hoy">Hoy</option>
            <option value="7">Últimos 7 días</option>
            <option value="30">Últimos 30 días</option>
            <option value="90">Últimos 90 días</option>
          </Select>
        }
      />
      {error && <ErrorState message={error} onRetry={reload} />}
      {loading && !data && <LoadingBlock rows={6} />}
      {data && (
        <div className="space-y-6">
          <section aria-label="Indicadores de hoy">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Hoy</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Stat label="Citas de hoy" value={data.operational.today.total} icon={<CalendarCheck />} />
              <Stat label="Confirmadas" value={data.operational.today.confirmed} icon={<CalendarCheck />} tone="teal" />
              <Stat label="Pendientes de confirmar" value={data.operational.today.pendingConfirmation} icon={<Hourglass />} tone="amber" />
              <Stat label="En espera" value={data.operational.today.waiting} icon={<Clock />} tone="amber" />
              <Stat label="En consulta" value={data.operational.today.inConsultation} icon={<Stethoscope />} />
              <Stat label="Completadas" value={data.operational.today.completed} icon={<CalendarCheck />} tone="teal" />
            </div>
          </section>

          <section aria-label="Indicadores del período" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Citas del período" value={data.operational.period.total} />
            <Stat label="Consultas completadas" value={data.operational.period.completed} tone="teal" />
            <Stat label="Cancelaciones" value={data.operational.period.cancelled} icon={<XCircle />} tone="red" />
            <Stat label="Ausencias" value={data.operational.period.noShow} icon={<UserX />} tone="red" />
          </section>

          {data.financial && (
            <>
              <section aria-label="Indicadores financieros">
                <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">Finanzas del período</h2>
                <p className="mb-3 text-xs text-muted">Facturado no es dinero cobrado: el cobrado es lo efectivamente recibido, neto de reembolsos y reversos.</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Stat label="Facturado" value={formatMoney(data.financial.billed.total, cur)} hint={`${data.financial.billed.invoices} ${data.financial.billed.invoices === 1 ? 'factura' : 'facturas'} · paciente ${formatMoney(data.financial.billed.patient, cur)} · seguro ${formatMoney(data.financial.billed.insurance, cur)}`} icon={<CircleDollarSign />} />
                  <Stat label="Cobrado (neto)" value={formatMoney(data.financial.collected.net, cur)} hint={`Bruto ${formatMoney(data.financial.collected.gross, cur)} · reembolsos ${formatMoney(data.financial.collected.refunds, cur)} · reversos ${formatMoney(data.financial.collected.reversals, cur)}`} icon={<Wallet />} tone="teal" />
                  <Stat label="Por cobrar a pacientes" value={formatMoney(data.financial.patientReceivable.amount, cur)} hint={`${data.financial.patientReceivable.invoices} ${data.financial.patientReceivable.invoices === 1 ? 'factura' : 'facturas'} con saldo`} icon={<FileWarning />} tone="amber" />
                  <Stat label="Por cobrar a aseguradoras" value={formatMoney(data.financial.insurerReceivable.claims, cur)} hint={`Sin reclamar aún: ${formatMoney(data.financial.insurerReceivable.notYetClaimed, cur)}`} icon={<Landmark />} tone="amber" />
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Stat label="Reclamaciones pendientes" value={data.financial.claims.pending} />
                  <Stat label="Reclamaciones rechazadas" value={data.financial.claims.rejectedInPeriod} tone="red" />
                  <Stat label="Pagos de ARS sin conciliar" value={formatMoney(data.financial.unreconciledInsurerPayments, cur)} tone="amber" />
                  <Stat label="Diferencias de caja" value={formatMoney(data.financial.cashDifferences.amount, cur)} hint={`${data.financial.cashDifferences.sessions} cierre(s) con diferencia`} icon={<AlertTriangle />} tone={Number(data.financial.cashDifferences.amount) === 0 ? 'navy' : 'red'} />
                </div>
              </section>

              <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                <Card className="xl:col-span-2">
                  <CardHeader title="Facturado vs. cobrado por día" />
                  <CardBody className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data.financial.daily.map((d) => ({ dia: formatDate(d.day).slice(0, 5), Facturado: Number(d.billed), Cobrado: Number(d.collected) }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                        <XAxis dataKey="dia" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} width={70} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                        <Tooltip formatter={(v) => formatMoney(Number(v ?? 0), cur)} />
                        <Legend />
                        <Line type="monotone" dataKey="Facturado" stroke="#112a47" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="Cobrado" stroke="#13a08e" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardBody>
                </Card>
                <Card>
                  <CardHeader title="Cobros por método" />
                  <CardBody className="h-72">
                    {data.financial.collected.byMethod.length ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={data.financial.collected.byMethod.map((m) => ({ name: m.label, value: Number(m.amount) }))} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                            {data.financial.collected.byMethod.map((_, i) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
                          </Pie>
                          <Tooltip formatter={(v) => formatMoney(Number(v ?? 0), cur)} />
                          <Legend />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : (
                      <p className="grid h-full place-items-center text-sm text-muted">Sin cobros en el período</p>
                    )}
                  </CardBody>
                </Card>
              </div>
            </>
          )}

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader title="Citas del período por estado" />
              <CardBody className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.operational.period.byStatus.map((s) => ({ estado: s.label, Citas: s.count }))} layout="vertical" margin={{ left: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="estado" tick={{ fontSize: 11 }} width={140} />
                    <Tooltip />
                    <Bar dataKey="Citas" fill="#2c5a8c" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Disponibilidad de médicos hoy" />
              <ul className="divide-y divide-border">
                {data.availability.map((p) => {
                  const capacity = Math.floor(p.scheduledMinutes / 30);
                  const pct = capacity ? Math.min(100, Math.round((p.appointmentsToday / capacity) * 100)) : 0;
                  return (
                    <li key={p.id} className="px-5 py-3">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium text-slate-700">{p.name}</span>
                        <span className="text-muted">{capacity ? `${p.appointmentsToday} / ~${capacity} citas` : 'No atiende hoy'}</span>
                      </div>
                      {capacity > 0 && (
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                          <div className={pct > 85 ? 'h-full bg-amber-500' : 'h-full bg-teal-500'} style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

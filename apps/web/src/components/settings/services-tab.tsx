'use client';

import { formatDateTime, formatMoney, SERVICE_CATEGORIES } from '@medigest/shared';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form';
import { Badge, Card, CardHeader, LoadingBlock, Notice } from '@/components/ui/layout';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { save, useMutation } from './shared';

interface Service {
  id: string; code: string; name: string; description: string | null; category: string; specialtyId: string | null; durationMin: number; taxRate: string; active: boolean;
  specialty: { name: string } | null;
  prices: { id: string; price: string; coverageAmount: string | null; coveragePercent: string | null; plan: { id: string; name: string; insurer: { name: string } } | null }[];
}
interface PriceRow { id: string; price: string; coverageAmount: string | null; coveragePercent: string | null; validFrom: string; validTo: string | null; plan: { name: string; insurer: { name: string } } | null }
interface Insurer { id: string; code: string; name: string; rnc: string | null; phone: string | null; email: string | null; claimSubmissionDays: number; paymentTermDays: number; active: boolean; integrationMode: string; plans: { id: string; code: string; name: string; coverageType: string; defaultCoveragePercent: string; active: boolean }[] }

export function ServicesTab() {
  const { can, me } = useSession();
  const cur = me?.organization.currency ?? 'DOP';
  const services = useApi<Service[]>('/services', { active: 'all' });
  const specialties = useApi<{ id: string; name: string }[]>('/specialties');
  const insurers = useApi<Insurer[]>('/insurance/insurers');
  const [svc, setSvc] = useState<Partial<Service> & { price?: string } | null>(null);
  const [prices, setPrices] = useState<Service | null>(null);
  const history = useApi<PriceRow[]>(prices ? `/services/${prices.id}/prices` : null);
  const [np, setNp] = useState({ insurancePlanId: '', price: '', coverageAmount: '', coveragePercent: '' });
  const [ins, setIns] = useState<Partial<Insurer> | null>(null);
  const [plan, setPlan] = useState<{ id?: string; insurerId: string; code: string; name: string; coverageType: string; defaultCoveragePercent: string; active: boolean } | null>(null);
  const { busy, run } = useMutation();
  const manage = can('catalogs.manage');
  const insManage = can('insurance.manage');

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Servicios y tarifas" description="Cada cambio de precio crea una nueva vigencia; las facturas emitidas conservan el precio con que se emitieron." actions={manage && <Button size="sm" variant="outline" onClick={() => setSvc({ category: 'CONSULTA', durationMin: 30, taxRate: '0', active: true })}><Plus /> Servicio</Button>} />
        {services.loading ? <LoadingBlock /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr className="border-b border-border bg-slate-50/70 text-left text-xs uppercase text-muted"><th className="px-5 py-2">Código</th><th className="px-5 py-2">Servicio</th><th className="px-5 py-2">Especialidad</th><th className="px-5 py-2 text-right">Particular</th><th className="px-5 py-2">Tarifas de seguro</th><th className="px-5 py-2" /></tr></thead>
              <tbody className="divide-y divide-border">
                {services.data?.map((s) => {
                  const particular = s.prices.find((p) => !p.plan);
                  return (
                    <tr key={s.id}>
                      <td className="px-5 py-2.5 font-mono text-xs">{s.code}</td>
                      <td className="px-5 py-2.5">{s.name} <span className="text-xs text-muted">· {s.durationMin} min</span> {!s.active && <Badge>Inactivo</Badge>}</td>
                      <td className="px-5 py-2.5 text-muted">{s.specialty?.name ?? '—'}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums">{particular ? formatMoney(particular.price, cur) : <Badge tone="red">Sin precio</Badge>}</td>
                      <td className="px-5 py-2.5 text-xs text-muted">{s.prices.filter((p) => p.plan).map((p) => `${p.plan!.insurer.name} ${p.plan!.name}: cubre ${p.coverageAmount ? formatMoney(p.coverageAmount, cur) : `${p.coveragePercent}%`}`).join(' · ') || '—'}</td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-right">
                        {(manage || insManage) && <Button size="sm" variant="ghost" onClick={() => { setPrices(s); setNp({ insurancePlanId: '', price: particular?.price ?? '', coverageAmount: '', coveragePercent: '' }); }}>Tarifas</Button>}
                        {manage && <Button size="sm" variant="ghost" onClick={() => setSvc(s)}>Editar</Button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Aseguradoras (ARS) y planes" actions={insManage && <Button size="sm" variant="outline" onClick={() => setIns({ claimSubmissionDays: 30, paymentTermDays: 45, active: true })}><Plus /> Aseguradora</Button>} />
        <Notice tone="sky" className="m-5 mb-0">Integración: modo MANUAL. Las validaciones y autorizaciones se registran a mano hasta contar con interfaces autorizadas y documentadas por cada ARS.</Notice>
        <ul className="divide-y divide-border text-sm">
          {insurers.data?.map((i) => (
            <li key={i.id} className="px-5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{i.name} <span className="font-mono text-xs text-muted">{i.code}</span> {!i.active && <Badge>Inactiva</Badge>}</p>
                {insManage && <span className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setPlan({ insurerId: i.id, code: '', name: '', coverageType: 'BASICO', defaultCoveragePercent: '0', active: true })}><Plus /> Plan</Button><Button size="sm" variant="ghost" onClick={() => setIns(i)}>Editar</Button></span>}
              </div>
              <p className="text-xs text-muted">Plazo para reclamar {i.claimSubmissionDays} días · pago esperado en {i.paymentTermDays} días</p>
              <div className="mt-2 flex flex-wrap gap-1.5">{i.plans.map((p) => <button key={p.id} disabled={!insManage} onClick={() => setPlan({ ...p, insurerId: i.id })}><Badge tone={p.active ? 'navy' : 'slate'}>{p.name} · {p.defaultCoveragePercent}%</Badge></button>)}</div>
            </li>
          ))}
        </ul>
      </Card>

      <Dialog open={!!svc} onOpenChange={(o) => !o && setSvc(null)} title={svc?.id ? 'Editar servicio' : 'Nuevo servicio'} size="lg" footer={<><Button variant="outline" onClick={() => setSvc(null)}>Cancelar</Button><Button loading={busy} onClick={async () => {
        const s = svc!;
        if (await run(() => save('/services', s.id, { code: s.code, name: s.name, description: s.description || null, category: s.category, specialtyId: s.specialtyId || null, durationMin: s.durationMin, taxRate: s.taxRate ?? '0', active: s.active ?? true, ...(s.id ? {} : { price: s.price || undefined }) }), 'Servicio guardado')) { setSvc(null); services.reload(); }
      }}>Guardar</Button></>}>
        {svc && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Código"><Input value={svc.code ?? ''} onChange={(e) => setSvc({ ...svc, code: e.target.value })} /></Field>
            <Field label="Nombre" className="sm:col-span-2"><Input value={svc.name ?? ''} onChange={(e) => setSvc({ ...svc, name: e.target.value })} /></Field>
            <Field label="Categoría"><Select value={svc.category} onChange={(e) => setSvc({ ...svc, category: e.target.value })}>{SERVICE_CATEGORIES.map((c) => <option key={c} value={c}>{c.toLowerCase()}</option>)}</Select></Field>
            <Field label="Especialidad"><Select value={svc.specialtyId ?? ''} onChange={(e) => setSvc({ ...svc, specialtyId: e.target.value })}><option value="">Ninguna</option>{specialties.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
            <Field label="Duración (min)"><Input type="number" value={svc.durationMin} onChange={(e) => setSvc({ ...svc, durationMin: Number(e.target.value) })} /></Field>
            <Field label="Impuesto (%)" hint="0 si está exento"><Input inputMode="decimal" value={svc.taxRate ?? '0'} onChange={(e) => setSvc({ ...svc, taxRate: e.target.value })} /></Field>
            {!svc.id && <Field label="Precio particular"><Input inputMode="decimal" value={svc.price ?? ''} onChange={(e) => setSvc({ ...svc, price: e.target.value })} /></Field>}
            <Field label="Descripción" className="sm:col-span-3"><Textarea value={svc.description ?? ''} onChange={(e) => setSvc({ ...svc, description: e.target.value })} className="min-h-[60px]" /></Field>
            <Checkbox label="Activo" checked={svc.active ?? true} onChange={(e) => setSvc({ ...svc, active: e.target.checked })} />
          </div>
        )}
      </Dialog>

      <Dialog open={!!prices} onOpenChange={(o) => !o && setPrices(null)} title={`Tarifas · ${prices?.name ?? ''}`} size="lg">
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_120px_120px_100px_auto]">
            <Select value={np.insurancePlanId} onChange={(e) => setNp({ ...np, insurancePlanId: e.target.value })} aria-label="Plan">
              {manage && <option value="">Particular</option>}
              {insurers.data?.map((i) => <optgroup key={i.id} label={i.name}>{i.plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}
            </Select>
            <Input inputMode="decimal" placeholder="Precio" value={np.price} onChange={(e) => setNp({ ...np, price: e.target.value })} aria-label="Precio" />
            <Input inputMode="decimal" placeholder="Cubre RD$" disabled={!np.insurancePlanId || !!np.coveragePercent} value={np.coverageAmount} onChange={(e) => setNp({ ...np, coverageAmount: e.target.value })} aria-label="Cobertura en monto" />
            <Input inputMode="decimal" placeholder="Cubre %" disabled={!np.insurancePlanId || !!np.coverageAmount} value={np.coveragePercent} onChange={(e) => setNp({ ...np, coveragePercent: e.target.value })} aria-label="Cobertura en porcentaje" />
            <Button variant="outline" loading={busy} disabled={!np.price} onClick={async () => { if (await run(() => api.post(`/services/${prices!.id}/prices`, { insurancePlanId: np.insurancePlanId || null, price: np.price, coverageAmount: np.coverageAmount || null, coveragePercent: np.coveragePercent || null }), 'Nueva tarifa vigente')) { history.reload(); services.reload(); } }}>Registrar</Button>
          </div>
          {history.loading ? <LoadingBlock /> : (
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {history.data?.map((p) => (
                <li key={p.id} className={`flex flex-wrap justify-between gap-2 px-3 py-2 ${p.validTo ? 'text-muted' : ''}`}>
                  <span>{p.plan ? `${p.plan.insurer.name} · ${p.plan.name}` : 'Particular'}</span>
                  <span className="tabular-nums">{formatMoney(p.price, cur)}{p.coverageAmount ? ` · cubre ${formatMoney(p.coverageAmount, cur)}` : p.coveragePercent ? ` · cubre ${p.coveragePercent}%` : ''}</span>
                  <span className="text-xs">{formatDateTime(p.validFrom)} → {p.validTo ? formatDateTime(p.validTo) : <Badge tone="teal">vigente</Badge>}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>

      <Dialog open={!!ins} onOpenChange={(o) => !o && setIns(null)} title="Aseguradora" footer={<><Button variant="outline" onClick={() => setIns(null)}>Cancelar</Button><Button loading={busy} onClick={async () => { const i = ins!; if (await run(() => save('/insurance/insurers', i.id, { code: i.code, name: i.name, rnc: i.rnc || null, phone: i.phone || null, email: i.email || null, claimSubmissionDays: i.claimSubmissionDays, paymentTermDays: i.paymentTermDays, active: i.active ?? true }), 'Aseguradora guardada')) { setIns(null); insurers.reload(); } }}>Guardar</Button></>}>
        {ins && <div className="grid grid-cols-2 gap-4">
          <Field label="Código"><Input value={ins.code ?? ''} onChange={(e) => setIns({ ...ins, code: e.target.value })} /></Field>
          <Field label="Nombre"><Input value={ins.name ?? ''} onChange={(e) => setIns({ ...ins, name: e.target.value })} /></Field>
          <Field label="RNC"><Input value={ins.rnc ?? ''} onChange={(e) => setIns({ ...ins, rnc: e.target.value })} /></Field>
          <Field label="Teléfono"><Input value={ins.phone ?? ''} onChange={(e) => setIns({ ...ins, phone: e.target.value })} /></Field>
          <Field label="Días para reclamar"><Input type="number" value={ins.claimSubmissionDays} onChange={(e) => setIns({ ...ins, claimSubmissionDays: Number(e.target.value) })} /></Field>
          <Field label="Días de pago"><Input type="number" value={ins.paymentTermDays} onChange={(e) => setIns({ ...ins, paymentTermDays: Number(e.target.value) })} /></Field>
          <Checkbox label="Activa" checked={ins.active ?? true} onChange={(e) => setIns({ ...ins, active: e.target.checked })} />
        </div>}
      </Dialog>
      <Dialog open={!!plan} onOpenChange={(o) => !o && setPlan(null)} title="Plan" footer={<><Button variant="outline" onClick={() => setPlan(null)}>Cancelar</Button><Button loading={busy} onClick={async () => { const p = plan!; if (await run(() => save('/insurance/plans', p.id, { insurerId: p.insurerId, code: p.code, name: p.name, coverageType: p.coverageType, defaultCoveragePercent: p.defaultCoveragePercent, active: p.active }), 'Plan guardado')) { setPlan(null); insurers.reload(); } }}>Guardar</Button></>}>
        {plan && <div className="grid grid-cols-2 gap-4">
          <Field label="Código"><Input value={plan.code} onChange={(e) => setPlan({ ...plan, code: e.target.value })} /></Field>
          <Field label="Nombre"><Input value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} /></Field>
          <Field label="Tipo de cobertura"><Input value={plan.coverageType} onChange={(e) => setPlan({ ...plan, coverageType: e.target.value })} /></Field>
          <Field label="Cobertura por defecto (%)" hint="Si el servicio no tiene tarifa negociada"><Input inputMode="decimal" value={plan.defaultCoveragePercent} onChange={(e) => setPlan({ ...plan, defaultCoveragePercent: e.target.value })} /></Field>
          <Checkbox label="Activo" checked={plan.active} onChange={(e) => setPlan({ ...plan, active: e.target.checked })} />
        </div>}
      </Dialog>
    </div>
  );
}

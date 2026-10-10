'use client';

import { formatCedula, formatDate, formatMoney, fromCents, sumCents, toCents } from '@medigest/shared';
import { Plus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PatientSearch, type PatientHit } from '@/components/patient-search';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form';
import { Card, CardBody, CardHeader, EmptyState, LoadingBlock, Notice, PageHeader } from '@/components/ui/layout';
import { api, errorMessage, newKey } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Charge { id: string; description: string; serviceDate: string; quantity: number; total: string; insuranceAmount: string; patientAmount: string; patientInsuranceId: string | null; branchId: string; discount: string }
interface Service { id: string; code: string; name: string }

function NewInvoice() {
  const router = useRouter();
  const params = useSearchParams();
  const { me, branchId, can } = useSession();
  const cur = me?.organization.currency ?? 'DOP';
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const charges = useApi<Charge[]>(patient ? '/charges' : null, { patientId: patient?.id, status: 'PENDIENTE' });
  const services = useApi<Service[]>(chargeOpen ? '/services' : null);
  const [cf, setCf] = useState({ serviceId: '', quantity: '1', discount: '0', discountReason: '', patientInsuranceId: '' });
  const [chargeKey, setChargeKey] = useState(newKey());

  useEffect(() => {
    const id = params.get('paciente');
    if (id) api.get<PatientHit>(`/patients/${id}`).then(setPatient).catch(() => undefined);
  }, [params]);
  useEffect(() => setSelected([]), [patient]);

  const list = (charges.data ?? []).filter((c) => !branchId || c.branchId === branchId);
  const chosen = list.filter((c) => selected.includes(c.id));
  // Vista previa: los totales definitivos los calcula la API al emitir.
  const preview = useMemo(() => ({
    total: fromCents(sumCents(chosen.map((c) => toCents(c.total)))),
    insurance: fromCents(sumCents(chosen.map((c) => toCents(c.insuranceAmount)))),
    patient: fromCents(sumCents(chosen.map((c) => toCents(c.patientAmount)))),
  }), [chosen]);
  const mixed = new Set(chosen.map((c) => c.patientInsuranceId ?? 'p')).size > 1;

  const issue = async (asDraft: boolean) => {
    setBusy(true);
    try {
      const inv = await api.post<{ id: string; number: string }>('/invoices', { patientId: patient!.id, branchId, chargeIds: selected, notes: notes || null, issue: !asDraft });
      toast.success(`Factura ${inv.number} ${asDraft ? 'guardada como borrador' : 'emitida'}`);
      router.push(`/facturacion/${inv.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const addCharge = async () => {
    try {
      await api.post('/charges', {
        patientId: patient!.id, branchId, serviceId: cf.serviceId, quantity: Number(cf.quantity), discount: cf.discount || '0',
        discountReason: cf.discountReason || null, patientInsuranceId: cf.patientInsuranceId || null, idempotencyKey: chargeKey,
      });
      toast.success('Cargo agregado');
      setChargeOpen(false);
      setChargeKey(newKey());
      setCf({ serviceId: '', quantity: '1', discount: '0', discountReason: '', patientInsuranceId: '' });
      charges.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader title="Facturar" breadcrumbs={[{ label: 'Facturación', href: '/facturacion' }, { label: 'Nueva factura' }]} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader title="Paciente" />
            <CardBody>
              {patient ? (
                <div className="flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3">
                  <div><p className="font-medium">{patient.lastName}, {patient.firstName}</p><p className="text-xs text-muted">{patient.recordNumber} · {formatCedula(patient.documentNumber)}</p></div>
                  <Button variant="ghost" size="sm" onClick={() => setPatient(null)}>Cambiar</Button>
                </div>
              ) : <PatientSearch autoFocus onSelect={setPatient} />}
            </CardBody>
          </Card>
          {patient && (
            <Card>
              <CardHeader title="Cargos pendientes de facturar" description="Seleccione los cargos a incluir. No mezcle particulares con seguro." actions={can('billing.write') && <Button size="sm" variant="outline" onClick={() => setChargeOpen(true)}><Plus /> Cargo manual</Button>} />
              {charges.loading ? <LoadingBlock /> : list.length ? (
                <ul className="divide-y divide-border">
                  {list.map((c) => (
                    <li key={c.id} className="flex items-start gap-3 px-5 py-3">
                      <Checkbox label="" checked={selected.includes(c.id)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, c.id] : s.filter((x) => x !== c.id)))} aria-label={`Incluir ${c.description}`} />
                      <div className="flex flex-1 flex-wrap justify-between gap-2 text-sm">
                        <div><p className="font-medium">{c.description}{c.quantity > 1 ? ` × ${c.quantity}` : ''}</p><p className="text-xs text-muted">{formatDate(c.serviceDate)} · {c.patientInsuranceId ? 'Con seguro' : 'Particular'}{Number(c.discount) > 0 ? ` · descuento ${formatMoney(c.discount, cur)}` : ''}</p></div>
                        <div className="text-right tabular-nums"><p>{formatMoney(c.total, cur)}</p>{Number(c.insuranceAmount) > 0 && <p className="text-xs text-muted">Seguro {formatMoney(c.insuranceAmount, cur)} · Paciente {formatMoney(c.patientAmount, cur)}</p>}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState title="No hay cargos pendientes" description="Los cargos se generan al firmar la consulta o pueden agregarse manualmente." />}
            </Card>
          )}
        </div>
        <Card className="h-fit xl:sticky xl:top-20">
          <CardHeader title="Resumen" />
          <CardBody className="space-y-3 text-sm">
            <div className="flex justify-between"><span className="text-muted">Total</span><span className="tabular-nums">{formatMoney(preview.total, cur)}</span></div>
            <div className="flex justify-between"><span className="text-muted">A cargo del seguro</span><span className="tabular-nums">{formatMoney(preview.insurance, cur)}</span></div>
            <div className="flex justify-between border-t border-border pt-2 font-semibold"><span>A cargo del paciente</span><span className="tabular-nums">{formatMoney(preview.patient, cur)}</span></div>
            {mixed && <Notice tone="red">Los cargos seleccionados mezclan particular y seguro (o afiliaciones distintas). Emita facturas separadas.</Notice>}
            <Field label="Notas"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-[60px]" /></Field>
            <Button className="w-full" variant="success" loading={busy} disabled={!chosen.length || mixed} onClick={() => issue(false)}>Emitir factura</Button>
            <Button className="w-full" variant="outline" disabled={!chosen.length || mixed || busy} onClick={() => issue(true)}>Guardar borrador</Button>
          </CardBody>
        </Card>
      </div>

      <Dialog open={chargeOpen} onOpenChange={setChargeOpen} title="Agregar cargo" description="El precio se toma de la tarifa vigente del servicio." footer={<><Button variant="outline" onClick={() => setChargeOpen(false)}>Cancelar</Button><Button variant="success" disabled={!cf.serviceId} onClick={addCharge}>Agregar</Button></>}>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Servicio" required className="col-span-2">
            <Select value={cf.serviceId} onChange={(e) => setCf({ ...cf, serviceId: e.target.value })}><option value="">Seleccione…</option>{services.data?.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}</Select>
          </Field>
          <Field label="Cantidad"><Input type="number" min={1} value={cf.quantity} onChange={(e) => setCf({ ...cf, quantity: e.target.value })} /></Field>
          <Field label="Seguro">
            <Select value={cf.patientInsuranceId} onChange={(e) => setCf({ ...cf, patientInsuranceId: e.target.value })}><option value="">Particular</option>{patient?.insurances?.map((i) => <option key={i.id} value={i.id}>{i.plan.insurer.name} · {i.plan.name}</option>)}</Select>
          </Field>
          {can('billing.discount') && (
            <>
              <Field label="Descuento (RD$)"><Input inputMode="decimal" value={cf.discount} onChange={(e) => setCf({ ...cf, discount: e.target.value })} /></Field>
              <Field label="Motivo del descuento"><Input value={cf.discountReason} onChange={(e) => setCf({ ...cf, discountReason: e.target.value })} /></Field>
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}

export default function NewInvoicePage() {
  return (
    <Suspense>
      <NewInvoice />
    </Suspense>
  );
}

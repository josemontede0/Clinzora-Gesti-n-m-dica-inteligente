'use client';

import { formatDate, formatDateTime, formatMoney } from '@medigest/shared';
import { Plus, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form';
import { Badge, Card, CardBody, CardHeader, EmptyState, LoadingBlock, Notice } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Policy {
  id: string; affiliateNumber: string; holderName: string | null; relationship: string; validFrom: string | null; validTo: string | null; isPrimary: boolean; active: boolean;
  plan: { id: string; name: string; insurer: { name: string } };
  verifications: { id: string; result: string; method: string; reference: string | null; verifiedAt: string }[];
  authorizations: { id: string; authorizationNumber: string | null; status: string; authorizedAmount: string | null; createdAt: string }[];
}
interface Insurer { id: string; name: string; plans: { id: string; name: string; active: boolean }[] }

export function InsurancePanel({ patientId }: { patientId: string }) {
  const { can, me } = useSession();
  const { data, loading, reload } = useApi<Policy[]>(`/insurance/patients/${patientId}/policies`);
  const insurers = useApi<Insurer[]>('/insurance/insurers');
  const [addOpen, setAddOpen] = useState(false);
  const [verify, setVerify] = useState<Policy | null>(null);
  const [auth, setAuth] = useState<Policy | null>(null);
  const [form, setForm] = useState({ planId: '', affiliateNumber: '', holderName: '', relationship: 'TITULAR', validFrom: '', validTo: '', isPrimary: true });
  const [vForm, setVForm] = useState({ result: 'ELEGIBLE', reference: '', notes: '' });
  const [aForm, setAForm] = useState({ authorizationNumber: '', authorizedAmount: '', status: 'APROBADA', validUntil: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const write = can('insurance.write');

  const run = async (fn: () => Promise<unknown>, ok: string, close: () => void) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      close();
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {write && <Button variant="outline" onClick={() => setAddOpen(true)}><Plus /> Registrar afiliación</Button>}
      {loading ? <LoadingBlock /> : !data?.length ? <Card><EmptyState title="Sin seguros registrados" description="El paciente se atenderá como particular." /></Card> : data.map((p) => (
        <Card key={p.id}>
          <CardHeader
            title={<span className="flex flex-wrap items-center gap-2">{p.plan.insurer.name} · {p.plan.name} {p.isPrimary && <Badge tone="navy">Principal</Badge>} {!p.active && <Badge tone="red">Inactiva</Badge>}</span>}
            description={`Afiliado ${p.affiliateNumber} · ${p.relationship === 'TITULAR' ? 'Titular' : 'Dependiente'}${p.holderName ? ` de ${p.holderName}` : ''} · Vigencia ${formatDate(p.validFrom)} – ${p.validTo ? formatDate(p.validTo) : 'abierta'}`}
            actions={write && (
              <>
                <Button size="sm" variant="outline" onClick={() => setVerify(p)}><ShieldCheck /> Validar cobertura</Button>
                <Button size="sm" variant="outline" onClick={() => setAuth(p)}>Autorización</Button>
                <Button size="sm" variant="ghost" onClick={() => run(() => api.post(`/insurance/policies/${p.id}/active`, { active: !p.active }), 'Afiliación actualizada', () => undefined)}>{p.active ? 'Inactivar' : 'Activar'}</Button>
              </>
            )}
          />
          <CardBody className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium uppercase text-muted">Validaciones</p>
              {p.verifications.length ? p.verifications.map((v) => (
                <p key={v.id}>{formatDateTime(v.verifiedAt)} · <b>{v.result.replace('_', ' ')}</b> · {v.method === 'MANUAL' ? 'registro manual' : 'integración'}{v.reference ? ` · ${v.reference}` : ''}</p>
              )) : <p className="text-muted">Sin validaciones</p>}
            </div>
            <div>
              <p className="mb-1 text-xs font-medium uppercase text-muted">Autorizaciones</p>
              {p.authorizations.length ? p.authorizations.map((a) => (
                <p key={a.id}>{a.authorizationNumber ?? 'Sin número'} · {a.status} {a.authorizedAmount ? `· ${formatMoney(a.authorizedAmount, me?.organization.currency)}` : ''}</p>
              )) : <p className="text-muted">Sin autorizaciones</p>}
            </div>
          </CardBody>
        </Card>
      ))}

      <Dialog open={addOpen} onOpenChange={setAddOpen} title="Registrar afiliación" footer={<><Button variant="outline" onClick={() => setAddOpen(false)}>Cancelar</Button><Button variant="success" loading={busy} onClick={() => run(() => api.post(`/insurance/patients/${patientId}/policies`, { ...form, holderName: form.holderName || null, validFrom: form.validFrom || null, validTo: form.validTo || null }), 'Afiliación registrada', () => setAddOpen(false))}>Guardar</Button></>}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Aseguradora y plan" required className="sm:col-span-2">
            <Select value={form.planId} onChange={(e) => setForm({ ...form, planId: e.target.value })}>
              <option value="">Seleccione…</option>
              {insurers.data?.map((i) => <optgroup key={i.id} label={i.name}>{i.plans.filter((pl) => pl.active).map((pl) => <option key={pl.id} value={pl.id}>{pl.name}</option>)}</optgroup>)}
            </Select>
          </Field>
          <Field label="Número de afiliado" required><Input value={form.affiliateNumber} onChange={(e) => setForm({ ...form, affiliateNumber: e.target.value })} /></Field>
          <Field label="Parentesco">
            <Select value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value })}><option value="TITULAR">Titular</option><option value="DEPENDIENTE">Dependiente</option></Select>
          </Field>
          {form.relationship === 'DEPENDIENTE' && <Field label="Nombre del titular" className="sm:col-span-2"><Input value={form.holderName} onChange={(e) => setForm({ ...form, holderName: e.target.value })} /></Field>}
          <Field label="Vigente desde"><Input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} /></Field>
          <Field label="Vigente hasta"><Input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} /></Field>
          <Checkbox className="sm:col-span-2" label="Seguro principal" checked={form.isPrimary} onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })} />
        </div>
      </Dialog>

      <Dialog open={!!verify} onOpenChange={(v) => !v && setVerify(null)} title="Validación de cobertura" footer={<><Button variant="outline" onClick={() => setVerify(null)}>Cancelar</Button><Button variant="success" loading={busy} onClick={() => run(() => api.post('/insurance/verifications', { patientInsuranceId: verify!.id, ...vForm }), 'Validación registrada', () => setVerify(null))}>Registrar</Button></>}>
        <Notice tone="sky" className="mb-4">Registro manual: indique el resultado de la consulta hecha a la ARS (portal o llamada). El sistema no valida automáticamente con la aseguradora.</Notice>
        <div className="space-y-4">
          <Field label="Resultado"><Select value={vForm.result} onChange={(e) => setVForm({ ...vForm, result: e.target.value })}><option value="ELEGIBLE">Elegible</option><option value="NO_ELEGIBLE">No elegible</option><option value="PENDIENTE">Pendiente</option></Select></Field>
          <Field label="Referencia (número de validación, nombre del agente…)"><Input value={vForm.reference} onChange={(e) => setVForm({ ...vForm, reference: e.target.value })} /></Field>
          <Field label="Notas"><Textarea value={vForm.notes} onChange={(e) => setVForm({ ...vForm, notes: e.target.value })} /></Field>
        </div>
      </Dialog>

      <Dialog open={!!auth} onOpenChange={(v) => !v && setAuth(null)} title="Registrar autorización" footer={<><Button variant="outline" onClick={() => setAuth(null)}>Cancelar</Button><Button variant="success" loading={busy} onClick={() => run(() => api.post('/insurance/authorizations', { patientInsuranceId: auth!.id, ...aForm, authorizedAmount: aForm.authorizedAmount || null, validUntil: aForm.validUntil || null }), 'Autorización registrada', () => setAuth(null))}>Registrar</Button></>}>
        <Notice tone="sky" className="mb-4">Una autorización no es un pago: solo registra lo que la ARS autorizó.</Notice>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Estado"><Select value={aForm.status} onChange={(e) => setAForm({ ...aForm, status: e.target.value })}><option value="SOLICITADA">Solicitada</option><option value="APROBADA">Aprobada</option><option value="DENEGADA">Denegada</option></Select></Field>
          <Field label="Número de autorización"><Input value={aForm.authorizationNumber} onChange={(e) => setAForm({ ...aForm, authorizationNumber: e.target.value })} /></Field>
          <Field label="Monto autorizado"><Input inputMode="decimal" value={aForm.authorizedAmount} onChange={(e) => setAForm({ ...aForm, authorizedAmount: e.target.value })} /></Field>
          <Field label="Válida hasta"><Input type="date" value={aForm.validUntil} onChange={(e) => setAForm({ ...aForm, validUntil: e.target.value })} /></Field>
          <Field label="Notas" className="sm:col-span-2"><Textarea value={aForm.notes} onChange={(e) => setAForm({ ...aForm, notes: e.target.value })} /></Field>
        </div>
      </Dialog>
    </div>
  );
}

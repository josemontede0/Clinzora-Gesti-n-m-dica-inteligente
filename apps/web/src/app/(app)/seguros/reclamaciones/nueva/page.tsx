'use client';

import { formatDate, formatMoney, fromCents, sumCents, toCents } from '@medigest/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Select, Textarea } from '@/components/ui/form';
import { Card, CardBody, CardHeader, EmptyState, LoadingBlock, PageHeader } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Item { id: string; description: string; insuranceAmount: string; invoice: { id: string; number: string; issuedAt: string; patient: { firstName: string; lastName: string; recordNumber: string } }; patientInsurance?: { affiliateNumber: string } }

export default function NewClaimPage() {
  const router = useRouter();
  const { me, branchId } = useSession();
  const cur = me?.organization.currency ?? 'DOP';
  const [insurerId, setInsurerId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const insurers = useApi<{ id: string; name: string }[]>('/insurance/insurers');
  const items = useApi<Item[]>(insurerId ? '/insurance/claimable' : null, { insurerId, branchId: branchId || undefined });
  const total = fromCents(sumCents((items.data ?? []).filter((i) => selected.includes(i.id)).map((i) => toCents(i.insuranceAmount))));

  const create = async () => {
    setBusy(true);
    try {
      const c = await api.post<{ id: string; number: string }>('/insurance/claims', { insurerId, branchId, invoiceItemIds: selected, notes: notes || null });
      toast.success(`Reclamación ${c.number} creada como borrador`);
      router.push(`/seguros/reclamaciones/${c.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Nueva reclamación" breadcrumbs={[{ label: 'Seguros', href: '/seguros' }, { label: 'Nueva reclamación' }]} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardBody>
              <Field label="Aseguradora" className="max-w-sm">
                <Select value={insurerId} onChange={(e) => { setInsurerId(e.target.value); setSelected([]); }}><option value="">Seleccione…</option>{insurers.data?.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select>
              </Field>
            </CardBody>
          </Card>
          {insurerId && (
            <Card>
              <CardHeader title="Servicios facturados pendientes de reclamar" actions={!!items.data?.length && <Button size="sm" variant="ghost" onClick={() => setSelected(selected.length === items.data!.length ? [] : items.data!.map((i) => i.id))}>{selected.length === items.data.length ? 'Quitar todos' : 'Seleccionar todos'}</Button>} />
              {items.loading ? <LoadingBlock /> : items.data?.length ? (
                <ul className="divide-y divide-border">
                  {items.data.map((i) => (
                    <li key={i.id} className="flex items-start gap-3 px-5 py-3 text-sm">
                      <Checkbox label="" checked={selected.includes(i.id)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, i.id] : s.filter((x) => x !== i.id)))} aria-label={`Incluir ${i.description}`} />
                      <div className="flex flex-1 flex-wrap justify-between gap-2">
                        <div><p className="font-medium">{i.invoice.patient.lastName}, {i.invoice.patient.firstName} · {i.description}</p><p className="text-xs text-muted">{i.invoice.number} · {formatDate(i.invoice.issuedAt)} · afiliado {i.patientInsurance?.affiliateNumber}</p></div>
                        <span className="tabular-nums">{formatMoney(i.insuranceAmount, cur)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState title="No hay servicios pendientes de reclamar a esta aseguradora" />}
            </Card>
          )}
        </div>
        <Card className="h-fit">
          <CardHeader title="Resumen" />
          <CardBody className="space-y-3 text-sm">
            <div className="flex justify-between"><span className="text-muted">Líneas</span><span>{selected.length}</span></div>
            <div className="flex justify-between font-semibold"><span>Monto a reclamar</span><span className="tabular-nums">{formatMoney(total, cur)}</span></div>
            <Field label="Notas"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-[60px]" /></Field>
            <Button className="w-full" variant="success" loading={busy} disabled={!selected.length} onClick={create}>Crear reclamación</Button>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

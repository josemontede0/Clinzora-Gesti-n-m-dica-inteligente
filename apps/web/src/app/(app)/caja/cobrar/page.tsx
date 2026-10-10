'use client';

import { formatCedula, formatDate, formatMoney, fromCents, sumCents, toCents } from '@medigest/shared';
import { Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PatientSearch, type PatientHit } from '@/components/patient-search';
import { ReceiptActions } from '@/components/receipts/receipt-actions';
import { Dialog } from '@/components/ui/dialog';
import { InvoiceStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Card, CardBody, CardHeader, EmptyState, LoadingBlock, Notice, PageHeader } from '@/components/ui/layout';
import { api, errorMessage, newKey } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Method { id: string; name: string; kind: string; requiresReference: boolean; active: boolean }
interface Account { balance: string; credit: string; openInvoices: { id: string; number: string; issuedAt: string | null; balance: string; status: string; overdue: boolean; patientAmount?: string }[] }
interface Tender { methodId: string; amount: string; reference: string; cardLast4: string }

const isCard = (kind?: string) => kind === 'TARJETA_CREDITO' || kind === 'TARJETA_DEBITO';
const safeCents = (v: string) => {
  try {
    return v ? toCents(v) : 0;
  } catch {
    return NaN;
  }
};

function Collect() {
  const router = useRouter();
  const params = useSearchParams();
  const { me, branchId } = useSession();
  const cur = me?.organization.currency ?? 'DOP';
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const methods = useApi<Method[]>('/settings/payment-methods');
  const cash = useApi<{ session: { id: string; register: { name: string } } | null }>('/cash/current');
  const account = useApi<Account>(patient ? `/patients/${patient.id}/account` : null);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Una clave por intento de cobro: si se reintenta por fallo de red, la API no duplica el pago.
  const [key, setKey] = useState(newKey());
  const [done, setDone] = useState<{ id: string; number: string; unapplied: string; amount: string } | null>(null);

  useEffect(() => {
    const id = params.get('paciente');
    if (id) api.get<PatientHit>(`/patients/${id}`).then(setPatient).catch(() => undefined);
  }, [params]);

  useEffect(() => {
    if (!account.data) return;
    const target = params.get('factura');
    const initial: Record<string, string> = {};
    for (const i of account.data.openInvoices.filter((x) => x.status !== 'BORRADOR')) if (!target || i.id === target) initial[i.id] = i.balance;
    setAlloc(initial);
  }, [account.data, params]);

  useEffect(() => {
    if (methods.data && !tenders.length) {
      const cashM = methods.data.find((m) => m.kind === 'EFECTIVO' && m.active);
      setTenders([{ methodId: cashM?.id ?? '', amount: '', reference: '', cardLast4: '' }]);
    }
  }, [methods.data, tenders.length]);

  const allocTotal = useMemo(() => sumCents(Object.values(alloc).map(safeCents).filter((n) => !Number.isNaN(n))), [alloc]);
  const tenderTotal = useMemo(() => sumCents(tenders.map((t) => safeCents(t.amount)).filter((n) => !Number.isNaN(n))), [tenders]);

  // Autocompleta el monto del único medio con el total aplicado.
  useEffect(() => {
    if (tenders.length === 1 && allocTotal > 0) setTenders((t) => [{ ...t[0], amount: fromCents(allocTotal) }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allocTotal]);

  const submit = async () => {
    setError(null);
    if (tenderTotal <= 0) return setError('Indique el monto recibido');
    if (allocTotal > tenderTotal) return setError('Lo aplicado a facturas supera lo recibido');
    setBusy(true);
    try {
      const p = await api.post<{ id: string; number: string; unapplied: string; amount: string }>('/payments', {
        patientId: patient!.id,
        branchId,
        idempotencyKey: key,
        notes: notes || null,
        tenders: tenders.filter((t) => safeCents(t.amount) > 0).map((t) => ({ methodId: t.methodId, amount: t.amount, reference: t.reference || null, cardLast4: t.cardLast4 || null })),
        allocations: Object.entries(alloc).filter(([, v]) => safeCents(v) > 0).map(([invoiceId, amount]) => ({ invoiceId, amount })),
      });
      toast.success(`Cobro registrado: recibo ${p.number}`);
      setKey(newKey());
      setDone({ id: p.id, number: p.number, unapplied: p.unapplied, amount: fromCents(tenderTotal) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (cash.loading) return <LoadingBlock />;
  if (!cash.data?.session) {
    return (
      <>
        <PageHeader title="Registrar cobro" breadcrumbs={[{ label: 'Caja', href: '/caja' }, { label: 'Cobrar' }]} />
        <Notice tone="amber">Debe abrir una caja antes de registrar cobros. <Link href="/caja" className="font-medium underline">Ir a Caja</Link></Notice>
      </>
    );
  }

  const invoices = account.data?.openInvoices.filter((i) => i.status !== 'BORRADOR') ?? [];

  return (
    <>
      <PageHeader title="Registrar cobro" description={`Caja: ${cash.data.session.register.name}`} breadcrumbs={[{ label: 'Caja', href: '/caja' }, { label: 'Cobrar' }]} />
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
              <CardHeader title="Aplicar a facturas" description="Lo no aplicado queda como anticipo a favor del paciente." />
              {account.loading ? <LoadingBlock /> : invoices.length ? (
                <ul className="divide-y divide-border">
                  {invoices.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                      <div className="text-sm">
                        <p className="font-medium">{i.number} <InvoiceStatusBadge status={i.status} overdue={i.overdue} /></p>
                        <p className="text-xs text-muted">{formatDate(i.issuedAt)} · saldo {formatMoney(i.balance, cur)}</p>
                      </div>
                      <Input className="w-36 text-right tabular-nums" inputMode="decimal" value={alloc[i.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.value })} aria-label={`Monto a aplicar a ${i.number}`} placeholder="0.00" />
                    </li>
                  ))}
                </ul>
              ) : <EmptyState title="El paciente no tiene facturas con saldo" description="Puede registrar un anticipo." />}
            </Card>
          )}
          {patient && (
            <Card>
              <CardHeader title="Medios de pago" description="Puede combinar varios medios (p. ej. efectivo y tarjeta)." actions={<Button size="sm" variant="ghost" onClick={() => setTenders([...tenders, { methodId: '', amount: '', reference: '', cardLast4: '' }])}><Plus /> Agregar medio</Button>} />
              <CardBody className="space-y-3">
                {tenders.map((t, i) => {
                  const m = methods.data?.find((x) => x.id === t.methodId);
                  return (
                    <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_140px_1fr_auto]">
                      <Select value={t.methodId} onChange={(e) => setTenders(tenders.map((x, j) => (j === i ? { ...x, methodId: e.target.value } : x)))} aria-label="Método">
                        <option value="">Método…</option>
                        {methods.data?.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </Select>
                      <Input inputMode="decimal" className="text-right tabular-nums" placeholder="Monto" value={t.amount} onChange={(e) => setTenders(tenders.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label="Monto" />
                      {isCard(m?.kind) ? (
                        <div className="grid grid-cols-2 gap-2">
                          <Input placeholder="Últimos 4" maxLength={4} inputMode="numeric" value={t.cardLast4} onChange={(e) => setTenders(tenders.map((x, j) => (j === i ? { ...x, cardLast4: e.target.value.replace(/\D/g, '') } : x)))} aria-label="Últimos 4 dígitos" />
                          <Input placeholder="Aprobación" value={t.reference} onChange={(e) => setTenders(tenders.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} aria-label="Número de aprobación" />
                        </div>
                      ) : m?.requiresReference ? (
                        <Input placeholder="Referencia" value={t.reference} onChange={(e) => setTenders(tenders.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} aria-label="Referencia" />
                      ) : <span />}
                      <Button variant="ghost" size="icon" disabled={tenders.length === 1} onClick={() => setTenders(tenders.filter((_, j) => j !== i))} aria-label="Quitar medio"><Trash2 /></Button>
                    </div>
                  );
                })}
                <p className="text-xs text-muted">Tarjetas: nunca ingrese el número completo ni el CVV. Solo los últimos 4 dígitos y el número de aprobación del voucher.</p>
              </CardBody>
            </Card>
          )}
        </div>
        <Card className="h-fit xl:sticky xl:top-20">
          <CardHeader title="Resumen del cobro" />
          <CardBody className="space-y-3 text-sm">
            <div className="flex justify-between"><span className="text-muted">Recibido</span><span className="font-semibold tabular-nums">{formatMoney(fromCents(tenderTotal), cur)}</span></div>
            <div className="flex justify-between"><span className="text-muted">Aplicado a facturas</span><span className="tabular-nums">{formatMoney(fromCents(allocTotal), cur)}</span></div>
            <div className="flex justify-between border-t border-border pt-2"><span className="text-muted">Queda como anticipo</span><span className="tabular-nums">{formatMoney(fromCents(Math.max(tenderTotal - allocTotal, 0)), cur)}</span></div>
            {allocTotal > tenderTotal && <Notice tone="red">Lo aplicado supera lo recibido.</Notice>}
            {error && <Notice tone="red">{error}</Notice>}
            <Field label="Notas"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-[60px]" /></Field>
            <Button className="w-full" variant="success" loading={busy} disabled={!patient || tenderTotal <= 0 || allocTotal > tenderTotal || tenders.some((t) => safeCents(t.amount) > 0 && !t.methodId)} onClick={submit}>Registrar cobro</Button>
          </CardBody>
        </Card>
      </div>

      <Dialog
        open={!!done}
        onOpenChange={(o) => { if (!o && done) router.push(`/pacientes/${patient!.id}`); }}
        title={`Cobro registrado · ${done?.number ?? ''}`}
        description="Imprima o descargue el recibo para el paciente. Podrá reimprimirlo luego desde Caja > Historial de recibos."
        footer={
          <>
            <Button variant="outline" onClick={() => { setDone(null); setAlloc({}); setTenders([]); setNotes(''); setPatient(null); }}>Nuevo cobro</Button>
            <Button variant="ghost" onClick={() => router.push(`/pacientes/${patient!.id}`)}>Ir al paciente</Button>
          </>
        }
      >
        {done && (
          <div className="space-y-4">
            <p className="text-sm">Total recibido: <b className="tabular-nums">{formatMoney(done.amount, cur)}</b>{Number(done.unapplied) > 0 && <> · anticipo a favor del paciente: <b className="tabular-nums">{formatMoney(done.unapplied, cur)}</b></>}</p>
            <ReceiptActions paymentId={done.id} />
          </div>
        )}
      </Dialog>
    </>
  );
}

export default function CollectPage() {
  return (
    <Suspense>
      <Collect />
    </Suspense>
  );
}

'use client';

import { ageFrom, formatDate, formatDateTime } from '@medigest/shared';
import { AlertTriangle, Download, Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/ui/layout';
import { api, backendUrl, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { fullName } from '@/lib/utils';

interface Summary {
  patient: { id: string; recordNumber: string; firstName: string; lastName: string; birthDate: string | null; sex: string };
  allergies: { id: string; substance: string; reaction: string | null; severity: string; active: boolean }[];
  medications: { id: string; name: string; dose: string | null; frequency: string | null; route: string | null; active: boolean }[];
  history: { id: string; kind: string; description: string }[];
  encounters: {
    id: string; status: string; startedAt: string; signedAt: string | null;
    professional: { title: string; firstName: string; lastName: string };
    diagnoses: { code: string | null; description: string; type: string }[];
    notes: { content: string }[];
    vitals: { systolic: number | null; diastolic: number | null; heartRate: number | null; temperatureC: string | null; weightKg: string | null }[];
  }[];
}

const HISTORY_LABEL: Record<string, string> = { PERSONAL: 'Personal', FAMILIAR: 'Familiar', QUIRURGICO: 'Quirúrgico', GINECO_OBSTETRICO: 'Gineco-obstétrico', SOCIAL: 'Social', OTRO: 'Otro' };

export default function ClinicalSummaryPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data, loading, error, reload } = useApi<Summary>(`/clinical/patients/${id}`);
  const [dialog, setDialog] = useState<null | 'allergy' | 'med' | 'history'>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const write = can('clinical.write');

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <LoadingBlock rows={8} />;
  const p = data.patient;

  const save = async () => {
    setBusy(true);
    try {
      const url = { allergy: 'allergies', med: 'medications', history: 'history' }[dialog!];
      const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v || null]));
      await api.post(`/clinical/patients/${id}/${url}`, body);
      toast.success('Registrado en el expediente');
      setDialog(null);
      setForm({});
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Pacientes', href: '/pacientes' }, { label: p.recordNumber, href: `/pacientes/${p.id}` }, { label: 'Expediente clínico' }]}
        title={`Expediente clínico · ${p.firstName} ${p.lastName}`}
        description={`${p.recordNumber} · ${p.birthDate ? `${ageFrom(p.birthDate)} años` : 'edad no registrada'} · ${p.sex.toLowerCase().replace('_', ' ')}`}
        actions={can('clinical.export') && <Button variant="outline" asChild><a href={backendUrl(`/reports/clinical/${p.id}`)}><Download /> Exportar PDF</a></Button>}
      />
      {data.allergies.some((a) => a.active) && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
          <AlertTriangle className="h-4 w-4" /> <b>Alergias:</b> {data.allergies.filter((a) => a.active).map((a) => `${a.substance} (${a.severity.toLowerCase()})`).join(', ')}
        </div>
      )}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Alergias" actions={write && <Button size="sm" variant="ghost" onClick={() => { setForm({ severity: 'MODERADA' }); setDialog('allergy'); }}><Plus /> Agregar</Button>} />
            {data.allergies.length ? (
              <ul className="divide-y divide-border">
                {data.allergies.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm">
                    <span className={a.active ? '' : 'text-muted line-through'}>{a.substance}{a.reaction ? ` — ${a.reaction}` : ''}</span>
                    <span className="flex items-center gap-2">
                      <Badge tone={a.severity === 'SEVERA' ? 'red' : a.severity === 'MODERADA' ? 'amber' : 'slate'}>{a.severity.toLowerCase()}</Badge>
                      {write && <button className="text-xs text-navy-600 hover:underline" onClick={async () => { await api.post(`/clinical/allergies/${a.id}/active`, { active: !a.active }); reload(); }}>{a.active ? 'Inactivar' : 'Reactivar'}</button>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="px-5 py-4 text-sm text-muted">Sin alergias conocidas registradas.</p>}
          </Card>
          <Card>
            <CardHeader title="Medicamentos actuales" actions={write && <Button size="sm" variant="ghost" onClick={() => { setForm({}); setDialog('med'); }}><Plus /> Agregar</Button>} />
            {data.medications.filter((m) => m.active).length ? (
              <ul className="divide-y divide-border">
                {data.medications.filter((m) => m.active).map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm">
                    <span>{[m.name, m.dose, m.route, m.frequency].filter(Boolean).join(' · ')}</span>
                    {write && <button className="text-xs text-navy-600 hover:underline" onClick={async () => { await api.post(`/clinical/medications/${m.id}/stop`); reload(); }}>Suspender</button>}
                  </li>
                ))}
              </ul>
            ) : <p className="px-5 py-4 text-sm text-muted">Sin medicamentos registrados.</p>}
          </Card>
          <Card>
            <CardHeader title="Antecedentes" actions={write && <Button size="sm" variant="ghost" onClick={() => { setForm({ kind: 'PERSONAL' }); setDialog('history'); }}><Plus /> Agregar</Button>} />
            {data.history.length ? (
              <ul className="divide-y divide-border">
                {data.history.map((h) => <li key={h.id} className="px-5 py-2.5 text-sm"><span className="text-xs font-medium uppercase text-muted">{HISTORY_LABEL[h.kind]}</span><p>{h.description}</p></li>)}
              </ul>
            ) : <p className="px-5 py-4 text-sm text-muted">Sin antecedentes registrados.</p>}
          </Card>
        </div>
        <Card className="xl:col-span-2">
          <CardHeader title="Cronología de consultas" />
          {data.encounters.length ? (
            <ol className="relative space-y-1 p-5">
              {data.encounters.map((e) => (
                <li key={e.id} className="relative border-l-2 border-border pb-5 pl-5 last:pb-0">
                  <span className={`absolute -left-[7px] top-1 h-3 w-3 rounded-full ${e.status === 'FIRMADO' ? 'bg-teal-500' : 'bg-amber-400'}`} />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`/clinico/encuentro/${e.id}`} className="font-medium text-navy-800 hover:underline">{formatDateTime(e.startedAt)}</Link>
                    {e.status === 'FIRMADO' ? <Badge tone="teal">Firmado {formatDate(e.signedAt)}</Badge> : <Badge tone="amber">En curso</Badge>}
                  </div>
                  <p className="text-sm text-muted">{fullName(e.professional)}</p>
                  {e.notes[0] && <p className="mt-1 line-clamp-2 text-sm text-slate-700">{e.notes[0].content}</p>}
                  {!!e.diagnoses.length && <p className="mt-1 text-sm"><span className="text-muted">Dx:</span> {e.diagnoses.map((d) => `${d.code ? d.code + ' ' : ''}${d.description}`).join('; ')}</p>}
                  {e.vitals[0] && <p className="mt-1 text-xs text-muted">PA {e.vitals[0].systolic ?? '—'}/{e.vitals[0].diastolic ?? '—'} · FC {e.vitals[0].heartRate ?? '—'} · T {e.vitals[0].temperatureC ?? '—'} °C · Peso {e.vitals[0].weightKg ?? '—'} kg</p>}
                </li>
              ))}
            </ol>
          ) : <EmptyState title="Sin consultas registradas" />}
        </Card>
      </div>

      <Dialog open={!!dialog} onOpenChange={(v) => !v && setDialog(null)} title={{ allergy: 'Registrar alergia', med: 'Registrar medicamento actual', history: 'Registrar antecedente' }[dialog ?? 'allergy']} footer={<><Button variant="outline" onClick={() => setDialog(null)}>Cancelar</Button><Button variant="success" loading={busy} onClick={save}>Guardar</Button></>}>
        {dialog === 'allergy' && (
          <div className="space-y-4">
            <Field label="Sustancia" required><Input value={form.substance ?? ''} onChange={set('substance')} /></Field>
            <Field label="Reacción"><Input value={form.reaction ?? ''} onChange={set('reaction')} /></Field>
            <Field label="Severidad"><Select value={form.severity} onChange={set('severity')}><option value="LEVE">Leve</option><option value="MODERADA">Moderada</option><option value="SEVERA">Severa</option></Select></Field>
          </div>
        )}
        {dialog === 'med' && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Medicamento" required className="col-span-2"><Input value={form.name ?? ''} onChange={set('name')} /></Field>
            <Field label="Dosis"><Input value={form.dose ?? ''} onChange={set('dose')} /></Field>
            <Field label="Vía"><Input value={form.route ?? ''} onChange={set('route')} /></Field>
            <Field label="Frecuencia"><Input value={form.frequency ?? ''} onChange={set('frequency')} /></Field>
            <Field label="Desde"><Input type="date" value={form.startDate ?? ''} onChange={set('startDate')} /></Field>
          </div>
        )}
        {dialog === 'history' && (
          <div className="space-y-4">
            <Field label="Tipo"><Select value={form.kind} onChange={set('kind')}>{Object.entries(HISTORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Descripción" required><Textarea value={form.description ?? ''} onChange={set('description')} /></Field>
          </div>
        )}
      </Dialog>
    </>
  );
}

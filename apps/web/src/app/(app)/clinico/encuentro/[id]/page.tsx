'use client';

import { ageFrom, formatDateTime, NOTE_SECTION_LABEL, NOTE_SECTIONS } from '@medigest/shared';
import { History, Lock, PenLine, Plus, Save, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DocumentsPanel } from '@/components/patients/documents-panel';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Badge, Card, CardBody, CardHeader, ErrorState, LoadingBlock, Notice, PageHeader } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { fullName } from '@/lib/utils';

type Section = (typeof NOTE_SECTIONS)[number];
interface Note { id: string; section: Section; content: string; version: number; isCurrent: boolean; correctionReason: string | null; authorId: string; createdAt: string; updatedAt: string }
interface Encounter {
  id: string; status: 'EN_CURSO' | 'FIRMADO'; startedAt: string; signedAt: string | null; signedById: string | null; canEdit: boolean;
  patient: { id: string; recordNumber: string; firstName: string; lastName: string; birthDate: string | null; sex: string };
  professional: { id: string; title: string; firstName: string; lastName: string; exequatur: string | null };
  appointment: { id: string; startsAt: string; reason: string | null } | null;
  notes: Note[];
  vitals: { id: string; recordedAt: string; systolic: number | null; diastolic: number | null; heartRate: number | null; respiratoryRate: number | null; temperatureC: string | null; spo2: number | null; weightKg: string | null; heightCm: string | null; bmi: string | null }[];
  diagnoses: { id: string; code: string | null; description: string; type: string; voidedAt: string | null }[];
  prescriptions: { id: string; notes: string | null; voidedAt: string | null; createdAt: string; items: { id: string; medication: string; dose: string | null; route: string | null; frequency: string | null; duration: string | null; instructions: string | null }[] }[];
  orders: { id: string; type: string; description: string; status: string; resultSummary: string | null }[];
  authors: { id: string; fullName: string }[];
}

const MAIN_SECTIONS: Section[] = ['MOTIVO_CONSULTA', 'ENFERMEDAD_ACTUAL', 'EXAMEN_FISICO', 'EVALUACION', 'PLAN', 'EVOLUCION'];

export default function EncounterPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data: enc, loading, error, reload } = useApi<Encounter>(`/clinical/encounters/${id}`);
  const allergies = useApi<{ allergies: { substance: string; severity: string; active: boolean }[] }>(enc ? `/clinical/patients/${enc.patient.id}` : null);
  const [drafts, setDrafts] = useState<Partial<Record<Section, string>>>({});
  const [saving, setSaving] = useState<Section | null>(null);
  const [vitals, setVitals] = useState<Record<string, string>>({});
  const [dx, setDx] = useState({ code: '', description: '', type: 'PRINCIPAL' });
  const [rxOpen, setRxOpen] = useState(false);
  const [rxItems, setRxItems] = useState([{ medication: '', dose: '', route: '', frequency: '', duration: '', instructions: '' }]);
  const [order, setOrder] = useState({ type: 'LABORATORIO', description: '' });
  const [signOpen, setSignOpen] = useState(false);
  const [correct, setCorrect] = useState<Note | null>(null);
  const [correctText, setCorrectText] = useState('');
  const [correctReason, setCorrectReason] = useState('');
  const [versions, setVersions] = useState<Note[] | null>(null);
  const [result, setResult] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    if (!enc) return;
    const current: Partial<Record<Section, string>> = {};
    for (const n of enc.notes) if (n.isCurrent) current[n.section] = n.content;
    setDrafts(current);
  }, [enc]);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !enc) return <LoadingBlock rows={10} />;

  const editable = enc.canEdit;
  const signed = enc.status === 'FIRMADO';
  const current = (s: Section) => enc.notes.find((n) => n.section === s && n.isCurrent);
  const author = (uid: string | null) => enc.authors.find((a) => a.id === uid)?.fullName ?? '—';

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast.success(ok);
      reload();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    }
  };

  const saveNote = async (section: Section) => {
    const content = drafts[section]?.trim();
    if (!content) return;
    setSaving(section);
    await run(() => api.put(`/clinical/encounters/${id}/notes`, { section, content }), 'Nota guardada');
    setSaving(null);
  };

  const v = enc.vitals[0];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Pacientes', href: '/pacientes' }, { label: enc.patient.recordNumber, href: `/pacientes/${enc.patient.id}` }, { label: 'Expediente', href: `/clinico/paciente/${enc.patient.id}` }, { label: 'Encuentro' }]}
        title={`${enc.patient.firstName} ${enc.patient.lastName}`}
        description={`${enc.patient.recordNumber} · ${enc.patient.birthDate ? `${ageFrom(enc.patient.birthDate)} años` : ''} · ${fullName(enc.professional)} · ${formatDateTime(enc.startedAt)}`}
        actions={
          <>
            {signed ? <Badge tone="teal"><Lock className="mr-1 h-3 w-3" /> Firmado {formatDateTime(enc.signedAt)} por {author(enc.signedById)}</Badge> : <Badge tone="amber">En curso</Badge>}
            {editable && can('clinical.sign') && <Button variant="success" onClick={() => setSignOpen(true)}><PenLine /> Firmar y cerrar</Button>}
          </>
        }
      />
      {allergies.data?.allergies.some((a) => a.active) && (
        <Notice tone="red" className="mb-4"><b>Alergias:</b> {allergies.data.allergies.filter((a) => a.active).map((a) => `${a.substance} (${a.severity.toLowerCase()})`).join(', ')}</Notice>
      )}
      {signed && <Notice tone="sky" className="mb-4">El encuentro está firmado: las notas no se pueden editar. Las correcciones crean una nueva versión con motivo y conservan el original.</Notice>}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {MAIN_SECTIONS.map((s) => {
            const note = current(s);
            const dirty = (drafts[s] ?? '') !== (note?.content ?? '');
            return (
              <Card key={s}>
                <CardHeader
                  title={NOTE_SECTION_LABEL[s]}
                  description={note ? `${note.version > 1 ? `Versión ${note.version} · ` : ''}${author(note.authorId)} · ${formatDateTime(note.updatedAt)}` : undefined}
                  actions={
                    <>
                      {note && note.version > 1 && <Button size="sm" variant="ghost" onClick={async () => setVersions(await api.get<Note[]>(`/clinical/notes/${note.id}/versions`))}><History /> Versiones</Button>}
                      {signed && note && can('clinical.sign') && enc.professional.id && (
                        <Button size="sm" variant="outline" onClick={() => { setCorrect(note); setCorrectText(note.content); setCorrectReason(''); }}><PenLine /> Corregir</Button>
                      )}
                    </>
                  }
                />
                <CardBody>
                  {editable ? (
                    <div className="space-y-2">
                      <Textarea value={drafts[s] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [s]: e.target.value }))} className="min-h-[110px]" placeholder={`Escriba ${NOTE_SECTION_LABEL[s].toLowerCase()}…`} />
                      <div className="flex justify-end">
                        <Button size="sm" variant={dirty ? 'default' : 'outline'} disabled={!dirty || !drafts[s]?.trim()} loading={saving === s} onClick={() => saveNote(s)}><Save /> {dirty ? 'Guardar' : 'Guardado'}</Button>
                      </div>
                    </div>
                  ) : note ? <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{note.content}</p> : <p className="text-sm text-muted">Sin registrar</p>}
                  {note?.correctionReason && <p className="mt-2 text-xs text-amber-700">Corregida: {note.correctionReason}</p>}
                </CardBody>
              </Card>
            );
          })}

          <Card>
            <CardHeader title="Diagnósticos" />
            <CardBody className="space-y-3">
              {enc.diagnoses.filter((d) => !d.voidedAt).map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>{d.code && <span className="mr-1 font-mono text-xs text-muted">{d.code}</span>}{d.description} <Badge tone={d.type === 'PRINCIPAL' ? 'navy' : 'slate'}>{d.type.toLowerCase()}</Badge></span>
                  {editable && <button aria-label="Anular diagnóstico" className="text-slate-400 hover:text-red-600" onClick={() => run(() => api.post(`/clinical/diagnoses/${d.id}/void`, { reason: 'Registrado por error' }), 'Diagnóstico anulado')}><Trash2 className="h-4 w-4" /></button>}
                </div>
              ))}
              {!enc.diagnoses.some((d) => !d.voidedAt) && <p className="text-sm text-muted">Sin diagnósticos</p>}
              {editable && (
                <div className="grid grid-cols-1 gap-2 border-t border-border pt-3 sm:grid-cols-[110px_1fr_140px_auto]">
                  <Input placeholder="CIE-10" value={dx.code} onChange={(e) => setDx({ ...dx, code: e.target.value })} aria-label="Código CIE-10" />
                  <Input placeholder="Descripción del diagnóstico" value={dx.description} onChange={(e) => setDx({ ...dx, description: e.target.value })} aria-label="Descripción" />
                  <Select value={dx.type} onChange={(e) => setDx({ ...dx, type: e.target.value })} aria-label="Tipo"><option value="PRINCIPAL">Principal</option><option value="SECUNDARIO">Secundario</option></Select>
                  <Button variant="outline" disabled={dx.description.trim().length < 2} onClick={async () => { if (await run(() => api.post(`/clinical/encounters/${id}/diagnoses`, { ...dx, code: dx.code || null }), 'Diagnóstico registrado')) setDx({ code: '', description: '', type: 'SECUNDARIO' }); }}><Plus /> Agregar</Button>
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Prescripciones" actions={editable && <Button size="sm" variant="outline" onClick={() => setRxOpen(true)}><Plus /> Nueva receta</Button>} />
            <CardBody className="space-y-3">
              {enc.prescriptions.length ? enc.prescriptions.map((rx) => (
                <div key={rx.id} className={`rounded-lg border border-border p-3 text-sm ${rx.voidedAt ? 'opacity-50' : ''}`}>
                  <div className="mb-1 flex justify-between text-xs text-muted"><span>{formatDateTime(rx.createdAt)}</span>{rx.voidedAt && <Badge tone="red">Anulada</Badge>}</div>
                  <ul className="list-disc space-y-0.5 pl-5">{rx.items.map((i) => <li key={i.id}>{[i.medication, i.dose, i.route, i.frequency, i.duration].filter(Boolean).join(' · ')}{i.instructions ? ` — ${i.instructions}` : ''}</li>)}</ul>
                  {rx.notes && <p className="mt-1 text-muted">{rx.notes}</p>}
                </div>
              )) : <p className="text-sm text-muted">Sin recetas</p>}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Órdenes médicas" />
            <CardBody className="space-y-3">
              {enc.orders.map((o) => (
                <div key={o.id} className="flex flex-wrap items-start justify-between gap-2 text-sm">
                  <div>
                    <p><Badge tone="slate">{o.type.toLowerCase()}</Badge> {o.description}</p>
                    {o.resultSummary && <p className="mt-1 text-muted">Resultado: {o.resultSummary}</p>}
                  </div>
                  <span className="flex items-center gap-2">
                    <Badge tone={o.status === 'COMPLETADA' ? 'teal' : o.status === 'CANCELADA' ? 'red' : 'amber'}>{o.status.toLowerCase()}</Badge>
                    {o.status === 'ORDENADA' && can('clinical.write') && <Button size="sm" variant="ghost" onClick={() => setResult({ id: o.id, text: '' })}>Registrar resultado</Button>}
                  </span>
                </div>
              ))}
              {!enc.orders.length && <p className="text-sm text-muted">Sin órdenes</p>}
              {editable && (
                <div className="grid grid-cols-1 gap-2 border-t border-border pt-3 sm:grid-cols-[170px_1fr_auto]">
                  <Select value={order.type} onChange={(e) => setOrder({ ...order, type: e.target.value })} aria-label="Tipo de orden">
                    <option value="LABORATORIO">Laboratorio</option><option value="IMAGEN">Imagen</option><option value="PROCEDIMIENTO">Procedimiento</option><option value="REFERIMIENTO">Referimiento</option><option value="OTRO">Otro</option>
                  </Select>
                  <Input placeholder="Descripción de la orden" value={order.description} onChange={(e) => setOrder({ ...order, description: e.target.value })} aria-label="Descripción de la orden" />
                  <Button variant="outline" disabled={order.description.trim().length < 2} onClick={async () => { if (await run(() => api.post(`/clinical/encounters/${id}/orders`, order), 'Orden registrada')) setOrder({ ...order, description: '' }); }}><Plus /> Agregar</Button>
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        {/* En móvil los signos vitales van primero: es lo que enfermería registra al llegar el paciente. */}
        <div className="order-first space-y-6 xl:order-none">
          <Card>
            <CardHeader title="Signos vitales" description={v ? `Último registro ${formatDateTime(v.recordedAt)}` : undefined} />
            <CardBody className="space-y-4">
              {v && (
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  {[
                    ['Presión arterial', v.systolic ? `${v.systolic}/${v.diastolic} mmHg` : '—'], ['Frec. cardíaca', v.heartRate ? `${v.heartRate} lpm` : '—'],
                    ['Frec. respiratoria', v.respiratoryRate ? `${v.respiratoryRate} rpm` : '—'], ['Temperatura', v.temperatureC ? `${v.temperatureC} °C` : '—'],
                    ['SpO₂', v.spo2 ? `${v.spo2} %` : '—'], ['Peso', v.weightKg ? `${v.weightKg} kg` : '—'], ['Talla', v.heightCm ? `${v.heightCm} cm` : '—'], ['IMC', v.bmi ?? '—'],
                  ].map(([k, val]) => <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="font-medium tabular-nums">{val}</dd></div>)}
                </dl>
              )}
              {!signed && can('clinical.vitals') && (
                <form
                  className="space-y-3 border-t border-border pt-3"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await run(() => api.post(`/clinical/encounters/${id}/vitals`, vitals), 'Signos vitales registrados')) setVitals({});
                  }}
                >
                  <div className="grid grid-cols-2 gap-2">
                    {[['systolic', 'PA sistólica'], ['diastolic', 'PA diastólica'], ['heartRate', 'FC (lpm)'], ['respiratoryRate', 'FR (rpm)'], ['temperatureC', 'Temp. (°C)'], ['spo2', 'SpO₂ (%)'], ['weightKg', 'Peso (kg)'], ['heightCm', 'Talla (cm)']].map(([k, label]) => (
                      <Field key={k} label={label}><Input inputMode="decimal" value={vitals[k] ?? ''} onChange={(e) => setVitals({ ...vitals, [k]: e.target.value })} /></Field>
                    ))}
                  </div>
                  <Button type="submit" variant="outline" className="w-full" disabled={!Object.values(vitals).some(Boolean)}>Registrar signos</Button>
                </form>
              )}
            </CardBody>
          </Card>
          <DocumentsPanel patientId={enc.patient.id} encounterId={enc.id} />
          {enc.appointment && <p className="text-xs text-muted">Cita: {formatDateTime(enc.appointment.startsAt)}{enc.appointment.reason ? ` · ${enc.appointment.reason}` : ''} · <Link href="/recepcion" className="underline">Sala de espera</Link></p>}
        </div>
      </div>

      <ConfirmDialog
        open={signOpen}
        onOpenChange={setSignOpen}
        title="Firmar y cerrar el encuentro"
        description="Después de firmar no podrá editar las notas; cualquier corrección quedará versionada con motivo. Se completará la cita y se generará el cargo del servicio."
        tone="success"
        confirmLabel="Firmar"
        onConfirm={async () => {
          const unsaved = MAIN_SECTIONS.filter((s) => (drafts[s] ?? '') !== (current(s)?.content ?? ''));
          if (unsaved.length) {
            toast.error(`Guarde primero: ${unsaved.map((s) => NOTE_SECTION_LABEL[s]).join(', ')}`);
            return;
          }
          await run(async () => {
            const r = await api.post<{ chargeId: string | null }>(`/clinical/encounters/${id}/sign`);
            toast.success(r.chargeId ? 'Encuentro firmado. Cargo enviado a facturación.' : 'Encuentro firmado.');
          });
        }}
      />

      <Dialog open={!!correct} onOpenChange={(o) => !o && setCorrect(null)} title={`Corregir: ${correct ? NOTE_SECTION_LABEL[correct.section] : ''}`} size="lg" footer={<><Button variant="outline" onClick={() => setCorrect(null)}>Cancelar</Button><Button variant="success" disabled={correctReason.trim().length < 5} onClick={async () => { if (await run(() => api.post(`/clinical/notes/${correct!.id}/correct`, { content: correctText, reason: correctReason }), 'Corrección registrada')) setCorrect(null); }}>Guardar corrección</Button></>}>
        <div className="space-y-4">
          <Notice tone="amber">El texto original se conserva y queda visible en el historial de versiones.</Notice>
          <Field label="Texto corregido"><Textarea value={correctText} onChange={(e) => setCorrectText(e.target.value)} className="min-h-[160px]" /></Field>
          <Field label="Motivo de la corrección" required><Input value={correctReason} onChange={(e) => setCorrectReason(e.target.value)} /></Field>
        </div>
      </Dialog>

      <Dialog open={!!versions} onOpenChange={(o) => !o && setVersions(null)} title="Historial de versiones" size="lg">
        <ol className="space-y-4">
          {versions?.map((n) => (
            <li key={n.id} className="rounded-lg border border-border p-3 text-sm">
              <p className="mb-1 text-xs text-muted">Versión {n.version} · {author(n.authorId)} · {formatDateTime(n.createdAt)} {n.isCurrent && <Badge tone="teal">Vigente</Badge>}</p>
              {n.correctionReason && <p className="mb-1 text-xs text-amber-700">Motivo: {n.correctionReason}</p>}
              <p className="whitespace-pre-wrap">{n.content}</p>
            </li>
          ))}
        </ol>
      </Dialog>

      <Dialog open={rxOpen} onOpenChange={setRxOpen} title="Nueva receta" size="lg" footer={<><Button variant="outline" onClick={() => setRxOpen(false)}>Cancelar</Button><Button variant="success" onClick={async () => {
        const items = rxItems.filter((i) => i.medication.trim()).map((i) => Object.fromEntries(Object.entries(i).map(([k, val]) => [k, val || null])));
        if (await run(() => api.post(`/clinical/encounters/${id}/prescriptions`, { items }), 'Receta emitida')) { setRxOpen(false); setRxItems([{ medication: '', dose: '', route: '', frequency: '', duration: '', instructions: '' }]); }
      }}>Emitir receta</Button></>}>
        <div className="space-y-4">
          {rxItems.map((it, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-border p-3 sm:grid-cols-3">
              <Input className="col-span-2 sm:col-span-3" placeholder="Medicamento" value={it.medication} onChange={(e) => setRxItems(rxItems.map((x, j) => (j === i ? { ...x, medication: e.target.value } : x)))} />
              {(['dose', 'route', 'frequency', 'duration'] as const).map((k) => (
                <Input key={k} placeholder={{ dose: 'Dosis', route: 'Vía', frequency: 'Frecuencia', duration: 'Duración' }[k]} value={it[k]} onChange={(e) => setRxItems(rxItems.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} />
              ))}
              <Input className="col-span-2" placeholder="Indicaciones" value={it.instructions} onChange={(e) => setRxItems(rxItems.map((x, j) => (j === i ? { ...x, instructions: e.target.value } : x)))} />
            </div>
          ))}
          <Button variant="ghost" size="sm" onClick={() => setRxItems([...rxItems, { medication: '', dose: '', route: '', frequency: '', duration: '', instructions: '' }])}><Plus /> Otro medicamento</Button>
        </div>
      </Dialog>

      <Dialog open={!!result} onOpenChange={(o) => !o && setResult(null)} title="Resultado de la orden" footer={<><Button variant="outline" onClick={() => run(() => api.post(`/clinical/orders/${result!.id}/result`, { status: 'CANCELADA', resultSummary: result!.text || null }), 'Orden cancelada').then(() => setResult(null))}>Cancelar orden</Button><Button variant="success" onClick={() => run(() => api.post(`/clinical/orders/${result!.id}/result`, { status: 'COMPLETADA', resultSummary: result!.text || null }), 'Resultado registrado').then(() => setResult(null))}>Registrar resultado</Button></>}>
        <Field label="Resumen del resultado"><Textarea value={result?.text ?? ''} onChange={(e) => setResult((r) => (r ? { ...r, text: e.target.value } : r))} className="min-h-[120px]" /></Field>
      </Dialog>
    </>
  );
}

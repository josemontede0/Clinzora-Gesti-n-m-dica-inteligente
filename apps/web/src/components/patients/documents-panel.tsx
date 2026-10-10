'use client';

import { formatDateTime } from '@medigest/shared';
import { Download, FileText, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input } from '@/components/ui/form';
import { Badge, Card, CardHeader, EmptyState, LoadingBlock } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Doc { id: string; title: string; isClinical: boolean; createdAt: string; file: { originalName: string; mimeType: string; sizeBytes: number } }

/** Documentos del paciente. Se descargan con enlaces temporales firmados (5 minutos). */
export function DocumentsPanel({ patientId, encounterId }: { patientId: string; encounterId?: string }) {
  const { can } = useSession();
  const { data, loading, reload } = useApi<Doc[]>(`/files/patients/${patientId}/documents`);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [clinical, setClinical] = useState(!!encounterId);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canUpload = can('patients.documents') || can('clinical.write');
  const docs = encounterId ? data : data;

  const download = async (doc: Doc) => {
    try {
      const { url } = await api.get<{ url: string }>(`/files/documents/${doc.id}/link`);
      window.open(`/backend${url}`, '_blank', 'noopener');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file || title.trim().length < 2) return toast.error('Seleccione un archivo e indique un título');
    const form = new FormData();
    form.append('patientId', patientId);
    form.append('title', title.trim());
    form.append('isClinical', String(clinical));
    if (encounterId) form.append('encounterId', encounterId);
    form.append('file', file);
    setBusy(true);
    try {
      await api.upload('/files/patient-documents', form);
      toast.success('Documento adjuntado');
      setOpen(false);
      setTitle('');
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Documentos" description="Archivos privados: se abren con enlaces temporales y cada descarga queda auditada." actions={canUpload && <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Upload /> Adjuntar</Button>} />
      {loading ? <LoadingBlock rows={2} /> : docs?.length ? (
        <ul className="divide-y divide-border">
          {docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{d.title}</span>
                  <span className="block text-xs text-muted">{d.file.originalName} · {(d.file.sizeBytes / 1024).toFixed(0)} KB · {formatDateTime(d.createdAt)}</span>
                </span>
              </span>
              <span className="flex items-center gap-2">
                {d.isClinical ? <Badge tone="violet">Clínico</Badge> : <Badge>Administrativo</Badge>}
                <Button size="sm" variant="ghost" onClick={() => download(d)}><Download /> Abrir</Button>
              </span>
            </li>
          ))}
        </ul>
      ) : <EmptyState title="Sin documentos" />}

      <Dialog open={open} onOpenChange={setOpen} title="Adjuntar documento" footer={<><Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button><Button variant="success" loading={busy} onClick={upload}>Adjuntar</Button></>}>
        <div className="space-y-4">
          <Field label="Título" required><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ej.: Resultado de laboratorio" /></Field>
          <Field label="Archivo" hint="PDF, PNG, JPG o WEBP. Máximo 15 MB."><Input ref={fileRef} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="py-1.5" /></Field>
          {can('clinical.write') && <Checkbox label="Documento clínico (solo visible para personal clínico autorizado)" checked={clinical} onChange={(e) => setClinical(e.target.checked)} />}
        </div>
      </Dialog>
    </Card>
  );
}

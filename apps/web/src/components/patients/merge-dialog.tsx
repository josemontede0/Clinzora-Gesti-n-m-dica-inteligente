'use client';

import { formatCedula } from '@medigest/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { PatientSearch, type PatientHit } from '@/components/patient-search';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/form';
import { Notice } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';

/** Fusión controlada: el expediente elegido (duplicado) se integra en el actual (destino). */
export function MergeDialog({ open, onOpenChange, target, onMerged }: { open: boolean; onOpenChange: (v: boolean) => void; target: { id: string; recordNumber: string; firstName: string; lastName: string }; onMerged: (targetId: string) => void }) {
  const [source, setSource] = useState<PatientHit | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!source) return;
    setBusy(true);
    try {
      const r = await api.post<{ targetId: string; moved: Record<string, number> }>('/patients/merge', { sourceId: source.id, targetId: target.id, reason });
      toast.success(`Expedientes fusionados (${Object.values(r.moved).reduce((a, b) => a + b, 0)} registros movidos)`);
      onOpenChange(false);
      onMerged(r.targetId);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Fusionar expediente duplicado"
      description={`Destino: ${target.recordNumber} · ${target.firstName} ${target.lastName}`}
      footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button><Button variant="destructive" loading={busy} disabled={!source || source.id === target.id || reason.trim().length < 5} onClick={submit}>Fusionar</Button></>}
    >
      <div className="space-y-4">
        <Notice tone="amber">Las citas, encuentros, facturas, pagos, seguros y documentos del duplicado pasarán al expediente destino. El duplicado queda marcado como fusionado (no se borra) y la operación se audita.</Notice>
        <Field label="Expediente duplicado">
          {source ? (
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
              <span>{source.recordNumber} · {source.lastName}, {source.firstName} · {formatCedula(source.documentNumber)}</span>
              <button className="text-navy-600 hover:underline" onClick={() => setSource(null)}>Cambiar</button>
            </div>
          ) : <PatientSearch onSelect={setSource} />}
        </Field>
        <Field label="Motivo" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

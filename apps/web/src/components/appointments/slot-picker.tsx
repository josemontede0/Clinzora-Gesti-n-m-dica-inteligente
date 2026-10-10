'use client';

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/use-api';

export interface Slot { start: string; end: string; label: string; roomId: string | null }

/** Espacios disponibles calculados por la API (horario − bloqueos − citas existentes). */
export function SlotPicker({ professionalId, branchId, date, durationMin, value, onChange }: { professionalId: string; branchId: string; date: string; durationMin?: number; value: string | null; onChange: (slot: Slot) => void }) {
  const { data, loading, error } = useApi<Slot[]>(professionalId && branchId && date ? '/appointments/availability' : null, { professionalId, branchId, date, durationMin });
  if (!professionalId || !date) return <p className="text-sm text-muted">Seleccione médico y fecha para ver la disponibilidad.</p>;
  if (loading) return <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Consultando disponibilidad…</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!data?.length) return <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-muted">No hay espacios disponibles ese día. Pruebe otra fecha o agregue al paciente a la lista de espera.</p>;
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
      {data.map((s) => (
        <button
          key={s.start}
          type="button"
          onClick={() => onChange(s)}
          className={cn(
            'rounded-lg border px-2 py-2 text-sm font-medium tabular-nums transition-colors',
            value === s.start ? 'border-teal-600 bg-teal-600 text-white' : 'border-border bg-white text-slate-700 hover:border-teal-500 hover:bg-teal-50',
          )}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

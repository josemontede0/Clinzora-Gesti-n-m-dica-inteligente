'use client';

import { ageFrom, formatCedula } from '@medigest/shared';
import { Search, UserRound } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-api';
import { cn } from '@/lib/utils';

export interface PatientHit {
  id: string;
  recordNumber: string;
  firstName: string;
  lastName: string;
  documentNumber: string | null;
  birthDate: string | null;
  phone: string | null;
  insurances?: { id: string; affiliateNumber: string; isPrimary: boolean; plan: { name: string; insurer: { name: string } } }[];
}

/** Autocompletado de pacientes por nombre, expediente, cédula o teléfono (teclado accesible). */
export function PatientSearch({ onSelect, placeholder = 'Buscar paciente…', autoFocus, className, compact }: { onSelect: (p: PatientHit) => void; placeholder?: string; autoFocus?: boolean; className?: string; compact?: boolean }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PatientHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const debounced = useDebounced(q, 250);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (debounced.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .get<PatientHit[]>('/patients/search', { q: debounced })
      .then((r) => !cancelled && (setHits(r), setActive(0)))
      .catch(() => !cancelled && setHits([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const pick = (p: PatientHit) => {
    onSelect(p);
    setQ('');
    setHits([]);
    setOpen(false);
  };

  return (
    <div ref={box} className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!hits.length) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, hits.length - 1));
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            pick(hits[active]);
          }
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        role="combobox"
        aria-controls={listId}
        aria-expanded={open && hits.length > 0}
        className={cn('w-full rounded-lg border border-border bg-white pl-9 pr-3 text-sm placeholder:text-slate-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20', compact ? 'h-9' : 'h-10')}
      />
      {open && debounced.trim().length >= 2 && (
        <div className="absolute z-40 mt-1 max-h-80 w-full overflow-y-auto rounded-xl border border-border bg-white py-1 shadow-lg" role="listbox" id={listId}>
          {loading && !hits.length && <p className="px-3 py-2 text-sm text-muted">Buscando…</p>}
          {!loading && !hits.length && <p className="px-3 py-2 text-sm text-muted">Sin coincidencias</p>}
          {hits.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(p)}
              className={cn('flex w-full items-start gap-3 px-3 py-2 text-left', i === active && 'bg-slate-50')}
            >
              <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-slate-800">{p.lastName}, {p.firstName}</span>
                <span className="block text-xs text-muted">
                  {p.recordNumber} · {p.documentNumber ? formatCedula(p.documentNumber) : 'Sin documento'}
                  {p.birthDate ? ` · ${ageFrom(p.birthDate)} años` : ''}
                  {p.phone ? ` · ${p.phone}` : ''}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

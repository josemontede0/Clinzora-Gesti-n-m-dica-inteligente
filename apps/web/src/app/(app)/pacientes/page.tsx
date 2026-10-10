'use client';

import { ageFrom, formatCedula, formatDate } from '@medigest/shared';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Input, Select } from '@/components/ui/form';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/layout';
import type { Paged } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi, useDebounced, usePersistentState } from '@/lib/use-api';

interface Row { id: string; recordNumber: string; firstName: string; lastName: string; documentNumber: string | null; birthDate: string | null; phone: string | null; status: string; lastVisitAt: string | null }

const columns: ColumnDef<Row, unknown>[] = [
  { header: 'Expediente', accessorKey: 'recordNumber', cell: ({ row }) => <span className="font-mono text-xs">{row.original.recordNumber}</span> },
  { header: 'Paciente', cell: ({ row }) => <span className="font-medium text-slate-800">{row.original.lastName}, {row.original.firstName}</span> },
  { header: 'Documento', cell: ({ row }) => formatCedula(row.original.documentNumber) },
  { header: 'Edad', cell: ({ row }) => (row.original.birthDate ? `${ageFrom(row.original.birthDate)} años` : '—') },
  { header: 'Teléfono', cell: ({ row }) => row.original.phone ?? '—' },
  { header: 'Última visita', cell: ({ row }) => formatDate(row.original.lastVisitAt) },
  { header: 'Estado', cell: ({ row }) => (row.original.status === 'ACTIVE' ? <Badge tone="teal">Activo</Badge> : <Badge>Inactivo</Badge>) },
];

export default function PatientsPage() {
  const router = useRouter();
  const { can } = useSession();
  const [filters, setFilters] = usePersistentState('mg_patients_filters', { q: '', status: 'ACTIVE', page: 1 });
  const q = useDebounced(filters.q, 300);
  const { data, loading, error, reload } = useApi<Paged<Row>>('/patients', { q, status: filters.status || undefined, page: filters.page, pageSize: 25 });

  return (
    <>
      <PageHeader
        title="Pacientes"
        description="Registro y búsqueda por nombre, expediente, cédula o teléfono."
        actions={can('patients.write') && <Button asChild variant="success"><Link href="/pacientes/nuevo"><Plus /> Nuevo paciente</Link></Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input className="pl-9" placeholder="Buscar…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value, page: 1 })} aria-label="Buscar pacientes" />
          </div>
          <Select className="sm:w-48" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value, page: 1 })} aria-label="Estado">
            <option value="ACTIVE">Activos</option>
            <option value="INACTIVE">Inactivos</option>
            <option value="">Todos</option>
          </Select>
        </div>
        <DataTable
          columns={columns}
          data={data?.items ?? []}
          loading={loading}
          error={error}
          onRetry={reload}
          page={data?.page}
          pages={data?.pages}
          total={data?.total}
          onPageChange={(page) => setFilters({ ...filters, page })}
          onRowClick={(r) => router.push(`/pacientes/${r.id}`)}
          mobileCard={(r) => (
            <div>
              <p className="font-medium">{r.lastName}, {r.firstName}</p>
              <p className="text-xs text-muted">{r.recordNumber} · {r.documentNumber ? formatCedula(r.documentNumber) : 'Sin documento'} · {r.phone ?? 'sin teléfono'}</p>
            </div>
          )}
          empty={<EmptyState title="No se encontraron pacientes" description={filters.q ? 'Pruebe con otro término o registre un paciente nuevo.' : undefined} action={can('patients.write') ? <Button asChild variant="outline"><Link href="/pacientes/nuevo">Registrar paciente</Link></Button> : undefined} />}
        />
      </Card>
    </>
  );
}

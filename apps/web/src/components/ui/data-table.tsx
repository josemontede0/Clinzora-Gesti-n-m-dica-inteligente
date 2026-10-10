'use client';

import { ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { EmptyState, ErrorState, LoadingBlock } from './layout';

/**
 * Tabla con paginación del servidor (TanStack Table). En móvil puede mostrarse como tarjetas
 * (mobileCard) en lugar de una tabla comprimida.
 */
export function DataTable<T>({
  columns,
  data,
  loading,
  error,
  onRetry,
  page,
  pages,
  total,
  onPageChange,
  onRowClick,
  mobileCard,
  empty,
}: {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  page?: number;
  pages?: number;
  total?: number;
  onPageChange?: (p: number) => void;
  onRowClick?: (row: T) => void;
  mobileCard?: (row: T) => React.ReactNode;
  empty?: React.ReactNode;
}) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel(), manualPagination: true });

  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (loading && !data.length) return <LoadingBlock />;
  if (!data.length) return <>{empty ?? <EmptyState title="Sin resultados" description="No hay registros que coincidan con los filtros." />}</>;

  return (
    <div className={cn(loading && 'opacity-60 transition-opacity')}>
      {mobileCard && (
        <ul className="divide-y divide-border sm:hidden">
          {data.map((row, i) => (
            <li key={i} className={cn('px-4 py-3', onRowClick && 'cursor-pointer active:bg-slate-50')} onClick={() => onRowClick?.(row)}>
              {mobileCard(row)}
            </li>
          ))}
        </ul>
      )}
      <div className={cn('overflow-x-auto', mobileCard && 'hidden sm:block')}>
        <table className="w-full text-left text-sm">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border bg-slate-50/70">
                {hg.headers.map((h) => (
                  <th key={h.id} className="whitespace-nowrap px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-border">
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} onClick={() => onRowClick?.(row.original)} className={cn('transition-colors hover:bg-slate-50/80', onRowClick && 'cursor-pointer')}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-3 align-middle">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page != null && pages != null && pages > 1 && onPageChange && (
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm text-muted">
          <span>{total} registro(s) · página {page} de {pages}</span>
          <div className="flex gap-1">
            <Button size="icon" variant="outline" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="Página anterior"><ChevronLeft /></Button>
            <Button size="icon" variant="outline" disabled={page >= pages} onClick={() => onPageChange(page + 1)} aria-label="Página siguiente"><ChevronRight /></Button>
          </div>
        </div>
      )}
    </div>
  );
}

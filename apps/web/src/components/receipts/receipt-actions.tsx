'use client';

import { Download, Printer } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { backendUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

export type ReceiptFormat = 'ticket' | 'carta';

const FORMAT_KEY = 'mg_receipt_format';

export function useReceiptFormat(): [ReceiptFormat, (f: ReceiptFormat) => void] {
  const [format, setFormat] = useState<ReceiptFormat>(() => {
    try {
      return (localStorage.getItem(FORMAT_KEY) as ReceiptFormat) || 'ticket';
    } catch {
      return 'ticket';
    }
  });
  const set = (f: ReceiptFormat) => {
    setFormat(f);
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {
      /* sin almacenamiento */
    }
  };
  return [format, set];
}

/**
 * Imprime el PDF del recibo con el diálogo del navegador (iframe oculto, mismo origen).
 * Si el navegador no permite imprimir el iframe, abre el PDF en una pestaña nueva.
 */
export function printReceipt(paymentId: string, format: ReceiptFormat) {
  printPdf(backendUrl(`/payments/${paymentId}/receipt`, { formato: format, modo: 'imprimir' }));
}

/** Abre el diálogo de impresión del navegador para un PDF del mismo origen. */
export function printPdf(url: string) {
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      window.open(url, '_blank', 'noopener');
    }
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}

export function downloadReceipt(paymentId: string, format: ReceiptFormat) {
  const a = document.createElement('a');
  a.href = backendUrl(`/payments/${paymentId}/receipt`, { formato: format, modo: 'descargar' });
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Botones Imprimir / Descargar con selector de formato (ticket 80 mm o carta). */
export function ReceiptActions({ paymentId, printedBefore, compact, onPrinted }: { paymentId: string; printedBefore?: boolean; compact?: boolean; onPrinted?: () => void }) {
  const [format, setFormat] = useReceiptFormat();
  const size = compact ? 'sm' : 'default';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex rounded-lg border border-border p-0.5" role="group" aria-label="Formato del recibo">
        {(['ticket', 'carta'] as ReceiptFormat[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFormat(f)}
            aria-pressed={format === f}
            className={cn('rounded-md px-2.5 py-1 text-xs font-medium', format === f ? 'bg-navy-800 text-white' : 'text-slate-600 hover:bg-slate-100')}
          >
            {f === 'ticket' ? 'Ticket 80 mm' : 'Carta'}
          </button>
        ))}
      </div>
      <Button
        size={size}
        onClick={() => {
          printReceipt(paymentId, format);
          toast.message(printedBefore ? 'Reimprimiendo recibo (saldrá marcado como copia)' : 'Abriendo impresión del recibo');
          onPrinted?.();
        }}
      >
        <Printer /> {printedBefore ? 'Reimprimir' : 'Imprimir'}
      </Button>
      <Button
        size={size}
        variant="outline"
        onClick={() => {
          downloadReceipt(paymentId, format);
          onPrinted?.();
        }}
      >
        <Download /> Descargar
      </Button>
    </div>
  );
}

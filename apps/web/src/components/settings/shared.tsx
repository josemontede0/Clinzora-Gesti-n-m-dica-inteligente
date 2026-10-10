'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';

/** Ejecuta una mutación con avisos de éxito o error. Devuelve true si salió bien. */
export function useMutation() {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export const save = (url: string, id: string | undefined, body: unknown) => (id ? api.put(`${url}/${id}`, body) : api.post(url, body));

export const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

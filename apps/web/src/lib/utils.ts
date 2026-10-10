import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fullName(p?: { firstName?: string; lastName?: string; title?: string } | null) {
  if (!p) return '—';
  return [p.title, p.firstName, p.lastName].filter(Boolean).join(' ');
}

/** Fecha local de hoy (YYYY-MM-DD) en Santo Domingo. */
export function todayYmd(timeZone = 'America/Santo_Domingo') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDaysYmd(ymd: string, days: number) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

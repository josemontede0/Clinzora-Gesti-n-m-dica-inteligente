export const DEFAULT_TIMEZONE = 'America/Santo_Domingo';

/** DD/MM/AAAA en la zona horaria indicada. Acepta Date o ISO. Para fechas sin hora (YYYY-MM-DD) no aplica zona. */
export function formatDate(value: string | Date | null | undefined, timeZone = DEFAULT_TIMEZONE): string {
  if (!value) return '—';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-');
    return `${d}/${m}/${y}`;
  }
  const date = typeof value === 'string' ? new Date(value) : value;
  if (typeof value === 'string' && /T00:00:00(\.000)?Z$/.test(value)) {
    // Columnas @db.Date serializadas como medianoche UTC: mostrar la fecha tal cual.
    return formatDate(value.slice(0, 10));
  }
  const parts = new Intl.DateTimeFormat('es-DO', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')}`;
}

export function formatTime(value: string | Date | null | undefined, timeZone = DEFAULT_TIMEZONE, hour12 = true): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('es-DO', { timeZone, hour: 'numeric', minute: '2-digit', hour12 }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined, timeZone = DEFAULT_TIMEZONE): string {
  if (!value) return '—';
  return `${formatDate(value, timeZone)} ${formatTime(value, timeZone)}`;
}

/** Desfase (minutos) de una zona horaria respecto a UTC en un instante dado. */
export function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** Convierte fecha local (YYYY-MM-DD) + minutos desde medianoche en esa zona a un instante UTC. */
export function zonedToUtc(dateYmd: string, minutesFromMidnight: number, timeZone: string): Date {
  const [y, m, d] = dateYmd.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 0, minutesFromMidnight));
  const offset = tzOffsetMinutes(guess, timeZone);
  const result = new Date(guess.getTime() - offset * 60000);
  // Corrección por cambio de horario entre la suposición y el resultado.
  const offset2 = tzOffsetMinutes(result, timeZone);
  return offset2 === offset ? result : new Date(guess.getTime() - offset2 * 60000);
}

/** Fecha local (YYYY-MM-DD), día de la semana (0=domingo) y minutos del día de un instante en una zona. */
export function utcToZonedParts(instant: Date, timeZone: string): { ymd: string; weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: weekdays.indexOf(get('weekday')),
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

export function minutesToHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  // Números dominicanos de 10 dígitos (809/829/849) se guardan sin el 1 inicial.
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

export function normalizeDocument(doc: string | null | undefined): string | null {
  if (!doc) return null;
  const clean = doc.replace(/[\s-]/g, '').toUpperCase();
  return clean || null;
}

/** Cédula dominicana: 11 dígitos con dígito verificador (algoritmo de Luhn). */
export function isValidCedula(cedula: string): boolean {
  const digits = cedula.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let n = Number(digits[i]) * (i % 2 === 0 ? 1 : 2);
    if (n > 9) n -= 9;
    sum += n;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[10]);
}

export function formatCedula(cedula: string | null | undefined): string {
  if (!cedula) return '—';
  const d = cedula.replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 10)}-${d.slice(10)}` : cedula;
}

export function ageFrom(birthDate: string | Date | null | undefined, now = new Date()): number | null {
  if (!birthDate) return null;
  const b = typeof birthDate === 'string' ? new Date(birthDate.slice(0, 10) + 'T12:00:00Z') : birthDate;
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

/** Sustituye {{variable}} en plantillas de notificación. Las variables desconocidas quedan vacías. */
export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? '');
}

export function maskRecipient(recipient: string): string {
  if (recipient.includes('@')) {
    const [user, domain] = recipient.split('@');
    return `${user.slice(0, 2)}***@${domain}`;
  }
  return recipient.length > 4 ? `***${recipient.slice(-4)}` : '****';
}

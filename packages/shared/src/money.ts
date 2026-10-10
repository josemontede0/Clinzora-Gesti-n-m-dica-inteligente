/**
 * Aritmética monetaria en centavos enteros para evitar errores de punto flotante.
 * La API es la fuente de verdad; estas funciones se comparten para que los cálculos
 * de vista previa del frontend usen exactamente las mismas reglas de redondeo.
 */

export type Cents = number;

/** "1,234.50" | "1234.5" | 1234.5 → 123450 */
export function toCents(value: string | number | { toString(): string }): Cents {
  const raw = typeof value === 'number' ? value.toFixed(2) : value.toString().replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error(`Importe inválido: ${raw}`);
  const negative = raw.startsWith('-');
  const [intPart, decPart = ''] = raw.replace('-', '').split('.');
  // Redondeo half-up a 2 decimales sobre la representación decimal (no binaria).
  const dec3 = (decPart + '000').slice(0, 3);
  let cents = parseInt(intPart, 10) * 100 + parseInt(dec3.slice(0, 2), 10);
  if (parseInt(dec3[2], 10) >= 5) cents += 1;
  return negative ? -cents : cents;
}

export function fromCents(cents: Cents): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `-${s}` : s;
}

/** Porcentaje (p. ej. 18 = 18 %) aplicado a centavos con redondeo half-up. */
export function percentOf(cents: Cents, percent: string | number): Cents {
  const basisPoints = toCents(percent); // 18.00 % → 1800
  return Math.round((cents * basisPoints) / 10000);
}

export interface LineInput {
  quantity: number;
  unitPrice: Cents;
  discount: Cents;
  taxRate: string | number;
  /** Cobertura de la aseguradora para la línea completa (ya calculada). */
  insuranceAmount?: Cents;
}

export interface LineTotals {
  gross: Cents;
  discount: Cents;
  taxable: Cents;
  tax: Cents;
  total: Cents;
  insuranceAmount: Cents;
  patientAmount: Cents;
}

/** total = cantidad × precio − descuento + impuesto; paciente = total − cobertura. */
export function computeLine(line: LineInput): LineTotals {
  if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new Error('La cantidad debe ser un entero positivo');
  const gross = line.quantity * line.unitPrice;
  if (line.discount < 0 || line.discount > gross) throw new Error('El descuento no puede superar el importe de la línea');
  const taxable = gross - line.discount;
  const tax = percentOf(taxable, line.taxRate);
  const total = taxable + tax;
  const insuranceAmount = Math.min(Math.max(line.insuranceAmount ?? 0, 0), total);
  return { gross, discount: line.discount, taxable, tax, total, insuranceAmount, patientAmount: total - insuranceAmount };
}

/**
 * Cobertura de una tarifa de seguro: monto fijo negociado o porcentaje del total.
 * Nunca supera el total de la línea.
 */
export function coverageFor(total: Cents, coverageAmount: Cents | null, coveragePercent: string | number | null): Cents {
  if (coverageAmount != null) return Math.min(coverageAmount, total);
  if (coveragePercent != null) return Math.min(percentOf(total, coveragePercent), total);
  return 0;
}

export function sumCents(values: Cents[]): Cents {
  return values.reduce((a, b) => a + b, 0);
}

/** Saldo pendiente = facturado al paciente − pagos aplicados − créditos autorizados. */
export function invoiceBalance(patientAmount: Cents, paid: Cents, credited: Cents): Cents {
  return patientAmount - paid - credited;
}

const dopFormatter = new Intl.NumberFormat('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatMoney(value: string | number | null | undefined, currency = 'DOP'): string {
  if (value == null || value === '') return '—';
  const cents = toCents(value);
  const symbol = currency === 'DOP' ? 'RD$' : currency === 'USD' ? 'US$' : `${currency} `;
  const formatted = dopFormatter.format(Math.abs(cents) / 100);
  return `${cents < 0 ? '-' : ''}${symbol}${formatted}`;
}

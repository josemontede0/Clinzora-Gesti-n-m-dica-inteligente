/**
 * Monto en letras para recibos ("TRES MIL QUINIENTOS PESOS CON 50/100").
 * Cubre hasta 999,999,999,999.99.
 */
const UNIDADES = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIUNO', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'];
const DECENAS = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const CENTENAS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

function hasta999(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'CIEN';
  const c = Math.floor(n / 100);
  const r = n % 100;
  const dec = r === 0 ? '' : r < 30 ? UNIDADES[r] : `${DECENAS[Math.floor(r / 10)]}${r % 10 ? ` Y ${UNIDADES[r % 10]}` : ''}`;
  return [CENTENAS[c], dec].filter(Boolean).join(' ');
}

/** "UNO" se apocopa delante de un sustantivo: "VEINTIÚN MIL", "UN MILLÓN", "TREINTA Y UN PESOS". */
const apocope = (s: string) => s.replace(/VEINTIUNO$/, 'VEINTIÚN').replace(/UNO$/, 'UN');

function hasta999999(n: number): string {
  const miles = Math.floor(n / 1000);
  const resto = hasta999(n % 1000);
  if (miles === 0) return resto;
  const m = miles === 1 ? 'MIL' : `${apocope(hasta999(miles))} MIL`;
  return [m, resto].filter(Boolean).join(' ');
}

function entero(n: number): string {
  if (n === 0) return 'CERO';
  const millones = Math.floor(n / 1_000_000);
  const resto = hasta999999(n % 1_000_000);
  if (millones === 0) return resto;
  const m = millones === 1 ? 'UN MILLÓN' : `${apocope(hasta999999(millones))} MILLONES`;
  return [m, resto].filter(Boolean).join(' ');
}

export function montoEnLetras(cents: number, moneda = 'DOP'): string {
  const unidades = Math.floor(Math.abs(cents) / 100);
  const centavos = Math.abs(cents) % 100;
  const nombre = moneda === 'USD' ? (unidades === 1 ? 'DÓLAR' : 'DÓLARES') : unidades === 1 ? 'PESO' : 'PESOS';
  // "UN MILLÓN DE PESOS": tras millón/millones exactos va "DE".
  const base = apocope(entero(unidades));
  const de = /MILL(ÓN|ONES)$/.test(base) ? ' DE' : '';
  return `${base}${de} ${nombre} CON ${String(centavos).padStart(2, '0')}/100`;
}

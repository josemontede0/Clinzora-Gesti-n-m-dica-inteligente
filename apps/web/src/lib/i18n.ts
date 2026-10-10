/**
 * Textos de la interfaz. El idioma inicial es español; para traducir, agregue otro diccionario con
 * las mismas claves y seleccione el idioma según la configuración del usuario.
 */
const es = {
  'nav.dashboard': 'Panel',
  'nav.reception': 'Sala de espera',
  'nav.agenda': 'Agenda',
  'nav.patients': 'Pacientes',
  'nav.billing': 'Facturación',
  'nav.cash': 'Caja',
  'nav.insurance': 'Seguros',
  'nav.reports': 'Reportes',
  'nav.notifications': 'Notificaciones',
  'nav.settings': 'Configuración',
  'nav.group.operation': 'Operación',
  'nav.group.finance': 'Finanzas',
  'nav.group.admin': 'Administración',
  'header.search': 'Buscar paciente por nombre, expediente, cédula o teléfono',
  'header.profile': 'Mi perfil',
  'header.logout': 'Cerrar sesión',
  'header.branch': 'Sucursal',
} as const;

export type MessageKey = keyof typeof es;
const dictionaries = { es } as const;
let current: keyof typeof dictionaries = 'es';

export function setLocale(locale: keyof typeof dictionaries) {
  current = locale;
}

export function t(key: MessageKey): string {
  return dictionaries[current][key] ?? key;
}

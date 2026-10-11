/**
 * Catálogo de permisos. El backend es quien los hace cumplir; el frontend solo los usa
 * para mostrar u ocultar opciones.
 */
export const PERMISSIONS = {
  // Administración
  'settings.read': { module: 'configuracion', description: 'Ver configuración' },
  'settings.manage': { module: 'configuracion', description: 'Modificar configuración general' },
  'users.read': { module: 'usuarios', description: 'Ver usuarios' },
  'users.manage': { module: 'usuarios', description: 'Crear, editar y bloquear usuarios' },
  'roles.manage': { module: 'usuarios', description: 'Administrar roles y matriz de permisos' },
  'audit.read': { module: 'auditoria', description: 'Consultar la auditoría' },
  'branches.all': { module: 'sucursales', description: 'Operar en todas las sucursales' },
  'catalogs.manage': { module: 'catalogos', description: 'Médicos, especialidades, servicios, consultorios' },
  // Pacientes
  'patients.read': { module: 'pacientes', description: 'Ver ficha administrativa de pacientes' },
  'patients.write': { module: 'pacientes', description: 'Registrar y editar pacientes' },
  'patients.merge': { module: 'pacientes', description: 'Fusionar expedientes duplicados' },
  'patients.documents': { module: 'pacientes', description: 'Ver y subir documentos administrativos' },
  // Agenda
  'appointments.read': { module: 'citas', description: 'Ver agenda y citas' },
  'appointments.write': { module: 'citas', description: 'Crear, reprogramar y cancelar citas' },
  'appointments.checkin': { module: 'citas', description: 'Registrar llegada y estados de recepción' },
  'schedules.manage': { module: 'citas', description: 'Administrar horarios y bloqueos' },
  // Clínico
  'clinical.read': { module: 'clinico', description: 'Ver expediente clínico de sus pacientes' },
  'clinical.read_all': { module: 'clinico', description: 'Ver expediente clínico de cualquier paciente de la organización' },
  'clinical.write': { module: 'clinico', description: 'Crear encuentros, notas, diagnósticos, recetas y órdenes' },
  'clinical.sign': { module: 'clinico', description: 'Firmar encuentros y corregir notas firmadas' },
  'clinical.vitals': { module: 'clinico', description: 'Registrar signos vitales' },
  'clinical.export': { module: 'clinico', description: 'Exportar datos clínicos' },
  // Facturación y caja
  'billing.read': { module: 'facturacion', description: 'Ver cargos y facturas' },
  'billing.write': { module: 'facturacion', description: 'Crear cargos y emitir facturas' },
  'billing.discount': { module: 'facturacion', description: 'Aplicar descuentos' },
  'billing.void': { module: 'facturacion', description: 'Anular facturas y emitir notas de crédito' },
  'payments.write': { module: 'caja', description: 'Registrar cobros' },
  'payments.refund': { module: 'caja', description: 'Autorizar reembolsos y reversos' },
  'cash.operate': { module: 'caja', description: 'Abrir y cerrar caja propia' },
  'cash.supervise': { module: 'caja', description: 'Ver y cerrar cajas de otros usuarios' },
  'fiscal.manage': { module: 'fiscal', description: 'Comprobantes fiscales y rangos NCF' },
  // Seguros
  'insurance.read': { module: 'seguros', description: 'Ver aseguradoras, afiliaciones y reclamaciones' },
  'insurance.write': { module: 'seguros', description: 'Registrar afiliaciones, validaciones y autorizaciones' },
  'insurance.claims': { module: 'seguros', description: 'Gestionar reclamaciones, glosas y pagos de ARS' },
  'insurance.manage': { module: 'seguros', description: 'Administrar aseguradoras, planes y tarifas' },
  // Turnos
  'queue.manage': { module: 'turnos', description: 'Emitir y llamar turnos de la sala de espera' },
  'queue.configure': { module: 'turnos', description: 'Configurar áreas de turnos y pantallas de recepción' },
  // Notificaciones y reportes
  'notifications.read': { module: 'notificaciones', description: 'Ver registro de notificaciones' },
  'notifications.manage': { module: 'notificaciones', description: 'Plantillas y reglas de recordatorio' },
  'reports.operational': { module: 'reportes', description: 'Reportes operativos' },
  'reports.financial': { module: 'reportes', description: 'Reportes financieros' },
  'reports.export': { module: 'reportes', description: 'Exportar reportes a Excel y PDF' },
} as const;

export type PermissionCode = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionCode[];

export interface RoleDefinition {
  code: string;
  name: string;
  description: string;
  requiresMfa: boolean;
  permissions: PermissionCode[];
}

/** Roles iniciales. Son editables desde Configuración > Roles. */
export const DEFAULT_ROLES: RoleDefinition[] = [
  {
    code: 'ADMIN',
    name: 'Administrador',
    description: 'Configuración, usuarios, catálogos y auditoría',
    requiresMfa: true,
    permissions: [
      'queue.configure',
      'settings.read', 'settings.manage', 'users.read', 'users.manage', 'roles.manage', 'audit.read',
      'branches.all', 'catalogs.manage', 'schedules.manage', 'patients.read', 'patients.write', 'patients.merge',
      'appointments.read', 'notifications.read', 'notifications.manage', 'insurance.read', 'insurance.manage',
      'billing.read', 'fiscal.manage', 'reports.operational', 'reports.financial', 'reports.export',
    ],
  },
  {
    code: 'RECEPCION',
    name: 'Recepcionista',
    description: 'Pacientes, citas y admisión',
    requiresMfa: false,
    permissions: [
      'queue.manage',
      'patients.read', 'patients.write', 'patients.documents', 'appointments.read', 'appointments.write',
      'appointments.checkin', 'insurance.read', 'insurance.write', 'notifications.read',
    ],
  },
  {
    code: 'MEDICO',
    name: 'Médico',
    description: 'Expediente clínico de sus pacientes',
    requiresMfa: true,
    permissions: [
      'queue.manage',
      'patients.read', 'patients.documents', 'appointments.read', 'appointments.checkin', 'clinical.read',
      'clinical.write', 'clinical.sign', 'clinical.vitals', 'billing.read',
    ],
  },
  {
    code: 'ENFERMERIA',
    name: 'Enfermería',
    description: 'Signos vitales y seguimiento',
    requiresMfa: false,
    permissions: ['queue.manage', 'patients.read', 'appointments.read', 'appointments.checkin', 'clinical.read', 'clinical.vitals'],
  },
  {
    code: 'CAJA',
    name: 'Cajero',
    description: 'Facturación, cobros y caja (sin notas clínicas)',
    requiresMfa: false,
    permissions: [
      'queue.manage',
      'patients.read', 'appointments.read', 'billing.read', 'billing.write', 'payments.write', 'cash.operate',
      'insurance.read',
    ],
  },
  {
    code: 'SEGUROS',
    name: 'Encargado de seguros',
    description: 'ARS, autorizaciones, reclamaciones y conciliación',
    requiresMfa: false,
    permissions: [
      'patients.read', 'appointments.read', 'billing.read', 'insurance.read', 'insurance.write', 'insurance.claims',
      'insurance.manage', 'reports.financial', 'reports.export',
    ],
  },
  {
    code: 'CONTABILIDAD',
    name: 'Contabilidad',
    description: 'Reportes financieros y conciliaciones',
    requiresMfa: true,
    permissions: [
      'billing.read', 'billing.void', 'payments.refund', 'cash.supervise', 'insurance.read', 'insurance.claims',
      'fiscal.manage', 'reports.financial', 'reports.export', 'patients.read', 'branches.all',
    ],
  },
  {
    code: 'GERENCIA',
    name: 'Gerente',
    description: 'Indicadores y supervisión',
    requiresMfa: true,
    permissions: [
      'queue.manage', 'queue.configure',
      'patients.read', 'appointments.read', 'billing.read', 'billing.discount', 'billing.void', 'payments.refund',
      'cash.supervise', 'insurance.read', 'reports.operational', 'reports.financial', 'reports.export',
      'branches.all', 'audit.read', 'notifications.read', 'users.read', 'settings.read',
    ],
  },
];

/**
 * Esquemas de validación compartidos (Zod v4). El backend los aplica en cada endpoint
 * (ZodValidationPipe) y los publica en Swagger; el frontend los usa con React Hook Form.
 */
import { z } from 'zod/v4';
import { isValidCedula } from './format';

const trimmed = (max = 200) => z.string().trim().max(max);
const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
const uuid = z.uuid({ message: 'Identificador inválido' });
const optionalUuid = z
  .union([uuid, z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null));
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');
const optionalYmd = z
  .union([ymd, z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null));
/** Importe con hasta 2 decimales, como texto ("1500.00") o número. */
export const money = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).replace(/,/g, '').trim())
  .refine((v) => /^\d{1,12}(\.\d{1,2})?$/.test(v), 'Importe inválido (máximo 2 decimales)');
const positiveMoney = money.refine((v) => Number(v) > 0, 'El importe debe ser mayor que cero');
const isoDateTime = z.iso.datetime({ offset: true, message: 'Fecha y hora inválidas' });

// ─────────── Autenticación ───────────

export const PASSWORD_MIN_LENGTH = 10;
export const passwordPolicy = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Mínimo ${PASSWORD_MIN_LENGTH} caracteres`)
  .max(128)
  .refine((v) => /[a-z]/.test(v), 'Debe incluir una letra minúscula')
  .refine((v) => /[A-Z]/.test(v), 'Debe incluir una letra mayúscula')
  .refine((v) => /\d/.test(v), 'Debe incluir un número')
  .refine((v) => /[^A-Za-z0-9]/.test(v), 'Debe incluir un símbolo');

export const loginSchema = z.object({
  email: z.email('Correo inválido').trim().toLowerCase(),
  password: z.string().min(1, 'Ingrese la contraseña').max(128),
});

export const mfaCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Código de 6 dígitos') });

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordPolicy })
  .refine((v) => v.currentPassword !== v.newPassword, { message: 'La nueva contraseña debe ser distinta', path: ['newPassword'] });

export const forgotPasswordSchema = z.object({ email: z.email('Correo inválido').trim().toLowerCase() });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), newPassword: passwordPolicy });

// ─────────── Usuarios ───────────

export const userCreateSchema = z.object({
  email: z.email('Correo inválido').trim().toLowerCase(),
  fullName: trimmed(120).min(3, 'Nombre requerido'),
  roleIds: z.array(uuid).min(1, 'Asigne al menos un rol'),
  branchIds: z.array(uuid).min(1, 'Asigne al menos una sucursal'),
  password: passwordPolicy,
});
export const userUpdateSchema = z.object({
  fullName: trimmed(120).min(3).optional(),
  roleIds: z.array(uuid).min(1).optional(),
  branchIds: z.array(uuid).min(1).optional(),
  active: z.boolean().optional(),
});
export const roleUpsertSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,30}$/, 'Código: letras, números y guion bajo'),
  name: trimmed(80).min(2),
  description: optionalText(200),
  requiresMfa: z.boolean().default(false),
  permissions: z.array(z.string()).default([]),
});

// ─────────── Pacientes ───────────

export const DOCUMENT_TYPES = ['CEDULA', 'PASAPORTE', 'OTRO', 'NINGUNO'] as const;
export const SEXES = ['FEMENINO', 'MASCULINO', 'INTERSEXUAL', 'NO_ESPECIFICADO'] as const;

const contactSchema = z.object({
  name: trimmed(120).min(2, 'Nombre del contacto requerido'),
  relationship: optionalText(60),
  phone: optionalText(30),
  email: z.union([z.email('Correo inválido'), z.literal(''), z.null()]).optional().transform((v) => v || null),
  documentNumber: optionalText(30),
});

/** Un contacto con el nombre vacío equivale a "sin contacto" (los formularios envían los campos vacíos). */
const optionalContact = z.preprocess(
  (v) => (v && typeof v === 'object' && !String((v as { name?: unknown }).name ?? '').trim() ? null : v),
  contactSchema.nullable().optional(),
);

export const patientBaseSchema = z.object({
  firstName: trimmed(80).min(1, 'Nombres requeridos'),
  lastName: trimmed(80).min(1, 'Apellidos requeridos'),
  documentType: z.enum(DOCUMENT_TYPES).default('CEDULA'),
  documentNumber: optionalText(30),
  birthDate: optionalYmd,
  sex: z.enum(SEXES).default('NO_ESPECIFICADO'),
  phone: optionalText(30),
  email: z.union([z.email('Correo inválido'), z.literal(''), z.null()]).optional().transform((v) => v || null),
  address: optionalText(250),
  city: optionalText(80),
  province: optionalText(80),
  adminNotes: optionalText(1000),
  emergencyContact: optionalContact,
  guardian: optionalContact,
});

const patientRefinements = <T extends z.ZodType<z.infer<typeof patientBaseSchema>>>(schema: T) =>
  schema.superRefine((v, ctx) => {
    if (v.documentType !== 'NINGUNO' && !v.documentNumber) {
      ctx.addIssue({ code: 'custom', message: 'Número de documento requerido', path: ['documentNumber'] });
    }
    if (v.documentType === 'CEDULA' && v.documentNumber && !isValidCedula(v.documentNumber)) {
      ctx.addIssue({ code: 'custom', message: 'Cédula inválida (11 dígitos con dígito verificador)', path: ['documentNumber'] });
    }
    if (v.birthDate && new Date(v.birthDate) > new Date()) {
      ctx.addIssue({ code: 'custom', message: 'La fecha de nacimiento no puede ser futura', path: ['birthDate'] });
    }
  });

export const CONSENT_TYPES = [
  'TRATAMIENTO', 'TRATAMIENTO_DATOS', 'COMUNICACION_WHATSAPP', 'COMUNICACION_SMS', 'COMUNICACION_EMAIL', 'TELEMEDICINA', 'OTRO',
] as const;
export const CONSENT_LABEL: Record<(typeof CONSENT_TYPES)[number], string> = {
  TRATAMIENTO: 'Consentimiento de tratamiento',
  TRATAMIENTO_DATOS: 'Tratamiento de datos personales',
  COMUNICACION_WHATSAPP: 'Recibir mensajes por WhatsApp',
  COMUNICACION_SMS: 'Recibir SMS',
  COMUNICACION_EMAIL: 'Recibir correos',
  TELEMEDICINA: 'Atención por telemedicina',
  OTRO: 'Otro',
};

export const consentSchema = z.object({
  type: z.enum(CONSENT_TYPES),
  granted: z.boolean(),
  notes: optionalText(500),
});

export const patientCreateSchema = patientRefinements(patientBaseSchema).and(
  z.object({
    confirmDuplicate: z.boolean().optional().default(false),
    consents: z.array(consentSchema).optional().default([]),
  }),
);
export const patientUpdateSchema = patientRefinements(patientBaseSchema);
export const patientMergeSchema = z
  .object({
    sourceId: uuid,
    targetId: uuid,
    reason: trimmed(500).min(5, 'Indique el motivo de la fusión'),
  })
  .refine((v) => v.sourceId !== v.targetId, { message: 'Seleccione dos expedientes distintos', path: ['targetId'] });

// ─────────── Catálogos ───────────

export const specialtySchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/, 'Código inválido'),
  name: trimmed(80).min(2),
  active: z.boolean().default(true),
});

export const professionalSchema = z.object({
  firstName: trimmed(80).min(1),
  lastName: trimmed(80).min(1),
  title: trimmed(20).default('Dr.'),
  exequatur: optionalText(30),
  phone: optionalText(30),
  email: z.union([z.email(), z.literal(''), z.null()]).optional().transform((v) => v || null),
  defaultDurationMin: z.coerce.number().int().min(5).max(480).default(30),
  allowOverlap: z.boolean().default(false),
  active: z.boolean().default(true),
  userId: optionalUuid,
  specialtyIds: z.array(uuid).default([]),
  branchIds: z.array(uuid).min(1, 'Asigne al menos una sucursal'),
});

export const scheduleSchema = z.object({
  branchId: uuid,
  roomId: optionalUuid,
  weekday: z.coerce.number().int().min(0).max(6),
  startMinute: z.coerce.number().int().min(0).max(1439),
  endMinute: z.coerce.number().int().min(1).max(1440),
  validFrom: optionalYmd,
  validTo: optionalYmd,
}).refine((v) => v.endMinute > v.startMinute, { message: 'La hora final debe ser posterior a la inicial', path: ['endMinute'] });

export const scheduleBlockSchema = z.object({
  professionalId: optionalUuid,
  branchId: optionalUuid,
  type: z.enum(['BLOQUEO', 'VACACIONES', 'FERIADO']).default('BLOQUEO'),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  reason: optionalText(200),
}).refine((v) => new Date(v.endsAt) > new Date(v.startsAt), { message: 'El fin debe ser posterior al inicio', path: ['endsAt'] });

export const SERVICE_CATEGORIES = ['CONSULTA', 'PROCEDIMIENTO', 'LABORATORIO', 'IMAGEN', 'OTRO'] as const;
export const serviceSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/, 'Código inválido'),
  name: trimmed(120).min(2),
  description: optionalText(500),
  category: z.enum(SERVICE_CATEGORIES).default('CONSULTA'),
  specialtyId: optionalUuid,
  durationMin: z.coerce.number().int().min(5).max(480).default(30),
  taxRate: money.default('0'),
  active: z.boolean().default(true),
  price: money.optional(),
});

export const servicePriceSchema = z.object({
  insurancePlanId: optionalUuid,
  price: money,
  coverageAmount: money.optional().nullable(),
  coveragePercent: money.optional().nullable(),
  validFrom: isoDateTime.optional(),
}).refine((v) => !(v.coverageAmount && v.coveragePercent), { message: 'Use monto o porcentaje de cobertura, no ambos', path: ['coverageAmount'] });

export const branchSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/),
  name: trimmed(120).min(2),
  address: optionalText(250),
  phone: optionalText(30),
  timezone: optionalText(60),
  active: z.boolean().default(true),
});

export const roomSchema = z.object({ branchId: uuid, name: trimmed(60).min(1), active: z.boolean().default(true) });

// ─────────── Citas ───────────

export const appointmentCreateSchema = z.object({
  branchId: uuid,
  patientId: uuid,
  professionalId: uuid,
  specialtyId: optionalUuid,
  serviceId: optionalUuid,
  roomId: optionalUuid,
  patientInsuranceId: optionalUuid,
  startsAt: isoDateTime,
  durationMin: z.coerce.number().int().min(5).max(480).optional(),
  modality: z.enum(['PRESENCIAL', 'VIRTUAL']).default('PRESENCIAL'),
  reason: optionalText(300),
  notes: optionalText(500),
  confirmed: z.boolean().default(false),
  waitlistEntryId: optionalUuid,
});

export const appointmentRescheduleSchema = z.object({
  startsAt: isoDateTime,
  durationMin: z.coerce.number().int().min(5).max(480).optional(),
  professionalId: optionalUuid,
  roomId: optionalUuid,
  reason: trimmed(300).min(3, 'Indique el motivo de la reprogramación'),
});

export const appointmentStatusSchema = z.object({
  status: z.enum(['SOLICITADA', 'PENDIENTE_CONFIRMACION', 'CONFIRMADA', 'EN_ESPERA', 'EN_CONSULTA', 'COMPLETADA', 'CANCELADA', 'NO_ASISTIO']),
  reason: optionalText(300),
});

export const waitlistSchema = z.object({
  branchId: uuid,
  patientId: uuid,
  professionalId: optionalUuid,
  specialtyId: optionalUuid,
  serviceId: optionalUuid,
  preferredFrom: optionalYmd,
  preferredTo: optionalYmd,
  notes: optionalText(300),
});

// ─────────── Clínico ───────────

export const NOTE_SECTIONS = ['MOTIVO_CONSULTA', 'ENFERMEDAD_ACTUAL', 'EXAMEN_FISICO', 'EVALUACION', 'PLAN', 'EVOLUCION', 'OTRO'] as const;
export const NOTE_SECTION_LABEL: Record<(typeof NOTE_SECTIONS)[number], string> = {
  MOTIVO_CONSULTA: 'Motivo de consulta',
  ENFERMEDAD_ACTUAL: 'Enfermedad actual',
  EXAMEN_FISICO: 'Examen físico',
  EVALUACION: 'Evaluación clínica',
  PLAN: 'Plan / tratamiento',
  EVOLUCION: 'Nota de evolución',
  OTRO: 'Otra nota',
};

export const encounterCreateSchema = z.object({ appointmentId: optionalUuid, patientId: uuid, branchId: optionalUuid });
export const noteSaveSchema = z.object({ section: z.enum(NOTE_SECTIONS), content: z.string().trim().min(1, 'Escriba el contenido').max(20000) });
export const noteCorrectionSchema = z.object({
  content: z.string().trim().min(1).max(20000),
  reason: trimmed(500).min(5, 'Indique el motivo de la corrección'),
});

const optInt = (min: number, max: number) =>
  z.union([z.coerce.number().int().min(min).max(max), z.literal(''), z.null()]).optional().transform((v) => (v === '' || v == null ? null : v));
const optDec = (min: number, max: number) =>
  z.union([z.coerce.number().min(min).max(max), z.literal(''), z.null()]).optional().transform((v) => (v === '' || v == null ? null : v));

export const vitalsSchema = z.object({
  systolic: optInt(40, 300),
  diastolic: optInt(20, 200),
  heartRate: optInt(20, 250),
  respiratoryRate: optInt(4, 80),
  temperatureC: optDec(30, 45),
  spo2: optInt(40, 100),
  weightKg: optDec(0.3, 400),
  heightCm: optDec(20, 250),
  notes: optionalText(300),
});

export const diagnosisSchema = z.object({
  code: optionalText(20),
  description: trimmed(300).min(2),
  type: z.enum(['PRINCIPAL', 'SECUNDARIO']).default('PRINCIPAL'),
});

export const allergySchema = z.object({
  substance: trimmed(120).min(2),
  reaction: optionalText(200),
  severity: z.enum(['LEVE', 'MODERADA', 'SEVERA']).default('MODERADA'),
});

export const medicationSchema = z.object({
  name: trimmed(120).min(2),
  dose: optionalText(60),
  frequency: optionalText(60),
  route: optionalText(40),
  startDate: optionalYmd,
});

export const historySchema = z.object({
  kind: z.enum(['PERSONAL', 'FAMILIAR', 'QUIRURGICO', 'GINECO_OBSTETRICO', 'SOCIAL', 'OTRO']),
  description: trimmed(1000).min(2),
});

export const prescriptionSchema = z.object({
  notes: optionalText(500),
  items: z
    .array(
      z.object({
        medication: trimmed(150).min(2),
        dose: optionalText(60),
        route: optionalText(40),
        frequency: optionalText(60),
        duration: optionalText(60),
        quantity: optionalText(40),
        instructions: optionalText(300),
      }),
    )
    .min(1, 'Agregue al menos un medicamento'),
});

export const medicalOrderSchema = z.object({
  type: z.enum(['LABORATORIO', 'IMAGEN', 'PROCEDIMIENTO', 'REFERIMIENTO', 'OTRO']),
  description: trimmed(500).min(2),
});
export const orderResultSchema = z.object({
  status: z.enum(['COMPLETADA', 'CANCELADA']),
  resultSummary: optionalText(4000),
});

// ─────────── Facturación ───────────

export const chargeCreateSchema = z.object({
  patientId: uuid,
  branchId: uuid,
  serviceId: uuid,
  professionalId: optionalUuid,
  encounterId: optionalUuid,
  appointmentId: optionalUuid,
  patientInsuranceId: optionalUuid,
  quantity: z.coerce.number().int().min(1).max(999).default(1),
  discount: money.default('0'),
  discountReason: optionalText(200),
  /** Clave de idempotencia enviada por el cliente para no duplicar el cargo al reintentar. */
  idempotencyKey: z.string().min(8).max(100),
});

export const invoiceCreateSchema = z.object({
  patientId: uuid,
  branchId: uuid,
  chargeIds: z.array(uuid).min(1, 'Seleccione al menos un cargo'),
  dueDate: optionalYmd,
  notes: optionalText(500),
  issue: z.boolean().default(true),
});

export const invoiceVoidSchema = z.object({ reason: trimmed(500).min(5, 'Indique el motivo de la anulación') });
export const creditNoteSchema = z.object({ amount: positiveMoney, reason: trimmed(500).min(5, 'Indique el motivo') });

// ─────────── Pagos y caja ───────────

export const tenderSchema = z.object({
  methodId: uuid,
  amount: positiveMoney,
  reference: optionalText(80),
  /** Solo para tarjeta: últimos 4 dígitos. Nunca el número completo ni el CVV. */
  cardLast4: z.union([z.string().regex(/^\d{4}$/, '4 dígitos'), z.literal(''), z.null()]).optional().transform((v) => v || null),
  cardBrand: optionalText(20),
});

export const paymentCreateSchema = z.object({
  patientId: uuid,
  branchId: uuid,
  tenders: z.array(tenderSchema).min(1, 'Agregue al menos un medio de pago'),
  allocations: z.array(z.object({ invoiceId: uuid, amount: positiveMoney })).default([]),
  notes: optionalText(300),
  idempotencyKey: z.string().min(8).max(100),
});

export const allocateSchema = z.object({ invoiceId: uuid, amount: positiveMoney });
export const paymentReverseSchema = z.object({ reason: trimmed(300).min(5, 'Indique el motivo del reverso') });
export const refundSchema = z.object({
  amount: positiveMoney,
  methodId: uuid,
  invoiceId: optionalUuid,
  reason: trimmed(300).min(5, 'Indique el motivo del reembolso'),
  idempotencyKey: z.string().min(8).max(100),
});

export const cashOpenSchema = z.object({ registerId: uuid, openingFloat: money });
export const cashCloseSchema = z.object({ countedCash: money, notes: optionalText(500) });
export const cashMovementSchema = z.object({
  type: z.enum(['RETIRO', 'INGRESO']),
  amount: positiveMoney,
  description: trimmed(200).min(3),
});

export const paymentMethodSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/),
  name: trimmed(60).min(2),
  kind: z.enum(['EFECTIVO', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'TRANSFERENCIA', 'CHEQUE', 'OTRO']),
  requiresReference: z.boolean().default(false),
  active: z.boolean().default(true),
});
export const cashRegisterSchema = z.object({ branchId: uuid, name: trimmed(60).min(2), active: z.boolean().default(true) });

// ─────────── Seguros ───────────

export const insurerSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/),
  name: trimmed(120).min(2),
  rnc: optionalText(20),
  phone: optionalText(30),
  email: z.union([z.email(), z.literal(''), z.null()]).optional().transform((v) => v || null),
  claimSubmissionDays: z.coerce.number().int().min(1).max(365).default(30),
  paymentTermDays: z.coerce.number().int().min(1).max(365).default(45),
  active: z.boolean().default(true),
});

export const insurancePlanSchema = z.object({
  insurerId: uuid,
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/),
  name: trimmed(120).min(2),
  coverageType: trimmed(40).default('BASICO'),
  defaultCoveragePercent: money.default('0').refine((v) => Number(v) <= 100, 'Máximo 100 %'),
  active: z.boolean().default(true),
});

export const patientInsuranceSchema = z.object({
  planId: uuid,
  affiliateNumber: trimmed(40).min(1, 'Número de afiliado requerido'),
  holderName: optionalText(120),
  relationship: z.enum(['TITULAR', 'DEPENDIENTE']).default('TITULAR'),
  validFrom: optionalYmd,
  validTo: optionalYmd,
  isPrimary: z.boolean().default(true),
});

export const coverageVerificationSchema = z.object({
  patientInsuranceId: uuid,
  appointmentId: optionalUuid,
  result: z.enum(['ELEGIBLE', 'NO_ELEGIBLE', 'PENDIENTE']),
  reference: optionalText(80),
  notes: optionalText(500),
});

export const authorizationSchema = z.object({
  patientInsuranceId: uuid,
  serviceId: optionalUuid,
  appointmentId: optionalUuid,
  authorizationNumber: optionalText(60),
  authorizedAmount: money.optional().nullable(),
  status: z.enum(['SOLICITADA', 'APROBADA', 'DENEGADA', 'VENCIDA', 'UTILIZADA']).default('SOLICITADA'),
  validUntil: optionalYmd,
  notes: optionalText(500),
});

export const claimCreateSchema = z.object({
  insurerId: uuid,
  branchId: uuid,
  invoiceItemIds: z.array(uuid).min(1, 'Seleccione al menos un servicio a reclamar'),
  notes: optionalText(500),
});

export const claimStatusSchema = z.object({
  status: z.enum(['SOMETIDA', 'EN_REVISION', 'APROBADA', 'APROBADA_PARCIAL', 'RECHAZADA', 'CERRADA']),
  externalReference: optionalText(80),
  note: optionalText(500),
  /** Montos aprobados por línea al registrar la respuesta de la ARS. */
  items: z.array(z.object({ id: uuid, approvedAmount: money })).optional(),
});

export const glosaSchema = z.object({
  claimItemId: optionalUuid,
  code: optionalText(20),
  reason: trimmed(500).min(3),
  amount: positiveMoney,
});
export const glosaResolveSchema = z.object({
  status: z.enum(['ACEPTADA', 'EN_DISPUTA', 'RECUPERADA']),
  resolution: optionalText(500),
});

export const insurerPaymentSchema = z.object({
  insurerId: uuid,
  receivedAt: isoDateTime,
  amount: positiveMoney,
  reference: optionalText(80),
  notes: optionalText(500),
  allocations: z.array(z.object({ claimId: uuid, amount: positiveMoney })).default([]),
});

// ─────────── Fiscal ───────────

export const fiscalSequenceSchema = z.object({
  type: z.string().trim().toUpperCase().regex(/^[BE]\d{2}$/, 'Tipo de comprobante (p. ej. B01, B02, E32)'),
  description: trimmed(120).min(2),
  prefix: z.string().trim().toUpperCase().regex(/^[BE]\d{2}$/),
  rangeFrom: z.coerce.number().int().min(1),
  rangeTo: z.coerce.number().int().min(1),
  validUntil: optionalYmd,
}).refine((v) => v.rangeTo >= v.rangeFrom, { message: 'Rango inválido', path: ['rangeTo'] });

export const fiscalIssueSchema = z.object({
  type: z.string().trim().toUpperCase().regex(/^[BE]\d{2}$/),
  buyerRnc: optionalText(20),
  buyerName: optionalText(150),
});

// ─────────── Notificaciones y configuración ───────────

export const templateSchema = z.object({
  subject: optionalText(150),
  body: z.string().trim().min(5).max(1000),
  active: z.boolean().default(true),
});

export const organizationSettingsSchema = z.object({
  name: trimmed(120).min(2),
  legalName: optionalText(150),
  rnc: optionalText(20),
  phone: optionalText(30),
  email: z.union([z.email(), z.literal(''), z.null()]).optional().transform((v) => v || null),
  address: optionalText(250),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('DOP'),
  timezone: trimmed(60).default('America/Santo_Domingo'),
});

export const operationalSettingsSchema = z.object({
  productName: trimmed(80).min(2),
  reminderOffsetsMinutes: z.array(z.coerce.number().int().min(15).max(10080)).max(5),
  notificationChannels: z.array(z.enum(['WHATSAPP', 'SMS', 'EMAIL'])),
  cancellationMinHours: z.coerce.number().int().min(0).max(168),
  invoiceDueDays: z.coerce.number().int().min(0).max(365),
  allowVirtualAppointments: z.boolean(),
  maxLoginAttempts: z.coerce.number().int().min(3).max(20),
  lockoutMinutes: z.coerce.number().int().min(1).max(1440),
  timeFormat24h: z.boolean(),
  dataRetentionYears: z.coerce.number().int().min(1).max(50),
});

export type OperationalSettings = z.infer<typeof operationalSettingsSchema>;
export const DEFAULT_OPERATIONAL_SETTINGS: OperationalSettings = {
  productName: 'MediGest',
  reminderOffsetsMinutes: [1440, 120],
  notificationChannels: ['EMAIL', 'WHATSAPP'],
  cancellationMinHours: 4,
  invoiceDueDays: 30,
  allowVirtualAppointments: true,
  maxLoginAttempts: 5,
  lockoutMinutes: 15,
  timeFormat24h: false,
  dataRetentionYears: 10,
};

export { z };

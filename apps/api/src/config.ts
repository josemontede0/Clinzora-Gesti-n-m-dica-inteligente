import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod/v4';

/** Raíz de apps/api (carpeta que contiene prisma/schema.prisma), tanto desde src/ como desde dist/src/. */
function findApiRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'prisma', 'schema.prisma'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}
export const API_ROOT = findApiRoot();

/** Carga apps/api/.env si existe (sin dependencias). Las variables ya definidas en el entorno tienen prioridad. */
function loadDotEnv() {
  if (process.env.MEDIGEST_SKIP_DOTENV === '1') return;
  const candidates = [join(API_ROOT, '.env'), resolve(process.cwd(), '.env')];
  const found = candidates.find((f) => existsSync(f));
  if (!found) return;
  for (const line of readFileSync(found, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
loadDotEnv();

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3001),
  API_HOST: z.string().default('127.0.0.1'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET debe tener al menos 32 caracteres'),
  MFA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'MFA_ENCRYPTION_KEY debe ser 64 caracteres hex'),
  FILE_URL_SECRET: z.string().min(32),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).default(12),
  /** Exige MFA a los roles marcados como privilegiados. Siempre activo en producción. */
  MFA_ENFORCE: bool,
  STORAGE_DIR: z.string().default('../../infra/storage'),
  MAX_UPLOAD_MB: z.coerce.number().int().default(15),
  REDIS_URL: z.string().optional(),
  NOTIFICATIONS_MODE: z.enum(['test', 'live']).default('test'),
  MAIL_OUTBOX_DIR: z.string().default('../../infra/mail-outbox'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  /** URL pública de la API (para validar firmas de webhooks). */
  PUBLIC_API_URL: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  PAYMENTS_PROVIDER: z.enum(['test', 'none']).default('test'),
  FISCAL_PROVIDER: z.enum(['manual']).default('manual'),
  SWAGGER_ENABLED: bool,
  /** Intentos de login por minuto y por IP. */
  LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
  JOBS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type AppConfig = z.infer<typeof schema> & { isProduction: boolean; storageDir: string; mailOutboxDir: string };

function build(): AppConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida (revise apps/api/.env):\n${msg}`);
  }
  const c = parsed.data;
  const isProduction = c.NODE_ENV === 'production';
  if (isProduction && c.PAYMENTS_PROVIDER === 'test') {
    throw new Error('PAYMENTS_PROVIDER=test no está permitido en producción. Configure el procesador real o use "none".');
  }
  const apiRoot = API_ROOT;
  return {
    ...c,
    MFA_ENFORCE: isProduction ? true : c.MFA_ENFORCE,
    isProduction,
    storageDir: resolve(apiRoot, c.STORAGE_DIR),
    mailOutboxDir: resolve(apiRoot, c.MAIL_OUTBOX_DIR),
  };
}

export const config: AppConfig = build();
